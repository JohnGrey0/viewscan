@echo off
rem Starts Viewscan and opens it in your browser. Close this window to stop it.
cd /d "%~dp0"
start "" http://localhost:8127/
node server.js
pause
