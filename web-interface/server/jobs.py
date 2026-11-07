"""The web-interface's queue: one job = one form submission = 1–4 pictures.

Jobs run one picture at a time through ComfyUI. Progress comes from ComfyUI's websocket
(sampler steps, which node runs); the time left is estimated from history: median seconds per
megapixel for the model (benchmark and task logs), plus model loading if another model is in
memory, then corrected by the real speed of sampler steps.
"""

import asyncio
import json
import logging
import random
import statistics
import time
import uuid
from collections import defaultdict
from dataclasses import dataclass, field

from . import catalog, config, graphs, tasks
from .comfy import ComfyError

log = logging.getLogger("studio.jobs")

DEFAULT_PER_MP = 30.0  # s per megapixel when there is no history for a model
DEFAULT_LOAD = 15.0
DECODE = 1.5
KEEP_FINISHED = 30


class Stats:
    """Seconds per megapixel and model load time, from logs in content/."""

    def __init__(self):
        self.per_mp = defaultdict(list)
        self.load = defaultdict(list)

    def scan(self):
        logs = list(config.CONTENT.glob("benchmarks/*/log.jsonl"))
        logs += list(config.PROTOTYPE.glob("*/log.jsonl"))
        for path in logs:
            for line in path.read_text(encoding="utf-8").splitlines():
                try:
                    self.add_entry(json.loads(line))
                except (ValueError, KeyError, TypeError):
                    pass

    def add_entry(self, e):
        if e.get("kind") == "warmup" and e.get("seconds"):
            self.load[e["model"]].append(float(e["seconds"]))
        elif e.get("kind") == "image" and e.get("seconds") and e.get("size") and not e.get("error") \
                and not e.get("loaded_model") and not e.get("init"):
            mp = e["size"][0] * e["size"][1] / 1e6
            self.per_mp[e["model"]].append(float(e["seconds"]) / mp)

    def image_seconds(self, model, mp):
        values = self.per_mp.get(model)
        return (statistics.median(values[-50:]) if values else DEFAULT_PER_MP) * mp

    def load_seconds(self, model):
        values = self.load.get(model)
        if not values:
            return DEFAULT_LOAD
        # Warm-ups draw a small 512² picture: subtract it.
        return max(3.0, statistics.median(values[-20:]) - self.image_seconds(model, 0.26))


@dataclass
class Job:
    id: str
    task_id: str
    task_title: str
    who: str
    model: str
    form: dict
    width: int
    height: int
    seeds: list
    created: float = field(default_factory=time.time)
    status: str = "queued"  # queued | running | done | error | cancelled
    stage: str = "В очереди"
    done: int = 0
    images: list = field(default_factory=list)
    error: str = ""
    started: float = 0.0
    finished: float = 0.0
    picture_started: float = 0.0
    loading: bool = False
    step: int = 0
    steps: int = 0
    first_step: int = 0
    first_step_time: float = 0.0
    cancel: bool = False
    prompt_id: str = ""

    @property
    def mp(self):
        return self.width * self.height / 1e6


