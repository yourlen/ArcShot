@echo off
setlocal
chcp 65001 >nul
set "ARCSHOT_NODE=C:\Users\yourlen\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%ARCSHOT_NODE%" (
  echo [ArcShot] 未找到本机 Node.js 运行时。
  pause
  exit /b 1
)
cd /d "%~dp0"
"%ARCSHOT_NODE%" "dist\server\src\LocalRelayServer.js"
endlocal

