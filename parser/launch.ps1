# ============================================================
#  RDXXB UDP Parser — Launcher (Windows PowerShell)
#  ─────────────────────────────────────────────────────────
#  Usage:
#    Right-click → "Run with PowerShell"   — OR —
#    powershell -ExecutionPolicy Bypass -File launch.ps1 [args]
#
#  If execution policy blocks it:
#    Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
# ============================================================
$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir   = Split-Path -Parent $ScriptDir
$VenvDir   = Join-Path $RootDir '.venv'

# ── Console helpers ────────────────────────────────────────────────────────────
function Info  { param($msg) Write-Host "[INFO]  $msg" -ForegroundColor Cyan }
function Ok    { param($msg) Write-Host "[OK]    $msg" -ForegroundColor Green }
function Warn  { param($msg) Write-Host "[WARN]  $msg" -ForegroundColor Yellow }
function Fail  { param($msg) Write-Host "[ERROR] $msg" -ForegroundColor Red; Read-Host "Press Enter to exit"; exit 1 }

Write-Host ""
Write-Host " =====================================================" -ForegroundColor DarkCyan
Write-Host "  RDXXB UDP Parser Launcher (PowerShell)" -ForegroundColor Cyan
Write-Host " =====================================================" -ForegroundColor DarkCyan
Write-Host ""

# ── Find Python 3.8+ ──────────────────────────────────────────────────────────
$PythonCmd = $null
foreach ($cmd in @('python3', 'python', 'py')) {
  try {
    $verStr = & $cmd --version 2>&1 | Out-String
    if ($verStr -match '(\d+)\.(\d+)') {
      $major = [int]$Matches[1]; $minor = [int]$Matches[2]
      if ($major -ge 3 -and $minor -ge 8) { $PythonCmd = $cmd; break }
    }
  } catch {}
}
if (-not $PythonCmd) {
  Fail "Python 3.8+ not found.`nInstall from: https://www.python.org/downloads/"
}
Info "Python : $PythonCmd  ($(& $PythonCmd --version 2>&1))"

# ── Executable paths inside venv (Windows vs Linux/macOS) ─────────────────────
$isWin  = $IsWindows -or ($env:OS -eq 'Windows_NT')
if ($isWin) {
  $PyExe  = Join-Path $VenvDir 'Scripts\python.exe'
  $PipExe = Join-Path $VenvDir 'Scripts\pip.exe'
} else {
  $PyExe  = Join-Path $VenvDir 'bin/python3'
  $PipExe = Join-Path $VenvDir 'bin/pip'
}

# ── Create virtual environment ────────────────────────────────────────────────
if (-not (Test-Path (Join-Path $VenvDir 'pyvenv.cfg'))) {
  Info "Creating virtual environment at $VenvDir …"
  & $PythonCmd -m venv $VenvDir
  Ok "Virtual environment created."
}

# ── Install / verify dependencies ─────────────────────────────────────────────
$needInstall = $false
try { & $PyExe -c "import paho.mqtt.client" | Out-Null } catch { $needInstall = $true }

if ($needInstall) {
  Info "Installing dependencies…"
  & $PipExe install --quiet --upgrade pip
  & $PipExe install --quiet paho-mqtt
  Ok "Dependencies installed."
}

# ── Launch parser ──────────────────────────────────────────────────────────────
Write-Host ""
Info "Starting RDXXB UDP Parser…"
Info "Config : $RootDir\runtime-config.json"
Write-Host "──────────────────────────────────────────────────────" -ForegroundColor DarkGray

$ParserPy = Join-Path $ScriptDir 'parser.py'
& $PyExe -u $ParserPy @args
