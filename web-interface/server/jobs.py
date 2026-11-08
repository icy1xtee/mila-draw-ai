"""The generation queue: one job = one press of «Нарисовать» = 1–4 pictures.

Modes: text (no picture), img2img (tag models: the first attached picture is redrawn with
denoise), edit (FLUX: all attached pictures are references).

Jobs run one picture at a time through ComfyUI. Progress comes from ComfyUI's websocket; the
time left is estimated from history (median seconds per megapixel for model + mode, benchmark
logs and the tasks' .json files), plus model loading if another model is in memory, then
corrected by the real speed of sampler steps.
"""

import asyncio
import json
import logging
import math
import random
import statistics
import time
import uuid
from collections import defaultdict
from dataclasses import dataclass, field

from . import catalog, config, graphs, tasks
from .comfy import ComfyError

log = logging.getLogger("mila.jobs")

DEFAULT_PER_MP = 30.0  # s per megapixel when there is no history at all
# vs text, until there is history; "+hires" is per megapixel of the final (enlarged) picture
MODE_FACTOR = {"text": 1.0, "img2img": 0.7, "edit": 3.0, "text+hires": 1.4, "img2img+hires": 1.3}
MAX_HIRES_MP = 6.0  # 2048×2688 ≈ 5.5 MP passes on 8 GB with the tiled VAE
DEFAULT_LOAD = 15.0
DECODE = 1.5
KEEP_FINISHED = 30
MAX_PICTURES = 4


def fit_size(width, height, megapixels=1.0, step=64):
    """Same proportions at about `megapixels`, sides multiples of `step`."""
    scale = math.sqrt(megapixels * 1e6 / (width * height))
    return (max(512, round(width * scale / step) * step),
            max(512, round(height * scale / step) * step))


class Stats:
    def __init__(self):
        self.per_mp = defaultdict(list)  # "model:mode" -> s/MP
        self.load = defaultdict(list)

    def scan(self):
        for path in config.CONTENT.glob("benchmarks/*/log.jsonl"):
            for line in path.read_text(encoding="utf-8").splitlines():
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                if e.get("kind") == "warmup" and e.get("seconds"):
                    self.load[e["model"]].append(float(e["seconds"]))
                elif e.get("kind") == "image":
                    self.add(e.get("model"), "text", e)
        for path in config.TASKS.glob("*/*.json"):
            e = tasks.read_json(path) or {}
            if e.get("type") == "generated":
                self.add(e.get("model"), stat_mode(e.get("mode", "text"), e.get("settings")), e)

    def add(self, model, mode, e):
        try:
            if model and e.get("seconds") and e.get("size") and not e.get("error") \
                    and not e.get("loaded_model"):
                mp = e["size"][0] * e["size"][1] / 1e6
                self.per_mp[f"{model}:{mode}"].append(float(e["seconds"]) / mp)
        except (TypeError, KeyError, IndexError, ZeroDivisionError):
            pass

    def image_seconds(self, model, mode, mp):
        values = self.per_mp.get(f"{model}:{mode}")
        if values:
            return statistics.median(values[-50:]) * mp
        text = self.per_mp.get(f"{model}:text")
        base = statistics.median(text[-50:]) if text else DEFAULT_PER_MP
        return base * MODE_FACTOR.get(mode, 1.0) * mp

    def load_seconds(self, model):
        values = self.load.get(model)
        if not values:
            return DEFAULT_LOAD
        # Warm-ups draw a small 512² picture: subtract it.
        return max(3.0, statistics.median(values[-20:]) - self.image_seconds(model, "text", 0.26))


def stat_mode(mode, settings):
    """Speed statistics keep pictures with a hires pass apart."""
    return mode + "+hires" if (settings or {}).get("hires") else mode


