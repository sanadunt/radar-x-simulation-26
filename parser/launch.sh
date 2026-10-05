#!/usr/bin/env bash
# ============================================================
#  RDXXB UDP Parser — Launcher (Linux / macOS)
#  ─────────────────────────────────────────────────────────
#  Usage:
#    chmod +x launch.sh && ./launch.sh [--flags-for-parser]
#
#  macOS tip: rename this file to "launch.command" to make
#  it double-clickable in Finder (Terminal opens automatically).
#
#  What it does:
#    1. Finds Python 3.8+
#    2. Creates/reuses a virtual environment in ../.venv
#    3. Installs paho-mqtt if missing
#    4. Runs parser.py, passing through any CLI arguments
# ============================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
VENV_DIR="$ROOT_DIR/.venv"

# ── Colour helpers ─────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
err()   { echo -e "${RED}[ERROR]${NC} $*"; }

# ── Find Python 3.8+ ──────────────────────────────────────────────────────────
find_python() {
  for cmd in python3 python3.13 python3.12 python3.11 python3.10 python3.9 python3.8 python; do
    if command -v "$cmd" &>/dev/null; then
      local ver major minor
      ver=$("$cmd" -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>/dev/null) || continue
      major="${ver%%.*}"; minor="${ver##*.}"
      if [[ "$major" -ge 3 && "$minor" -ge 8 ]]; then
        echo "$cmd"
        return 0
      fi
    fi
  done
  return 1
}

PYTHON=$(find_python) || {
  err "Python 3.8+ not found."
  err "Install from: https://www.python.org/downloads/"
  read -rp "Press Enter to exit…"
  exit 1
}
info "Python : $PYTHON  ($("$PYTHON" --version))"

# ── Create virtual environment if absent ──────────────────────────────────────
if [ ! -f "$VENV_DIR/pyvenv.cfg" ]; then
  info "Creating virtual environment at $VENV_DIR …"
  "$PYTHON" -m venv "$VENV_DIR"
  ok "Virtual environment created."
fi

PY="$VENV_DIR/bin/python3"
PIP="$VENV_DIR/bin/pip"

# Fallback for systems where the venv python is named just 'python'
[ -f "$PY" ] || PY="$VENV_DIR/bin/python"

# ── Install / verify dependencies ─────────────────────────────────────────────
DEPS_OK=0
"$PY" -c "import paho.mqtt.client" &>/dev/null && DEPS_OK=1

if [ "$DEPS_OK" -eq 0 ]; then
  info "Installing dependencies (first-time or update needed)…"
  "$PIP" install --quiet --upgrade pip
  "$PIP" install --quiet paho-mqtt
  ok "Dependencies installed."
fi

# ── Launch parser ──────────────────────────────────────────────────────────────
echo ""
info "Starting RDXXB UDP Parser…"
info "Config : $ROOT_DIR/runtime-config.json"
info "Args   : ${*:-(none)}"
echo "────────────────────────────────────────────────────────────"
exec "$PY" -u "$SCRIPT_DIR/parser.py" "$@"
