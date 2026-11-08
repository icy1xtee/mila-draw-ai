"""Claude in Mila Draw AI: describes attached pictures and turns Mila's words into a prompt.

Runs Claude Code headless (`claude -p`, prompt on stdin) in --restricted mode: no Bash, no web,
file tools confined to the working directory.

- describe: tool Read only, working directory = the task folder; answer {description, tags}
  is stored in the picture's .json ("analysis").
- prompt_help: no tools; converts the text, adds nothing (claude/prompt-helper.md).
"""

import asyncio
import json
import logging
import shutil
import time

from . import config, tasks

log = logging.getLogger("mila.claude")

_running = asyncio.Semaphore(2)  # 16 GB RAM: at most two Claude processes at once
_background = set()


def available():
    return shutil.which(config.CLAUDE_BIN) is not None


def _render(template_name, **values):
    text = (config.CLAUDE_DIR / template_name).read_text(encoding="utf-8")
    for key, value in values.items():
        text = text.replace("{" + key + "}", str(value))
    return text


async def run_claude(prompt, cwd, tools, timeout=300):
    """Run `claude -p` with the prompt on stdin; returns (result text, info dict)."""
    exe = shutil.which(config.CLAUDE_BIN)
    if not exe:
        raise RuntimeError("claude не найден в PATH")
    args = [exe, "-p", "--restricted", "--strict-mcp-config", "--no-session-persistence",
            "--output-format", "json", "--permission-mode", "acceptEdits",
            "--permission-prompts", "none", "--tools", ",".join(tools) if tools else "",
            "--model", config.CLAUDE_MODEL]
    started = time.monotonic()
    async with _running:
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
    # total_cost_usd in the answer is an API-price estimate; Claude runs on Pavel's
    # subscription, so it is not a real cost and is not stored.
    return data.get("result", ""), {"seconds": seconds}


def _json_answer(text):
    start, end = text.find("{"), text.rfind("}")
    return json.loads(text[start:end + 1])


# --- picture description ----------------------------------------------------------------------


def describe_later(rel_path):
    """Start describing a picture in the background (the page polls the task)."""
    tasks.set_analysis(rel_path, {"status": "pending"})
    job = asyncio.get_running_loop().create_task(describe(rel_path))
    _background.add(job)
    job.add_done_callback(_background.discard)


async def describe(rel_path):
    image = tasks.resolve(rel_path)
    try:
        result, info = await run_claude(_render("describe.md", file=image.name), image.parent,
                                        ["Read"], timeout=240)
        data = _json_answer(result)

        def tag_list(value):
            if isinstance(value, list):
                value = ", ".join(map(str, value))
            return ", ".join(dict.fromkeys(t.strip() for t in str(value or "").split(",") if t.strip()))

        tasks.set_analysis(rel_path, {
            "status": "done", "description": str(data.get("description", "")).strip(),
            # tags = what is in the picture (go to the prompt with «＋ все теги»);
            # medium = how it is made (sketch, monochrome…): describes the input, not the wish.
            "tags": tag_list(data.get("tags")), "medium": tag_list(data.get("medium")), **info})
    except Exception as e:  # never break the page: show the error next to the picture
        log.warning("describe %s failed: %s", rel_path, e)
        try:
            tasks.set_analysis(rel_path, {"status": "error", "message": str(e)[:300]})
        except OSError:  # the task was deleted meanwhile
            pass


# --- prompt helper ----------------------------------------------------------------------------

FORMATS = {
    "tags": (
        "Теги Danbooru по-английски через запятую: нижний регистр, пробелы вместо "
        "подчёркиваний. Каждую мысль из текста — тегом; что тегом не передать — короткой "
        "английской фразой через запятую."
    ),
    "flux": (
        "Обычные английские предложения, коротко и прямо, в том порядке, в каком мысли идут "
        "в тексте."
    ),
}
REFERENCES = (
    "К генерации прикреплено картинок: {n}. Модель видит их как <ref_image_0>, "
    "<ref_image_1> и так далее, в порядке прикрепления. Если текст говорит о прикреплённой "
    "картинке («эта заколка», «на фото», «мой набросок», «первая картинка»), напиши вместо "
    "этого ссылку <ref_image_N>. Если не говорит — не упоминай картинки."
)


async def prompt_help(text, model, images=0):
    """Mila's text → prompt in the model's format, nothing added. Returns {prompt, ...info}."""
    family = model["family"]
    fmt = FORMATS["flux" if family == "flux" else "tags"]
    if family == "flux" and images and model.get("references"):
        fmt += "\n\n" + REFERENCES.format(n=images)
    prompt = _render("prompt-helper.md", model_title=model.get("title", ""), format=fmt,
                     text=text.strip())
    workdir = config.CACHE / "claude"
    workdir.mkdir(parents=True, exist_ok=True)
    result, info = await run_claude(prompt, workdir, [], timeout=120)
    answer = result.strip().strip("`").strip()
    if answer.lower().startswith(("prompt:", "промпт:")):
        answer = answer.split(":", 1)[1].strip()
    return {"prompt": answer.strip('"').strip(), **info}
