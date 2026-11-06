@echo off
:: Tab Organizer Launcher
:: Starts the backend silently and opens Brave browser

setlocal

set BACKEND_DIR=%~dp0backend
set PYTHON=C:\Program Files\Python314\python.exe
set BRAVE=C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe
set PORT=8742

:: Check if backend is already running on port 8742
netstat -ano | findstr ":%PORT% " | findstr "LISTENING" >nul 2>&1
if %errorlevel% == 0 (
    echo Backend already running on port %PORT%.
    goto :launch_brave
)

:: Start backend silently in the background (no console window)
echo Starting Tab Organizer backend...
start "" /B /MIN cmd /c "cd /d "%BACKEND_DIR%" && "%PYTHON%" -m uvicorn app.main:app --host 127.0.0.1 --port %PORT% >> "%BACKEND_DIR%\launcher.log" 2>&1"

:: Wait up to 8 seconds for backend to become ready
set /a attempts=0
:wait_loop
timeout /t 1 /nobreak >nul
set /a attempts+=1
netstat -ano | findstr ":%PORT% " | findstr "LISTENING" >nul 2>&1
if %errorlevel% == 0 goto :backend_ready
if %attempts% lss 8 goto :wait_loop

echo Backend did not start in time. Brave will still open.
goto :launch_brave

:backend_ready
echo Backend is ready.

:launch_brave
echo Launching Brave...
start "" "%BRAVE%"

endlocal
