"""Claude in the web interface: the task journal and the prompt helper.

Runs Claude Code headless (`claude -p`, prompt on stdin) in --restricted mode: no Bash or other
code-running tools, no web, file tools confined to the working directory.

- Journal: working directory content/prototype/, tools Read/Write/Edit/Glob/Grep; Claude
  rewrites <task>/notes.md and content/prototype/README.md. Starts only when the generation
  queue is empty (16 GB RAM: Claude must not compete with FLUX), JOURNAL_DELAY seconds after
  the last event in the task, or at once on «подвести итог».
- Prompt helper: no tools at all; card texts and prompt rules go into the prompt.
"""

import asyncio
import json
import logging
import shutil
import time
from pathlib import Path

from . import catalog, config, tasks

log = logging.getLogger("studio.claude")

IMAGES_PER_RUN = 10
# Long fields of log entries that Claude does not need to read in full.
SKIP_FIELDS = {"prompt_final", "negative_final", "payload", "job"}


def _render(template_name, **values):
    text = (config.CLAUDE_DIR / template_name).read_text(encoding="utf-8")
    for key, value in values.items():
        text = text.replace("{" + key + "}", str(value))
    return text


async def run_claude(prompt, cwd, tools, timeout=600, model=None):
    """Run `claude -p` with the prompt on stdin; returns (result text, info dict)."""
    exe = shutil.which(config.CLAUDE_BIN)
    if not exe:
        raise RuntimeError("claude не найден в PATH")
    args = [exe, "-p", "--restricted", "--strict-mcp-config", "--no-session-persistence",
            "--output-format", "json", "--permission-mode", "acceptEdits",
            "--permission-prompts", "none", "--tools", ",".join(tools) if tools else ""]
    if model or config.CLAUDE_MODEL:
        args += ["--model", model or config.CLAUDE_MODEL]
    started = time.monotonic()
    process = await asyncio.create_subprocess_exec(
        *args, cwd=str(cwd), stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE)
    try:
        out, err = await asyncio.wait_for(process.communicate(prompt.encode("utf-8")), timeout)
    except asyncio.TimeoutError:
        process.kill()
        raise RuntimeError(f"Claude не ответил за {timeout} с")
    seconds = round(time.monotonic() - started, 1)
    try:
        data = json.loads(out.decode("utf-8", errors="replace"))
    except ValueError:
        raise RuntimeError((err or out).decode("utf-8", errors="replace").strip()[:500]
                           or f"claude завершился с кодом {process.returncode}")
    if data.get("is_error"):
        raise RuntimeError(str(data.get("result") or data.get("subtype"))[:500])
    info = {"seconds": seconds, "cost_usd": data.get("total_cost_usd"),
            "turns": data.get("num_turns")}
    return data.get("result", ""), info


