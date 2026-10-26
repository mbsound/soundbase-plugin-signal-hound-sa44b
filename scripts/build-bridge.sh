#!/usr/bin/env bash
# Build driver/bridge/ftdi-bridge.c for this Mac as a self-contained binary.
#
#   scripts/build-bridge.sh            # driver/bridge/bin/darwin-<arch>/ftdi-bridge
#
# libusb and libftdi are built from pinned source tarballs and linked
# statically, so the result depends on nothing outside macOS itself: no
# Homebrew at build time and none at run time (`otool -L` shows only system
# libraries). The tarballs are cached under build/ and checked by SHA-256.
#
# The bridge is the macOS half of running Signal Hound's x86-64 Linux SA API on
# Apple Silicon: it holds the SA44B's FTDI ports through libusb and serves
# FTDI D2XX calls over TCP (loopback only) to the shim inside the Linux guest.
#
# Prerequisites: Xcode Command Line Tools (cc, make), curl.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$ROOT/build/bridge"
MIN_MACOS="${SB_MIN_MACOS:-13.0}"

LIBUSB_VERSION=1.0.29
LIBUSB_URL="https://github.com/libusb/libusb/releases/download/v$LIBUSB_VERSION/libusb-$LIBUSB_VERSION.tar.bz2"
LIBUSB_SHA256=5977fc950f8d1395ccea9bd48c06b3f808fd3c2c961b44b0c2e6e29fc3a70a85
LIBFTDI_VERSION=1.5
LIBFTDI_URL="https://www.intra2net.com/en/developer/libftdi/download/libftdi1-$LIBFTDI_VERSION.tar.bz2"
LIBFTDI_SHA256=7c7091e9c86196148bd41177b4590dccb1510bfe6cea5bf7407ff194482eb049

case "$(uname -m)" in
  arm64) ARCH=arm64 ;;
  x86_64) ARCH=x64 ;;
  *) echo "[build-bridge] unsupported host arch $(uname -m)" >&2; exit 1 ;;
esac
OUT="$ROOT/driver/bridge/bin/darwin-$ARCH"
mkdir -p "$BUILD" "$OUT"

fetch() { # url sha256 dest
  if [ ! -f "$3" ]; then
    echo "[build-bridge] fetching $1"
    curl -fsSL -o "$3.part" "$1" && mv "$3.part" "$3"
  fi
  echo "$2  $3" | shasum -a 256 -c - >/dev/null || { echo "[build-bridge] checksum mismatch for $3" >&2; exit 1; }
}

fetch "$LIBUSB_URL" "$LIBUSB_SHA256" "$BUILD/libusb-$LIBUSB_VERSION.tar.bz2"
fetch "$LIBFTDI_URL" "$LIBFTDI_SHA256" "$BUILD/libftdi1-$LIBFTDI_VERSION.tar.bz2"

export MACOSX_DEPLOYMENT_TARGET="$MIN_MACOS"
CFLAGS="-O2 -mmacosx-version-min=$MIN_MACOS"

# libusb: static only, no udev on macOS
if [ ! -f "$BUILD/libusb-$LIBUSB_VERSION/libusb/.libs/libusb-1.0.a" ]; then
  echo "[build-bridge] building libusb $LIBUSB_VERSION (static)"
  rm -rf "$BUILD/libusb-$LIBUSB_VERSION"
  tar -xjf "$BUILD/libusb-$LIBUSB_VERSION.tar.bz2" -C "$BUILD"
  (cd "$BUILD/libusb-$LIBUSB_VERSION" &&
    ./configure --disable-shared --enable-static --disable-udev --quiet CFLAGS="$CFLAGS" >/dev/null &&
    make -s -j"$(sysctl -n hw.ncpu)" >/dev/null)
fi

# libftdi: a single C file; its cmake step only generates a version header
if [ ! -f "$BUILD/libftdi.o" ]; then
  echo "[build-bridge] building libftdi $LIBFTDI_VERSION (static)"
  rm -rf "$BUILD/libftdi1-$LIBFTDI_VERSION"
  tar -xjf "$BUILD/libftdi1-$LIBFTDI_VERSION.tar.bz2" -C "$BUILD"
  sed -e 's/@MAJOR_VERSION@/1/' -e 's/@MINOR_VERSION@/5/' -e "s/@VERSION_STRING@/$LIBFTDI_VERSION/" -e 's/@SNAPSHOT_VERSION@/release/' \
    "$BUILD/libftdi1-$LIBFTDI_VERSION/src/ftdi_version_i.h.in" > "$BUILD/libftdi1-$LIBFTDI_VERSION/src/ftdi_version_i.h"
  cc $CFLAGS -w -c -o "$BUILD/libftdi.o" "$BUILD/libftdi1-$LIBFTDI_VERSION/src/ftdi.c" \
    -I"$BUILD/libftdi1-$LIBFTDI_VERSION/src" -I"$BUILD/libusb-$LIBUSB_VERSION/libusb"
fi

# the bridge includes <libftdi1/ftdi.h> and <libusb-1.0/libusb.h>, as installed copies are laid out
mkdir -p "$BUILD/include/libftdi1" "$BUILD/include/libusb-1.0"
cp "$BUILD/libftdi1-$LIBFTDI_VERSION/src/ftdi.h" "$BUILD/include/libftdi1/"
cp "$BUILD/libusb-$LIBUSB_VERSION/libusb/libusb.h" "$BUILD/include/libusb-1.0/"

echo "[build-bridge] ftdi-bridge (darwin-$ARCH, static libusb + libftdi)"
cc $CFLAGS -Wall -Wextra -std=gnu11 -o "$OUT/ftdi-bridge" "$ROOT/driver/bridge/ftdi-bridge.c" \
  -I"$BUILD/include" "$BUILD/libftdi.o" "$BUILD/libusb-$LIBUSB_VERSION/libusb/.libs/libusb-1.0.a" \
  -lpthread -lobjc -framework IOKit -framework CoreFoundation -framework Security
strip "$OUT/ftdi-bridge"
# ad-hoc signature: required to run on Apple Silicon at all; release builds
# re-sign with a Developer ID (see docs/macos-runtime.md)
codesign --force --sign - "$OUT/ftdi-bridge" 2>/dev/null || true

if otool -L "$OUT/ftdi-bridge" | grep -q -E "homebrew|/usr/local|/opt/"; then
  echo "[build-bridge] ERROR: the bridge still links a non-system library:" >&2
  otool -L "$OUT/ftdi-bridge" >&2
  exit 1
fi
ls -la "$OUT/ftdi-bridge"
otool -L "$OUT/ftdi-bridge"
