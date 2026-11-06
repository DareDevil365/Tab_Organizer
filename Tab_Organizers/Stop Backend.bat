@echo off
setlocal

set PORT=8742
set FOUND=0

echo Stopping Tab Organizer backend on port %PORT%...

for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PORT% " ^| findstr "LISTENING"') do (
    taskkill /F /PID %%a >nul 2>&1
    set FOUND=1
)

if %FOUND%==1 (
    echo [SUCCESS] Backend server stopped successfully.
) else (
    echo [INFO] No backend server was running on port %PORT%.
)

timeout /t 2 >nul
endlocal
