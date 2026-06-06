@echo off
echo ============================================
echo  AutoHR - Clean Install
echo ============================================

REM Remove any leftover Cargo files from old extractions (not src-tauri ones)
if exist "Cargo.lock" (
    echo Removing stale Cargo.lock from root...
    del /f Cargo.lock
)

echo Installing Node dependencies...
call npm install
if errorlevel 1 ( echo npm install failed & pause & exit /b 1 )

echo Installing better-sqlite3...
call npm install better-sqlite3 --save-dev
if errorlevel 1 ( echo better-sqlite3 install failed & pause & exit /b 1 )

echo Seeding database...
call npm run seed-db
if errorlevel 1 ( echo seed-db failed & pause & exit /b 1 )

echo.
echo ============================================
echo  Build complete. Now run:
echo    npm run tauri:dev   (development)
echo    npm run tauri:build (release installer)
echo ============================================
pause
