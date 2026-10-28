# The macOS runtime

How the SA44B runs on Apple Silicon without anything installed, how to
rebuild the pieces, how to sign them for distribution, and what to look at
when it does not come up. The user-facing summary is in `README.md`.

## The pieces

| Piece | Source | Built by | Ships as |
| --- | --- | --- | --- |
| `ftdi-bridge` | `driver/bridge/ftdi-bridge.c` | `scripts/build-bridge.sh` | `driver/bridge/bin/darwin-arm64/ftdi-bridge` |
| `sa44b-vm` launcher | `driver/microvm/Launcher.swift` | `scripts/build-launcher.sh` | `driver/microvm/bin/sa44b-vm` |
| guest kernel + initramfs | `driver/microvm/guest/init.sh` + Alpine packages | `scripts/build-guest.sh` | `driver/microvm/guest/Image`, `initramfs.img` |
| x86-64 payload | `driver/worker/`, `driver/shim/`, `driver/microvm/agent/` + Debian packages | `scripts/build-x86.sh` | `driver/microvm/guest/x86/` |

`npm run build:mac` runs the four in order. The built files are committed,
because the release zip is `git ls-files` plus `node_modules` and nothing
builds on the user's machine. Each build writes a `MANIFEST` next to its
output naming every input by version and SHA-256.

Sizes: kernel 35 MB (an uncompressed arm64 Image; 9.5 MB in the zip),
initramfs 0.85 MB, x86-64 payload 5.2 MB, bridge 0.2 MB, launcher 0.15 MB.

### What happens on open

`driver/mac-host.js`, `ensureReady()`:

1. **Bridge.** Pings `127.0.0.1:7788`; starts `ftdi-bridge` if nothing
   answers. The bridge is reused across plugin restarts if one is already up.
2. **Library.** If `~/Library/Caches/signal-hound-sa44b/state/sdk/libsa_api.so.3.0.11`
   is missing, downloads Signal Hound's SDK zip to `…/downloads/` (a copy
   under `~/.cache/signal-hound-sa44b/`, where the old provisioning script
   kept it, is reused) and extracts the Linux SDK's library, header, README
   and licence from the nested zip with `/usr/bin/unzip`.
3. **Rosetta.** Asks the launcher (`sa44b-vm --check-rosetta`). `installed`
   is what macOS 27 reports always and macOS 13–26 report once Rosetta is
   installed; `notInstalled` makes the plugin run
   `softwareupdate --install-rosetta --agree-to-license` and check again;
   `notSupported` (Intel, or macOS 12) is a clear error.
4. **Guest.** Spawns the launcher with the arguments `launcherArgs()` builds
   (tested in `__tests__/mac-host.test.js`, and parsed back by the launcher's
   `--dry-run`): kernel, initramfs, a `host` virtiofs share with `payload`
   (read-only, the x86-64 files) and `state` (the cache dir), `--rosetta`,
   a vsock listener on port 7788 proxied to the bridge's TCP port, and a
   forward from a unix socket in the temp dir to guest vsock port 7790. It
   waits for the console line `vsock-agent: listening`.

Then the adapter opens a `WorkerClient` on that unix socket. Each connection
is a fresh worker in the guest with the socket as its stdin and stdout; its
stderr goes to the guest console, which the launcher relays as
`{"event":"console"}` lines that end up in the plugin log prefixed `guest:`.
Dropping the connection is the kill: the agent polls each connection for
hang-up and SIGKILLs that worker. The launcher exits when the plugin's pipe
to it closes, which stops the guest.

Environment knobs: `SB_SA44B_CACHE_DIR`, `SB_SA44B_BRIDGE_PORT`,
`SB_SA44B_AGENT_PORT`, `SB_SA44B_VM_CPUS` (2), `SB_SA44B_VM_MEMORY_MB` (1024),
`SB_SA44B_SDK_URL`, `SB_SA44B_SHIM_LOG=1` (the shim logs every D2XX call to
`<cache>/state/shim.log`), `SB_SA44B_BRIDGE_TRACE=<file>` (the bridge logs
every USB read and write).

## Building

Everything is pinned; the scripts refuse an input whose SHA-256 does not
match and record what went in.

- **Bridge** (`scripts/build-bridge.sh`): needs only the Xcode Command Line
  Tools. Fetches libusb 1.0.29 and libftdi1 1.5 source tarballs, builds
  libusb static with its own `configure`, compiles libftdi's single C file
  directly (its CMake step only generates a version header), links the bridge
  against both plus IOKit/CoreFoundation/Security, and fails if `otool -L`
  shows anything outside `/usr/lib` and `/System`.
- **Launcher** (`scripts/build-launcher.sh`): `swiftc` against
  Virtualization.framework, deployment target macOS 13, then `codesign` with
  `driver/microvm/sa44b-vm.entitlements`. See *Signing* below.
- **Guest** (`scripts/build-guest.sh`): fetches Alpine 3.22's `linux-virt`
  (6.12.114) and `busybox-static` packages for aarch64, unwraps the kernel
  from Alpine's EFI zboot wrapper into the plain Image the Linux boot loader
  wants, and packs an initramfs (busybox, the six modules `/init` loads —
  fuse, virtiofs, vsock and its virtio transport, binfmt_misc — `/init` and
  the Rosetta binfmt line) with `scripts/mkinitramfs.py`, every entry owned
  by root. Runs on macOS or Linux with curl, tar, gzip and python3.
