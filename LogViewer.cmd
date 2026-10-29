@echo off
rem Log Viewer launcher: double-click to open the app in your browser.
rem First run installs dependencies and builds the app; later runs start in seconds.
rem   LogViewer.cmd           start (rebuilds automatically after a git pull)
rem   LogViewer.cmd rebuild   force a fresh build (e.g. after editing the code)
setlocal
title Log Viewer
cd /d "%~dp0"

set "PORT=4173"
set "URL=http://localhost:%PORT%/"
set "OPEN=--open"
if defined LOGVIEWER_NO_OPEN set "OPEN="

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer is required. Install it from https://nodejs.org/ and run this again.
  goto :fail
)

rem Already running (e.g. double-clicked twice)? Just open the browser.
curl -s -o nul "%URL%" 2>nul
if not errorlevel 1 (
  if defined OPEN start "" "%URL%"
  exit /b 0
)

if not exist "node_modules\" (
  echo Installing dependencies - first run only, this takes a minute...
  call npm ci
  if errorlevel 1 goto :fail
)

rem Rebuild when the code changed since the last build (git commit differs) or when asked to.
set "REV="
for /f %%r in ('git rev-parse HEAD 2^>nul') do set "REV=%%r"
set "BUILT="
if exist "dist\.build-rev" set /p BUILT=<"dist\.build-rev"
if /i "%~1"=="rebuild" goto :build
if not exist "dist\index.html" goto :build
if defined REV if not "%REV%"=="%BUILT%" goto :build
goto :serve

:build
echo Building the app...
call npm run build
if errorlevel 1 goto :fail
if defined REV (echo %REV%)>"dist\.build-rev"

:serve
echo.
echo   Log Viewer is running at %URL%
echo   Your log files are read only in the browser on this PC.
echo   Close this window to stop it.
echo.
call npm run preview -- --port %PORT% --strictPort %OPEN%
exit /b 0

:fail
echo.
echo Log Viewer could not start (see the messages above).
pause
exit /b 1
