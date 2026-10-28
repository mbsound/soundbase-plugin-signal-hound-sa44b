# Signal Hound SA44B for SoundBase

A [SoundBase](https://soundbase.app) plugin that turns a Signal Hound **SA44B**
USB spectrum analyzer (and its siblings, the SA44, SA124A and SA124B) into a
live spectrum source for RF coordination.

This plugin runs on **Apple Silicon Macs** (macOS 13 or newer) only. It runs
Signal Hound's obsolete x86-64 **Linux** build of their SA API inside a small
Linux guest it boots itself, and bridges the analyzer's USB traffic back to
the Mac.

> **Not supported by Signal Hound.** Signal Hound supports the SA44 and SA124
> on Windows only and does not support them on macOS or Apple Silicon. They do
> not support this plugin, and they cannot help with problems running it.
> Report problems with this plugin through its own GitHub repository, not to
> Signal Hound.

## macOS (Apple Silicon)

There is no macOS SA API, no published USB protocol and no open-source
driver, so the only code that can drive an SA44B on a Mac is the x86-64 Linux
`libsa_api.so.3.0.11` that Signal Hound still ships (marked obsolete) inside
their SDK zip. This plugin runs it out of its own folder, with nothing to
install:

```
SoundBase Desktop ── plugin (Node, arm64) ── sa44b-vm (Virtualization.framework) ──▶ Linux guest (arm64 kernel + busybox initramfs)
                           │                        │  virtiofs: Rosetta, x86 payload, cache       │ Rosetta binfmt
                           │                        │  vsock: worker channel, bridge channel       └─ vsock-agent ─ sa44b-worker (x86-64)
                           │                        │                                                   libsa_api.so ─ shim libftd2xx.so
                           └─ ftdi-bridge (static libusb) ◀── launcher proxies vsock port 7788 ──▶ TCP 127.0.0.1:7788 ◀────┘
                                   │
                              SA44B (FT2232H, both ports)
```

- `driver/bridge/ftdi-bridge.c` holds the SA44B's two FTDI ports through
  libusb (no root, no kernel extension; it coexists with Apple's FTDI driver)
  and serves the thirteen D2XX calls the library uses, with D2XX semantics
  (blocking reads with timeouts, queue status, port cycling). It is linked
  statically against libusb and libftdi, so it needs nothing from Homebrew.
- `driver/microvm/Launcher.swift` is a small launcher on Apple's
  Virtualization.framework: it boots the guest in `driver/microvm/guest/`
  (an Alpine `linux-virt` kernel and a busybox initramfs, pinned by version
  and digest), shares Rosetta and two host directories with it, and exposes
  a vsock. No Lima, no ssh, no disk image.
- The guest's `/init` mounts the shares, registers Rosetta for x86-64 ELFs
  and starts `vsock-agent`, which hands the plugin a fresh `sa44b-worker`
  for every connection. The x86-64 side (`driver/microvm/guest/x86/`) is the
  worker, the agent, the shim `libftd2xx.so` that forwards every D2XX call
  over the vsock to the bridge, and the Debian glibc/libstdc++ the library
  needs. No distribution, no package manager.
- `driver/mac-host.js` runs it all: starts the bridge, fetches the library
  on first open, checks Rosetta, boots the guest and connects the adapter to
  a worker.

### Setup

None. Install the plugin in SoundBase (or `npm install && npm start` from a
checkout with the built runtime committed in it). The first time a device is
opened the plugin:

1. downloads Signal Hound's SDK zip (about 160 MB, with a progress line in
   the plugin log) and extracts `libsa_api.so.3.0.11` from it into
   `~/Library/Caches/signal-hound-sa44b/state/sdk/`. The library is not part
   of this plugin; Signal Hound's API licence governs it and it is fetched
   for use with your own device.
2. makes sure Rosetta is available. macOS 27 has it built in; on macOS 13 to
   26 the plugin runs `softwareupdate --install-rosetta --agree-to-license`
   when it is missing and says so in the log.
3. boots the guest, which takes well under a second.

Then `npm start`, or point SoundBase Desktop at the folder:

```sh
SB_PLUGIN_DIRS="$HOME/Documents" open -a "SoundBase Desktop"
```

What to expect: discovery lists the unit by serial within a second (the
bridge enumerates it directly; the guest is not needed for that). The first
open after a boot takes about 10 s (5–6 s of that is the library's own open
sequence, which cycles the USB port once). A 146 MHz UHF span at 10 kHz RBW
sweeps in about 1.4 s. The library pulls the unit's calibration files from
the device's flash on first open and keeps them in the cache directory, so
no internet access is needed after the SDK download.

Measured on this path with an SA44B (firmware 2.12): stable UHF sweeps with
repeatable peaks across consecutive sweeps, 76 650 device bins resampled to
451 points.

The guest lives and dies with the plugin process: the launcher exits when
the plugin's pipe to it closes, and the agent kills a worker the moment the
plugin drops its connection, so a wedged library never survives a restart
and nothing is left running when SoundBase quits.

Caveats:

- Signal Hound warns that their non-Windows FTDI paths can lose data on slow
  systems; the bridge buffers up to 32 MB per port and has not dropped data
  in testing, but this is an unsupported library on an unsupported OS.
- Only Apple Silicon, macOS 13 or newer: Rosetta for Linux is what runs the
  x86-64 library at native speed. An Intel Mac would need an x86-64 Linux VM
  instead.
- macOS allows two Virtualization.framework VMs at a time. If another VM
  product (Lima, Docker Desktop, Parallels on Apple's hypervisor) already
  holds both, opening the device fails with "The virtual machine failed to
  start"; stop one of them.

Building the runtime yourself, signing it for distribution, and what to do
when it does not come up are in `docs/macos-runtime.md`.

## What SoundBase gets

- **Discovery** by serial number: every attached SA unit appears as
  `usb:sa:<serial>`. A device can also be added by hand with its serial.
- **Sweeps** from 1 Hz to 4.4 GHz (SA44/SA44B) or 100 kHz to 13 GHz (SA124),
  at any point count up to 10 000. The device sweeps at its own bin size; the
  plugin resamples onto the requested points, keeping the **maximum** of the
  bins behind each point so a narrow carrier is never lost between points.
- **RBW** 1 k, 3 k, 10 k, 30 k, 100 k and 250 kHz (plus 6 MHz on the SA124),
  or auto. The API's rule that RBW must be at least 6.5 kHz on spans of
  100 MHz or more (and on spans over 200 kHz that start below 16 MHz) is
  applied before the request reaches the hardware and echoed back as the
  effective value, so a 10 kHz request on a 146 MHz span sweeps at 10 kHz and
  a 1 kHz request on the same span sweeps at 6.5 kHz.
- **Reference level** from -100 to +20 dBm, as a device control (SoundBase's
  live-scan dialog has no field of its own for it), **default -50 dBm**.
  Leave attenuation and gain on *Auto* and set the reference level a little
  above the strongest expected signal: that is how the API picks the front
  end for the best dynamic range. At -20 dBm the displayed floor sits near
  -80 dBm; at -50 to -60 dBm with the preamp on it reaches about -100 dBm at
  10 kHz RBW, which is where a coordination sweep needs to be.
- **VBW**, offered in the same steps as RBW and clamped to at most the RBW.
  Left on auto it equals the RBW, which is what the API recommends for
  speed; narrower smooths the trace and slows the sweep. The device's
  6.5 kHz floor on spans of 100 MHz or more applies to VBW as well as RBW
  (the API clamps it itself and reports "bandwidth limited"), so on a wide
  span VBW only has room once the RBW is above 6.5 kHz.
- **Controls**, rendered by SoundBase beside RBW and point count, covering
  everything the SA API exposes for a sweep: reference level, attenuation,
  gain, detector (peak or average), image rejection, RBW filter shape, video
  processing units (log, power, voltage, bypass), the 10 MHz timebase port
  (internal, external in, internal out), a second **Min** curve from the
  min/max detector, and — on the SA44B only — the internal preamplifier.
- A **sweep-time estimate** with every configuration, refined from measured
  sweeps, so SoundBase does not mistake a slow wide sweep for a stalled
  device. The SA44B is not fast: a 146 MHz UHF span at 10 kHz RBW takes on
  the order of a second, and the full 4.4 GHz at 10 kHz takes tens of seconds.

## How it is built

```
soundbase-plugin.json      identity, the SA44B product, config fields
THIRD-PARTY-NOTICES.md     the third-party components and their licences
licenses/                  the full licence texts
main.js                    shell bootstrap — unchanged from the template
adapter.js                 device logic: capabilities, clamping, the sweep loop
driver/
  worker-client.js         one child process per device, JSON lines over stdio,
                           a deadline on every call, SIGKILL when one is missed
  worker/sa44b-worker.c    the only code that touches the SA API
  worker/bin/<target>/     host builds for mock mode (not committed)
  bridge/                  macOS: FTDI D2XX over TCP, on libusb (static)
  shim/                    Linux: libftd2xx.so that forwards to the bridge
  microvm/                 macOS: the Virtualization.framework launcher, the
                           guest (kernel, initramfs, x86-64 payload) and the
                           guest agent
  mac-host.js              macOS: bridge, library fetch, Rosetta, guest boot
scripts/build-worker.sh    builds the worker for this machine (mock mode)
scripts/build-bridge.sh    the static bridge (libusb + libftdi from source)
scripts/build-launcher.sh  the launcher (swiftc + codesign)
scripts/build-guest.sh     the guest kernel and initramfs (Alpine packages)
scripts/build-x86.sh       the x86-64 payload (docker or a Lima chroot)
scripts/fetch-sources.sh   the GPL/LGPL corresponding sources, for each release
__tests__/                 contract tests through the real shell, in mock mode
```

The vendor library is blocking and owns a USB device, so it never runs inside
the plugin's own process. `sa44b-worker` loads `libsa_api.so` at runtime
inside the guest and answers one request at a time; if a USB transfer wedges,
the plugin drops the worker's connection, the guest kills it, and the plugin
reports the device as failed and stays alive for every other device.

## Running without hardware (mock mode)

```sh
npm install
npm run build:worker        # needs a C compiler
SB_SA44B_MOCK=1 npm start   # the worker produces a synthetic spectrum
npm test                    # the tests set SB_SA44B_MOCK themselves
SB_SA44B_MOCK=1 npm run smoke
```

In mock mode the worker still runs as a real child process — only the vendor
library is replaced — so the process boundary, the RPC, the deadline, the
resampling and the failure path are all exercised. The synthetic unit reports
serial `12345678` and a spectrum with two carriers and an occasional transient.

To see the mock device inside SoundBase Desktop:

```sh
SB_SA44B_MOCK=1 SB_PLUGIN_DIRS="$HOME/CODE" open -a "SoundBase Desktop"
```

## Testing against the real SA44B

With the unit plugged in:

```sh
npm install
npm start
```

Then, in another shell, using the port the handshake line printed:

```sh
curl localhost:PORT/devices
curl -X POST localhost:PORT/devices/usb%3Asa%3ASERIAL/configuration -H "content-type: application/json" -d '{"startHz":470000000,"stopHz":616000000,"pointCount":451,"rbwHz":10000}'
curl -X POST localhost:PORT/devices/usb%3Asa%3ASERIAL/sweep/start
curl localhost:PORT/devices/usb%3Asa%3ASERIAL/trace
```

The first configuration request boots the guest and opens the unit, which
takes about 8 s. `docs/macos-runtime.md` shows how to boot the guest by hand
and talk to a worker directly.

## Releasing

`npm run pack:release` builds `dist/signal-hound-sa44b-<version>.zip` and
boots it the way SoundBase does. The GitHub Actions workflow in
`.github/workflows/release.yml` does the same on a tag and publishes the zip
together with `signal-hound-sa44b-<version>-sources.tar`, the corresponding
source of the GPL and LGPL components (`THIRD-PARTY-NOTICES.md`). See
`docs/publishing.md`.

The macOS runtime under `driver/` is committed, because the zip is made of
tracked files. Rebuild it with `npm run build:mac` after changing anything
it is built from. Its binaries are ad-hoc signed, which is all a Lab install
needs; see the signing section of `docs/macos-runtime.md`.

The plugin does **not** bundle Signal Hound's library. Their API licence
governs it, and the plugin downloads it from signalhound.com to the user's
Mac on first use.

## Known limits

- No real-time, I/Q or audio modes: SoundBase wants sweeps.
- The SA API reports only serial numbers until a unit is opened, so every
  unit is listed under the SA44B product; the model it really is appears
  once it has been opened.
- Verified against hardware on one Mac: an SA44B (firmware 2.12) on macOS 27
  with an M-series CPU. The SA44, SA124A and SA124B follow the same API but
  have not been tried.
- The Rosetta install path for macOS 13 to 26 has not been exercised; macOS
  27 has Rosetta built in.
