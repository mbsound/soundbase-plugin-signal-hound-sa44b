#!/usr/bin/env bash
# Build the Linux guest the macOS runtime boots: an arm64 kernel and a busybox
# initramfs. Output: driver/microvm/guest/Image and driver/microvm/guest/initramfs.img.
#
#   scripts/build-guest.sh
#
# Inputs, pinned by version and SHA-256, fetched into build/guest/:
#   Alpine linux-virt      the kernel (virtio, virtiofs, vsock, binfmt_misc)
#   Alpine busybox-static  the whole userland of the initramfs
# No distribution, no package manager, no compiler runs in the guest: /init is
# driver/microvm/guest/init.sh, which mounts the launcher's shares, registers
# Rosetta and starts the x86-64 agent from the host share. The x86-64 side is
# built separately by scripts/build-x86.sh.
#
# Alpine's aarch64 kernel is an EFI "zboot" image (a PE wrapper around a
# gzip-compressed Image). Virtualization.framework's Linux boot loader wants
# the plain Image, so it is unwrapped here.
#
# Prerequisites: curl, tar, gzip, python3. Runs on macOS or Linux.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$ROOT/build/guest"
OUT="$ROOT/driver/microvm/guest"

ALPINE_MIRROR="${SB_ALPINE_MIRROR:-https://dl-cdn.alpinelinux.org/alpine}"
ALPINE_BRANCH=v3.22
KERNEL_PKG=linux-virt-6.12.114-r0
KERNEL_SHA256=345b2d561443cd8c978cbcc0f36f2374b3ef702debb747221384b4ddc07d6a77
KERNEL_RELEASE=6.12.114-0-virt
BUSYBOX_PKG=busybox-static-1.37.0-r20
BUSYBOX_SHA256=ee469aee2958feffd7f64dd96655704025ff60af614f77a1d7323dc237c34da2
# modules /init loads, in order (each is pulled from the kernel package)
MODULES="fs/fuse/fuse fs/fuse/virtiofs net/vmw_vsock/vsock net/vmw_vsock/vmw_vsock_virtio_transport_common net/vmw_vsock/vmw_vsock_virtio_transport fs/binfmt_misc"

mkdir -p "$BUILD" "$OUT"
fetch() { # url sha256 dest
  if [ ! -f "$3" ]; then
    echo "[build-guest] fetching $1"
    curl -fsSL -o "$3.part" "$1" && mv "$3.part" "$3"
  fi
  echo "$2  $3" | shasum -a 256 -c - >/dev/null || { echo "[build-guest] checksum mismatch for $3" >&2; exit 1; }
}
fetch "$ALPINE_MIRROR/$ALPINE_BRANCH/main/aarch64/$KERNEL_PKG.apk" "$KERNEL_SHA256" "$BUILD/$KERNEL_PKG.apk"
fetch "$ALPINE_MIRROR/$ALPINE_BRANCH/main/aarch64/$BUSYBOX_PKG.apk" "$BUSYBOX_SHA256" "$BUILD/$BUSYBOX_PKG.apk"

# -- kernel ------------------------------------------------------------------
rm -rf "$BUILD/kernel" && mkdir -p "$BUILD/kernel"
# an apk is a gzip tarball (with signature sections tar ignores, hence the warnings)
tar -xzf "$BUILD/$KERNEL_PKG.apk" -C "$BUILD/kernel" 2>/dev/null || true
python3 - "$BUILD/kernel/boot/vmlinuz-virt" "$OUT/Image" <<'PY'
import gzip, struct, sys
src, dst = sys.argv[1], sys.argv[2]
data = open(src, "rb").read()
if data[:2] == b"MZ" and data[4:8] == b"zimg":
    # Linux EFI zboot header: payload offset and size at 8 and 12, compression name at 24
    off, size = struct.unpack_from("<II", data, 8)
    comp = data[24:32].rstrip(b"\0").decode()
    assert comp == "gzip", f"unexpected zboot compression {comp}"
    image = gzip.decompress(data[off:off + size])
    print(f"[build-guest] unwrapped zboot kernel: {size} bytes gzip -> {len(image)} bytes Image")
else:
    image = data
    print(f"[build-guest] kernel is already a plain Image ({len(image)} bytes)")
assert image[56:60] == b"ARM\x64", "not an arm64 Linux Image"
open(dst, "wb").write(image)
PY

# -- initramfs ---------------------------------------------------------------
rm -rf "$BUILD/initramfs" && mkdir -p "$BUILD/initramfs"
tar -xzf "$BUILD/$BUSYBOX_PKG.apk" -C "$BUILD" 2>/dev/null || true
R="$BUILD/initramfs"
mkdir -p "$R/bin" "$R/sbin" "$R/etc" "$R/proc" "$R/sys" "$R/dev" "$R/lib/modules" "$R/mnt/rosetta" "$R/host" "$R/tmp" "$R/run"
cp "$BUILD/bin/busybox.static" "$R/bin/busybox"
chmod 755 "$R/bin/busybox"
for a in sh mount insmod mkdir cat echo ln sleep head tail poweroff printf test ls dmesg; do ln -sf busybox "$R/bin/$a"; done
for m in $MODULES; do
  gzip -dc "$BUILD/kernel/lib/modules/$KERNEL_RELEASE/kernel/$m.ko.gz" > "$R/lib/modules/$(basename "$m").ko"
done
cp "$ROOT/driver/microvm/guest/init.sh" "$R/init"
chmod 755 "$R/init"
# the binfmt_misc registration line for Rosetta, as Apple documents it. The
# kernel decodes the \xHH escapes itself; raw bytes would be cut at the first
# NUL. A file rather than a shell string, so no shell escape handling is involved.
printf '%s' ':rosetta:M::\x7fELF\x02\x01\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x02\x00\x3e\x00:\xff\xff\xff\xff\xff\xfe\xfe\x00\xff\xff\xff\xff\xff\xff\xff\xff\xfe\xff\xff\xff:/mnt/rosetta/rosetta:OCF' > "$R/etc/rosetta.binfmt"
python3 "$ROOT/scripts/mkinitramfs.py" "$R" "$OUT/initramfs.img"

{
  echo "# driver/microvm/guest — built by scripts/build-guest.sh"
  echo "alpine: $ALPINE_BRANCH"
  echo "kernel: $KERNEL_PKG sha256:$KERNEL_SHA256 (release $KERNEL_RELEASE)"
  echo "busybox: $BUSYBOX_PKG sha256:$BUSYBOX_SHA256"
  echo "modules: $MODULES"
  echo
  (cd "$OUT" && shasum -a 256 Image initramfs.img)
} > "$OUT/MANIFEST"
ls -la "$OUT/Image" "$OUT/initramfs.img"
cat "$OUT/MANIFEST"
