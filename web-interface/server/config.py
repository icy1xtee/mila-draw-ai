"""Paths and settings. Settings come from web-interface/.env (see .env.example) or STUDIO_* env."""

import os
from pathlib import Path

WEB = Path(__file__).resolve().parent.parent
REPO = WEB.parent
CONTENT = REPO / "content"
PROTOTYPE = CONTENT / "prototype"
CATALOG = REPO / "msi" / "catalog"
BLOCKS = REPO / "prompts" / "blocks.json"
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
USERS = [u.strip() for u in _env.get("STUDIO_USERS", "Мила,Павел").split(",") if u.strip()]
HOST = _env.get("STUDIO_HOST", "0.0.0.0")
PORT = int(_env.get("STUDIO_PORT", "8000"))
COMFY_URL = _env.get("STUDIO_COMFY_URL", "http://127.0.0.1:8188").rstrip("/")
SECRET = (_env.get("STUDIO_SECRET") or PASSWORD or "dev-secret").encode()
CLAUDE_BIN = _env.get("STUDIO_CLAUDE", "claude")
# Claude writes the journal after this many seconds without new events in a task.
JOURNAL_DELAY = int(_env.get("STUDIO_JOURNAL_DELAY", "90"))
MAX_UPLOAD_MB = int(_env.get("STUDIO_MAX_UPLOAD_MB", "50"))
# Model for the journal and the prompt helper: an alias (sonnet, opus) or a full model id.
CLAUDE_MODEL = _env.get("STUDIO_CLAUDE_MODEL", "sonnet")
