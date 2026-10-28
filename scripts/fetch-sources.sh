#!/usr/bin/env bash
# Collect the complete corresponding source of every GPL/LGPL component the
# plugin ships (see THIRD-PARTY-NOTICES.md) into one archive, for attaching
# to a GitHub Release next to the plugin zip.
#
#   scripts/fetch-sources.sh [out-dir]     # default dist/
#
# Produces <out-dir>/signal-hound-sa44b-<version>-sources.tar with a
# SHA256SUMS file inside. The archive is several hundred MB, mostly the
# kernel and gcc-12 sources. Prerequisites: curl, tar, shasum.
#
# The pins here must match scripts/build-guest.sh, scripts/build-x86.sh and
# scripts/build-bridge.sh; bump them together.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(cd "${1:-$ROOT/dist}" 2>/dev/null && pwd || { mkdir -p "${1:-$ROOT/dist}" && cd "${1:-$ROOT/dist}" && pwd; })"
VERSION="$(node -e "process.stdout.write(require('$ROOT/soundbase-plugin.json').version)")"
NAME="signal-hound-sa44b-$VERSION-sources"
WORK="$ROOT/build/sources/$NAME"
DEB="${SB_DEB_MIRROR:-https://deb.debian.org/debian}"

rm -rf "$WORK" && mkdir -p "$WORK"
get() { # url dest
  echo "[fetch-sources] $1"
  curl -fsSL --retry 3 -o "$WORK/$2" "$1"
}
aports() { # commit path dest
  get "https://gitlab.alpinelinux.org/alpine/aports/-/archive/$1/aports-$1.tar.gz?path=$2" "$3"
}

# Linux 6.12.114 as Alpine builds linux-virt
aports 6a0c60d347a1193d1d7ebb41a6e72dc0da1e8137 main/linux-lts alpine-aports-linux-lts-6.12.114-r0.tar.gz
get https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-6.12.114.tar.xz linux-6.12.114.tar.xz

# BusyBox 1.37.0 as Alpine builds busybox-static
aports 2e97d754a30d558f15524b8e422303c8a96832df main/busybox alpine-aports-busybox-1.37.0-r20.tar.gz
get https://busybox.net/downloads/busybox-1.37.0.tar.bz2 busybox-1.37.0.tar.bz2

# Debian source packages: the .dsc names every file that makes up the source
debsrc() { # pool-dir dsc
  get "$DEB/$1/$2" "$2"
  awk '/^Files:/{f=1;next} /^[^ ]/{f=0} f{print $3}' "$WORK/$2" | while read -r file; do
    get "$DEB/$1/$file" "$file"
  done
}
debsrc pool/main/g/glibc glibc_2.36-9+deb12u14.dsc
debsrc pool/main/g/gcc-12 gcc-12_12.2.0-14+deb12u1.dsc

# the bridge's statically linked libraries
get https://github.com/libusb/libusb/releases/download/v1.0.29/libusb-1.0.29.tar.bz2 libusb-1.0.29.tar.bz2
get https://www.intra2net.com/en/developer/libftdi/download/libftdi1-1.5.tar.bz2 libftdi1-1.5.tar.bz2

cp "$ROOT/THIRD-PARTY-NOTICES.md" "$WORK/"
(cd "$WORK" && shasum -a 256 $(ls | grep -v SHA256SUMS) > SHA256SUMS)
tar -cf "$OUT/$NAME.tar" -C "$(dirname "$WORK")" "$NAME"
ls -la "$OUT/$NAME.tar"
