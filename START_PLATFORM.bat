@echo off
title Asfarma TeleMeet Platform
chcp 65001 > nul
set "PATH=%~dp0nodejs;D:\Программы\nodejs;%PATH%"

echo ========================================================
echo    🚀 Asfarma TeleMeet видеоконференция платформаси
echo    (Админ ҳуқуқлари ТАЛАБ ҚИЛИНМАЙДИ)
echo ========================================================
echo.
echo Сервер ишга туширилмоқда...
cd /d "%~dp0server"

timeout /t 2 /nobreak > nul
start http://localhost:5000

node src/index.js
pause
