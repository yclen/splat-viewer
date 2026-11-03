@echo off
rem Serves the viewer on http://localhost:8123 and opens it in your browser.
rem Close this window to stop the server.
cd /d "%~dp0"
start "" http://localhost:8123
python serve.py 8123
