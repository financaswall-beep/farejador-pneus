@echo off
cd /d "%~dp0..\.."
node scripts\lab-negociacao\iniciar.mjs
if errorlevel 1 pause