- **x86-64 payload** (`scripts/build-x86.sh`): the compile needs an x86-64
  glibc toolchain. With Docker it uses `debian:bookworm-slim` pinned by
  digest under `--platform linux/amd64`; without, `--lima` uses the x86-64
  chroot of a Lima VM made by `scripts/vm/x86-build-env.sh` (developer
  machines that had the old runtime already have one). Either way
  `scripts/x86-compile.sh` runs inside and refuses any binary that needs a
  glibc symbol newer than 2.36. The runtime libraries come from Debian
  bookworm's `libc6`, `libgcc-s1` and `libstdc++6` packages, fetched from
  the pool and checked by SHA-256, unpacked with `tar` (a `.deb` is an `ar`
  archive). The guest sees `lib64/ld-linux-x86-64.so.2`, a flat `lib/` and
  `bin/`.

## Signing

Virtualization.framework refuses to create a VM unless the calling binary
carries the `com.apple.security.virtualization` entitlement. That entitlement
is not restricted: it needs no provisioning profile and no Apple Developer
account, and it works under an ad-hoc signature. `scripts/build-launcher.sh`
signs ad hoc (`codesign -s -`) with the entitlement, and `scripts/build-bridge.sh`
signs the bridge ad hoc. Those are the binaries that ship.

What decides whether ad hoc is enough is the quarantine flag. macOS refuses
to run an ad-hoc-signed executable from a file marked as downloaded from the
internet, and asks for a Developer ID signature instead.

- **Lab installs**: SoundBase Desktop downloads and unpacks the plugin
  itself, and the files it writes are not quarantined. Every plugin
  installed that way on the test Mac had no quarantined file, and other Lab
  plugins already ship ad-hoc-signed native libraries. Ad hoc is enough.
- **Manual installs from a browser download**: the zip, and anything
  unpacked from it with Finder, is quarantined, and the launcher and bridge
  will not start. Clear the flag on the plugin folder once:

  ```sh
  xattr -dr com.apple.quarantine "/path/to/signal-hound-sa44b"
  ```

- **If that ever changes**, sign both binaries with a Developer ID
  Application certificate, hardened runtime on, keeping the entitlement
  (`SB_CODESIGN_IDENTITY="Developer ID Application: …" scripts/build-launcher.sh`),
  and notarize them. That needs the paid Apple Developer Program; a free
  Apple ID cannot issue Developer ID certificates or notarize. The x86-64
  Linux files and the kernel are data to macOS and never need a signature.

## When it does not come up

Everything the runtime does is in the plugin log (`[signal-hound-sa44b]
mac-host:` lines; guest console lines are prefixed `guest:`).

- **"ftdi-bridge is not built"** / **"the macOS runtime is incomplete
  (missing: …)"** — the built files are not in the folder. `npm run
  build:mac`, or reinstall the plugin.
- **"The virtual machine failed to start" (VZErrorDomain Code=1)** — almost
  always the two-VM limit: macOS runs at most two Virtualization.framework
  VMs per host, and Lima, Docker Desktop, OrbStack, Parallels (on Apple's
  hypervisor) and leftover `limactl hostagent` processes each count. Stop
  one. The same error with no other VM running means the launcher's
  signature lost its entitlement (`codesign -d --entitlements - driver/microvm/bin/sa44b-vm`).
- **The launcher or bridge is killed on start, or macOS says it "cannot be
  verified"** — the plugin folder is quarantined (a manual install from a
  browser download). See *Signing*.
- **"Rosetta is required … not installed"** — `softwareupdate` failed or
  needs an administrator; run the command it names in Terminal.
- **`guest: [guest] FATAL: cannot mount the Rosetta share`** — Rosetta is
  installed but the share is refused; macOS 13 or newer is required.
- **`guest: … Exec format error`** on `vsock-agent` — the Rosetta binfmt did
  not register; the console line before it says why. The registration line
  uses `\xHH` escapes that the kernel decodes itself (raw bytes are cut at
  the first NUL).
- **`[launcher] guest vsock port 7788: cannot reach 127.0.0.1:7788`** — the
  bridge died; the next open restarts it.
- **Worker answers but `list` is empty** — the bridge does not see the unit:
  cable, hub, or Spike/another program holding the FTDI ports. `curl
  localhost:PORT/devices` is served by the bridge alone and is the quick
  check.
- **Everything works by hand but not from SoundBase** — compare the
  environment: `HOME` must be set (the cache dir derives from it) and
  `/usr/bin/unzip` must be reachable; nothing else from the environment is
  used.

To watch a boot by hand:

```sh
driver/microvm/bin/sa44b-vm --kernel "$PWD/driver/microvm/guest/Image" --initrd "$PWD/driver/microvm/guest/initramfs.img" --cmdline "console=hvc0" --share "host=payload:$PWD/driver/microvm/guest/x86:ro" --share "host=state:$HOME/Library/Caches/signal-hound-sa44b/state" --rosetta --vsock-listen 7788:7788 --forward /tmp/sa44b.sock:7790 --ready-marker "vsock-agent: listening"
```

It prints one JSON line per event and exits when its stdin closes. With it
up, `printf '{"id":1,"op":"ping"}\n' | nc -U /tmp/sa44b.sock` answers from a
worker inside the guest.
