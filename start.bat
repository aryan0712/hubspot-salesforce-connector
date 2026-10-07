@echo off
title CRM-Sync
cd /d "%~dp0"

echo ===================================================
echo               Starting CRM-Sync
echo ===================================================

:: 1. Check if node_modules exists
if not exist "node_modules\" (
    echo [1/3] Dependencies not found. Running npm install...
    call npm.cmd install
    if %errorlevel% neq 0 (
        echo Error: npm install failed.
        pause
        exit /b 1
    )
) else (
    echo [1/3] Dependencies verified.
)

:: 2. Check if PostgreSQL is already running on port 5432
echo [2/3] Checking PostgreSQL database...
powershell -NoProfile -Command "$c = New-Object Net.Sockets.TcpClient; try { $c.Connect('127.0.0.1', 5432); exit 0 } catch { exit 1 } finally { $c.Dispose() }" >nul 2>&1
if %errorlevel% neq 0 (
    echo Starting project-local PostgreSQL database...
    start "CRM-Sync Database" /min cmd /c "npm.cmd run db:local"
    echo Waiting for PostgreSQL to become ready...
    powershell -NoProfile -Command "$w=0; while($w -lt 30) { $c = New-Object Net.Sockets.TcpClient; try { $c.Connect('127.0.0.1', 5432); $c.Dispose(); exit 0 } catch { Start-Sleep -Milliseconds 500; $w++ } }; exit 1" >nul 2>&1
    if %errorlevel% neq 0 (
        echo [Error] PostgreSQL failed to start on port 5432.
        pause
        exit /b 1
    )
    echo PostgreSQL is ready!
) else (
    echo PostgreSQL is already active on port 5432.
)

:: 3. Start application server and open browser once ready
echo [3/3] Starting CRM-Sync application server...
start /b "" powershell -NoProfile -Command "$w=0; while($w -lt 40) { try { $res = Invoke-WebRequest -Uri 'http://localhost:3000/health' -UseBasicParsing -TimeoutSec 1; if ($res.StatusCode -eq 200) { Start-Process 'http://localhost:3000/'; exit 0 } } catch { Start-Sleep -Milliseconds 500; $w++ } }; exit 1"
call npm.cmd run dev


