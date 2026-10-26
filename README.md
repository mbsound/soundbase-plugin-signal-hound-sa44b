# Signal Hound SA44B for SoundBase

A [SoundBase](https://soundbase.app) plugin that turns a Signal Hound **SA44B**
USB spectrum analyzer (and its siblings, the SA44, SA124A and SA124B) into a
live spectrum source for RF coordination.

> **Windows only.** Signal Hound ships the SA-series API (`sa_api.dll`) for
> Windows x64 and nothing else; the company has said repeatedly that the
> SA44/SA124 are Windows-only and that the old Linux and ARM builds are
> unsupported. There is no macOS library and no published USB protocol, so
> this plugin cannot drive the hardware on a Mac. It declares `win32-x64` in
> its manifest and SoundBase Desktop will refuse to install it anywhere else.
> On a Mac the whole plugin still *runs* in mock mode (below), which is how
> it is developed and tested.

## Requirements on the Windows machine

1. **SoundBase Desktop** for Windows.
2. **Spike**, Signal Hound's own software, installed from
   [signalhound.com](https://signalhound.com/spike/). Installing Spike is the
   supported way to get three things this plugin needs:
   - the FTDI D2XX USB driver the SA44B talks through;
   - `sa_api.dll` and `ftd2xx.dll`, in `C:\Program Files\Signal Hound\Spike`,
     which the plugin loads from there by default;
   - the Visual C++ runtime the DLL depends on.
3. **Internet access the first time a unit is opened** on that PC. The API
   downloads the unit's calibration file from Signal Hound and caches it under
   `C:\ProgramData\SignalHound`. That first open can take well over the usual
   five seconds; the plugin allows 90.

Open the SA44B in Spike once to confirm it sweeps. Close Spike before using
SoundBase: only one program can hold the device.

If `sa_api.dll` lives somewhere else, set **SA API folder** in the plugin's
settings (or the `SB_SA44B_SDK_DIR` environment variable) to the folder that
contains both DLLs.

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
- **Reference level** from -100 to +20 dBm. Leave attenuation and gain on
  *Auto* and set the reference level a little above the strongest expected
  signal: that is how the API picks the front end for the best dynamic range.
- **Controls**, rendered by SoundBase beside RBW and point count: attenuation,
  gain, detector (peak or average), image rejection, RBW filter shape, and —
  on the SA44B only — the internal preamplifier.
- A **sweep-time estimate** with every configuration, refined from measured
  sweeps, so SoundBase does not mistake a slow wide sweep for a stalled
  device. The SA44B is not fast: a 146 MHz UHF span at 10 kHz RBW takes on
  the order of a second, and the full 4.4 GHz at 10 kHz takes tens of seconds.

## How it is built

```
soundbase-plugin.json      identity, the SA44B product, config fields
main.js                    shell bootstrap — unchanged from the template
adapter.js                 device logic: capabilities, clamping, the sweep loop
driver/
  worker-client.js         one child process per device, JSON lines over stdio,
                           a deadline on every call, SIGKILL when one is missed
  worker/sa44b-worker.c    the only code that touches sa_api.dll
  worker/bin/<target>/     built workers (win32-x64 is committed; host builds
                           are made locally)
scripts/build-worker.sh    builds the worker for the host and, with mingw-w64
                           installed, for Windows
__tests__/                 contract tests through the real shell, in mock mode
```

The vendor library is blocking and owns a USB device, so it never runs inside
the plugin's own process. `sa44b-worker` loads `sa_api.dll` at runtime and
answers one request at a time; if a USB transfer wedges, the plugin kills the
worker, reports the device as failed, and stays alive for every other device.
The worker binary is a plain C program with no dependencies beyond the DLLs
Spike installs.

## Running without hardware (mock mode)

```sh
npm install
npm run build:worker        # needs a C compiler; adds mingw-w64 for the Windows build
SB_SA44B_MOCK=1 npm start   # the worker produces a synthetic spectrum
npm test                    # the tests set SB_SA44B_MOCK themselves
SB_SA44B_MOCK=1 npm run smoke
```

In mock mode the worker still runs as a real child process — only the vendor
library is replaced — so the process boundary, the RPC, the deadline, the
resampling and the failure path are all exercised. The synthetic unit reports
serial `12345678` and a spectrum with two carriers and an occasional transient.

To see the mock device inside SoundBase Desktop on a development machine, add
that machine's platform (for example `darwin-arm64`) to `platforms` in the
manifest temporarily, then:

```sh
SB_SA44B_MOCK=1 SB_PLUGIN_DIRS="$HOME/CODE" open -a "SoundBase Desktop"
```

Put the platform list back before releasing.

## Testing against the real SA44B

On the Windows machine, with Spike installed and closed and the unit plugged
in:

```sh
npm install
npm start
```

Then, in another shell, using the port the handshake line printed:

```sh
curl localhost:PORT/devices
curl -X POST localhost:PORT/devices/usb%3Asa%3ASERIAL/configuration -H "content-type: application/json" -d "{\"startHz\":470000000,\"stopHz\":616000000,\"pointCount\":451,\"rbwHz\":10000}"
curl -X POST localhost:PORT/devices/usb%3Asa%3ASERIAL/sweep/start
curl localhost:PORT/devices/usb%3Asa%3ASERIAL/trace
```

The worker can also be driven by hand, which is the quickest way to see what
the API says about a unit:

```sh
printf "%s\n" "{\"id\":1,\"op\":\"ping\"}" "{\"id\":2,\"op\":\"list\"}" "{\"id\":3,\"op\":\"open\"}" | driver\worker\bin\win32-x64\sa44b-worker.exe
```

## Releasing

`npm run pack:release` builds `dist/signal-hound-sa44b-<version>.zip` and
boots it the way SoundBase does. The GitHub Actions workflow in
`.github/workflows/release.yml` does the same on a tag, building the worker
for Windows with mingw-w64 first. See `docs/publishing.md`.

The plugin does **not** bundle `sa_api.dll` or `ftd2xx.dll`; Signal Hound's
API licence governs their redistribution, and installing Spike provides them.

## Known limits

- No real-time, I/Q or audio modes: SoundBase wants sweeps.
- The SA API reports only serial numbers until a unit is opened, so every
  unit is listed under the SA44B product; the model it really is appears
  once it has been opened.
- Not yet verified against hardware. The adapter follows the SA API manual
  and the code paths are tested against the worker in mock mode, but the
  first run on a Windows PC with an SA44B attached is still to be done.
