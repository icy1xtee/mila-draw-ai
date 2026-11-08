"""Paths and settings. Settings come from web-interface/.env (see .env.example) or STUDIO_* env."""

import os
from pathlib import Path

WEB = Path(__file__).resolve().parent.parent
REPO = WEB.parent
CONTENT = REPO / "content"
TASKS = CONTENT / "tasks"
MODELS = REPO / "msi" / "catalog" / "models.json"
LORAS = REPO / "msi" / "catalog" / "loras.json"
PRESETS = WEB / "presets.json"
HELP = WEB / "help.json"
STATIC = WEB / "static"
CACHE = WEB / ".cache"
CLAUDE_DIR = WEB / "claude"


def _load_env(path):
    values = {}
    if path.exists():
        for line in path.read_text(encoding="utf-8-sig").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip().strip('"').strip("'")
    return values


_env = {
    **_load_env(WEB / ".env"),
    **{k: v for k, v in os.environ.items() if k.startswith("STUDIO_")},
}

PASSWORD = _env.get("STUDIO_PASSWORD", "")
HOST = _env.get("STUDIO_HOST", "0.0.0.0")
PORT = int(_env.get("STUDIO_PORT", "8000"))
COMFY_URL = _env.get("STUDIO_COMFY_URL", "http://127.0.0.1:8188").rstrip("/")
SECRET = (_env.get("STUDIO_SECRET") or PASSWORD or "dev-secret").encode()
CLAUDE_BIN = _env.get("STUDIO_CLAUDE", "claude")
# Claude model for describing pictures and the prompt helper: an alias (sonnet, opus) or an id.
CLAUDE_MODEL = _env.get("STUDIO_CLAUDE_MODEL", "sonnet")
MAX_UPLOAD_MB = int(_env.get("STUDIO_MAX_UPLOAD_MB", "50"))
# Uploaded pictures are stored at most this many pixels on the long side.
MAX_SIDE = int(_env.get("STUDIO_MAX_SIDE", "2048"))
