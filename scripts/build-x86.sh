#!/usr/bin/env bash
# Build the x86-64 Linux payload of the macOS runtime: the shim, the worker,
# the guest agent, and the glibc/libstdc++ they and Signal Hound's library
# need. Output: driver/microvm/guest/x86/ (what the guest mounts as
# /host/payload).
#
#   scripts/build-x86.sh                 # docker if present, else the Lima VM
#   scripts/build-x86.sh --docker        # debian:bookworm-slim (digest-pinned), linux/amd64
#   scripts/build-x86.sh --lima [name]   # the x86-64 chroot of a Lima VM made by scripts/vm/provision.sh
#
# The compile needs an x86-64 glibc toolchain; nothing in the output comes
# from the build machine's own userland. The runtime libraries are taken
# from Debian bookworm packages pinned by version and SHA-256:
#   libc6, libgcc-s1, libstdc++6
# which is everything libsa_api.so.3.0.11 links against besides libftd2xx.so
# (the shim). No apt, no package manager, nothing else in the guest.
#
# Prerequisites: curl, ar, tar, xz; and docker or Lima.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$ROOT/build/x86"
OUT="$ROOT/driver/microvm/guest/x86"

# -- pins --------------------------------------------------------------------
DEBIAN_IMAGE="debian:bookworm-slim@sha256:7ff6ba31527b9e336162fa061746c366c4b2032f4d2cff2078bea43f78efe3f8"
DEB_MIRROR="${SB_DEB_MIRROR:-https://deb.debian.org/debian}"
# name  pool path  sha256
DEBS="
libc6      pool/main/g/glibc/libc6_2.36-9+deb12u14_amd64.deb        ba4f88f73dbc3ae9055f3c20f4523bfdbaf1ad13ff95e258924f77d20b4fbedf
libgcc-s1  pool/main/g/gcc-12/libgcc-s1_12.2.0-14+deb12u1_amd64.deb  3016e62cb4b7cd8038822870601f5ed131befe942774d0f745622cc77d8a88f7
libstdc++6 pool/main/g/gcc-12/libstdc++6_12.2.0-14+deb12u1_amd64.deb 5cd3171216d4ab0fc911cfe9c35509bf2dd8f47761c43b7f6a4296701551a24d
"
# bookworm's glibc; the compile refuses binaries that need a newer one
export MAX_GLIBC=2.36

MODE=""
LIMA_INSTANCE="${SB_SA44B_LIMA_INSTANCE:-sa44b}"
case "${1:-}" in
  --docker) MODE=docker ;;
  --lima) MODE=lima; [ -n "${2:-}" ] && LIMA_INSTANCE="$2" ;;
  "") if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then MODE=docker;
      elif command -v limactl >/dev/null 2>&1; then MODE=lima;
      else echo "[build-x86] need docker or Lima to compile for x86-64 Linux" >&2; exit 1; fi ;;
  *) echo "usage: $0 [--docker | --lima [instance]]" >&2; exit 2 ;;
esac

mkdir -p "$BUILD/debs" "$BUILD/out"
rm -rf "$OUT"
mkdir -p "$OUT/bin" "$OUT/lib" "$OUT/lib64"

# -- 1. compile --------------------------------------------------------------
echo "[build-x86] compiling the worker, agent and shim ($MODE)"
rm -rf "$BUILD/src" "$BUILD/out"
mkdir -p "$BUILD/src/driver" "$BUILD/src/scripts" "$BUILD/out"
cp -R "$ROOT/driver/worker" "$ROOT/driver/shim" "$ROOT/driver/bridge" "$BUILD/src/driver/"
mkdir -p "$BUILD/src/driver/microvm"
cp -R "$ROOT/driver/microvm/agent" "$BUILD/src/driver/microvm/"
rm -rf "$BUILD/src/driver/worker/bin" "$BUILD/src/driver/shim/bin" "$BUILD/src/driver/bridge/bin"
cp "$ROOT/scripts/x86-compile.sh" "$BUILD/src/scripts/"

if [ "$MODE" = docker ]; then
  docker run --rm --platform linux/amd64 -e MAX_GLIBC -v "$BUILD/src:/src:ro" -v "$BUILD/out:/out" "$DEBIAN_IMAGE" \
    bash -c 'apt-get update -qq >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq gcc libc6-dev binutils >/dev/null && bash /src/scripts/x86-compile.sh /src /out'
