@echo off
rem Double-click launcher: ComfyUI and the web interface in the background, same as
rem "studio start" in the repo root. Stop them with "studio stop". ASCII only + CRLF.
call "%~dp0..\studio.bat" start
pause
