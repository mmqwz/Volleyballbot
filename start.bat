@echo off
cd /d "%~dp0"
if not exist ".env" (
  echo Создайте файл .env на основе .env.example
  echo и укажите BOT_TOKEN и ADMIN_IDS
  pause
  exit /b 1
)
if not exist "node_modules" (
  call npm install
)
call npm start
pause
