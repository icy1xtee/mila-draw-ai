@echo off
rem Start and stop ComfyUI and the web interface on MSI (logic: msi\scripts\studio.ps1).
rem ASCII only + CRLF. Run from the repo root; in PowerShell prefix with .\
rem   studio start  /  studio stop  /  studio restart     both services
rem   studio start comfy  /  studio stop web  /  ...      one of them
rem   studio status                                       what is running and where
rem   studio logs comfy  /  studio logs web               follow a log, Ctrl+C to quit
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0msi\scripts\studio.ps1" %*
exit /b %errorlevel%
