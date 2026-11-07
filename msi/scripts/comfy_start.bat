@echo off
rem Start ComfyUI portable on MSI. ASCII only + CRLF: cmd breaks on UTF-8 and LF.
rem   comfy_start.bat       - this PC only:  http://127.0.0.1:8188
rem   comfy_start.bat lan   - home network (Krita on Mac, web-interface): http://<MSI IP>:8188
rem Never expose to the internet: ComfyUI has no auth.
rem Override the ComfyUI folder with the COMFY_ROOT env variable.

setlocal
if "%COMFY_ROOT%"=="" set "COMFY_ROOT=C:\AI\ComfyUI"

set "LISTEN=127.0.0.1"
if /I "%~1"=="lan" set "LISTEN=0.0.0.0"

if not exist "%COMFY_ROOT%\python_embeded\python.exe" (
  echo Not found: %COMFY_ROOT%\python_embeded\python.exe
  exit /b 1
)

cd /d "%COMFY_ROOT%"
echo ComfyUI: %COMFY_ROOT%  listen=%LISTEN%:8188
"%COMFY_ROOT%\python_embeded\python.exe" -s ComfyUI\main.py --windows-standalone-build --listen %LISTEN% --port 8188 --disable-auto-launch --enable-manager
