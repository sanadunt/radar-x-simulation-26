@echo off
:: ============================================================
::  RDXXB Parser — PyInstaller Build Script (Windows)
::  ─────────────────────────────────────────────────────────
::  Produces a standalone .exe that runs WITHOUT Python.
::
::  Usage: double-click or run from cmd.exe
::
::  Output:
::    parser\dist\rdxxb-parser.exe
::
::  Deployment:
::    Copy `dist\rdxxb-parser.exe` + `runtime-config.json`
::    to the target machine (same folder), then double-click
::    or run: rdxxb-parser.exe
:: ============================================================
setlocal enabledelayedexpansion

set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
for %%I in ("%SCRIPT_DIR%\..") do set "ROOT_DIR=%%~fI"
set "VENV_DIR=%ROOT_DIR%\.venv"
set "PY=%VENV_DIR%\Scripts\python.exe"
set "PIP=%VENV_DIR%\Scripts\pip.exe"
set "PYINST=%VENV_DIR%\Scripts\pyinstaller.exe"
set "DIST_DIR=%SCRIPT_DIR%\dist"
set "BUILD_TMP=%SCRIPT_DIR%\.build_tmp"

echo.
echo  =====================================================
echo   RDXXB Parser -- PyInstaller Build (Windows)
echo  =====================================================
echo.

:: ── Check venv ────────────────────────────────────────────────────────────────
if not exist "%VENV_DIR%\pyvenv.cfg" (
  echo [BUILD] Virtual environment not found. Run launch.bat first.
  pause & exit /b 1
)

:: ── Install build deps ────────────────────────────────────────────────────────
echo [BUILD] Installing/updating PyInstaller and dependencies...
"%PIP%" install --quiet --upgrade pip
"%PIP%" install --quiet paho-mqtt pyinstaller
if errorlevel 1 (
  echo [ERROR] Failed to install build tools.
  pause & exit /b 1
)

:: ── Clean previous build ──────────────────────────────────────────────────────
if exist "%DIST_DIR%\rdxxb-parser.exe" del /f /q "%DIST_DIR%\rdxxb-parser.exe"
if exist "%BUILD_TMP%" rmdir /s /q "%BUILD_TMP%"

:: ── Run PyInstaller ───────────────────────────────────────────────────────────
echo [BUILD] Running PyInstaller...
"%PYINST%" ^
  --onefile ^
  --name rdxxb-parser ^
  --distpath "%DIST_DIR%" ^
  --workpath "%BUILD_TMP%" ^
  --specpath "%SCRIPT_DIR%" ^
  --noconfirm ^
  "%SCRIPT_DIR%\parser.py"

if errorlevel 1 (
  echo [ERROR] PyInstaller failed. See output above.
  pause & exit /b 1
)

:: ── Copy config ───────────────────────────────────────────────────────────────
if not exist "%DIST_DIR%\runtime-config.json" (
  echo [BUILD] Copying runtime-config.json to dist\ ...
  copy "%ROOT_DIR%\runtime-config.json" "%DIST_DIR%\runtime-config.json" >nul
)

:: ── Cleanup ───────────────────────────────────────────────────────────────────
if exist "%BUILD_TMP%" rmdir /s /q "%BUILD_TMP%"
if exist "%SCRIPT_DIR%\rdxxb-parser.spec" del /f /q "%SCRIPT_DIR%\rdxxb-parser.spec"

echo.
echo [BUILD] Done!
echo [BUILD] Binary : %DIST_DIR%\rdxxb-parser.exe
echo [BUILD] Config : %DIST_DIR%\runtime-config.json
echo.
echo  Deploy both files to the target machine, then run:
echo    rdxxb-parser.exe
echo    rdxxb-parser.exe --self-test
echo.
pause
