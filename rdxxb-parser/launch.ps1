# ============================================================
#  RDXXB UDP Parser — Standalone Launcher (PowerShell)
#  ─────────────────────────────────────────────────────────
#  Right-click → "Run with PowerShell"   — OR —
#  powershell -ExecutionPolicy Bypass -File launch.ps1 [args]
# ============================================================
$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$VenvDir   = Join-Path $ScriptDir '.venv'
$isWin     = $IsWindows -or ($env:OS -eq 'Windows_NT')
$PyExe     = if ($isWin) { Join-Path $VenvDir 'Scripts\python.exe' } else { Join-Path $VenvDir 'bin/python3' }
$PipExe    = if ($isWin) { Join-Path $VenvDir 'Scripts\pip.exe'    } else { Join-Path $VenvDir 'bin/pip' }

function Info { param($m) Write-Host "[INFO]  $m" -ForegroundColor Cyan }
function Ok   { param($m) Write-Host "[OK]    $m" -ForegroundColor Green }
function Fail { param($m) Write-Host "[ERROR] $m" -ForegroundColor Red; Read-Host "Press Enter"; exit 1 }

Write-Host ""
Write-Host "  RDXXB UDP Parser -- Standalone" -ForegroundColor Cyan
Write-Host "  --------------------------------" -ForegroundColor DarkCyan
Write-Host ""

# ── Find Python ────────────────────────────────────────────────────────────────
$PythonCmd = $null
foreach ($cmd in @('python3','python','py')) {
  try {
    $v = & $cmd --version 2>&1 | Out-String
    if ($v -match '(\d+)\.(\d+)') {
      if ([int]$Matches[1] -ge 3 -and [int]$Matches[2] -ge 8) { $PythonCmd = $cmd; break }
    }
  } catch {}
}
if (-not $PythonCmd) { Fail "Python 3.8+ not found.`nInstall: https://www.python.org/downloads/" }
Info "Python  : $PythonCmd  ($(& $PythonCmd --version 2>&1))"

# ── Create venv inside this folder ────────────────────────────────────────────
if (-not (Test-Path (Join-Path $VenvDir 'pyvenv.cfg'))) {
  Info "Creating virtual environment at $VenvDir …"
  & $PythonCmd -m venv $VenvDir
  Ok "Virtual environment created."
}

# ── Install paho-mqtt ──────────────────────────────────────────────────────────
$needInstall = $false
try { & $PyExe -c "import paho.mqtt.client" | Out-Null } catch { $needInstall = $true }
if ($needInstall) {
  Info "Installing paho-mqtt…"
  & $PipExe install --quiet --upgrade pip
  & $PipExe install --quiet paho-mqtt
  Ok "paho-mqtt installed."
}

# ── Run ────────────────────────────────────────────────────────────────────────
Info "Config  : $ScriptDir\config.json"
Write-Host "  --------------------------------" -ForegroundColor DarkGray
& $PyExe -u (Join-Path $ScriptDir 'parser.py') @args
