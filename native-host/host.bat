@echo off
rem Chrome launches this .bat as the native-messaging host; it hands off to host.ps1.
rem %~dp0 = this file's directory (trailing backslash) so host.ps1 resolves from any CWD.
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0host.ps1"
