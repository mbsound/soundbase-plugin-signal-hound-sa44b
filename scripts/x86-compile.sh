#!/usr/bin/env bash
# Compiles the x86-64 Linux side of the macOS runtime. Runs INSIDE an x86-64
# Debian/Ubuntu userland with gcc (scripts/build-x86.sh arranges that); not
# meant to be run directly.
#
#   x86-compile.sh <source dir> <output dir>
#
# <source dir> holds driver/ as in the repository. Produces, in <output dir>:
#   bin/sa44b-worker   the worker (driver/worker/sa44b-worker.c)
#   bin/vsock-agent    the guest agent (driver/microvm/agent/vsock-agent.c)
#   lib/libftd2xx.so   the shim (driver/shim/ftd2xx-shim.c)
#
# Every binary is checked against the glibc the guest ships (MAX_GLIBC): a
# newer toolchain must not bind to a symbol version the guest does not have.
set -euo pipefail
SRC="${1:?source dir}"
OUT="${2:?output dir}"
MAX_GLIBC="${MAX_GLIBC:-2.36}"
mkdir -p "$OUT/bin" "$OUT/lib"
CFLAGS="-O2 -Wall -Wextra"
echo "[x86-compile] $(gcc --version | head -1), $(ldd --version | head -1)"
gcc $CFLAGS -std=c11 -D_DEFAULT_SOURCE -o "$OUT/bin/sa44b-worker" "$SRC/driver/worker/sa44b-worker.c" -lm -ldl
gcc $CFLAGS -std=c11 -D_DEFAULT_SOURCE -o "$OUT/bin/vsock-agent" "$SRC/driver/microvm/agent/vsock-agent.c"
gcc $CFLAGS -shared -fPIC -o "$OUT/lib/libftd2xx.so" "$SRC/driver/shim/ftd2xx-shim.c" -lpthread
strip "$OUT/bin/sa44b-worker" "$OUT/bin/vsock-agent" "$OUT/lib/libftd2xx.so"
for f in "$OUT/bin/sa44b-worker" "$OUT/bin/vsock-agent" "$OUT/lib/libftd2xx.so"; do
  need="$(objdump -T "$f" | grep -o 'GLIBC_[0-9.]*' | sed 's/GLIBC_//' | sort -uV | tail -1)"
  if [ "$(printf '%s\n%s\n' "$need" "$MAX_GLIBC" | sort -V | tail -1)" != "$MAX_GLIBC" ]; then
    echo "[x86-compile] ERROR: $f needs glibc $need, the guest ships $MAX_GLIBC" >&2
    exit 1
  fi
  echo "[x86-compile] $(basename "$f"): glibc <= $need ok"
done
