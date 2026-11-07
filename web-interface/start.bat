@echo off
rem Start the web interface on MSI: ComfyUI first (if it is not running), then the server.
rem ASCII only + CRLF. Settings: web-interface\.env (copy .env.example).
rem   start.bat   - open http://127.0.0.1:8000 here, http://<MSI IP>:8000 on the home network
setlocal
set "HERE=%~dp0"
if "%COMFY_ROOT%"=="" set "COMFY_ROOT=C:\AI\ComfyUI"

curl -s -o nul -m 2 http://127.0.0.1:8188/system_stats
if errorlevel 1 (
  echo ComfyUI is not running - starting it in a new window...
  start "ComfyUI" cmd /c ""%HERE%..\msi\scripts\comfy_start.bat""
  echo Waiting for ComfyUI...
  for /l %%i in (1,1,90) do (
    curl -s -o nul -m 2 http://127.0.0.1:8188/system_stats && goto comfy_ready
    timeout /t 2 /nobreak >nul
  )
  echo ComfyUI did not answer in 3 minutes - the interface starts anyway, generation will wait.
)
:comfy_ready

cd /d "%HERE%"
uv run --python 3.13 python -m server
