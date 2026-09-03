@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-Local-Resource-Server.ps1"
if errorlevel 1 (
  echo.
  echo The local resource server stopped with an error.
  pause
)
endlocal
