#!/bin/sh
# /init of the sa44b guest: a busybox initramfs that mounts what the launcher
# shares, registers Rosetta, and hands the x86-64 worker to the host.
#
# What the launcher (driver/microvm/Launcher.swift) gives this guest:
#   virtiofs "rosetta"   Apple's Rosetta runtime for Linux (VZLinuxRosettaDirectoryShare)
#   virtiofs "host"      /host/payload  driver/microvm/guest/x86 (read-only):
#                                       the worker, the agent, the shim and
#                                       the glibc/libstdc++ they need
#                        /host/state    the plugin's cache dir: sdk/ with
#                                       libsa_api.so, cal/ for the library's
#                                       calibration files
#   vsock                guest port AGENT_PORT   the host connects here, one
#                                               worker per connection
#                        host port FTDI_BRIDGE_PORT  the shim connects there;
#                                               the launcher proxies it to
#                                               the ftdi-bridge TCP port
#   console hvc0         everything printed here reaches the plugin log
#
# Kernel command-line options:
#   sa44b.agent_port=N    vsock port the agent listens on (default 7790)
#   sa44b.bridge_port=N   vsock port the shim connects to (default 7788)
#   sa44b.shimlog=1       the shim logs every D2XX call to /host/state/shim.log

export PATH=/bin:/sbin
say() { echo "[guest] $*"; }
die() { say "FATAL: $*"; sleep 1; poweroff -f; sleep 5; exit 1; }

mount -t proc proc /proc
mount -t sysfs sys /sys
mount -t devtmpfs dev /dev 2>/dev/null
mkdir -p /dev/pts /tmp /run /mnt/rosetta /host
mount -t devpts devpts /dev/pts 2>/dev/null
mount -t tmpfs tmp /tmp

for m in fuse virtiofs vsock vmw_vsock_virtio_transport_common vmw_vsock_virtio_transport binfmt_misc; do
  insmod "/lib/modules/$m.ko" || die "insmod $m failed"
done

mount -t virtiofs host /host || die "cannot mount the host share"
mount -t virtiofs rosetta /mnt/rosetta || die "cannot mount the Rosetta share (is Rosetta installed on the Mac?)"
[ -x /mnt/rosetta/rosetta ] || die "no rosetta binary in the Rosetta share"

mount -t binfmt_misc binfmt_misc /proc/sys/fs/binfmt_misc || die "cannot mount binfmt_misc"
cat /etc/rosetta.binfmt > /proc/sys/fs/binfmt_misc/register || die "cannot register the Rosetta binfmt"
read -r binfmt_state < /proc/sys/fs/binfmt_misc/rosetta && say "rosetta binfmt: $binfmt_state ($(/mnt/rosetta/rosetta 2>&1 | tail -1))"

AGENT_PORT=7790
export FTDI_BRIDGE_VSOCK_CID=2
export FTDI_BRIDGE_PORT=7788
for w in $(cat /proc/cmdline); do
  case "$w" in
    sa44b.agent_port=*) AGENT_PORT="${w#*=}" ;;
    sa44b.bridge_port=*) export FTDI_BRIDGE_PORT="${w#*=}" ;;
    sa44b.shimlog=1) export FTDI_SHIM_VERBOSE=1 FTDI_SHIM_LOG=/host/state/shim.log ;;
  esac
done

# the x86-64 side: ELF interpreter at its absolute path, libraries by LD_LIBRARY_PATH
PAYLOAD=/host/payload
[ -x "$PAYLOAD/bin/sa44b-worker" ] || die "no x86-64 worker in the host share (scripts/build-x86.sh)"
ln -sfn "$PAYLOAD/lib64" /lib64
export LD_LIBRARY_PATH="$PAYLOAD/lib:/host/state/sdk"
mkdir -p /host/state/cal /host/state/sdk 2>/dev/null
[ -e /host/state/sdk/libsa_api.so ] || say "warning: /host/state/sdk/libsa_api.so is missing; the worker will report library_unavailable"

say "ready: agent on vsock port $AGENT_PORT, bridge via host vsock port $FTDI_BRIDGE_PORT"
# the agent serves one worker per host connection; the launcher watches the
# console for its "listening" line
"$PAYLOAD/bin/vsock-agent" "$AGENT_PORT" -C /host/state/cal -- "$PAYLOAD/bin/sa44b-worker" --sdk /host/state/sdk
die "the agent exited"
