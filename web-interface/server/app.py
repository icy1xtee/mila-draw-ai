"""Mila Draw AI server: API for the page, pictures from content/tasks/, the generation queue.

    cd web-interface && uv run python -m server
"""

import asyncio
import hashlib
import hmac
import logging
from contextlib import asynccontextmanager

from fastapi import Body, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import catalog, claude, config, tasks
from .comfy import Comfy
from .jobs import Jobs

log = logging.getLogger("mila")
COOKIE = "mila"

comfy = Comfy(config.COMFY_URL)
jobs = Jobs(comfy)


@asynccontextmanager
async def lifespan(app):
    background = [asyncio.create_task(comfy.listen()), asyncio.create_task(jobs.worker())]
    if not config.PASSWORD:
        log.warning("STUDIO_PASSWORD is empty: anyone on the network can open the page")
    if claude.available():
        for rel in tasks.pending_analyses():  # descriptions the last run did not finish
            claude.describe_later(rel)
    yield
    for task in background:
        task.cancel()


app = FastAPI(title="Mila Draw AI", lifespan=lifespan, docs_url=None, redoc_url=None)


# --- login: one shared password ---------------------------------------------------------------


def _token():
    return hmac.new(config.SECRET, b"mila-draw-ai", hashlib.sha256).hexdigest()[:32]


def _authed(request):
    return not config.PASSWORD or hmac.compare_digest(request.cookies.get(COOKIE, ""), _token())


OPEN_PATHS = ("/api/session", "/api/login")


@app.middleware("http")
async def auth(request: Request, call_next):
    path = request.url.path
    if path.startswith(("/api/", "/files/", "/thumbs/")) and not path.startswith(OPEN_PATHS):
        if not _authed(request):
            return JSONResponse({"detail": "Нужно войти"}, status_code=401)
    return await call_next(request)


@app.get("/api/session")
async def session(request: Request):
    return {"authed": _authed(request), "password": bool(config.PASSWORD)}


@app.post("/api/login")
async def login(data: dict = Body(...)):
    if config.PASSWORD and not hmac.compare_digest(data.get("password", ""), config.PASSWORD):
        raise HTTPException(403, "Неверный пароль")
    response = JSONResponse({"ok": True})
    response.set_cookie(COOKIE, _token(), max_age=365 * 24 * 3600, httponly=True, samesite="lax")
    return response


# --- catalog and status -----------------------------------------------------------------------


@app.get("/api/catalog")
async def get_catalog():
    samplers, schedulers = await comfy.sampler_options()
    return {**catalog.public(await comfy.list_models("loras"), samplers, schedulers,
                             await comfy.list_models("upscale_models")),
            "claude": claude.available()}


@app.get("/api/status")
async def status():
    return jobs.snapshot()


# --- tasks ------------------------------------------------------------------------------------


def _task(task_id):
    try:
        return tasks.get(task_id)
    except KeyError:
        raise HTTPException(404, "Задача не найдена")


@app.get("/api/tasks")
async def list_tasks():
    return {"tasks": tasks.all_tasks()}


@app.post("/api/tasks")
async def create_task(data: dict = Body(...)):
    try:
        return tasks.create(data.get("title", ""))
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.get("/api/tasks/{task_id}")
async def get_task(task_id: str):
    return _task(task_id)


@app.patch("/api/tasks/{task_id}")
async def rename_task(task_id: str, data: dict = Body(...)):
    _task(task_id)
    return tasks.rename(task_id, data.get("title", ""))


@app.delete("/api/tasks/{task_id}")
async def delete_task(task_id: str):
    """Delete the whole task: folder, pictures, previews."""
    _task(task_id)
    if any(j.task_id == task_id and j.status in ("queued", "running") for j in jobs.jobs):
        raise HTTPException(409, "В задаче идёт генерация — дождитесь конца или отмените её")
    try:
        tasks.delete(task_id)
    except OSError as e:
        raise HTTPException(500, f"Не получилось удалить: {e}")
    log.info("task %s deleted", task_id)
    return {"ok": True}


@app.post("/api/tasks/{task_id}/uploads")
async def upload(task_id: str, files: list[UploadFile] = File(...)):
    """Attach pictures; Claude starts describing each one at once."""
    _task(task_id)
    saved = []
    for f in files:
        data = await f.read()
        if len(data) > config.MAX_UPLOAD_MB * 2**20:
            raise HTTPException(413, f"{f.filename}: больше {config.MAX_UPLOAD_MB} МБ")
        try:
            item = tasks.save_upload(task_id, f.filename or "picture", data)
        except ValueError as e:
            raise HTTPException(400, str(e))
        saved.append(item)
        if claude.available():
            claude.describe_later(item["file"])
        else:
            tasks.set_analysis(item["file"], {"status": "off"})
            item["analysis"] = {"status": "off"}
    return {"saved": saved}


