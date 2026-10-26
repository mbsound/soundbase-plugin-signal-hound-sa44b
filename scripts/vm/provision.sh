#!/usr/bin/env bash
# One-time setup for running the SA44B on an Apple Silicon Mac.
#
#   scripts/vm/provision.sh
#
# What it does, each step skipped when already done:
#   1. builds driver/bridge/ftdi-bridge for this Mac     (needs: brew install libftdi)
#   2. fetches Signal Hound's SDK zip and extracts the obsolete x86-64 Linux
#      SA API (libsa_api.so.3.0.11) from it                (needs: curl, unzip)
#   3. creates a Lima VM "sa44b": arm64 Ubuntu with Rosetta (needs: brew install lima)
#   4. copies the driver sources and the library into the VM
#   5. builds an x86-64 Ubuntu chroot in the VM and compiles the shim and
#      the worker inside it
#
# Afterwards the plugin brings the pieces up by itself whenever a device is
# opened (driver/mac-host.js). Re-run this after changing anything under
# driver/ to rebuild the Linux side.
#
# Signal Hound's API licence governs libsa_api.so; it is downloaded from
# signalhound.com for use with your own SA device and is not part of this
# repository.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
INSTANCE="${SB_SA44B_LIMA_INSTANCE:-sa44b}"
SDK_URL="${SB_SA44B_SDK_URL:-https://signalhound.com/sigdownloads/SDK/signal_hound_sdk_10_05_26.zip}"
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/signal-hound-sa44b"
SDK_DIR="$ROOT/sdk"

step() { printf '\n[provision] %s\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "[provision] missing: $1 ($2)" >&2; exit 1; }; }

need brew "https://brew.sh"
need limactl "brew install lima"
need curl "curl"
need unzip "unzip"

if [ "$(uname -m)" != "arm64" ]; then
  echo "[provision] this path is for Apple Silicon (Rosetta for Linux); on Intel Macs run the Linux library in an x86-64 VM instead" >&2
  exit 1
fi

step "1/5 ftdi-bridge"
brew list --versions libftdi >/dev/null 2>&1 || brew install libftdi
bash "$ROOT/scripts/build-bridge.sh"

step "2/5 Signal Hound Linux SA API"
mkdir -p "$SDK_DIR" "$CACHE"
if [ ! -f "$SDK_DIR/libsa_api.so.3.0.11" ]; then
  ZIP="$CACHE/$(basename "$SDK_URL")"
  if [ ! -f "$ZIP" ]; then
    echo "[provision] downloading $SDK_URL (about 160 MB)"
    curl -fL --progress-bar -o "$ZIP" "$SDK_URL"
  fi
  INNER="signal_hound_sdk/device_apis/sa_series/lib/_obsolete/linux (obsolete)/sa_linux_sdk_3011.zip"
  TMP="$(mktemp -d)"
  unzip -q -o "$ZIP" "$INNER" -d "$TMP"
  unzip -q -o "$TMP/$INNER" "sa_linux_sdk/lib/libsa_api.so.3.0.11" "sa_linux_sdk/include/sa_api.h" "sa_linux_sdk/README.txt" "sa_linux_sdk/software_license/*" -d "$TMP"
  cp "$TMP/sa_linux_sdk/lib/libsa_api.so.3.0.11" "$TMP/sa_linux_sdk/include/sa_api.h" "$TMP/sa_linux_sdk/README.txt" "$SDK_DIR/"
  cp -r "$TMP/sa_linux_sdk/software_license" "$SDK_DIR/"
  rm -rf "$TMP"
fi
ln -sf libsa_api.so.3.0.11 "$SDK_DIR/libsa_api.so"
ls -la "$SDK_DIR"

step "3/5 Lima VM \"$INSTANCE\""
if ! limactl list --json 2>/dev/null | grep -q "\"name\":\"$INSTANCE\""; then
  limactl start --name="$INSTANCE" --vm-type=vz --rosetta --cpus=4 --memory=4 --tty=false template://ubuntu
else
  limactl start --tty=false "$INSTANCE" 2>/dev/null || true
fi
limactl shell "$INSTANCE" -- bash -c 'test -e /proc/sys/fs/binfmt_misc/rosetta' \
  || { echo "[provision] Rosetta is not enabled in the VM; recreate it with --rosetta" >&2; exit 1; }

step "4/5 copying driver sources and the library into the VM"
# keep the calibration files the library pulled from the device (root-owned,
# like everything the chroot built), replace the rest
limactl shell "$INSTANCE" -- bash -c 'mkdir -p ~/sa44b/scripts ~/sa44b/sdk ~/sa44b/cal && sudo find ~/sa44b/driver -maxdepth 4 \( -name "*.tep" -o -name "*.bin" \) -exec mv -f {} ~/sa44b/cal/ \; 2>/dev/null; sudo rm -rf ~/sa44b/driver'
limactl copy -r "$ROOT/driver" "$INSTANCE:sa44b/"
limactl copy -r "$ROOT/scripts/vm" "$INSTANCE:sa44b/scripts/"
limactl copy "$SDK_DIR/libsa_api.so.3.0.11" "$SDK_DIR/sa_api.h" "$INSTANCE:sa44b/sdk/"
limactl shell "$INSTANCE" -- bash -c 'cd ~/sa44b && ln -sf libsa_api.so.3.0.11 sdk/libsa_api.so && rm -rf driver/bridge/bin driver/worker/bin/darwin-* driver/worker/bin/win32-* && mkdir -p driver/worker/bin/linux-x64 && cp -f cal/* driver/worker/bin/linux-x64/ 2>/dev/null; true'

step "5/5 x86-64 chroot, shim and worker"
limactl shell "$INSTANCE" -- bash -c 'sudo bash "$HOME/sa44b/scripts/vm/setup-chroot.sh" "$HOME/sa44b"'

step "done. Try:  npm start   then open the device from SoundBase, or curl the plugin."
