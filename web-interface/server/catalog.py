"""Models, LoRA and pre-prompt blocks: msi/catalog/*.json and prompts/blocks.json.

Files are re-read on every call, so edits to the catalog show up without a restart.
"""

import json
from pathlib import PurePosixPath

from . import config


def _read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def models_file():
    return _read(config.CATALOG / "models.json")


def models():
    return models_file()["models"]


def sizes():
    return models_file()["sizes"]


def blocks_file():
    return _read(config.BLOCKS)


def described_loras():
    return {entry["file"]: entry for entry in _read(config.CATALOG / "loras.json").get("loras", [])}


def lora_entries(files):
    """Merge LoRA files that ComfyUI sees with their descriptions from loras.json."""
    described = described_loras()
    result = []
    for name in files:
        key = name.replace("\\", "/")
        entry = described.get(key) or described.get(name)
        if entry:
            result.append({"strength": 0.8, "range": [0, 1.5], **entry, "file": name,
                           "described": True})
        else:
            result.append({
                "file": name,
                "title": PurePosixPath(key).stem,
                "family": None,
                "hint": "Без описания: неизвестно, к какой модели подходит.",
                "strength": 0.8,
                "range": [0, 1.5],
                "described": False,
            })
    return result


def public(lora_files):
    """What the page needs to build the form."""
    blocks = blocks_file()
    return {
        "models": [
            {
                "key": key,
                "title": m.get("title", key),
                "name": m.get("name", key),
                "hint": m.get("hint", ""),
                "family": m["family"],
                "good_for": m.get("good_for", []),
                "negative_works": m.get("negative_works", True),
                "params": m["params"],
            }
            for key, m in models().items()
        ],
        "sizes": sizes(),
        "loras": lora_entries(lora_files),
        "groups": blocks.get("groups", {}),
        "blocks": [
            {k: b.get(k) for k in ("id", "title", "hint", "group", "default", "default_for")}
            | {"families": sorted(set(b.get("tags", {})) | set(b.get("text", {}))
                                  | set(b.get("negative", {})))
               if b.get("source") != "model" else ["*"]}
            for b in blocks["blocks"]
        ],
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


def position(block, family):
    pos = block.get("position", "before")
    return pos.get(family, "before") if isinstance(pos, dict) else pos


def assemble(model, block_ids, prompt, negative, loras=()):
    """Final positive and negative prompt: block tags, block phrases placed before, the user's
    prompt, block phrases placed after, LoRA trigger words at the end. Tags always go first:
    Anima wants tags, then sentences."""
    family = model["family"]
    tags, before, after, negatives = [], [], [], []
    for block in blocks_file()["blocks"]:
        if block["id"] not in block_ids:
            continue
        if block.get("source") == "model":
            tags.append(model.get("prefix", ""))
            negatives.append(model.get("negative", ""))
            continue
        tags.append(block.get("tags", {}).get(family, ""))
        text = block.get("text", {}).get(family, "")
        (after if position(block, family) == "after" else before).append(text)
        negatives.append(block.get("negative", {}).get(family, ""))
    described = described_loras()
    triggers = [described.get(l["file"], {}).get("trigger", "") for l in loras]
    positive = smart_join(tags + before + [prompt] + after + triggers)
    return positive, smart_join(negatives + [negative])
