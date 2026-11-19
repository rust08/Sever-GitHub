@echo off
cd /d "%~dp0"
where node >nul 2>&1 || (echo Node.js 24+ required & pause & exit /b 1)
node server.mjs --open
if errorlevel 1 pause
