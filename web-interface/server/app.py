"""Web interface server: API for the page, files from content/, the generation queue.

    cd web-interface && uv run python -m server
"""

import asyncio
import hashlib
import hmac
import io
import logging
import time
import zipfile
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import quote, unquote

from fastapi import Body, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import catalog, config, graphs, library, tasks
from .comfy import Comfy, ComfyError
from .jobs import Jobs

log = logging.getLogger("studio")
COOKIE = "studio"

comfy = Comfy(config.COMFY_URL)
jobs = Jobs(comfy)
journal = None  # set in lifespan when Claude is available (server/claude.py)


@asynccontextmanager
async def lifespan(app):
    global journal
    background = [asyncio.create_task(comfy.listen()), asyncio.create_task(jobs.worker())]
    try:
        from .claude import Journal
        journal = Journal(jobs)
        background.append(asyncio.create_task(journal.run()))
    except ImportError:
        journal = None
    if not config.PASSWORD:
        log.warning("STUDIO_PASSWORD is empty: anyone on the network can log in")
    yield
    for task in background:
        task.cancel()


app = FastAPI(title="mila-draw-ai web interface", lifespan=lifespan, docs_url=None, redoc_url=None)


# --- login ------------------------------------------------------------------------------------


def _sign(who):
    sig = hmac.new(config.SECRET, who.encode(), hashlib.sha256).hexdigest()[:32]
    return f"{quote(who)}.{sig}"


def _user(request):
    token = request.cookies.get(COOKIE, "")
    if "." not in token:
        return None
    name, sig = token.rsplit(".", 1)
    who = unquote(name)
    return who if hmac.compare_digest(_sign(who), token) else None


OPEN_PATHS = ("/api/session", "/api/login")


@app.middleware("http")
async def auth(request: Request, call_next):
    path = request.url.path
    protected = path.startswith(("/api/", "/files/", "/thumbs/")) and not path.startswith(OPEN_PATHS)
    if protected:
        who = _user(request)
        if not who:
            return JSONResponse({"detail": "Нужно войти"}, status_code=401)
        request.state.who = who
    return await call_next(request)


@app.get("/api/session")
async def session(request: Request):
    return {"who": _user(request), "users": config.USERS, "password": bool(config.PASSWORD)}


@app.post("/api/login")
async def login(data: dict = Body(...)):
    who = (data.get("who") or "").strip()
    if not who or len(who) > 40:
        raise HTTPException(400, "Выберите, кто вы")
    if config.PASSWORD and not hmac.compare_digest(data.get("password", ""), config.PASSWORD):
        raise HTTPException(403, "Неверный пароль")
    response = JSONResponse({"who": who})
    response.set_cookie(COOKIE, _sign(who), max_age=365 * 24 * 3600, httponly=True, samesite="lax")
    return response


@app.post("/api/logout")
async def logout():
    response = JSONResponse({"ok": True})
    response.delete_cookie(COOKIE)
    return response


# --- catalog and status -----------------------------------------------------------------------


@app.get("/api/catalog")
async def get_catalog():
    return catalog.public(await comfy.list_models("loras"))


@app.get("/api/status")
async def status():
    return {**jobs.snapshot(), "journal": journal.status() if journal else None}


# --- tasks ------------------------------------------------------------------------------------


def _task(task_id):
    try:
        return tasks.get(task_id)
    except KeyError:
        raise HTTPException(404, "Задача не найдена")


@app.get("/api/tasks")
async def list_tasks():
    return {"tasks": tasks.all_tasks(), "kinds": tasks.KINDS}


@app.post("/api/tasks")
async def create_task(request: Request, data: dict = Body(...)):
    return tasks.create(data.get("title", ""), data.get("kind", "other"), request.state.who)


@app.get("/api/tasks/{task_id}")
async def get_task(task_id: str):
    task = _task(task_id)
    task["journal"] = journal.task_status(task_id) if journal else None
    return task


