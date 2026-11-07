"""Browsing content/: folders, files, previews."""

import hashlib
from datetime import datetime
from pathlib import Path

from PIL import Image, ImageOps

from . import config

IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}
TOP = ["references", "prototype", "generated", "benchmarks"]


def resolve(content_path):
    """content/-relative path → absolute, refusing anything outside content/."""
    root = config.CONTENT.resolve()
    path = (root / (content_path or "")).resolve()
    if path != root and root not in path.parents:
        raise PermissionError(content_path)
    return path


def listdir(content_path=""):
    path = resolve(content_path)
    if not path.is_dir():
        raise FileNotFoundError(content_path)
    root = config.CONTENT.resolve()
    dirs, files = [], []
    for item in path.iterdir():
        if item.name.startswith("."):
            continue
        entry = {"name": item.name, "path": item.relative_to(root).as_posix()}
        if item.is_dir():
            if not content_path and item.name not in TOP:
                continue
            count = sum(1 for f in item.iterdir() if f.suffix.lower() in IMAGE_EXT)
            dirs.append({**entry, "images": count})
        else:
            stat = item.stat()
            files.append({**entry, "image": item.suffix.lower() in IMAGE_EXT,
                          "size": stat.st_size,
                          "time": datetime.fromtimestamp(stat.st_mtime).isoformat(timespec="seconds")})
    order = {name: i for i, name in enumerate(TOP)}
    dirs.sort(key=lambda d: (order.get(d["name"], 99), d["name"]))
    files.sort(key=lambda f: f["name"])
    return {"path": Path(content_path).as_posix() if content_path else "", "dirs": dirs, "files": files,
            "can_upload": (content_path or "").split("/")[0] == "references"}


def thumb(content_path, size=480):
    """WebP preview in web-interface/.cache/, rebuilt when the original changes."""
    src = resolve(content_path)
    stat = src.stat()
    key = hashlib.sha1(f"{content_path}|{stat.st_mtime_ns}|{size}".encode()).hexdigest()
    target = config.CACHE / "thumbs" / f"{key}.webp"
    if not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        with Image.open(src) as im:
            im = ImageOps.exif_transpose(im)
            im.thumbnail((size, size * 2))
            if im.mode not in ("RGB", "RGBA"):
                im = im.convert("RGBA" if "A" in im.getbands() else "RGB")
            im.save(target, "WEBP", quality=80)
    return target
