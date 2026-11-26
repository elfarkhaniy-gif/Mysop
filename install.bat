@echo off
REM Windows installer: checks Node.js, creates .env, adds a first key, runs the tests.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install Node.js 20+ from https://nodejs.org and run this again.
  pause
  exit /b 1
)
node scripts\setup.js
if errorlevel 1 ( pause & exit /b 1 )
node --test test\router.test.js test\robustness.test.js >nul 2>nul && echo Self-test: OK || echo Self-test failed: run "npm test" to see why.
echo.
set /p P=Add a provider key now? Enter provider name (groq, gemini, mistral, openrouter, cerebras, nvidia, github) or press Enter to skip: 
if not "%P%"=="" node src\cli.js keys add %P%
echo.
echo Done. Start the server by double-clicking start.bat
pause
