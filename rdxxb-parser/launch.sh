#!/usr/bin/env bash
# ============================================================
#  RDXXB UDP Parser — Standalone Launcher (Linux / macOS)
#  ─────────────────────────────────────────────────────────
#  Self-contained: venv and config live in this folder.
#
#  Usage:
#    chmod +x launch.sh && ./launch.sh
#    ./launch.sh --self-test
#    ./launch.sh --config /path/to/other-config.json
#
#  macOS tip: rename to "launch.command" to double-click in Finder.
# ============================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$SCRIPT_DIR/.venv"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info() { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()   { echo -e "${GREEN}[OK]${NC}    $*"; }
err()  { echo -e "${RED}[ERROR]${NC} $*"; }

echo ""
echo "  RDXXB UDP Parser — Standalone"
echo "  ──────────────────────────────"
echo ""

# ── Find Python 3.8+ ──────────────────────────────────────────────────────────
find_python() {
  for cmd in python3 python3.13 python3.12 python3.11 python3.10 python3.9 python3.8 python; do
    command -v "$cmd" &>/dev/null || continue
    ver=$("$cmd" -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>/dev/null) || continue
    major="${ver%%.*}"; minor="${ver##*.}"
    [[ "$major" -ge 3 && "$minor" -ge 8 ]] && echo "$cmd" && return 0
  done
  return 1
}

PYTHON=$(find_python) || {
  err "Python 3.8+ not found. Install from: https://www.python.org/downloads/"
  read -rp "Press Enter to exit…"; exit 1
}
info "Python  : $PYTHON  ($("$PYTHON" --version))"

# ── Virtual environment (inside this folder) ──────────────────────────────────
if [ ! -f "$VENV_DIR/pyvenv.cfg" ]; then
  info "Creating virtual environment at $VENV_DIR …"
  "$PYTHON" -m venv "$VENV_DIR"
  ok "Virtual environment created."
fi

PY="$VENV_DIR/bin/python3"
[ -f "$PY" ] || PY="$VENV_DIR/bin/python"
PIP="$VENV_DIR/bin/pip"

# ── Install dependencies ───────────────────────────────────────────────────────
"$PY" -c "import paho.mqtt.client" &>/dev/null || {
  info "Installing paho-mqtt…"
  "$PIP" install --quiet --upgrade pip
  "$PIP" install --quiet paho-mqtt
  ok "paho-mqtt installed."
}

# ── Run ───────────────────────────────────────────────────────────────────────
info "Config  : $SCRIPT_DIR/config.json"
info "Args    : ${*:-(none)}"
echo "  ──────────────────────────────"
exec "$PY" -u "$SCRIPT_DIR/parser.py" "$@"
