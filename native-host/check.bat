@echo off
rem AnyRouter local health check - double-click to run; ASCII only (cmd reads .bat as GBK).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0check.ps1" %*
echo.
pause
