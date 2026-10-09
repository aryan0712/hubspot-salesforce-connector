@echo off
title Stop CRM-Sync
cd /d "%~dp0"

echo Stopping CRM-Sync and PostgreSQL...
powershell -NoProfile -Command "$procs = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*src/server.ts*' -or $_.CommandLine -like '*src/db/local.ts*' -or ($_.Name -eq 'postgres.exe' -and $_.ExecutablePath -like '*embedded-postgres*') }; foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }; Write-Host 'Stopped all CRM-Sync processes.'"
echo Done.

