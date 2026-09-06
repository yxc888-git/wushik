@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在启动五十K（郑州版）...
echo 服务地址：http://localhost:8080/
echo.

:: 先看服务是不是已经起来了
powershell -NoProfile -Command "try { (New-Object Net.Sockets.TcpClient('127.0.0.1',8080)).Close(); exit 0 } catch { exit 1 }"
if %errorlevel%==0 (
  echo 服务已在运行，直接开浏览器。
) else (
  echo 启动本地服务中（这个黑窗口别关，关了游戏就断）...
  start "五十K服务" /min node serve.js 8080
  timeout /t 2 >nul
)

:: 用系统 Chrome 打开游戏（最大化）
if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" (
  start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --start-maximized http://localhost:8080/
) else if exist "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" (
  start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --start-maximized http://localhost:8080/
) else (
  start "" http://localhost:8080/
)
echo.
echo 已打开浏览器。若页面打不开，把上面这个黑窗口留着再刷新一次页面。
timeout /t 5 >nul
