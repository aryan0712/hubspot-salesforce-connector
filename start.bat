@echo off
title CRM-Sync
cd /d "%~dp0"

:: 0. Resolve Node.js binary and fix PATH (avoid trailing-space bug in %ProgramFiles%)
if exist "C:\Program Files\nodejs\node.exe" (
    set "NODE_EXE=C:\Program Files\nodejs\node.exe"
    set "PATH=C:\Program Files\nodejs;%APPDATA%\npm;%PATH%"
) else if exist "C:\Program Files (x86)\nodejs\node.exe" (
    set "NODE_EXE=C:\Program Files (x86)\nodejs\node.exe"
    set "PATH=C:\Program Files (x86)\nodejs;%APPDATA%\npm;%PATH%"
) else (
    set "NODE_EXE=node"
)

echo ===================================================
echo               Starting CRM-Sync
echo ===================================================

:: 1. Check if node_modules exists
if not exist "node_modules\" (
    echo [1/3] Dependencies not found. Running npm install...
    call npm install
    if %errorlevel% neq 0 (
        echo Error: npm install failed.
        pause
        exit /b 1
    )
) else (
    echo [1/3] Dependencies verified.
)

:: 2. Ensure PostgreSQL is active on port 5432
echo [2/3] Checking PostgreSQL database...
"%NODE_EXE%" scripts\startDb.mjs
if %errorlevel% neq 0 (
    pause
    exit /b 1
)

:: 3. Start application server and open browser once ready
echo [3/3] Starting CRM-Sync application server...
start /b "" "%NODE_EXE%" scripts\waitAndOpen.mjs
"%NODE_EXE%" node_modules\tsx\dist\cli.mjs watch src/server.ts



