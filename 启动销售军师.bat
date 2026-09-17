@echo off
chcp 65001 >nul
title 销售军师 - 一键启动服务
cd /d "%~dp0"
echo ================================================
echo    销售军师 - 一键启动服务
echo    将停止当前正在运行的服务,再重新启动
echo ================================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\restart-service.ps1"
echo.
if %errorlevel% neq 0 (
  echo [失败] 服务启动未通过健康检查,请查看上方日志或 apps/api/log/service.log
) else (
  echo [成功] 服务已重启完成
)
echo.
pause