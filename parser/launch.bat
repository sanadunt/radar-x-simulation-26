@echo off
:: ============================================================
::  RDXXB UDP Parser — Launcher (Windows CMD)
::  ─────────────────────────────────────────────────────────
::  Usage:
::    Double-click this file   — OR —   drag it to cmd.exe
::    To pass flags:  launch.bat --self-test
::
::  What it does:
::    1. Finds Python 3.8+
::    2. Creates/reuses a virtual environment in ..\.venv
::    3. Installs paho-mqtt if missing
::    4. Runs parser.py, passing through any CLI arguments
:: ============================================================
setlocal enabledelayedexpansion

set "SCRIPT_DIR=%~dp0"
:: Remove trailing backslash
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
for %%I in ("%SCRIPT_DIR%\..") do set "ROOT_DIR=%%~fI"
set "VENV_DIR=%ROOT_DIR%\.venv"
set "PY=%VENV_DIR%\Scripts\python.exe"
set "PIP=%VENV_DIR%\Scripts\pip.exe"

echo.
echo  =====================================================
echo   RDXXB UDP Parser Launcher
echo  =====================================================
echo.

:: ── Find Python ───────────────────────────────────────────────────────────────
set "PYTHON="
for %%P in (python3 python py) do (
  if "!PYTHON!"=="" (
    %%P --version >nul 2>&1 && (
      for /f "tokens=2" %%V in ('%%P --version 2^>^&1') do (
        for /f "tokens=1,2 delims=." %%A in ("%%V") do (
          if %%A GEQ 3 if %%B GEQ 8 set "PYTHON=%%P"
        )
      )
    )
  )
)

if "%PYTHON%"=="" (
  echo [ERROR] Python 3.8+ not found.
  echo         Install from: https://www.python.org/downloads/
  echo         Make sure "Add Python to PATH" is checked during install.
  pause
  exit /b 1
)

for /f "tokens=*" %%V in ('%PYTHON% --version 2^>^&1') do echo [INFO]  Python : %%V

:: ── Create virtual environment ────────────────────────────────────────────────
if not exist "%VENV_DIR%\pyvenv.cfg" (
  echo [INFO]  Creating virtual environment at %VENV_DIR% ...
  %PYTHON% -m venv "%VENV_DIR%"
  if errorlevel 1 (
    echo [ERROR] Failed to create virtual environment.
    pause & exit /b 1
  )
  echo [OK]    Virtual environment created.
)

:: ── Install / verify dependencies ─────────────────────────────────────────────
"%PY%" -c "import paho.mqtt.client" >nul 2>&1
if errorlevel 1 (
  echo [INFO]  Installing dependencies...
  "%PIP%" install --quiet --upgrade pip
  "%PIP%" install --quiet paho-mqtt
  if errorlevel 1 (
    echo [ERROR] Failed to install paho-mqtt.
    pause & exit /b 1
  )
  echo [OK]    Dependencies installed.
)

:: ── Launch parser ─────────────────────────────────────────────────────────────
echo.
echo [INFO]  Starting RDXXB UDP Parser...
echo [INFO]  Config : %ROOT_DIR%\runtime-config.json
echo ──────────────────────────────────────────────────────
"%PY%" -u "%SCRIPT_DIR%\parser.py" %*
