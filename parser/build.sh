#!/usr/bin/env bash
# ============================================================
#  RDXXB Parser — PyInstaller Build Script (Linux / macOS)
#  ─────────────────────────────────────────────────────────
#  Produces a single-file standalone binary that runs
#  WITHOUT Python installed on the target machine.
#
#  Usage:
#    chmod +x build.sh && ./build.sh
#
#  Output:
#    parser/dist/rdxxb-parser          (Linux)
#    parser/dist/rdxxb-parser          (macOS)
#
#  Deployment:
#    Copy `dist/rdxxb-parser` + `runtime-config.json`
#    to the target machine (same folder), then run:
#      ./rdxxb-parser
# ============================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
VENV_DIR="$ROOT_DIR/.venv"

CYAN='\033[0;36m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${CYAN}[BUILD]${NC} $*"; }
ok()    { echo -e "${GREEN}[BUILD]${NC} $*"; }
warn()  { echo -e "${YELLOW}[BUILD]${NC} $*"; }

echo ""
echo "  ====================================================="
echo "   RDXXB Parser – PyInstaller Build"
echo "  ====================================================="
echo ""

# ── Activate venv ─────────────────────────────────────────────────────────────
if [ ! -f "$VENV_DIR/pyvenv.cfg" ]; then
  info "Virtual environment not found. Run launch.sh first, or create it now…"
  python3 -m venv "$VENV_DIR"
fi
source "$VENV_DIR/bin/activate"

# ── Install build deps ────────────────────────────────────────────────────────
info "Installing/updating PyInstaller and dependencies…"
pip install --quiet --upgrade pip
pip install --quiet paho-mqtt pyinstaller

# ── Clean previous build ──────────────────────────────────────────────────────
BUILD_TMP="$SCRIPT_DIR/.build_tmp"
DIST_DIR="$SCRIPT_DIR/dist"
rm -rf "$BUILD_TMP" "$DIST_DIR/rdxxb-parser"

# ── Run PyInstaller ───────────────────────────────────────────────────────────
info "Running PyInstaller…"
pyinstaller \
  --onefile \
  --name rdxxb-parser \
  --distpath "$DIST_DIR" \
  --workpath "$BUILD_TMP" \
  --specpath "$SCRIPT_DIR" \
  --noconfirm \
  "$SCRIPT_DIR/parser.py"

# ── Copy default config next to binary ───────────────────────────────────────
if [ ! -f "$DIST_DIR/runtime-config.json" ]; then
  info "Copying default runtime-config.json to dist/ …"
  cp "$ROOT_DIR/runtime-config.json" "$DIST_DIR/runtime-config.json"
fi

# ── Cleanup temp files ────────────────────────────────────────────────────────
rm -rf "$BUILD_TMP" "$SCRIPT_DIR/rdxxb-parser.spec"

echo ""
ok "Build complete!"
ok "Binary : $DIST_DIR/rdxxb-parser"
ok "Config : $DIST_DIR/runtime-config.json"
echo ""
echo "  Deploy both files to the target machine, then run:"
echo "    ./rdxxb-parser"
echo "    ./rdxxb-parser --self-test"
echo ""