class Jobs:
    def __init__(self, comfy):
        self.comfy = comfy
        self.stats = Stats()
        self.jobs = []
        self.wake = asyncio.Event()
        self.loaded_model = None
        self.idle_callbacks = []  # called when the queue becomes empty (Claude's journal)
        self.done_callbacks = []  # called with task_id when a job ends (journal request)

    # --- queue --------------------------------------------------------------------------------

    def submit(self, task, who, form):
        models = catalog.models()
        if form.get("model") not in models:
            raise ValueError("Неизвестная модель")
        width, height = int(form["width"]), int(form["height"])
        if width % 64 or height % 64 or not (512 <= width <= 2048 and 512 <= height <= 2048):
            raise ValueError("Размер: от 512 до 2048, кратно 64")
        count = max(1, min(4, int(form.get("count", 1))))
        seed = form.get("seed")
        seed = random.randint(0, 2**31 - 1) if seed in (None, "") else int(seed)
        job = Job(id=uuid.uuid4().hex[:10], task_id=task["id"], task_title=task["title"], who=who,
                  model=form["model"], form=form, width=width, height=height,
                  seeds=[seed + i for i in range(count)])
        # Log first: if logging fails, the job must not sit in the queue half-submitted.
        tasks.log(task["id"], "generate", who, job=job.id, seeds=job.seeds,
                  form={k: v for k, v in form.items() if k not in ("seed", "task_id")})
        self.jobs.append(job)
        self.wake.set()
        return job

    def cancel(self, job_id):
        job = self.find(job_id)
        if job.status == "queued":
            job.status, job.stage, job.finished = "cancelled", "Отменено", time.time()
        elif job.status == "running":
            job.cancel = True
            asyncio.get_running_loop().create_task(self.comfy.interrupt())
        return job

    def find(self, job_id):
        for job in self.jobs:
            if job.id == job_id:
                return job
        raise KeyError(job_id)

    def active(self):
        return [j for j in self.jobs if j.status in ("queued", "running")]

    def busy(self):
        return bool(self.active())

    # --- worker -------------------------------------------------------------------------------

    async def worker(self):
        self.stats.scan()
        while True:
            job = next((j for j in self.jobs if j.status == "queued"), None)
            if not job:
                self._trim()
                for callback in self.idle_callbacks:
                    callback()
                self.wake.clear()
                await self.wake.wait()
                continue
            try:
                await self._run(job)
            except Exception as e:  # keep the worker alive whatever happens
                log.exception("job %s failed", job.id)
                job.status, job.error, job.stage = "error", str(e), "Ошибка"
                job.finished = time.time()
                tasks.log(job.task_id, "error", job.who, job=job.id, error=str(e))

    def _trim(self):
        finished = [j for j in self.jobs if j.status not in ("queued", "running")]
        for job in finished[:-KEEP_FINISHED]:
            self.jobs.remove(job)

    async def _run(self, job):
        model = catalog.models()[job.model]
        form = job.form
        job.status, job.started, job.stage = "running", time.time(), "Готовлю"

        init_name = None
        if form.get("init"):
            job.stage = "Загружаю картинку-основу"
            src = config.CONTENT / form["init"]
            init_name = await self.comfy.upload(src.read_bytes(), f"{job.id}{src.suffix}")

        loras = [{"file": l["file"], "strength": float(l["strength"])} for l in form.get("loras", [])]
        positive, negative = catalog.assemble(model, form.get("blocks", []), form.get("prompt", ""),
                                              form.get("negative", ""), loras)
        overrides = {k: form[k] for k in ("steps", "cfg", "sampler", "scheduler") if form.get(k)}
        if "steps" in overrides:
            overrides["steps"] = int(overrides["steps"])
        if "cfg" in overrides:
            overrides["cfg"] = float(overrides["cfg"])

        for seed in job.seeds:
            if job.cancel:
                break
            graph = graphs.build(model, positive, negative, seed, job.width, job.height, loras,
                                 init_name, float(form.get("denoise", 0.6)), overrides)
            job.loading = self.loaded_model != job.model
            job.step = job.steps = job.first_step = 0
            job.first_step_time = 0.0
            job.picture_started = time.time()
            job.stage = "Загружаю модель" if job.loading else "Начинаю"
            try:
                png, seconds = await self._picture(job, graph)
            except ComfyError as e:
                if job.cancel:
                    break
                raise
            self.loaded_model = job.model
            record = {
                "kind": "image", "machine": "msi", "task": job.task_id, "who": job.who,
                "job": job.id, "model": job.model, "model_name": model.get("name", job.model),
                "seed": seed, "time": tasks.now(), "seconds": seconds,
                "loaded_model": job.loading, "size": [job.width, job.height],
                "init": form.get("init"),
                "form": {k: v for k, v in form.items() if k not in ("seed", "task_id")},
                "prompt_final": positive, "negative_final": negative, "payload": graph,
            }
            path = tasks.save_output(job.task_id, f"{job.model}_{seed}.png", png, record)
            rel = tasks.rel(path)
            job.images.append(rel)
            job.done += 1
            entry = {k: v for k, v in record.items() if k not in ("payload", "form", "kind",
                                                                 "time", "who", "task")}
            tasks.log(job.task_id, "image", job.who, file=rel, **entry)
            self.stats.add_entry({**record, "kind": "image"})

        job.finished = time.time()
        if job.cancel:
            job.status, job.stage = "cancelled", "Отменено"
        else:
            job.status, job.stage = "done", "Готово"
        for callback in self.done_callbacks:
            callback(job.task_id)

    async def _picture(self, job, graph):
        finished = asyncio.Event()
        result = {}

        def on_event(kind, data):
            if kind == "executing":
                node = data.get("node")
                if node is None:
                    finished.set()
                elif node in graphs.LOADER_NODES:
                    job.stage = "Загружаю модель"
                elif node == "load" or node == "scale":
                    job.stage = "Готовлю картинку-основу"
                elif node == "sample":
                    job.stage = "Рисую"
                elif node == "decode":
                    job.stage = "Проявляю"
                elif node == "out":
                    job.stage = "Сохраняю"
            elif kind == "progress" and data.get("node") == "sample":
                job.step, job.steps = int(data["value"]), int(data["max"])
                if not job.first_step_time:
                    job.first_step, job.first_step_time = job.step, time.time()
                job.stage = f"Рисую: шаг {job.step} из {job.steps}"
            elif kind == "execution_error":
                result["error"] = data.get("exception_message", "ошибка ComfyUI").strip()
                finished.set()
            elif kind == "execution_interrupted":
                result["error"] = "прервано"
                finished.set()
            elif kind == "execution_success":
                finished.set()

        prompt_id = await self.comfy.queue(graph)
        job.prompt_id = prompt_id
        self.comfy.watchers[prompt_id] = on_event
        started = time.monotonic()
        try:
            # The websocket is the main signal; history is polled as a fallback.
            while not finished.is_set():
                try:
                    await asyncio.wait_for(finished.wait(), timeout=3)
                except asyncio.TimeoutError:
                    item = await self.comfy.history(prompt_id)
                    if item and item.get("status", {}).get("completed") is not None:
                        if item["status"].get("status_str") == "error":
                            result["error"] = "ошибка ComfyUI"
                        finished.set()
                if time.monotonic() - started > 1800:
                    raise ComfyError("нет ответа от ComfyUI 30 минут")
        finally:
            self.comfy.watchers.pop(prompt_id, None)
        if "error" in result:
            raise ComfyError(result["error"])
        item = None
        for _ in range(10):
            item = await self.comfy.history(prompt_id)
            if item and item.get("outputs"):
                break
            await asyncio.sleep(0.3)
        for output in (item or {}).get("outputs", {}).values():
            if output.get("images"):
                png = await self.comfy.image(output["images"][0])
                return png, round(time.monotonic() - started, 1)
        raise ComfyError("ComfyUI не вернул картинку")

    # --- progress and time left ---------------------------------------------------------------

    def remaining(self, job, now=None):
        now = now or time.time()
        per = self.stats.image_seconds(job.model, job.mp)
        total = len(job.seeds)
        if job.status == "queued":
            loaded = self.loaded_model == job.model
            return per * total + (0 if loaded else self.stats.load_seconds(job.model))
        if job.status != "running":
            return 0.0
        elapsed = now - job.picture_started
        if job.first_step_time and job.step > job.first_step and job.steps:
            rate = (now - job.first_step_time) / (job.step - job.first_step)
            current = (job.steps - job.step) * rate + DECODE
        else:
            expected = per + (self.stats.load_seconds(job.model) if job.loading else 0)
            current = max(expected - elapsed, 2.0)
        left = total - job.done - 1
        return current + max(left, 0) * per

    def view(self, job, ahead=0.0, position=0, now=None):
        now = now or time.time()
        remaining = self.remaining(job, now)
        if job.status == "running":
            elapsed = now - job.started
            progress = elapsed / (elapsed + remaining) if elapsed + remaining else 0
        elif job.status == "done":
            progress = 1.0
        else:
            progress = 0.0
        model = catalog.models().get(job.model, {})
        return {
            "id": job.id, "task_id": job.task_id, "task_title": job.task_title, "who": job.who,
            "model": job.model, "model_title": model.get("title", job.model),
            "count": len(job.seeds), "done": job.done, "status": job.status, "stage": job.stage,
            "progress": round(min(progress, 0.99) if job.status == "running" else progress, 3),
            "remaining": round(remaining), "eta": round(ahead + remaining), "position": position,
            "step": job.step, "steps": job.steps, "images": job.images, "error": job.error,
            "created": job.created, "finished": job.finished,
        }

    def snapshot(self):
        now = time.time()
        ahead, position, active, finished = 0.0, 0, [], []
        for job in self.jobs:
            if job.status in ("queued", "running"):
                view = self.view(job, ahead, position, now)
                ahead += self.remaining(job, now)
                position += 1
                active.append(view)
            else:
                finished.append(self.view(job, now=now))
        return {"active": active, "finished": finished[-10:][::-1],
                "comfy": {"connected": self.comfy.connected},
                "total_remaining": round(ahead)}
