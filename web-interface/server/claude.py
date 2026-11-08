"""Claude in Mila Draw AI: describes attached pictures and turns Mila's words into a prompt.

Runs Claude Code headless (`claude -p`, prompt on stdin) in --restricted mode: no Bash, no web,
file tools confined to the working directory.

- describe: tool Read only, working directory = the task folder; answer {description, tags}
  is stored in the picture's .json ("analysis").
- assistant: no tools; Mila's wish → prompt, negative, settings to change and a tip
  (claude/assistant.md). The prompt takes its content only from the wish (and, for img2img,
  from the picture's description).
- brainstorm: tool Read, working directory = the task folder; a photo → several different
  character ideas, each as tags (tag models) and as sentences (FLUX) (claude/brainstorm.md).
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




# --- assistant: wish → prompt, negative, settings, tip -----------------------------------------

FORMATS = {
    "tags": (
        "Теги Danbooru по-английски через запятую: нижний регистр, пробелы вместо "
        "подчёркиваний. Каждую мысль — тегом; что тегом не передать — короткой английской "
        "фразой через запятую."
    ),
    "flux": (
        "Обычные английские предложения, коротко и прямо, в том порядке, в каком мысли идут "
        "в пожелании."
    ),
}
MODES = {
    "text": "без картинки — модель рисует с нуля по промпту.",
    "img2img": ("img2img — модель перерисовывает первую прикреплённую картинку; насколько "
                "сильно — решает «сила изменений» (denoise)."),
    "edit": ("с референсами — модель видит все прикреплённые картинки и рисует новую по "
             "инструкции."),
}
MODE_RULES = {
    "text": "",
    "img2img": (
        "- Модель перерисовывает картинку и не понимает команд: промпт описывает весь результат "
        "целиком. Возьми теги содержания из описания картинки (теги техники исходника — sketch, "
        "monochrome, lineart и т. п. — только если пожелание просит их оставить) и добавь "
        "изменения из пожелания как описание результата: «red hair», а не «make the hair red»."
    ),
    "edit": (
        "- Пиши как инструкцию: что изменить и что оставить как есть.\n"
        "- Модель видит картинки как <ref_image_0>, <ref_image_1> и так далее, в порядке "
        "прикрепления. Если пожелание говорит о картинке («эта заколка», «на фото», «мой "
        "набросок», «вторая картинка»), пиши вместо этого <ref_image_N>."
    ),
}
NEGATIVE_RULES = {
    True: ("Только то, чего художница просит избежать («без шляпы», «не надо фона»), — тегами "
           "по-английски. Если ничего такого нет — пустая строка. Стандартный негатив модели "
           "добавляется сам, не повторяй его."),
    False: ("Эта модель негатив не понимает: \"negative\" — пустая строка. Если художница просит "
            "чего-то избежать — опиши в промпте, что должно быть вместо."),
}
SETTING_LIMITS = {"steps": (int, 1, 60), "cfg": (float, 0, 15), "denoise": (float, 0.05, 1.0),
                  "count": (int, 1, 4)}


def _help():
    try:
        return json.loads(config.HELP.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _model_notes(key, model, mode):
    """What Claude needs to know about the model to advise on settings."""
    params = (mode == "edit" and model.get("edit_params")) or model["params"]
    lines = [f"Стандартные настройки: шагов {params['steps']}, CFG {params['cfg']}, "
             f"сэмплер {params['sampler']}, планировщик {params['scheduler']}."]
    help_ = _help()
    family = help_.get("families", {}).get(model["family"], {})
    section = family.get("text" if mode == "text" else "picture", {})
    if section.get("how"):
        lines.append(section["how"])
    for name in ("steps", "cfg", "denoise", "sampler"):
        note = help_.get("settings", {}).get(name, {}).get("models", {}).get(key)
        if note and (name != "denoise" or mode == "img2img"):
            lines.append(f"{name}: {note}")
    lines += help_.get("models", {}).get(key, [])
    return " ".join(lines)


def _clean_settings(raw, model, mode):
    result = {}
    if not isinstance(raw, dict):
        return result
    for name, (kind, low, high) in SETTING_LIMITS.items():
        if name not in raw or raw[name] in (None, ""):
            continue
        if name == "denoise" and mode != "img2img":
            continue
        params = (mode == "edit" and model.get("edit_params")) or model["params"]
        if name == "cfg" and params.get("cfg") == 1:  # distilled model: CFG stays 1
            continue
        try:
            value = kind(raw[name])
        except (TypeError, ValueError):
            continue
        if low <= value <= high:
            result[name] = round(value, 2) if kind is float else value
    return result


async def assistant(wish, key, model, mode, pictures, preset, settings):
    """Mila's own words → {prompt, negative, settings, tip}.

    pictures: [{description, tags, medium}] of the attached pictures (Claude's descriptions);
    preset: the chosen preset or None; settings: what is set now ({steps, cfg, denoise, count}).
    """
    tag_model = model["family"] != "flux"
    fmt = FORMATS["tags" if tag_model else "flux"]
    if pictures:
        lines = []
        for n, p in enumerate(pictures):
            lines.append(f"{n + 1}) {p.get('description') or 'описания нет'}"
                         + (f" Теги: {p['tags']}." if p.get("tags") else "")
                         + (f" Техника: {p['medium']}." if p.get("medium") else ""))
        pictures_text = "\n" + "\n".join(lines)
    else:
        pictures_text = "нет"
    if preset:
        adds = preset.get("tags" if tag_model else "text") or ""
        preset_text = f"«{preset['title']}» — {preset.get('description', '')}" \
                      + (f" Сама добавляет к промпту: {adds}" if adds else "")
    else:
        preset_text = "нет (только промпт художницы)"
    negative_works = bool(model.get("negative_works", True))
    prompt = _render(
        "assistant.md", model_title=model.get("title", key), model_notes=_model_notes(key, model, mode),
        mode=MODES[mode], preset=preset_text, pictures=pictures_text,
        settings=json.dumps(settings, ensure_ascii=False), format=fmt,
        mode_rule=MODE_RULES[mode], negative_rule=NEGATIVE_RULES[negative_works], wish=wish.strip())
    workdir = config.CACHE / "claude"
    workdir.mkdir(parents=True, exist_ok=True)
    result, info = await run_claude(prompt, workdir, [], timeout=120)
    try:
        data = _json_answer(result)
    except ValueError:
        raise RuntimeError("Claude ответил не в том формате, попробуйте ещё раз")
    return {
        "prompt": str(data.get("prompt") or "").strip(),
        "negative": str(data.get("negative") or "").strip() if negative_works else "",
        "settings": _clean_settings(data.get("settings"), model, mode),
        "tip": str(data.get("tip") or "").strip(),
        **info,
    }


# --- brainstorm: a photo → different character ideas -------------------------------------------


async def brainstorm(images, wish, count):
    """Pictures of one task + Mila's wish → {ideas: [{title, description, tags, text}]}."""
    paths = [tasks.resolve(i) for i in images]
    folder = paths[0].parent
    if any(p.parent != folder for p in paths):
        raise ValueError("Картинки должны быть из одной задачи")
    files = ", ".join(p.name for p in paths)
    result, info = await run_claude(
        _render("brainstorm.md", files=files, count=count, wish=(wish or "").strip() or "—"),
        folder, ["Read"], timeout=300)
    try:
        data = _json_answer(result)
    except ValueError:
        raise RuntimeError("Claude ответил не в том формате, попробуйте ещё раз")
    ideas = []
    for idea in data.get("ideas") or []:
        if not isinstance(idea, dict):
            continue
        clean = {k: str(idea.get(k) or "").strip() for k in ("title", "description", "tags", "text")}
        if clean["tags"] and clean["text"]:
            ideas.append(clean)
    if not ideas:
        raise RuntimeError("Claude не вернул идей, попробуйте ещё раз")
    return {"ideas": ideas[:count], **info}
