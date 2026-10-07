@echo off
title CRM-Sync
cd /d "%~dp0"

echo ===================================================
echo               Starting CRM-Sync
echo ===================================================

:: 1. Check if node_modules exists
if not exist "node_modules\" (
    echo [1/4] node_modules not found. Running npm install...
    call npm install
    if %errorlevel% neq 0 (
        echo Error: npm install failed.
        pause
        exit /b 1
    )
) else (
    echo [1/4] Dependencies verified.
)

:: 2. Check if PostgreSQL is already running on port 5432
echo [2/4] Checking PostgreSQL database...
powershell -NoProfile -Command "if (Test-NetConnection -ComputerName localhost -Port 5432 -InformationLevel Quiet) { exit 0 } else { exit 1 }" >nul 2>&1
if %errorlevel% neq 0 (
    echo Starting project-local PostgreSQL database...
    start "CRM-Sync Database" /min cmd /k "npm run db:local"
    echo Waiting for PostgreSQL to become ready...
    timeout /t 5 /nobreak >nul
) else (
    echo PostgreSQL is already active on port 5432.
)

:: 3. Run database migrations to ensure schema is current
echo [3/4] Ensuring database schema is up to date...
call npm run db:migrate
if %errorlevel% neq 0 (
    echo [Warning] Migration check returned non-zero. Proceeding to server startup...
)

:: 4. Start the server and launch browser
echo [4/4] Starting CRM-Sync application server...
start http://localhost:3000/
call npm run dev
