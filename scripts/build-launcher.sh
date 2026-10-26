#!/usr/bin/env bash
# Build driver/microvm/Launcher.swift into driver/microvm/bin/sa44b-vm and sign
# it with the entitlement Virtualization.framework requires.
#
#   scripts/build-launcher.sh                 # ad-hoc signed: runs on this Mac
#   SB_CODESIGN_IDENTITY="Developer ID Application: ..." scripts/build-launcher.sh
#
# A distributed binary must carry com.apple.security.virtualization under a
# Developer ID signature (and be notarized with the rest of the plugin);
# an ad-hoc signature is enough for a local build. See docs/macos-runtime.md.
#
# Prerequisites: Xcode Command Line Tools (swiftc, codesign). macOS 13 SDK or newer.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/driver/microvm/bin"
MIN_MACOS="${SB_MIN_MACOS:-13.0}"
IDENTITY="${SB_CODESIGN_IDENTITY:--}"
mkdir -p "$OUT"
echo "[build-launcher] sa44b-vm (swiftc, macOS >= $MIN_MACOS)"
swiftc -O -target "arm64-apple-macos$MIN_MACOS" -framework Virtualization \
  -o "$OUT/sa44b-vm" "$ROOT/driver/microvm/Launcher.swift"
strip -x "$OUT/sa44b-vm"
echo "[build-launcher] codesign ($([ "$IDENTITY" = - ] && echo ad-hoc || echo "$IDENTITY"))"
codesign --force --sign "$IDENTITY" --options runtime --entitlements "$ROOT/driver/microvm/sa44b-vm.entitlements" "$OUT/sa44b-vm"
codesign -d --entitlements - "$OUT/sa44b-vm" 2>&1 | grep -q virtualization || { echo "[build-launcher] the entitlement did not take" >&2; exit 1; }
ls -la "$OUT/sa44b-vm"
"$OUT/sa44b-vm" --check-rosetta
