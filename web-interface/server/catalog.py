"""Models, LoRA and presets: msi/catalog/models.json, msi/catalog/loras.json, presets.json.

Files are re-read on every call, so edits show up without a restart.
"""

import json
from pathlib import PurePosixPath

from . import config


def _read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def models():
    return _read(config.MODELS)["models"]


def presets():
    return _read(config.PRESETS)


def find_preset(preset_id):
    """A kind (no picture) or an action (with pictures) by id; None for "my own prompt"."""
    if not preset_id:
        return None
    p = presets()
    for item in p["kinds"] + p["actions"]:
        if item["id"] == preset_id:
            return item
    raise ValueError("Неизвестная заготовка")


def lora_entries(files):
    """LoRA files that ComfyUI sees, with titles and trigger words from loras.json."""
    described = {e["file"]: e for e in _read(config.LORAS).get("loras", [])}
    result = []
    for name in files:
        key = name.replace("\\", "/")
        entry = described.get(key) or described.get(name) or {}
        result.append({
            "file": name,
            "title": entry.get("title") or PurePosixPath(key).stem,
            "family": entry.get("family"),
            "trigger": entry.get("trigger", ""),
            "strength": entry.get("strength", 0.8),
            "range": entry.get("range", [0, 1.5]),
        })
    return result


def public(lora_files, samplers, schedulers):
    """What the page needs to build the form."""
    p = presets()
    return {
        "models": [
            {
                "key": key,
                "title": m.get("title", key),
                "family": m["family"],
                "tags": m["family"] != "flux",
                "negative_works": m.get("negative_works", True),
                "references": m.get("references", False),
                "params": m["params"],
                "edit_params": m.get("edit_params"),
                "prefix": m.get("prefix", ""),
                "negative": m.get("negative", ""),
            }
            for key, m in models().items()
        ],
        "sizes": p["sizes"],
        "white_bg": p["white_bg"],
        "kinds": p["kinds"],
        "actions": p["actions"],
        "loras": lora_entries(lora_files),
        "samplers": samplers,
        "schedulers": schedulers,
        "help": _read(config.HELP) if config.HELP.exists() else {},
    }


def smart_join(parts):
    """Join prompt pieces: after a sentence a space, after a tag a comma."""
    out = ""
    for part in parts:
        part = (part or "").strip().strip(",").strip()
        if not part:
            continue
        if not out:
            out = part
        elif out.endswith((".", "!", "?")):
            out += " " + part
        else:
            out += ", " + part
    return out


def assemble(model, preset, white_bg, prompt, negative, loras=(), quality=True):
    """Final positive and negative prompt.

    Tag models: quality tags, preset tags, white background, the prompt, LoRA triggers.
    FLUX: preset sentence, white background, the prompt, LoRA triggers.
    A tag that ends up in the positive is dropped from the negative (e.g. "sketch" in
    WAI's negative when the preset asks for a sketch).
    """
    tags = model["family"] != "flux"
    key = "tags" if tags else "text"
    parts = []
    if tags and quality:
        parts.append(model.get("prefix", ""))
    if preset:
        parts.append(preset.get(key, ""))
        if white_bg and preset.get("white_bg"):
            parts.append(presets()["white_bg"][key])
    parts.append(prompt)
    parts += [l.get("trigger", "") for l in loras]
    positive = smart_join(parts)

    if not model.get("negative_works", True):
        return positive, ""
    neg = smart_join([model.get("negative", "") if quality else "",
                      (preset or {}).get("negative", ""), negative])
    in_positive = {t.strip().lower() for t in positive.split(",")}
    neg = ", ".join(t.strip() for t in neg.split(",")
                    if t.strip() and t.strip().lower() not in in_positive)
    return positive, neg
