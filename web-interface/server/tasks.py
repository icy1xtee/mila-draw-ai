"""Tasks: one folder per task in content/tasks/<YYYY-MM-DD>-<slug>/.

    task.json            title, created
    <picture>.png|jpg    pictures Mila attached and pictures the models drew, side by side
    <picture>.json       what the picture is: {"type": "upload" | "generated", "time", ...};
                         Claude's description goes into "analysis"

The task's history is these .json files sorted by time; generated pictures of one submission
share "job".
"""

import io
import json
import re
import shutil
import threading
from datetime import date, datetime
from pathlib import Path

from PIL import Image, ImageOps

from . import config

TASK_ID = re.compile(r"^\d{4}-\d{2}-\d{2}-[a-z0-9-]+$")
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp"}
TASK_FILE = "task.json"

_TRANSLIT = dict(zip(
    "абвгдеёжзийклмнопрстуфхцчшщъыьэюя",
    ["a", "b", "v", "g", "d", "e", "e", "zh", "z", "i", "y", "k", "l", "m", "n", "o", "p", "r",
     "s", "t", "u", "f", "h", "ts", "ch", "sh", "sch", "", "y", "", "e", "yu", "ya"]))

_lock = threading.Lock()


def now():
    return datetime.now().isoformat(timespec="seconds")


def slugify(text, limit=40):
    text = "".join(_TRANSLIT.get(ch, ch) for ch in text.lower())
    text = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    return text[:limit].strip("-")


def unique(folder, name):
    path = folder / name
    n = 2
    while path.exists() or path.with_suffix(".json").exists():
        path = folder / f"{Path(name).stem}-{n}{Path(name).suffix}"
        n += 1
    return path


def rel(path):
    """Path relative to content/tasks/ with forward slashes: what /files/ and the page use."""
    return Path(path).resolve().relative_to(config.TASKS.resolve()).as_posix()


def resolve(rel_path):
    """content/tasks/<rel_path>, refusing anything outside content/tasks/."""
    root = config.TASKS.resolve()
    target = (root / rel_path).resolve()
    if root != target and root not in target.parents:
        raise PermissionError(rel_path)
    return target


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def write_json(path, data):
    tmp = Path(path).with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def folder(task_id):
    if not TASK_ID.match(task_id or ""):
        raise KeyError(task_id)
    path = config.TASKS / task_id
    if not (path / TASK_FILE).exists():
        raise KeyError(task_id)
    return path


# --- tasks ------------------------------------------------------------------------------------


def create(title):
    title = (title or "").strip()[:120]
    config.TASKS.mkdir(parents=True, exist_ok=True)
    if not title:
        title = _next_unknown()
    base = f"{date.today().isoformat()}-{slugify(title) or 'task'}"
    task_id, n = base, 2
    with _lock:
        while (config.TASKS / task_id).exists():
            task_id, n = f"{base}-{n}", n + 1
        path = config.TASKS / task_id
        path.mkdir()
        write_json(path / TASK_FILE, {"id": task_id, "title": title, "created": now()})
    return get(task_id)


def _next_unknown():
    """Name for a task created without one: unknown_1, unknown_2, … (max existing + 1)."""
    numbers = [0]
    for task_file in config.TASKS.glob(f"*/{TASK_FILE}"):
        m = re.fullmatch(r"unknown_(\d+)", (read_json(task_file) or {}).get("title", ""))
        if m:
            numbers.append(int(m.group(1)))
    return f"unknown_{max(numbers) + 1}"


def items(task_id):
    """Every picture of the task with its .json, oldest first."""
    path = folder(task_id)
    result = []
    for meta_path in path.glob("*.json"):
        if meta_path.name == TASK_FILE:
            continue
        meta = read_json(meta_path)
        if not meta or meta.get("type") not in ("upload", "generated"):
            continue
        image = next((meta_path.with_suffix(ext) for ext in IMAGE_EXT
                      if meta_path.with_suffix(ext).exists()), None)
        if not image:
            continue
        meta.pop("payload", None)
        result.append({**meta, "file": rel(image)})
    result.sort(key=lambda m: (m.get("time", ""), m["file"]))
    return result


def get(task_id):
    task = read_json(folder(task_id) / TASK_FILE)
    return {**task, "items": items(task_id)}


def summary(task_id):
    task = read_json(folder(task_id) / TASK_FILE)
    all_items = items(task_id)
    generated = [i for i in all_items if i["type"] == "generated"]
    last = (generated or all_items or [None])[-1]
    return {**task, "count": len(generated), "cover": last["file"] if last else None,
            "updated": all_items[-1]["time"] if all_items else task.get("created")}


def all_tasks():
    if not config.TASKS.exists():
        return []
    result = []
    for path in config.TASKS.iterdir():
        if path.is_dir() and (path / TASK_FILE).exists():
            try:
                result.append(summary(path.name))
            except (KeyError, OSError, ValueError):
                pass
    result.sort(key=lambda t: t.get("updated") or "", reverse=True)
    return result


