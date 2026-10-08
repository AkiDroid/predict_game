@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy.ps1" %*
set "deploy_result=%errorlevel%"
if not "%deploy_result%"=="0" echo Deployment failed. See the error above.
pause
exit /b %deploy_result%
