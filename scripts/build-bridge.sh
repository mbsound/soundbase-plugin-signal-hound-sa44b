#!/usr/bin/env bash
# Build driver/bridge/ftdi-bridge.c for this Mac.
#
# Prerequisite: brew install libftdi   (pulls in libusb)
#
# The bridge is the macOS half of running Signal Hound's x86-64 Linux SA API on
# Apple Silicon: it holds the SA44B's FTDI ports through libusb and serves
# FTDI D2XX calls over TCP (loopback only) to the shim inside the Linux VM.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/driver/bridge/bin"
PREFIX="$(brew --prefix 2>/dev/null || echo /opt/homebrew)"
mkdir -p "$OUT"
echo "[build-bridge] ftdi-bridge (host)"
cc -O2 -Wall -Wextra -std=gnu11 -o "$OUT/ftdi-bridge" "$ROOT/driver/bridge/ftdi-bridge.c" \
  -I"$PREFIX/include" -L"$PREFIX/lib" -lftdi1 -lusb-1.0 -lpthread
ls -la "$OUT/ftdi-bridge"
