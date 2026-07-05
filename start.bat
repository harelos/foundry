@echo off
setlocal
cd /d "%~dp0"

set "MC_PROJECT_DIR=%USERPROFILE%\Downloads\flowmate-pro-final\flowmate-pro-final"
set "MC_PORT=4317"
set "MC_PERMISSION_MODE=bypassPermissions"

echo ============================================
echo   Mission Control
echo ============================================

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  ERROR: Node.js was not found on PATH. Install from https://nodejs.org
  echo.
  pause
  exit /b 1
)

echo  Clearing any old server on port %MC_PORT% ...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :%MC_PORT% ^| findstr LISTENING') do taskkill /F /PID %%a >nul 2>nul

start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 3; Start-Process 'http://localhost:%MC_PORT%/'"

echo.
echo  ====================================================
echo   Server starting on http://localhost:%MC_PORT%
echo   KEEP THIS WINDOW OPEN. Closing it stops the server.
echo  ====================================================
echo.
node "%~dp0server.js"

echo.
echo  Server stopped (exit code %errorlevel%).
pause
