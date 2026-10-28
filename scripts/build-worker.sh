#!/usr/bin/env bash
# Build driver/worker/sa44b-worker.c for this machine.
#
#   scripts/build-worker.sh
#
# The output lands in driver/worker/bin/<platform>-<arch>/, which is what
# driver/worker-client.js looks for. This host build is for mock mode (the
# tests and `npm run smoke`); the worker that talks to the real SA44B is the
# x86-64 Linux build in the guest payload (scripts/build-x86.sh).
#
# Prerequisite: a C compiler (clang on macOS, gcc on Linux).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/driver/worker/sa44b-worker.c"
OUT="$ROOT/driver/worker/bin"
CFLAGS="-O2 -Wall -Wextra -std=c11 -D_DEFAULT_SOURCE"

host_target() {
  local os arch
  case "$(uname -s)" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) os=unknown ;;
  esac
  case "$(uname -m)" in
    arm64 | aarch64) arch=arm64 ;;
    x86_64 | amd64) arch=x64 ;;
    *) arch=unknown ;;
  esac
  echo "$os-$arch"
}

build_host() {
  local target
  target="$(host_target)"
  mkdir -p "$OUT/$target"
  echo "[build-worker] $target"
  cc $CFLAGS -o "$OUT/$target/sa44b-worker" "$SRC" -lm
}

build_host
