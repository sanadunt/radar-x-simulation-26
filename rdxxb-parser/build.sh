#!/usr/bin/env bash
# ============================================================
#  RDXXB Parser — PyInstaller Build Script (Linux / macOS)
#  ─────────────────────────────────────────────────────────
#  Produces a standalone binary. No Python needed on target.
#
#  Usage:  chmod +x build.sh && ./build.sh
#
#  Output:
#    dist/rdxxb-parser          ← binary
#    dist/config.json           ← copy of config (edit before deploy)
#
#  Deploy: copy dist/ contents to target machine, run:
#    ./rdxxb-parser
#    ./rdxxb-parser --self-test
# ============================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$SCRIPT_DIR/.venv"
DIST_DIR="$SCRIPT_DIR/dist"
BUILD_TMP="$SCRIPT_DIR/.build_tmp"

CYAN='\033[0;36m'; GREEN='\033[0;32m'; NC='\033[0m'
info() { echo -e "${CYAN}[BUILD]${NC} $*"; }
ok()   { echo -e "${GREEN}[BUILD]${NC} $*"; }

echo ""
echo "  RDXXB Parser — PyInstaller Build"
echo "  ─────────────────────────────────"
echo ""

# ── Activate / create venv ────────────────────────────────────────────────────
if [ ! -f "$VENV_DIR/pyvenv.cfg" ]; then
  info "Creating virtual environment first (run launch.sh once to set it up)…"
  python3 -m venv "$VENV_DIR"
fi
source "$VENV_DIR/bin/activate"

# ── Install build deps ────────────────────────────────────────────────────────
info "Installing/updating build tools…"
pip install --quiet --upgrade pip
pip install --quiet paho-mqtt pyinstaller

# ── Clean previous ────────────────────────────────────────────────────────────
rm -rf "$BUILD_TMP" "$DIST_DIR/rdxxb-parser"

# ── Build ─────────────────────────────────────────────────────────────────────
info "Running PyInstaller…"
pyinstaller \
  --onefile \
  --name rdxxb-parser \
  --distpath "$DIST_DIR" \
  --workpath "$BUILD_TMP" \
  --specpath "$SCRIPT_DIR" \
  --noconfirm \
  "$SCRIPT_DIR/parser.py"

# ── Copy config alongside binary ──────────────────────────────────────────────
cp "$SCRIPT_DIR/config.json" "$DIST_DIR/config.json"

# ── Cleanup ───────────────────────────────────────────────────────────────────
rm -rf "$BUILD_TMP" "$SCRIPT_DIR/rdxxb-parser.spec"

echo ""
ok "Done!  Binary : $DIST_DIR/rdxxb-parser"
ok "       Config : $DIST_DIR/config.json"
echo ""
echo "  Deploy both files, then run: ./rdxxb-parser"
echo ""
