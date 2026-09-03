@echo off
setlocal
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. The resource can still be installed, but the optional validation suite requires Node.js.
  pause
  exit /b 1
)
node.exe "%~dp0tests\validate.js"
set "exitcode=%errorlevel%"
echo.
if "%exitcode%"=="0" (
  echo Validation passed.
) else (
  echo Validation failed with exit code %exitcode%.
)
pause
exit /b %exitcode%
