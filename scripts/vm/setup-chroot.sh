#!/usr/bin/env bash
# Runs INSIDE a Lima VM (arm64 Ubuntu, Rosetta enabled). Creates an x86-64
# Ubuntu chroot at /amd64 with gcc, which scripts/build-x86.sh --lima uses to
# compile the x86-64 side of the macOS runtime. Developer tooling only.
#
#   limactl shell <instance> -- sudo bash setup-chroot.sh

set -euo pipefail
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
mkdir -p "$CHROOT/proc" "$CHROOT/sys" "$CHROOT/dev" "$CHROOT/mnt/lima-rosetta"
mountpoint -q "$CHROOT/proc" || mount -t proc proc "$CHROOT/proc"
mount_if /sys
mount_if /dev
mount_if /mnt/lima-rosetta

if [ ! -x "$CHROOT/usr/bin/gcc" ]; then
  echo "[setup] installing gcc in the chroot (under Rosetta)"
  chroot "$CHROOT" /bin/bash -c "apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq gcc libc6-dev binutils ca-certificates >/dev/null"
fi
echo "[setup] done: x86-64 chroot with $(chroot "$CHROOT" gcc --version | head -1)"
