@echo off
echo ============================================
echo  AutoHR - Clean Install
echo ============================================

REM Cargo.lock in the root is the workspace lock file. Keep it for reproducible builds.

echo Installing Node dependencies from package-lock.json...
call npm ci
if errorlevel 1 ( echo npm ci failed & pause & exit /b 1 )

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
