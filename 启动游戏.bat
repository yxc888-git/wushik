@echo off
chcp 65001 >nul 2>nul
cd /d "%~dp0"
title 五十K - 河南郑州版

set "NODE_EXE=C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-2\node.exe"
if not exist "%NODE_EXE%" (
  where node >nul 2>nul
  if errorlevel 1 (
    echo.
    echo   [!] 没找到 Node.js
    echo   请先安装 Node.js ( https://nodejs.org ) 再双击本文件
    echo.
    pause
    exit /b 1
  )
  set "NODE_EXE=node"
)

echo.
echo   正在启动，浏览器会自动打开...
echo   如果没弹出来，手动访问 http://localhost:8080
echo.

start "" http://localhost:8080
"%NODE_EXE%" serve.js 8080

echo.
echo   服务已停止。
pause