@app.post("/api/tasks/{task_id}/uploads")
async def upload(request: Request, task_id: str, files: list[UploadFile] = File(...),
                 note: str = Form("")):
    _task(task_id)
    saved = []
    for f in files:
        data = await f.read()
        if len(data) > config.MAX_UPLOAD_MB * 2**20:
            raise HTTPException(413, f"{f.filename}: больше {config.MAX_UPLOAD_MB} МБ")
        saved.append(tasks.add_input(task_id, f.filename or "file", data, request.state.who, note))
    _touch(task_id)
    return {"saved": saved}


@app.post("/api/tasks/{task_id}/attach")
async def attach(request: Request, task_id: str, data: dict = Body(...)):
    _task(task_id)
    try:
        library.resolve(data["path"])
        saved = tasks.attach(task_id, data["path"], request.state.who)
    except (PermissionError, FileNotFoundError, KeyError):
        raise HTTPException(400, "Нет такого файла")
    _touch(task_id)
    return {"saved": saved}


@app.post("/api/tasks/{task_id}/notes")
async def add_note(request: Request, task_id: str, data: dict = Body(...)):
    _task(task_id)
    text = (data.get("text") or "").strip()
    if not text:
        raise HTTPException(400, "Пустая заметка")
    entry = tasks.add_note(task_id, request.state.who, text)
    _touch(task_id)
    return entry


@app.post("/api/tasks/{task_id}/marks")
async def mark(request: Request, task_id: str, data: dict = Body(...)):
    _task(task_id)
    if data.get("kind") not in ("star", "final"):
        raise HTTPException(400, "kind: star | final")
    task = tasks.mark(task_id, request.state.who, data["file"], data["kind"], bool(data.get("on")))
    _touch(task_id)
    return {"stars": task["stars"], "finals": task["finals"], "status": task["status"]}


@app.post("/api/tasks/{task_id}/journal")
async def run_journal(request: Request, task_id: str):
    _task(task_id)
    if not journal:
        raise HTTPException(503, "Claude недоступен")
    journal.request(task_id, now=True)
    return journal.task_status(task_id)


@app.post("/api/prompt-help")
async def prompt_help(request: Request, data: dict = Body(...)):
    if not journal or not journal.available:
        raise HTTPException(503, "Claude недоступен")
    idea = (data.get("idea") or "").strip()
    if not idea:
        raise HTTPException(400, "Опишите идею")
    if data.get("model") not in catalog.models():
        raise HTTPException(400, "Неизвестная модель")
    from .claude import prompt_help as helper
    try:
        result = await helper(idea, data["model"], data.get("blocks", []))
    except RuntimeError as e:
        raise HTTPException(502, f"Claude: {e}")
    if data.get("task_id"):
        try:
            tasks.log(data["task_id"], "prompt_help", request.state.who, idea=idea,
                      model=data["model"], prompt=result["prompt"], negative=result["negative"],
                      comment=result["comment"], seconds=result.get("seconds"))
            _touch(data["task_id"])
        except KeyError:
            pass
    return result


def _touch(task_id):
    if journal:
        journal.request(task_id)


# --- generation -------------------------------------------------------------------------------


@app.post("/api/jobs")
async def submit(request: Request, data: dict = Body(...)):
    task = _task(data.get("task_id", ""))
    if data.get("init"):
        try:
            library.resolve(data["init"]).stat()
        except (PermissionError, FileNotFoundError):
            raise HTTPException(400, "Картинка-основа не найдена")
    try:
        job = jobs.submit(task, request.state.who, data)
    except (ValueError, KeyError, TypeError) as e:
        raise HTTPException(400, str(e))
    return jobs.view(job)


@app.delete("/api/jobs/{job_id}")
async def cancel(job_id: str):
    try:
        return jobs.view(jobs.cancel(job_id))
    except KeyError:
        raise HTTPException(404, "Нет такой задачи в очереди")


