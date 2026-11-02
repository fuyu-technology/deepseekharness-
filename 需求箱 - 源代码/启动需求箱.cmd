@echo off
chcp 936 >nul
title Box Server
cd /d "%~dp0"
echo.
echo   URL: http://127.0.0.1:3200/?token=7603d5d502bbb4e2943a8855ba879799
echo.
if exist "..\SnowLuma\node.exe" (
  "..\SnowLuma\node.exe" "box-server.mjs"
) else (
  node "box-server.mjs"
)
echo.
echo   exited. log: state\box.out.log
pause