def delete(task_id):
    """Remove the task folder with every picture in it, and its previews. Only a person does
    this, from the page; there is no undo."""
    path = folder(task_id)
    with _lock:
        shutil.rmtree(path)
    shutil.rmtree(config.CACHE / "thumbs" / task_id, ignore_errors=True)


def delete_picture(rel_path):
    """Remove one picture of a task with its .json and previews. Only a person does this, from
    the page; there is no undo."""
    image = resolve(rel_path)
    if (image.suffix.lower() not in IMAGE_EXT or not image.is_file()
            or image.parent.parent != config.TASKS.resolve()
            or not (image.parent / TASK_FILE).exists()):
        raise FileNotFoundError(rel_path)
    with _lock:
        image.unlink()
        image.with_suffix(".json").unlink(missing_ok=True)
    thumbs = config.CACHE / "thumbs" / image.parent.name
    for preview in thumbs.glob(f"{image.name}.*.webp"):
        preview.unlink(missing_ok=True)


def rename(task_id, title):
    path = folder(task_id) / TASK_FILE
    task = read_json(path)
    task["title"] = (title or "").strip()[:120] or task["title"]
    write_json(path, task)
    return task


# --- pictures ---------------------------------------------------------------------------------


def save_upload(task_id, filename, data):
    """Store a picture Mila attached: upright (EXIF), transparency on white, at most
    MAX_SIDE px. Photos stay JPEG, everything else becomes PNG."""
    try:
        im = Image.open(io.BytesIO(data))
        im.load()
    except Exception:
        raise ValueError(f"{filename}: не получается открыть как картинку (нужен PNG, JPG или WebP)")
    is_photo = (im.format or "").upper() == "JPEG"
    im = ImageOps.exif_transpose(im)
    if im.mode in ("RGBA", "LA", "PA") or (im.mode == "P" and "transparency" in im.info):
        im = im.convert("RGBA")
        flat = Image.new("RGB", im.size, "white")
        flat.paste(im, mask=im.getchannel("A"))
        im = flat
    else:
        im = im.convert("RGB")
    if max(im.size) > config.MAX_SIDE:
        im.thumbnail((config.MAX_SIDE, config.MAX_SIDE), Image.LANCZOS)

    stem = slugify(Path(filename).stem, 50) or "picture"
    target = unique(folder(task_id), stem + (".jpg" if is_photo else ".png"))
    if is_photo:
        im.save(target, "JPEG", quality=95)
    else:
        im.save(target, "PNG")
    meta = {"type": "upload", "time": now(), "original": filename, "size": list(im.size),
            "analysis": {"status": "pending"}}
    write_json(target.with_suffix(".json"), meta)
    return {**meta, "file": rel(target)}


def save_generated(task_id, name, png, record):
    target = unique(folder(task_id), name)
    target.write_bytes(png)
    write_json(target.with_suffix(".json"), {"type": "generated", "time": now(), **record})
    return rel(target)


def meta_path(rel_path):
    image = resolve(rel_path)
    if image.suffix.lower() not in IMAGE_EXT or not image.is_file():
        raise FileNotFoundError(rel_path)
    return image.with_suffix(".json")


def get_meta(rel_path):
    return read_json(meta_path(rel_path)) or {}


def set_analysis(rel_path, analysis):
    with _lock:
        path = meta_path(rel_path)
        meta = read_json(path) or {}
        meta["analysis"] = analysis
        write_json(path, meta)


def pending_analyses():
    """Pictures whose description was not finished (e.g. the server stopped meanwhile)."""
    if not config.TASKS.exists():
        return []
    result = []
    for meta_file in config.TASKS.glob("*/*.json"):
        meta = read_json(meta_file) or {}
        if (meta.get("analysis") or {}).get("status") == "pending":
            image = next((meta_file.with_suffix(e) for e in IMAGE_EXT
                          if meta_file.with_suffix(e).exists()), None)
            if image:
                result.append(rel(image))
    return result


def picture_size(rel_path):
    with Image.open(resolve(rel_path)) as im:
        return im.size


def thumb(rel_path, size):
    """WebP preview in .cache/thumbs/, rebuilt when the picture changes."""
    src = resolve(rel_path)
    if not src.is_file() or src.suffix.lower() not in IMAGE_EXT:
        raise FileNotFoundError(rel_path)
    target = config.CACHE / "thumbs" / f"{rel_path}.{size}.webp"
    if not target.exists() or target.stat().st_mtime < src.stat().st_mtime:
        target.parent.mkdir(parents=True, exist_ok=True)
        with Image.open(src) as im:
            im = ImageOps.exif_transpose(im)
            im.thumbnail((size, size), Image.LANCZOS)
            if im.mode not in ("RGB", "RGBA"):
                im = im.convert("RGBA" if "A" in im.getbands() else "RGB")
            im.save(target, "WEBP", quality=82)
    return target
