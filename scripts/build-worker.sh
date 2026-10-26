#!/usr/bin/env bash
# Build driver/worker/sa44b-worker.c for every target we can reach from here.
#
#   scripts/build-worker.sh            # host build + win32-x64 if mingw-w64 is installed
#   scripts/build-worker.sh --host     # host build only
#
# Outputs land in driver/worker/bin/<platform>-<arch>/, which is what
# driver/worker-client.js looks for. The Windows build is the one that talks to
# real hardware (Signal Hound ships sa_api.dll for Windows only); the host build
# is for running the plugin in mock mode on a development machine.
#
# Prerequisites: a C compiler for the host (clang on macOS, gcc on Linux) and,
# for the Windows target, mingw-w64 (`brew install mingw-w64` on macOS,
# `apt install gcc-mingw-w64-x86-64` on Debian/Ubuntu).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/driver/worker/sa44b-worker.c"
OUT="$ROOT/driver/worker/bin"
CFLAGS="-O2 -Wall -Wextra -std=c11"

host_target() {
  local os arch
  case "$(uname -s)" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) os=unknown ;;
  esac
  case "$(uname -m)" in
    arm64 | aarch64) arch=arm64 ;;
    x86_64 | amd64) arch=x64 ;;
    *) arch=unknown ;;
  esac
  echo "$os-$arch"
}

build_host() {
  local target
  target="$(host_target)"
  mkdir -p "$OUT/$target"
  echo "[build-worker] $target"
  cc $CFLAGS -o "$OUT/$target/sa44b-worker" "$SRC" -lm
}

build_win32_x64() {
  local cc=x86_64-w64-mingw32-gcc
  if ! command -v "$cc" >/dev/null 2>&1; then
    echo "[build-worker] win32-x64 skipped: $cc not found (brew install mingw-w64)"
    return 0
  fi
  mkdir -p "$OUT/win32-x64"
  echo "[build-worker] win32-x64"
  # static libgcc so the exe has no mingw runtime dependency on the user's PC
  "$cc" $CFLAGS -static -o "$OUT/win32-x64/sa44b-worker.exe" "$SRC" -lm
}

build_host
if [[ "${1:-}" != "--host" ]]; then
  build_win32_x64
fi
echo "[build-worker] done"
ls -la "$OUT"/*/