@app.post("/api/images/nobg")
async def remove_background(request: Request, data: dict = Body(...)):
    """Transparent background for one picture; saved next to it as <name>_nobg.png."""
    path = data.get("path", "")
    try:
        src = library.resolve(path)
        src.stat()
    except (PermissionError, FileNotFoundError):
        raise HTTPException(400, "Нет такого файла")
    models = await comfy.list_models("background_removal")
    if not models:
        raise HTTPException(503, "Модель удаления фона не установлена (веха 6.7)")
    name = await comfy.upload(src.read_bytes(), f"nobg-{int(time.time())}{src.suffix}")
    graph = graphs.remove_background(name, models[0])
    started = time.monotonic()
    try:
        prompt_id = await comfy.queue(graph)
        item = None
        for _ in range(600):
            await asyncio.sleep(0.5)
            item = await comfy.history(prompt_id)
            if item and item.get("status", {}).get("completed") is not None:
                break
        refs = [o["images"][0] for o in (item or {}).get("outputs", {}).values() if o.get("images")]
        if not refs:
            raise ComfyError("ComfyUI не вернул картинку")
        png = await comfy.image(refs[0])
    except ComfyError as e:
        raise HTTPException(500, f"Не получилось убрать фон: {e}")
    target = tasks.output_path_for(path, "_nobg")
    target.write_bytes(png)
    tasks.copy_record(src, target, {"nobg_from": path, "nobg_model": models[0],
                                    "nobg_seconds": round(time.monotonic() - started, 1)})
    out = tasks.rel(target)
    parts = path.split("/")
    if len(parts) > 2 and parts[0] == "prototype":
        tasks.log(parts[1], "nobg", request.state.who, file=out, source=path, model=models[0])
        _touch(parts[1])
    return {"path": out}


# --- files and library ------------------------------------------------------------------------


@app.get("/api/library")
async def get_library(path: str = ""):
    try:
        return library.listdir(path)
    except (PermissionError, FileNotFoundError):
        raise HTTPException(404, "Нет такой папки")


@app.post("/api/library/upload")
async def library_upload(request: Request, path: str = Form(...), files: list[UploadFile] = File(...)):
    """Add files to content/references/… (adding only: deleting there is not allowed)."""
    if path.split("/")[0] != "references":
        raise HTTPException(403, "Добавлять можно только в references/")
    folder = library.resolve(path)
    folder.mkdir(parents=True, exist_ok=True)
    saved = []
    for f in files:
        data = await f.read()
        target = tasks.unique(folder, tasks.safe_filename(f.filename or "file"))
        target.write_bytes(data)
        saved.append(tasks.rel(target))
    log.info("%s added %d files to %s", request.state.who, len(saved), path)
    return {"saved": saved}


@app.get("/files/{path:path}")
def get_file(path: str, download: bool = False):
    try:
        target = library.resolve(path)
    except PermissionError:
        raise HTTPException(403)
    if not target.is_file():
        raise HTTPException(404)
    return FileResponse(target, filename=target.name if download else None)


@app.get("/thumbs/{path:path}")
def get_thumb(path: str, size: int = 480):
    try:
        target = library.thumb(path, max(128, min(size, 1600)))
    except PermissionError:
        raise HTTPException(403)
    except (FileNotFoundError, OSError):
        raise HTTPException(404)
    return FileResponse(target, media_type="image/webp",
                        headers={"Cache-Control": "private, max-age=86400"})


@app.post("/api/zip")
def make_zip(data: dict = Body(...)):
    paths = data.get("paths") or []
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_STORED) as z:
        for p in paths[:200]:
            try:
                target = library.resolve(p)
            except PermissionError:
                continue
            if target.is_file():
                z.write(target, target.name)
    buffer.seek(0)
    name = data.get("name") or "images"
    return StreamingResponse(buffer, media_type="application/zip", headers={
        "Content-Disposition": f"attachment; filename*=UTF-8''{quote(name)}.zip"})


# --- page -------------------------------------------------------------------------------------


@app.get("/")
def index():
    return FileResponse(config.STATIC / "index.html", headers={"Cache-Control": "no-cache"})


app.mount("/static", StaticFiles(directory=config.STATIC), name="static")
