@echo off
title Asfarma TeleMeet Online
chcp 65001 > nul
set "PATH=%~dp0nodejs;D:\Программы\nodejs;%PATH%"

echo ========================================================
echo    🚀 Asfarma TeleMeet - ОНЛАЙН ИНТЕРНЕТ КОНФЕРЕНЦИЯ
echo    (Турли жойлардан уланиш учун очиқ ҳавола)
echo ========================================================
echo.
echo 1. Сервер ишга туширилмоқда...
start "TeleMeet Server" /b node "%~dp0server\src\index.js"

timeout /t 2 /nobreak > nul

echo 2. Бутун интернет учун бепул хавфсиз HTTPS туннель ишга тушмоқда...
echo.
echo Қуйида кўрсатилган https://...trycloudflare.com ҳаволасини
echo кўчириб олиб, гуруҳга юборишингиз мумкин:
echo --------------------------------------------------------

if exist "%~dp0cloudflared.exe" (
    "%~dp0cloudflared.exe" tunnel --url http://localhost:5000
) else (
    "D:\Программы\videoconf-platform\cloudflared.exe" tunnel --url http://localhost:5000
)
pause
