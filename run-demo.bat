@echo off
setlocal
title The Gate - BEDA enquiry triage
cd /d "%~dp0"

echo.
echo   The Gate - BEDA enquiry triage
echo   ------------------------------
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   Node.js is not installed, or is not on your PATH.
  echo   Install the LTS build from https://nodejs.org and run this again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo   First run - installing dependencies. This takes a minute.
  echo.
  call npm install --no-fund --no-audit
  if errorlevel 1 (
    echo.
    echo   npm install failed. Scroll up for the reason.
    pause
    exit /b 1
  )
  echo.
)

echo   Opening http://localhost:5173 in your browser...
echo.
echo     /        the design document, six chapters
echo     /demo    the running pipeline, click through it
echo.
echo   Close this window to stop the server.
echo.

start "" http://localhost:5173
call npx tsx src/server.ts

echo.
echo   Server stopped.
pause
