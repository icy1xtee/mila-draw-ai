"""LoRA catalog: find new files, look them up on Civitai, write the docs.

    python msi/scripts/lora_catalog.py scan   files in models/loras/ that msi/catalog/loras.json
                                              does not describe yet: SHA256 → Civitai → draft
                                              entries (printed; review, translate, paste)
    python msi/scripts/lora_catalog.py doc    msi/catalog/loras.md and README.md next to the
                                              files (C:/AI/ComfyUI/ComfyUI/models/loras/)

Run with ComfyUI's Python: C:\\AI\\ComfyUI\\python_embeded\\python.exe -I msi\\scripts\\lora_catalog.py doc
Only the standard library; the Civitai API needs no key for public models.
"""

import hashlib
import html
import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CATALOG = REPO / "msi" / "catalog" / "loras.json"
DOC = REPO / "msi" / "catalog" / "loras.md"
LORAS = Path(r"C:\AI\ComfyUI\ComfyUI\models\loras")
FAMILIES = {"illustrious": "WAI-Illustrious (Illustrious / NoobAI)", "anima": "Anima (Turbo и Aesthetic)",
            "krea2": "Krea 2 Turbo", "flux": "FLUX"}
KINDS = {"style": "Стиль", "detail": "Детали", "quality": "Качество", "clothes": "Одежда",
         "effect": "Эффект", "concept": "Приём", "service": "Служебная", "other": "Другое"}


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 24), b""):
            h.update(chunk)
    return h.hexdigest()