else
  # the chroot cannot see the host; stage through the VM user's home
  limactl shell "$LIMA_INSTANCE" -- sudo bash -c 'test -x /amd64/usr/bin/gcc' \
    || { echo "[build-x86] Lima instance \"$LIMA_INSTANCE\" has no x86-64 chroot with gcc; run scripts/vm/provision.sh once, or use --docker" >&2; exit 1; }
  VMHOME="$(limactl shell "$LIMA_INSTANCE" -- bash -c 'echo "$HOME"' 2>/dev/null | tr -d '\r')"
  limactl shell "$LIMA_INSTANCE" -- sudo bash -c "rm -rf $VMHOME/sa44b-x86 $VMHOME/sa44b-x86-out /amd64/tmp/sa44b-x86"
  limactl copy -r "$BUILD/src" "$LIMA_INSTANCE:sa44b-x86"
  limactl shell "$LIMA_INSTANCE" -- sudo bash -c "cp -r $VMHOME/sa44b-x86 /amd64/tmp/sa44b-x86 && chroot /amd64 /bin/bash -c 'MAX_GLIBC=$MAX_GLIBC bash /tmp/sa44b-x86/scripts/x86-compile.sh /tmp/sa44b-x86 /tmp/sa44b-x86/out' && cp -r /amd64/tmp/sa44b-x86/out $VMHOME/sa44b-x86-out && chown -R \$SUDO_UID $VMHOME/sa44b-x86-out"
  rm -rf "$BUILD/out"
  limactl copy -r "$LIMA_INSTANCE:sa44b-x86-out" "$BUILD/out"
fi
cp "$BUILD/out/bin/sa44b-worker" "$BUILD/out/bin/vsock-agent" "$OUT/bin/"
cp "$BUILD/out/lib/libftd2xx.so" "$OUT/lib/"

# -- 2. runtime libraries from pinned Debian packages ------------------------
echo "[build-x86] runtime libraries from Debian bookworm"
echo "$DEBS" | while read -r name path sha; do
  [ -n "$name" ] || continue
  deb="$BUILD/debs/$(basename "$path")"
  if [ ! -f "$deb" ]; then
    echo "[build-x86] fetching $DEB_MIRROR/$path"
    curl -fsSL -o "$deb.part" "$DEB_MIRROR/$path" && mv "$deb.part" "$deb"
  fi
  echo "$sha  $deb" | shasum -a 256 -c - >/dev/null || { echo "[build-x86] checksum mismatch for $deb" >&2; exit 1; }
  x="$BUILD/debs/$name"
  rm -rf "$x" && mkdir -p "$x"
  # a .deb is an ar archive: ar unpacks it on macOS and Linux alike (GNU tar
  # cannot), then its data member is an ordinary tarball
  (cd "$x" && ar x "$deb" && tar -xf data.tar.xz)
done
# libc6 keeps its libraries in lib/, libstdc++6 in usr/lib/; the guest sees a flat lib/
cp "$BUILD/debs/libc6/lib/x86_64-linux-gnu/"{libc.so.6,libm.so.6,libdl.so.2,libpthread.so.0,librt.so.1} "$OUT/lib/"
cp "$BUILD/debs/libc6/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2" "$OUT/lib64/"
cp "$BUILD/debs/libgcc-s1/lib/x86_64-linux-gnu/libgcc_s.so.1" "$OUT/lib/"
cp "$BUILD/debs/libstdc++6/usr/lib/x86_64-linux-gnu/libstdc++.so.6" "$OUT/lib/"
# the loader's own path, as the ELF interpreter names it, is a symlink into lib64
chmod -R u+w "$OUT"

# -- 3. record what went in --------------------------------------------------
{
  echo "# driver/microvm/guest/x86 — built by scripts/build-x86.sh"
  echo "compiled-with: $MODE"
  echo "debian-image: $DEBIAN_IMAGE"
  echo "$DEBS" | sed '/^$/d' | awk '{print "deb: " $2 " sha256:" $3}'
  echo
  (cd "$OUT" && find . -type f | sort | xargs shasum -a 256)
} > "$OUT/MANIFEST"
du -sh "$OUT"
cat "$OUT/MANIFEST"
