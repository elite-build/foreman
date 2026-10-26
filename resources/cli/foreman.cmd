@echo off
rem The `foreman` command in an installed Foreman (Settings - Advanced puts this folder on your PATH).
rem Runs the CLI with the app's own binary in Node mode, so Node.js needn't be installed.
setlocal
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\..\Foreman.exe" "%~dp0..\app.asar\out\main\cli.js" %*
