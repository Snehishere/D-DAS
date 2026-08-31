@echo off
cd /d "S:\antigravity\d-das"
if not exist "node_modules" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 exit /b 1
)
start "" cmd /c "npm start && exit"