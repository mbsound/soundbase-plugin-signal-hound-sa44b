#!/usr/bin/env bash
# Developer-only: an x86-64 build environment for scripts/build-x86.sh --lima,
# for Macs without Docker. Creates a Lima VM "sa44b-build" (arm64 Ubuntu with
# Rosetta) and an x86-64 Ubuntu chroot with gcc inside it. Nothing here is
# part of the runtime users get; the plugin no longer uses Lima at all.
#
#   scripts/vm/x86-build-env.sh          # then: scripts/build-x86.sh --lima sa44b-build
#
# Needs: brew install lima. A VM left from the old Lima-based runtime
# ("sa44b", made by the former provision.sh) works too: scripts/build-x86.sh
# --lima sa44b.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
INSTANCE="${SB_SA44B_LIMA_INSTANCE:-sa44b-build}"
command -v limactl >/dev/null 2>&1 || { echo "[x86-build-env] missing: limactl (brew install lima)" >&2; exit 1; }
if ! limactl list --json 2>/dev/null | grep -q "\"name\":\"$INSTANCE\""; then
  limactl start --name="$INSTANCE" --vm-type=vz --rosetta --cpus=4 --memory=4 --tty=false template://ubuntu
else
  limactl start --tty=false "$INSTANCE" 2>/dev/null || true
fi
limactl shell "$INSTANCE" -- bash -c 'test -e /proc/sys/fs/binfmt_misc/rosetta' \
  || { echo "[x86-build-env] Rosetta is not enabled in the VM; recreate it with --rosetta" >&2; exit 1; }
limactl copy "$ROOT/scripts/vm/setup-chroot.sh" "$INSTANCE:setup-chroot.sh"
limactl shell "$INSTANCE" -- sudo bash ./setup-chroot.sh
echo "[x86-build-env] ready: scripts/build-x86.sh --lima $INSTANCE"
