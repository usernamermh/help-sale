@echo off
title Sales Copilot - Restart Service
cd /d "%~dp0"
echo ================================================
echo   Sales Copilot - One-click service restart
echo   It will stop the running service and restart it
echo ================================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\restart-service.ps1"
echo.
if %errorlevel% neq 0 (
  echo [FAILED] Service did not pass health check. See apps/api/log/service.log
) else (
  echo [OK] Service restarted.
)
echo.
pause