def civitai(url):
    req = urllib.request.Request(url, headers={"User-Agent": "mila-draw-ai lora_catalog"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return None if e.code == 404 else {"error": e.code}


def clean(text, limit=600):
    text = html.unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", text or ""))).strip()
    return text[:limit]


def scan():
    known = {e["file"] for e in json.loads(CATALOG.read_text(encoding="utf-8"))["loras"]}
    new = [p for p in sorted(LORAS.rglob("*.safetensors"))
           if p.relative_to(LORAS).as_posix() not in known]
    if not new:
        print("Все файлы в loras/ уже описаны.")
        return
    drafts = []
    for p in new:
        rel = p.relative_to(LORAS).as_posix()
        h = sha256(p)
        v = civitai(f"https://civitai.com/api/v1/model-versions/by-hash/{h}") or {}
        m = civitai(f"https://civitai.com/api/v1/models/{v['modelId']}") if v.get("modelId") else {}
        m = m or {}
        words = v.get("trainedWords") or []
        drafts.append({
            "file": rel,
            "family": rel.split("/")[0] if rel.split("/")[0] in FAMILIES else "?",
            "kind": "style",
            "title": m.get("name") or p.stem,
            "hint": "",
            "trigger": ", ".join(w.strip().strip(",") for w in words[:1]),
            "strength": 0.8,
            "range": [0, 1.2],
            "how": [],
            "avoid": [],
            "source": f"https://civitai.com/models/{v['modelId']}?modelVersionId={v['id']}" if v.get("id") else "",
            "version": v.get("name", ""),
            "author": (m.get("creator") or {}).get("username", ""),
            "license": {"images_commercial": "Image" in (m.get("allowCommercialUse") or [])},
            "_sha256": h,
            "_base": v.get("baseModel"),
            "_civitai_description": clean(m.get("description")),
            "_trained_words": words,
        })
        print(f"{rel}: {m.get('name') or 'нет на Civitai'} ({v.get('baseModel', '?')})", file=sys.stderr)
    print(json.dumps(drafts, ensure_ascii=False, indent=2))


def doc():
    data = json.loads(CATALOG.read_text(encoding="utf-8"))
    entries = data["loras"]
    on_disk = {p.relative_to(LORAS).as_posix() for p in LORAS.rglob("*.safetensors")} if LORAS.exists() else set()
    out = ["# LoRA — что у нас есть и как ими пользоваться", "",
           "Сгенерировано из [msi/catalog/loras.json](loras.json) скриптом "
           "`msi/scripts/lora_catalog.py doc` — правьте JSON, а не этот файл. Файлы лежат на MSI в "
           "`C:\\AI\\ComfyUI\\ComfyUI\\models\\loras\\<семейство>\\`, в git их нет.", "",
           "**Как это работает.** LoRA — небольшое дообучение поверх модели: стиль, детали, одежда, "
           "эффект. Работает только с моделью своего семейства (папка = семейство). В Mila Draw AI — "
           "блок «LoRA» под выбором модели: галочка, сила, слово-ключ добавляется в промпт само. "
           "Больше 2–3 LoRA сразу обычно портят картинку; две стилевые LoRA вместе дают кашу.", "",
           "**Лицензия.** «Продавать картинки — да» значит, что автор на Civitai разрешил продавать "
           "сгенерированные картинки. «нет» — только для себя и этюдов: для ассетов продаваемой игры "
           "не годится.", ""]
    for family, title in FAMILIES.items():
        group = [e for e in entries if e.get("family") == family]
        if not group:
            continue
        out += [f"## {title} — `loras/{family}/`", "",
                "| LoRA | Тип | Что делает | Слово-ключ | Сила | Продавать картинки |",
                "| --- | --- | --- | --- | --- | --- |"]
        for e in group:
            trig = e.get("trigger") or " / ".join(v["word"] for v in e.get("variants", [])) or "—"
            out.append(f"| [{e['title']}](#{anchor(e['title'])}) | {KINDS.get(e.get('kind'), '')} | "
                       f"{e.get('hint', '')} | `{trig}` | {fmt(e.get('strength'))} | "
                       f"{'да' if e.get('license', {}).get('images_commercial') else 'нет'} |")
        out.append("")
        for e in group:
            out += [f"### {e['title']}", ""]
            missing = " ⚠️ файла нет на диске" if on_disk and e["file"] not in on_disk else ""
            out.append(f"`{e['file']}` · {e.get('version', '')} · автор {e.get('author', '?')} · "
                       f"[Civitai]({e.get('source', '')}){missing}")
            out += ["", e.get("hint", ""), ""]
            if e.get("trigger"):
                out.append(f"- **Слово-ключ** (добавляется само): `{e['trigger']}`")
            if e.get("variants"):
                out.append("- **Варианты** (выбрать один):")
                out += [f"  - `{v['word']}` — {v['title']}" for v in e["variants"]]
            if e.get("words"):
                out.append("- **Слова по желанию** (нажимаются в промпт):")
                out += [f"  - `{w['text']}` — {w['title']}" for w in e["words"]]
            rng = e.get("range", [0, 1.5])
            out.append(f"- **Сила:** {fmt(e.get('strength'))} (ползунок {fmt(rng[0])}…{fmt(rng[1])})")
            if e.get("settings"):
                out.append("- **Настройки автора:** " + ", ".join(f"{k} {v}" for k, v in e["settings"].items()))
            out += [f"- **Как использовать:** {line}" for line in e.get("how", [])]
            out += [f"- **Как не надо:** {line}" for line in e.get("avoid", [])]
            lic = e.get("license", {})
            out.append(f"- **Лицензия:** продавать картинки — {'да' if lic.get('images_commercial') else 'нет'}"
                       + (f". {lic['note']}" if lic.get("note") else ""))
            out.append("")
    undescribed = sorted(on_disk - {e["file"] for e in entries})
    if undescribed:
        out += ["## Без описания", "", "Лежат в `loras/`, но в каталоге их нет — "
                "`lora_catalog.py scan` подготовит черновик:", ""]
        out += [f"- `{f}`" for f in undescribed] + [""]
    text = "\n".join(out)
    DOC.write_text(text, encoding="utf-8")
    print(f"{DOC} — {len(entries)} LoRA")
    if LORAS.exists():
        (LORAS / "README.md").write_text(
            text.replace("[msi/catalog/loras.json](loras.json)", "`msi/catalog/loras.json` (репо mila-draw-ai)"),
            encoding="utf-8")
        print(f"{LORAS / 'README.md'}")


def fmt(x):
    return str(x).replace(".", ",") if x is not None else "—"


def anchor(title):
    return re.sub(r"[^\w\- ]", "", title.lower()).strip().replace(" ", "-")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    {"scan": scan, "doc": doc}.get(sys.argv[1] if len(sys.argv) > 1 else "", lambda: print(__doc__))()
