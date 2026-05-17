@echo off
setlocal
cd /d "%~dp0"
echo Starting LPR matGPR local server...
echo.
echo Open this URL in your browser:
echo   http://127.0.0.1:4173/
echo.
where node >nul 2>nul
if %errorlevel%==0 (
  node server.mjs
) else if exist "C:\Environment\node.exe" (
  "C:\Environment\node.exe" server.mjs
) else if exist "C:\code\anaconda\python.exe" (
  "C:\code\anaconda\python.exe" -m http.server 4173 --bind 127.0.0.1
) else (
  echo Could not find Node.js or Python.
  echo Please install Node.js or use Python to serve this folder.
)
echo.
pause