class Journal:
    """Keeps every task's notes.md up to date."""

    def __init__(self, jobs):
        self.jobs = jobs
        self.due = {}  # task_id -> time to run
        self.running = None
        self.last = {}  # task_id -> {time, ok, message, seconds}
        self.available = shutil.which(config.CLAUDE_BIN) is not None
        self.wake = asyncio.Event()
        jobs.idle_callbacks.append(self.wake.set)
        jobs.done_callbacks.append(self.request)

    def request(self, task_id, now=False):
        if not self.available:
            return
        when = time.time() + (0 if now else config.JOURNAL_DELAY)
        self.due[task_id] = min(self.due.get(task_id, when), when) if now else when
        self.wake.set()

    def task_status(self, task_id):
        if not self.available:
            return {"state": "off", "message": "Claude не установлен на этой машине"}
        if self.running == task_id:
            return {"state": "running", "message": "Claude пишет дневник…"}
        if task_id in self.due:
            wait = max(0, round(self.due[task_id] - time.time()))
            busy = self.jobs.busy()
            return {"state": "pending", "in": wait,
                    "message": "Дневник обновится, когда закончится генерация" if busy
                    else f"Дневник обновится через {wait} с"}
        last = self.last.get(task_id)
        if last:
            return {"state": "ok" if last["ok"] else "error", **last}
        return {"state": "idle"}

    def status(self):
        return {"available": self.available, "running": self.running,
                "pending": len(self.due)}

    async def run(self):
        while True:
            self.wake.clear()
            ready = [t for t, when in self.due.items() if when <= time.time()]
            if ready and not self.jobs.busy():
                task_id = min(ready, key=self.due.get)
                self.due.pop(task_id, None)
                await self._journal(task_id)
                continue
            try:
                await asyncio.wait_for(self.wake.wait(), timeout=5)
            except asyncio.TimeoutError:
                pass

    async def _journal(self, task_id):
        self.running = task_id
        try:
            prompt = self._prompt(task_id)
            if prompt is None:
                return
            result, info = await run_claude(
                prompt, config.PROTOTYPE, ["Read", "Write", "Edit", "Glob", "Grep"], timeout=900)
            self.last[task_id] = {"time": tasks.now(), "ok": True, "message": result.strip()[:300],
                                  **info}
            tasks.log(task_id, "claude", "Claude", action="journal", result=result.strip()[:300],
                      **info)
            self._save_state(task_id)
        except Exception as e:  # the journal must never break the interface
            log.exception("journal for %s failed", task_id)
            self.last[task_id] = {"time": tasks.now(), "ok": False, "message": str(e)[:300]}
        finally:
            self.running = None

    # --- what Claude gets ---------------------------------------------------------------------

    def _state_path(self, task_id):
        return tasks.folder(task_id) / ".journal.json"

    def _save_state(self, task_id):
        lines = len(tasks.read_log(task_id))
        self._state_path(task_id).write_text(json.dumps({"log_lines": lines, "time": tasks.now()}),
                                             encoding="utf-8")

    def _prompt(self, task_id):
        folder = tasks.folder(task_id)
        try:
            state = json.loads(self._state_path(task_id).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            state = {"log_lines": 0}
        entries = tasks.read_log(task_id)
        new = entries[state.get("log_lines", 0):]
        new = [e for e in new if e.get("kind") != "claude"]
        if not new:
            return None
        task = json.loads((folder / "task.json").read_text(encoding="utf-8"))
        marked = set(task.get("stars", [])) | set(task.get("finals", []))

        images = []
        for e in new:
            if e.get("kind") == "upload" and _is_image(e.get("file")):
                images.append(e["file"])
        images += [f for f in marked if f not in images]
        outputs = [e["file"] for e in new if e.get("kind") == "image"]
        images += outputs[-4:]
        prefix = f"prototype/{task_id}/"
        images = [p[len(prefix):] if p.startswith(prefix) else p for p in images]
        images = list(dict.fromkeys(images))[:IMAGES_PER_RUN]

        events = "\n".join(json.dumps({k: v for k, v in e.items() if k not in SKIP_FIELDS},
                                      ensure_ascii=False) for e in new)
        cards = ""
        kind = task.get("kind")
        card_file = {"character": "characters.md", "background": "locations.md"}.get(kind)
        if card_file:
            card_path = config.REPO / ".claude" / "vibe-description" / card_file
            if card_path.exists():
                cards = (f"\n\n## Карточки проекта ({card_file}, демо-концепт, для справки)\n\n"
                         + card_path.read_text(encoding="utf-8"))
        return (
            _render("journal.md", task_dir=task_id)
            + f"\n\n## task.json\n\n```json\n{json.dumps(task, ensure_ascii=False, indent=2)}\n```"
            + f"\n\n## Новые события ({len(new)})\n\n```\n{events}\n```"
            + "\n\n## Картинки посмотреть (пути от папки задачи)\n\n"
            + ("\n".join(f"- {task_id}/{p}" for p in images) if images else "- нет новых")
            + cards
        )


def _is_image(path):
    return bool(path) and Path(path).suffix.lower() in tasks.IMAGE_EXT


async def prompt_help(idea, model_key, block_ids):
    """Russian idea → prompt for the model's family. Returns {prompt, negative, comment}."""
    models = catalog.models()
    model = models[model_key]
    blocks = [b for b in catalog.blocks_file()["blocks"] if b["id"] in block_ids]
    block_lines = "\n".join(
        f"- {b['title']}: {b.get('text', {}).get(model['family'], '(текст модели)') if b.get('source') != 'model' else model.get('prefix', '')}"
        for b in blocks) or "- нет"
    vibe = config.REPO / ".claude" / "vibe-description"
    cards = "\n\n".join((vibe / name).read_text(encoding="utf-8")
                        for name in ("characters.md", "locations.md") if (vibe / name).exists())
    prompt = (
        _render("prompt-helper.md", model_title=model.get("title", model_key),
                family=model["family"], negative_works=str(model.get("negative_works", True)).lower())
        + f"\n\n## Включённые блоки (их текст добавится сам)\n\n{block_lines}"
        + f"\n\n## Идея Милы\n\n{idea.strip()}"
        + f"\n\n## Карточки персонажей и мест (демо-концепт)\n\n{cards}"
    )
    result, info = await run_claude(prompt, config.PROTOTYPE, [], timeout=180)
    text = result.strip()
    start, end = text.find("{"), text.rfind("}")
    try:
        data = json.loads(text[start:end + 1])
    except ValueError:
        data = {"prompt": text, "negative": "", "comment": "Claude ответил не в формате JSON"}
    return {"prompt": data.get("prompt", ""), "negative": data.get("negative", ""),
            "comment": data.get("comment", ""), **info}