@app.post("/api/describe")
async def describe(data: dict = Body(...)):
    """Describe a picture (a result taken back into work, or a retry after an error)."""
    if not claude.available():
        raise HTTPException(503, "Claude не установлен на этой машине")
    path = data.get("file", "")
    try:
        meta = tasks.get_meta(path)
    except (PermissionError, FileNotFoundError):
        raise HTTPException(400, "Нет такой картинки")
    analysis = meta.get("analysis") or {}
    if analysis.get("status") in ("done", "pending") and not data.get("again"):
        return analysis
    claude.describe_later(path)
    return {"status": "pending"}


def _pictures(files):
    """Attached pictures: checked paths and Claude's descriptions of them."""
    result = []
    for f in list(files or [])[:4]:
        try:
            analysis = tasks.get_meta(f).get("analysis") or {}
        except (PermissionError, FileNotFoundError):
            raise HTTPException(400, "Прикреплённая картинка не найдена")
        result.append({k: analysis.get(k, "") for k in ("description", "tags", "medium")})
    return result


@app.post("/api/assistant")
async def assistant(data: dict = Body(...)):
    """AI helper: Mila's words → prompt, negative, settings to change, a tip."""
    if not claude.available():
        raise HTTPException(503, "Claude не установлен на этой машине")
    wish = (data.get("wish") or "").strip()
    if not wish:
        raise HTTPException(400, "Напишите, что хотите получить")
    key = data.get("model")
    model = catalog.models().get(key)
    if not model:
        raise HTTPException(400, "Неизвестная модель")
    pictures = _pictures(data.get("images"))
    mode = "text" if not pictures else "edit" if model.get("references") else "img2img"
    try:
        preset = catalog.find_preset(data.get("preset"))
    except ValueError:
        preset = None
    settings = {k: v for k, v in (data.get("settings") or {}).items()
                if k in ("steps", "cfg", "denoise", "count")}
    try:
        return await claude.assistant(wish, key, model, mode, pictures, preset, settings)
    except RuntimeError as e:
        raise HTTPException(502, f"Claude: {e}")


@app.post("/api/brainstorm")
async def brainstorm(data: dict = Body(...)):
    """Photo → several different character ideas (the page then draws them in chosen models)."""
    if not claude.available():
        raise HTTPException(503, "Claude не установлен на этой машине")
    task = _task(data.get("task_id", ""))
    images = list(data.get("images") or [])[:4]
    if not images:
        raise HTTPException(400, "Прикрепите фото")
    own = {i["file"] for i in task["items"]}
    if any(i not in own for i in images):
        raise HTTPException(400, "Картинка не из этой задачи")
    try:
        count = max(2, min(int(data.get("count") or 4), 8))
        return await claude.brainstorm(images, data.get("wish", ""), count)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except RuntimeError as e:
        raise HTTPException(502, f"Claude: {e}")


# --- generation -------------------------------------------------------------------------------


@app.post("/api/jobs")
async def submit(data: dict = Body(...)):
    task = _task(data.get("task_id", ""))
    try:
        job = jobs.submit(task, data)
    except (PermissionError, FileNotFoundError):
        raise HTTPException(400, "Прикреплённая картинка не найдена")
    except (ValueError, KeyError, TypeError) as e:
        raise HTTPException(400, str(e))
    return jobs.view(job)


@app.delete("/api/jobs/{job_id}")
async def cancel(job_id: str):
    try:
        return jobs.view(jobs.cancel(job_id))
    except KeyError:
        raise HTTPException(404, "Нет такой генерации в очереди")


# --- pictures ---------------------------------------------------------------------------------


@app.get("/files/{path:path}")
def get_file(path: str, download: bool = False):
    try:
        target = tasks.resolve(path)
    except PermissionError:
        raise HTTPException(403)
    if not target.is_file() or target.suffix.lower() not in tasks.IMAGE_EXT:
        raise HTTPException(404)
    return FileResponse(target, filename=target.name if download else None)


@app.get("/thumbs/{path:path}")
def get_thumb(path: str, size: int = 480):
    try:
        target = tasks.thumb(path, max(128, min(size, 1600)))
    except PermissionError:
        raise HTTPException(403)
    except (FileNotFoundError, OSError):
        raise HTTPException(404)
    return FileResponse(target, media_type="image/webp",
                        headers={"Cache-Control": "private, max-age=86400"})


# --- page -------------------------------------------------------------------------------------


@app.get("/")
def index():
    return FileResponse(config.STATIC / "index.html", headers={"Cache-Control": "no-cache"})


app.mount("/static", StaticFiles(directory=config.STATIC), name="static")
