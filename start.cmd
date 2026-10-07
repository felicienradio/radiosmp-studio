@echo off
rem Lance le dashboard Flux (et Icecast). Double-cliquez sur ce fichier.
cd /d "%~dp0"
if not exist node_modules (
  echo Installation des dependances...
  call npm install --omit=dev || goto :error
)
start "" http://127.0.0.1:3000
node server\index.js
goto :eof

:error
echo.
echo Echec de l'installation. Verifiez que Node.js 22.13 ou plus recent est installe : https://nodejs.org
pause
