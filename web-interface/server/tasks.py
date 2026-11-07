"""Tasks: one folder per task in content/prototype/, layout in .claude/develop/mac/content.md.

    <date>-<slug>/task.json, inputs/, outputs/, log.jsonl, notes.md
"""

import json
import re
import shutil
import threading
from datetime import date, datetime
from pathlib import Path

from . import config

TASK_ID = re.compile(r"^\d{4}-\d{2}-\d{2}-[a-z0-9-]+$")
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}
KINDS = {"character": "Персонаж", "background": "Фон", "other": "Другое"}

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


def safe_filename(name):
    stem, ext = Path(name).stem, Path(name).suffix.lower()
    ext = ext if re.fullmatch(r"\.[a-z0-9]{1,5}", ext) else ""
    return (slugify(stem, 60) or "file") + ext


def unique(folder, name):
    path = folder / name
    n = 2
    while path.exists():
        path = folder / f"{Path(name).stem}-{n}{Path(name).suffix}"
        n += 1
    return path


def rel(path):
    """Path relative to content/, with forward slashes: what /files/ and the page use."""
    return Path(path).resolve().relative_to(config.CONTENT.resolve()).as_posix()


def _read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def _write_json(path, data):
    Path(path).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def folder(task_id):
    if not TASK_ID.match(task_id or ""):
        raise KeyError(task_id)
    path = config.PROTOTYPE / task_id
    if not (path / "task.json").exists():
        raise KeyError(task_id)
    return path


def log(task_id, kind, who, **data):
    entry = {"time": now(), "who": who, "kind": kind, **data}
    with _lock:
        with open(folder(task_id) / "log.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    return entry


def read_log(task_id):
    path = folder(task_id) / "log.jsonl"
    if not path.exists():
        return []
    entries = []
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            entries.append(json.loads(line))
        except ValueError:
            pass
    return entries


def create(title, kind, who):
    title = (title or "").strip() or "Без названия"
    kind = kind if kind in KINDS else "other"
    config.PROTOTYPE.mkdir(parents=True, exist_ok=True)
    base = f"{date.today():%Y-%m-%d}-{slugify(title) or 'task'}"
    path = config.PROTOTYPE / base
    n = 2
    while path.exists():
        path = config.PROTOTYPE / f"{base}-{n}"
        n += 1
    (path / "inputs").mkdir(parents=True)
    (path / "outputs").mkdir()
    task = {"id": path.name, "title": title, "kind": kind, "created": now(), "who": who,
            "status": "active", "stars": [], "finals": []}
    _write_json(path / "task.json", task)
    log(path.name, "created", who, title=title, task_kind=kind)
    return task


def _files(path, sub):
    items = []
    for f in sorted((path / sub).glob("*"), key=lambda p: p.stat().st_mtime):
        if f.suffix == ".json" or f.name.startswith("."):
            continue
        meta = _read_json(f.with_suffix(f.suffix + ".json")) or _read_json(f.with_suffix(".json")) or {}
        meta.pop("payload", None)
        items.append({"name": f.name, "path": rel(f), "image": f.suffix.lower() in IMAGE_EXT,
                      "size": f.stat().st_size, "meta": meta})
    return items


def summary(path):
    task = _read_json(path / "task.json", {})
    outputs = [f for f in (path / "outputs").glob("*.png")]
    cover = max(outputs, key=lambda p: p.stat().st_mtime) if outputs else None
    log_file = path / "log.jsonl"
    updated = datetime.fromtimestamp(
        (log_file if log_file.exists() else path / "task.json").stat().st_mtime)
    return {**task, "kind_title": KINDS.get(task.get("kind"), ""),
            "updated": updated.isoformat(timespec="seconds"),
            "cover": rel(cover) if cover else None, "outputs": len(outputs),
            "inputs": len([f for f in (path / "inputs").glob("*") if f.suffix != ".json"])}


def all_tasks():
    if not config.PROTOTYPE.exists():
        return []
    items = [summary(p) for p in config.PROTOTYPE.iterdir() if (p / "task.json").exists()]
    return sorted(items, key=lambda t: t["updated"], reverse=True)


def get(task_id):
    path = folder(task_id)
    notes = path / "notes.md"
    notes_list = [e for e in read_log(task_id) if e["kind"] == "note"]
    return {**summary(path), "inputs_list": _files(path, "inputs"),
            "outputs_list": _files(path, "outputs"),
            "notes": notes.read_text(encoding="utf-8") if notes.exists() else "",
            "notes_updated": datetime.fromtimestamp(notes.stat().st_mtime).isoformat(
                timespec="seconds") if notes.exists() else None,
            "user_notes": notes_list}


def add_input(task_id, filename, data, who, note="", source=None):
    target = unique(folder(task_id) / "inputs", safe_filename(filename))
    target.write_bytes(data)
    meta = {"who": who, "time": now(), "original_name": filename}
    if note:
        meta["note"] = note
    if source:
        meta["from"] = source
    _write_json(target.with_suffix(target.suffix + ".json"), meta)
    log(task_id, "upload", who, file=rel(target), original_name=filename,
        **({"note": note} if note else {}), **({"from": source} if source else {}))
    return rel(target)


def attach(task_id, content_path, who):
    """Copy a file from content/ (library, another task) into this task's inputs."""
    src = config.CONTENT / content_path
    return add_input(task_id, src.name, src.read_bytes(), who, source=content_path)


def add_note(task_id, who, text):
    return log(task_id, "note", who, text=text.strip())


def mark(task_id, who, file, kind, on):
    path = folder(task_id)
    with _lock:
        task = _read_json(path / "task.json")
        key = {"star": "stars", "final": "finals"}[kind]
        items = set(task.get(key, []))
        (items.add if on else items.discard)(file)
        task[key] = sorted(items)
        if kind == "final" and task[key]:
            task["status"] = "final"
        _write_json(path / "task.json", task)
    log(task_id, kind, who, file=file, on=on)
    return task


def save_output(task_id, name, png, record):
    target = unique(folder(task_id) / "outputs", name)
    target.write_bytes(png)
    _write_json(target.with_suffix(".json"), record)
    return target


def output_path_for(content_path, suffix):
    """Sibling file for a derived image, e.g. <name>_nobg.png next to the original."""
    src = config.CONTENT / content_path
    return unique(src.parent, f"{src.stem}{suffix}.png")


def copy_record(src_png, dst_png, extra):
    meta = _read_json(Path(src_png).with_suffix(".json"), {}) or {}
    _write_json(Path(dst_png).with_suffix(".json"), {**meta, **extra})


def remove_tree(path):
    shutil.rmtree(path)
