#!/usr/bin/env bash
# Runs INSIDE the Lima VM (arm64 Ubuntu, Rosetta enabled). Creates an x86-64
# Ubuntu chroot at /amd64 where Signal Hound's x86-64 libsa_api.so can run
# under Rosetta, and builds the shim and the worker inside it.
#
#   limactl shell sa44b -- sudo bash /path/to/setup-chroot.sh /path/to/plugin
#
# Everything x86-64 stays inside the chroot; the VM's own userland stays arm64.

set -euo pipefail
PLUGIN_DIR="${1:?plugin directory (as mounted in the VM)}"
CHROOT=/amd64
RELEASE=noble
BASE_URL="https://cdimage.ubuntu.com/ubuntu-base/releases/$RELEASE/release"

if [ ! -e /proc/sys/fs/binfmt_misc/rosetta ]; then
  echo "rosetta binfmt is not registered in this VM; start it with --rosetta" >&2
  exit 1
fi

if [ ! -x "$CHROOT/bin/bash" ]; then
  echo "[setup] fetching ubuntu-base ($RELEASE, amd64)"
  mkdir -p "$CHROOT"
  TARBALL="$(curl -fsSL "$BASE_URL/" | grep -o "ubuntu-base-[0-9.]*-base-amd64.tar.gz" | sort -u | tail -1)"
  curl -fsSL -o /tmp/ubuntu-base.tar.gz "$BASE_URL/$TARBALL"
  tar -xzf /tmp/ubuntu-base.tar.gz -C "$CHROOT"
  rm -f /tmp/ubuntu-base.tar.gz
  cp /etc/resolv.conf "$CHROOT/etc/resolv.conf" || true
fi

mount_if() { mountpoint -q "$CHROOT$1" || mount --bind "$1" "$CHROOT$1"; }
mkdir -p "$CHROOT/proc" "$CHROOT/sys" "$CHROOT/dev" "$CHROOT/mnt/lima-rosetta" "$CHROOT/plugin"
mountpoint -q "$CHROOT/proc" || mount -t proc proc "$CHROOT/proc"
mount_if /sys
mount_if /dev
mount_if /mnt/lima-rosetta
mountpoint -q "$CHROOT/plugin" || mount --bind "$PLUGIN_DIR" "$CHROOT/plugin"

if [ ! -x "$CHROOT/usr/bin/gcc" ]; then
  echo "[setup] installing gcc in the chroot (under Rosetta)"
  chroot "$CHROOT" /bin/bash -c "apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq gcc libc6-dev libstdc++6 libusb-1.0-0 ca-certificates >/dev/null"
fi

echo "[setup] building the shim and the worker for x86-64"
chroot "$CHROOT" /bin/bash -c '
  set -e
  cd /plugin
  mkdir -p driver/shim/bin/linux-x64 driver/worker/bin/linux-x64
  gcc -O2 -Wall -shared -fPIC -o driver/shim/bin/linux-x64/libftd2xx.so driver/shim/ftd2xx-shim.c -lpthread
  gcc -O2 -Wall -std=c11 -D_DEFAULT_SOURCE -o driver/worker/bin/linux-x64/sa44b-worker driver/worker/sa44b-worker.c -lm -ldl
  file driver/shim/bin/linux-x64/libftd2xx.so driver/worker/bin/linux-x64/sa44b-worker 2>/dev/null || true
'
# what the chroot built belongs to whoever owns the plugin directory
chown -R "$(stat -c %u:%g "$PLUGIN_DIR")" "$PLUGIN_DIR/driver/shim/bin" "$PLUGIN_DIR/driver/worker/bin"
echo "[setup] done"
