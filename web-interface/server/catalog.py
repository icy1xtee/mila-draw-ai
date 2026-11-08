"""Models, LoRA and presets: msi/catalog/models.json, msi/catalog/loras.json, presets.json.

Files are re-read on every call, so edits show up without a restart.
"""

import json
import re
from pathlib import PurePosixPath

from . import config


def _read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def models():
    return _read(config.MODELS)["models"]


TAG_FAMILIES = ("illustrious", "anima")


def is_tag_model(model):
    """Danbooru tags (Illustrious, Anima) or plain sentences (FLUX, Krea 2)."""
    return model.get("prompt", "tags" if model["family"] in TAG_FAMILIES else "text") == "tags"


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


FAMILIES = ("illustrious", "anima", "krea2", "flux")


def lora_entries(files):
    """LoRA files that ComfyUI sees, with everything loras.json says about them.

    A file without an entry still shows: family from its folder (loras/<family>/...), title
    from the file name, "no description".
    """
    described = {e["file"]: e for e in _read(config.LORAS).get("loras", [])}
    result = []
    for name in files:
        key = name.replace("\\", "/")
        entry = described.get(key) or described.get(name) or {}
        folder = key.split("/")[0] if "/" in key else None
        result.append({
            **entry,
            "file": name,
            "title": entry.get("title") or PurePosixPath(key).stem,
            "family": entry.get("family") or (folder if folder in FAMILIES else None),
            "kind": entry.get("kind", "other"),
            "trigger": entry.get("trigger", ""),
            "variants": entry.get("variants", []),
            "words": entry.get("words", []),
            "strength": entry.get("strength", 0.8),
            "range": entry.get("range", [0, 1.5]),
            "described": bool(entry),
        })
    return result


def lora_trigger(entry, variant=None):
    """Words a LoRA adds to the prompt: its trigger plus the chosen variant (if it is one of its)."""
    words = [entry.get("trigger", "")]
    if variant and any(v["word"] == variant for v in entry.get("variants", [])):
        words.append(variant)
    elif entry.get("variants"):
        words.append(entry["variants"][0]["word"])
    return ", ".join(w for w in words if w)


def public(lora_files, samplers, schedulers, upscalers=()):
    """What the page needs to build the form."""
    p = presets()
    return {
        "models": [
            {
                "key": key,
                "title": m.get("title", key),
                "family": m["family"],
                "tags": is_tag_model(m),
                "negative_works": m.get("negative_works", True),
                "references": m.get("references", False),
                "params": m["params"],
                "edit_params": m.get("edit_params"),
                "prefix": m.get("prefix", ""),
                # file names: the page recognises "Model: <name>" in pasted A1111 parameters
                "files": list(m.get("files", {}).values()),
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
        "upscalers": list(upscalers),
        "help": _read(config.HELP) if config.HELP.exists() else {},
    }


# A1111/Forge: [word] = weaker by 1.1 per bracket. ComfyUI has no such syntax (the brackets
# would go to the model as characters), so [x] → (x:0.91), [[x]] → (x:0.83). Prompt editing
# [a:b:step] and alternation [a|b] are left as they are: ComfyUI has no equivalent.
_A1111_WEAKER = re.compile(r"(?<!\\)(\[+)([^\[\]:|]+?)(\]+)")


def a1111_weights(text):
    def weaker(m):
        n = min(len(m.group(1)), len(m.group(3)))
        return (m.group(1)[n:] + f"({m.group(2).strip()}:{round(1 / 1.1 ** n, 2):g})"
                + m.group(3)[n:])
    return _A1111_WEAKER.sub(weaker, text or "")


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
    tags = is_tag_model(model)
    key = "tags" if tags else "text"
    if tags:  # prompts copied from Civitai (A1111/Forge) use [x] for weaker words
        prompt, negative = a1111_weights(prompt), a1111_weights(negative)
    parts = []
    if tags and quality:
        parts.append(model.get("prefix", ""))
    if preset:
        parts.append(preset.get(key, ""))
        if white_bg and preset.get("white_bg"):
            parts.append(presets()["white_bg"][key])
    parts.append(prompt)
    # A trigger already in the prompt (pasted parameters carry them) is not added twice.
    have = (prompt or "").lower()
    parts += [", ".join(w for w in (l.get("trigger") or "").split(", ") if w.strip().lower() not in have)
              for l in loras]
    positive = smart_join(parts)

    if not model.get("negative_works", True):
        return positive, ""
    neg = smart_join([model.get("negative", "") if quality else "",
                      (preset or {}).get("negative", ""), negative])
    in_positive = {t.strip().lower() for t in positive.split(",")}
    neg = ", ".join(t.strip() for t in neg.split(",")
                    if t.strip() and t.strip().lower() not in in_positive)
    return positive, neg
