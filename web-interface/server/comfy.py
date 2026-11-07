"""ComfyUI client: queue a graph, follow its progress over the websocket, fetch the image."""

import asyncio
import json
import logging
import uuid

import httpx
import websockets

log = logging.getLogger("studio.comfy")


class ComfyError(RuntimeError):
    pass


class Comfy:
    def __init__(self, url):
        self.url = url
        self.client_id = str(uuid.uuid4())
        self.http = httpx.AsyncClient(base_url=url, timeout=60)
        self.watchers = {}  # prompt_id -> callback(kind, data)
        self.connected = False
        self.queue_remaining = 0

    # --- HTTP ---------------------------------------------------------------------------------

    async def alive(self):
        try:
            r = await self.http.get("/system_stats", timeout=3)
            return r.status_code == 200
        except httpx.HTTPError:
            return False

    async def list_models(self, folder):
        try:
            r = await self.http.get(f"/models/{folder}", timeout=5)
            return r.json() if r.status_code == 200 else []
        except httpx.HTTPError:
            return []

    async def queue(self, graph):
        r = await self.http.post("/prompt", json={"prompt": graph, "client_id": self.client_id})
        if r.status_code != 200:
            raise ComfyError(_error_text(r))
        return r.json()["prompt_id"]

    async def history(self, prompt_id):
        r = await self.http.get(f"/history/{prompt_id}")
        return r.json().get(prompt_id)

    async def image(self, ref):
        r = await self.http.get("/view", params={
            "filename": ref["filename"], "subfolder": ref.get("subfolder", ""),
            "type": ref.get("type", "output")})
        r.raise_for_status()
        return r.content

    async def upload(self, data, name):
        """Put a file into ComfyUI's input folder (subfolder 'studio'); returns the name for
        LoadImage."""
        r = await self.http.post(
            "/upload/image",
            files={"image": (name, data, "image/png")},
            data={"subfolder": "studio", "overwrite": "true", "type": "input"})
        r.raise_for_status()
        info = r.json()
        return f"{info['subfolder']}/{info['name']}" if info.get("subfolder") else info["name"]

    async def interrupt(self):
        try:
            await self.http.post("/interrupt", json={})
        except httpx.HTTPError:
            pass

    async def queue_info(self):
        """Prompts in ComfyUI's own queue (ours and anyone else's, e.g. comfy_generate.py)."""
        try:
            r = await self.http.get("/queue", timeout=3)
            q = r.json()
            return len(q.get("queue_running", [])), len(q.get("queue_pending", []))
        except (httpx.HTTPError, ValueError):
            return 0, 0

    # --- Websocket ----------------------------------------------------------------------------

    async def listen(self):
        ws_url = self.url.replace("http", "ws", 1) + f"/ws?clientId={self.client_id}"
        while True:
            try:
                async with websockets.connect(ws_url, max_size=None, ping_interval=20) as ws:
                    self.connected = True
                    log.info("websocket connected")
                    async for message in ws:
                        if isinstance(message, str):
                            self._dispatch(json.loads(message))
            except (OSError, websockets.WebSocketException) as e:
                if self.connected:
                    log.warning("websocket lost: %s", e)
            self.connected = False
            await asyncio.sleep(2)

    def _dispatch(self, message):
        kind, data = message.get("type"), message.get("data") or {}
        if kind == "status":
            info = data.get("status", {}).get("exec_info", {})
            self.queue_remaining = info.get("queue_remaining", 0)
            return
        callback = self.watchers.get(data.get("prompt_id"))
        if callback:
            callback(kind, data)


def _error_text(response):
    try:
        body = response.json()
    except ValueError:
        return f"HTTP {response.status_code}: {response.text[:300]}"
    error = body.get("error", {})
    parts = [error.get("message", ""), error.get("details", "")]
    for node, info in (body.get("node_errors") or {}).items():
        for e in info.get("errors", []):
            parts.append(f"{node}: {e.get('message')} {e.get('details', '')}")
    return " ".join(p for p in parts if p).strip() or f"HTTP {response.status_code}"
