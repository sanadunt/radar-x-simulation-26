@echo off
:: ============================================================
::  RDXXB UDP Parser — Standalone Launcher (Windows)
::  ─────────────────────────────────────────────────────────
::  Self-contained: venv and config live in this folder.
::  Double-click to run, or: launch.bat [--args]
:: ============================================================
setlocal enabledelayedexpansion

set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "VENV_DIR=%SCRIPT_DIR%\.venv"
set "PY=%VENV_DIR%\Scripts\python.exe"
set "PIP=%VENV_DIR%\Scripts\pip.exe"

echo.
echo  RDXXB UDP Parser -- Standalone
echo  --------------------------------
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
  pause & exit /b 1
)
for /f "tokens=*" %%V in ('%PYTHON% --version 2^>^&1') do echo [INFO]  Python : %%V

:: ── Create venv inside this folder ───────────────────────────────────────────
if not exist "%VENV_DIR%\pyvenv.cfg" (
  echo [INFO]  Creating virtual environment...
  %PYTHON% -m venv "%VENV_DIR%"
  if errorlevel 1 ( echo [ERROR] Failed to create venv. & pause & exit /b 1 )
  echo [OK]    Virtual environment created.
)

:: ── Install paho-mqtt ─────────────────────────────────────────────────────────
"%PY%" -c "import paho.mqtt.client" >nul 2>&1
if errorlevel 1 (
  echo [INFO]  Installing paho-mqtt...
  "%PIP%" install --quiet --upgrade pip
  "%PIP%" install --quiet paho-mqtt
  if errorlevel 1 ( echo [ERROR] Failed to install paho-mqtt. & pause & exit /b 1 )
  echo [OK]    paho-mqtt installed.
)

:: ── Run ───────────────────────────────────────────────────────────────────────
echo [INFO]  Config : %SCRIPT_DIR%\config.json
echo  --------------------------------
"%PY%" -u "%SCRIPT_DIR%\parser.py" %*
