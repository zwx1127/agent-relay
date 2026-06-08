@echo off
setlocal

set "BUN=%AGENT_RELAY_BUN_PATH%"
if "%BUN%"=="" set "BUN=bun"

"%BUN%" "%~dp0agent-relay-helper" %*
exit /b %ERRORLEVEL%