@dataclass
class Job:
    id: str
    task_id: str
    task_title: str
    model: str
    mode: str
    form: dict
    width: int | None
    height: int | None
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
    hires_scale: float = 0.0
    hires_steps: int = 0

    @property
    def mp(self):
        """Megapixels of the result (after the hires pass, if any)."""
        if not (self.width and self.height):
            return 1.0
        return self.width * self.height * (self.hires_scale or 1.0) ** 2 / 1e6

    @property
    def stat_mode(self):
        return self.mode + "+hires" if self.hires_scale else self.mode


def _number(settings, key, kind, low, high, default=None):
    value = settings.get(key)
    if value in (None, ""):
        return default
    value = kind(value)
    if not low <= value <= high:
        raise ValueError(f"{key}: от {low} до {high}")
    return value


class Jobs:
    def __init__(self, comfy):
        self.comfy = comfy
        self.stats = Stats()
        self.jobs = []
        self.wake = asyncio.Event()
        self.loaded_model = None

    # --- queue --------------------------------------------------------------------------------

    def submit(self, task, form):
        """form: {model, images: [file], preset, white_bg, prompt, negative, settings, idea?}.

        idea — a brainstorm idea drawn from text: {batch, n, title, description, source photo}.
        """
        models = catalog.models()
        model = models.get(form.get("model"))
        if not model:
            raise ValueError("Неизвестная модель")
        images = list(form.get("images") or [])[:MAX_PICTURES]
        for image in images:
            tasks.meta_path(image)  # exists and is inside content/tasks
        preset = catalog.find_preset(form.get("preset"))
        presets = catalog.presets()
        settings = form.get("settings") or {}

        if not images:
            mode = "text"
        elif model.get("references"):
            mode = "edit"
        else:
            mode = "img2img"
        if preset:
            is_action = preset in presets["actions"]
            if is_action and mode == "text":
                raise ValueError(f"«{preset['title']}» — для работы с картинкой: прикрепите её")
            if not is_action and mode != "text":
                raise ValueError(f"«{preset['title']}» — для рисования без картинки")
            if preset.get("references") and mode != "edit":
                raise ValueError(f"«{preset['title']}» умеет только модель с референсами")
        if not (form.get("prompt") or "").strip() and not preset:
            raise ValueError("Напишите промпт или выберите заготовку")

        if mode == "text":
            width = _number(settings, "width", int, 512, 2048)
            height = _number(settings, "height", int, 512, 2048)
            if not width or not height or width % 64 or height % 64:
                raise ValueError("Размер: от 512 до 2048, кратно 64")
        elif mode == "img2img":
            width, height = fit_size(*tasks.picture_size(images[0]))
        else:
            size = presets["sizes"].get((preset or {}).get("size"))
            width, height = (size["width"], size["height"]) if size else (None, None)

        clean = {
            "steps": _number(settings, "steps", int, 1, 150),
            "cfg": _number(settings, "cfg", float, 0, 30),
            "sampler": settings.get("sampler") or None,
            "scheduler": settings.get("scheduler") or None,
            "denoise": _number(settings, "denoise", float, 0.05, 1.0,
                               (preset or {}).get("denoise", 0.6)),
            "quality": settings.get("quality", True) is not False,
            "loras": [{"file": l["file"], "strength": float(l["strength"]),
                       **({"variant": str(l["variant"])} if l.get("variant") else {})}
                      for l in settings.get("loras", []) if l.get("file")],
        }
        hires = None
        raw = settings.get("hires")
        if isinstance(raw, dict) and raw.get("on", True) and catalog.is_tag_model(model)                 and mode in ("text", "img2img"):
            hires = {"upscaler": str(raw.get("upscaler") or ""),
                     "scale": _number(raw, "scale", float, 1.1, 2.0, 1.5),
                     "denoise": _number(raw, "denoise", float, 0.1, 0.9, 0.5),
                     "steps": _number(raw, "steps", int, 1, 60, 20),
                     "cfg": _number(raw, "cfg", float, 0, 30)}
            if width * height * hires["scale"] ** 2 / 1e6 > MAX_HIRES_MP:
                raise ValueError(f"Hires fix: итог больше {MAX_HIRES_MP:g} Мп — уменьшите размер "
                                 "или увеличение (на 8 ГБ не поместится)")
        clean["hires"] = hires
        count = _number(settings, "count", int, 1, 4, 1)
        seed = settings.get("seed")
        seed = random.randint(0, 2**31 - 1) if seed in (None, "") else int(seed)
        idea = None
        if isinstance(form.get("idea"), dict):  # one idea of a brainstorm drawn in one model
            raw = form["idea"]
            source = raw.get("source") or None
            if source:
                tasks.meta_path(source)
            idea = {"batch": str(raw.get("batch") or "")[:24], "n": int(raw.get("n") or 0),
                    "title": str(raw.get("title") or "")[:120],
                    "description": str(raw.get("description") or "")[:600], "source": source}
        job = Job(id=uuid.uuid4().hex[:10], task_id=task["id"], task_title=task["title"],
                  model=form["model"], mode=mode, width=width, height=height,
                  seeds=[seed + i for i in range(count)],
                  hires_scale=hires["scale"] if hires else 0.0,
                  hires_steps=hires["steps"] if hires else 0,
                  form={"images": images, "preset": (preset or {}).get("id"),
                        "white_bg": bool(form.get("white_bg")),
                        "prompt": (form.get("prompt") or "").strip(),
                        "negative": (form.get("negative") or "").strip(), "settings": clean,
                        "idea": idea})
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

    # --- worker -------------------------------------------------------------------------------

    async def worker(self):
        self.stats.scan()
        while True:
            job = next((j for j in self.jobs if j.status == "queued"), None)
            if not job:
                self._trim()
                self.wake.clear()
                await self.wake.wait()
                continue
            try:
                await self._run(job)
            except Exception as e:  # keep the worker alive whatever happens
                log.exception("job %s failed", job.id)
                job.status, job.error, job.stage = "error", str(e), "Ошибка"
                job.finished = time.time()

    def _trim(self):
        finished = [j for j in self.jobs if j.status not in ("queued", "running")]
        for job in finished[:-KEEP_FINISHED]:
            self.jobs.remove(job)

    async def _run(self, job):
        model = catalog.models()[job.model]
        form, settings = job.form, job.form["settings"]
        preset = catalog.find_preset(form["preset"])
        job.status, job.started, job.stage = "running", time.time(), "Готовлю картинки"

        names = []
        for image in form["images"][: (MAX_PICTURES if job.mode == "edit" else 1)]:
            src = tasks.resolve(image)
            names.append(await self.comfy.upload(src.read_bytes(), f"{job.id}-{src.name}"))

        lora_info = {l["file"]: l for l in catalog.lora_entries([l["file"] for l in settings["loras"]])}
        loras = [{**l, "trigger": catalog.lora_trigger(lora_info.get(l["file"], {}), l.get("variant"))}
                 for l in settings["loras"]]
        positive, negative = catalog.assemble(model, preset, form["white_bg"], form["prompt"],
                                              form["negative"], loras, settings["quality"])
        overrides = {k: settings[k] for k in ("steps", "cfg", "sampler", "scheduler")
                     if settings.get(k) not in (None, "")}
        upscalers = await self.comfy.list_models("upscale_models") if settings.get("hires") else []

        for seed in job.seeds:
            if job.cancel:
                break
            graph = graphs.build(
                model, positive, negative, seed, job.width, job.height, loras,
                init_image=names[0] if job.mode == "img2img" else None,
                denoise=settings["denoise"], overrides=overrides,
                references=names if job.mode == "edit" else (),
                hires=settings.get("hires"), upscalers=upscalers)
            job.loading = self.loaded_model != job.model
            job.step = job.steps = job.first_step = 0
            job.first_step_time = 0.0
            job.picture_started = time.time()
            job.stage = "Загружаю модель" if job.loading else "Начинаю"
            try:
                png, seconds, size = await self._picture(job, graph)
            except ComfyError:
                if job.cancel:
                    break
                raise
            self.loaded_model = job.model
            record = {
                "job": job.id, "mode": job.mode, "model": job.model,
                "model_title": model.get("title", job.model), "preset": form["preset"],
                "preset_title": (preset or {}).get("title"), "white_bg": form["white_bg"],
                "prompt": form["prompt"], "negative": form["negative"],
                "inputs": form["images"] if job.mode == "edit" else form["images"][:1],
                "settings": settings, "seed": seed, "seconds": seconds, "size": size,
                "loaded_model": job.loading, "positive_final": positive,
                "negative_final": negative, "machine": "msi", "payload": graph,
            }
            if form.get("idea"):
                record["idea"] = form["idea"]
            rel = tasks.save_generated(job.task_id, f"{job.model}_{seed}.png", png, record)
            job.images.append(rel)
            job.done += 1
            self.stats.add(job.model, job.stat_mode, record)

        job.finished = time.time()
        job.status, job.stage = ("cancelled", "Отменено") if job.cancel else ("done", "Готово")

    async def _picture(self, job, graph):
        finished = asyncio.Event()
        result = {}

        def on_event(kind, data):
            if kind == "executing":
                node = data.get("node")
                if node is None:
                    finished.set()
                else:
                    job.stage = graphs.stage(node) or job.stage
            elif kind == "progress" and data.get("node") in ("sample", "hires"):
                job.step, job.steps = int(data["value"]), int(data["max"])
                if not job.first_step_time:
                    job.first_step, job.first_step_time = job.step, time.time()
                job.stage = (f"Рисую: шаг {job.step} из {job.steps}" if data["node"] == "sample"
                             else f"Детали: шаг {job.step} из {job.steps}")
            elif kind == "execution_error":
                result["error"] = data.get("exception_message", "ошибка ComfyUI").strip()
                finished.set()
            elif kind == "execution_interrupted":
                result["error"] = "прервано"
                finished.set()
            elif kind == "execution_success":
                finished.set()

        prompt_id = await self.comfy.queue(graph)
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
                return png, round(time.monotonic() - started, 1), _png_size(png)
        raise ComfyError("ComfyUI не вернул картинку")

    # --- progress and time left ---------------------------------------------------------------

    def remaining(self, job, now=None):
        now = now or time.time()
        per = self.stats.image_seconds(job.model, job.stat_mode, job.mp)
        total = len(job.seeds)
        if job.status == "queued":
            loaded = self.loaded_model == job.model
            return per * total + (0 if loaded else self.stats.load_seconds(job.model))
        if job.status != "running":
            return 0.0
        elapsed = now - job.picture_started
        # With a hires pass the step speed of the first pass says little about the whole.
        if job.first_step_time and job.step > job.first_step and job.steps and not job.hires_scale:
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
            progress = min(elapsed / (elapsed + remaining), 0.99) if elapsed + remaining else 0
        else:
            progress = 1.0 if job.status == "done" else 0.0
        model = catalog.models().get(job.model, {})
        return {
            "id": job.id, "task_id": job.task_id, "task_title": job.task_title,
            "model": job.model, "model_title": model.get("title", job.model), "mode": job.mode,
            "count": len(job.seeds), "done": job.done, "status": job.status, "stage": job.stage,
            "progress": round(progress, 3), "remaining": round(remaining),
            "eta": round(ahead + remaining), "position": position, "images": job.images,
            "error": job.error, "created": job.created, "finished": job.finished,
        }

    def snapshot(self):
        now = time.time()
        ahead, position, active, finished = 0.0, 0, [], []
        for job in self.jobs:
            if job.status in ("queued", "running"):
                active.append(self.view(job, ahead, position, now))
                ahead += self.remaining(job, now)
                position += 1
            else:
                finished.append(self.view(job, now=now))
        return {"active": active, "finished": finished[-10:][::-1],
                "comfy": self.comfy.connected, "total_remaining": round(ahead)}


def _png_size(png):
    # PNG header: width and height are big-endian at bytes 16..24.
    if png[:8] == b"\x89PNG\r\n\x1a\n":
        return [int.from_bytes(png[16:20], "big"), int.from_bytes(png[20:24], "big")]
    return None
