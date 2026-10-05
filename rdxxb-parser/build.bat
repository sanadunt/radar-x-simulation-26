@echo off
:: ============================================================
::  RDXXB Parser — PyInstaller Build Script (Windows)
::  ─────────────────────────────────────────────────────────
::  Produces a standalone .exe. No Python needed on target.
::
::  Usage: double-click or: build.bat
::
::  Output:
::    dist\rdxxb-parser.exe   ← binary
::    dist\config.json        ← config (edit before deploy)
::
::  Deploy: copy dist\ contents, then double-click rdxxb-parser.exe
:: ============================================================
setlocal enabledelayedexpansion

set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "VENV_DIR=%SCRIPT_DIR%\.venv"
set "PY=%VENV_DIR%\Scripts\python.exe"
set "PIP=%VENV_DIR%\Scripts\pip.exe"
set "PYINST=%VENV_DIR%\Scripts\pyinstaller.exe"
set "DIST_DIR=%SCRIPT_DIR%\dist"
set "BUILD_TMP=%SCRIPT_DIR%\.build_tmp"

echo.
echo  RDXXB Parser -- PyInstaller Build (Windows)
echo  ---------------------------------------------
echo.

if not exist "%VENV_DIR%\pyvenv.cfg" (
  echo [BUILD] Venv not found. Run launch.bat first.
  pause & exit /b 1
)

echo [BUILD] Installing/updating build tools...
"%PIP%" install --quiet --upgrade pip
"%PIP%" install --quiet paho-mqtt pyinstaller
if errorlevel 1 ( echo [ERROR] Build tool install failed. & pause & exit /b 1 )

if exist "%DIST_DIR%\rdxxb-parser.exe" del /f /q "%DIST_DIR%\rdxxb-parser.exe"
if exist "%BUILD_TMP%" rmdir /s /q "%BUILD_TMP%"

echo [BUILD] Running PyInstaller...
"%PYINST%" ^
  --onefile ^
  --name rdxxb-parser ^
  --distpath "%DIST_DIR%" ^
  --workpath "%BUILD_TMP%" ^
  --specpath "%SCRIPT_DIR%" ^
  --noconfirm ^
  "%SCRIPT_DIR%\parser.py"
if errorlevel 1 ( echo [ERROR] PyInstaller failed. & pause & exit /b 1 )

copy "%SCRIPT_DIR%\config.json" "%DIST_DIR%\config.json" >nul

if exist "%BUILD_TMP%" rmdir /s /q "%BUILD_TMP%"
if exist "%SCRIPT_DIR%\rdxxb-parser.spec" del /f /q "%SCRIPT_DIR%\rdxxb-parser.spec"

echo.
echo [BUILD] Done!
echo [BUILD] Binary : %DIST_DIR%\rdxxb-parser.exe
echo [BUILD] Config : %DIST_DIR%\config.json
echo.
echo  Deploy both files, then run: rdxxb-parser.exe
echo.
pause
