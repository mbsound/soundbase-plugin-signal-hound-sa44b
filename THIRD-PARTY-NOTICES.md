# Third-party software in this plugin

The plugin's own code is licensed under BUSL-1.1 (see `LICENSE`). The macOS
runtime under `driver/` also carries the third-party components below, each
under its own licence. The full licence texts are in `licenses/`.

## Signal Hound's SA API (not included)

`libsa_api.so.3.0.11` is **not** part of this plugin. On first use the plugin
downloads Signal Hound's SDK zip from signalhound.com to the user's own Mac
and extracts the library from it. It is governed by Signal Hound's API EULA,
which ships inside the SDK zip under
`sa_linux_sdk/software_license/`. Signal Hound does not support the SA44 or
SA124 on macOS and does not support this plugin; do not contact them about it.

## Components in the macOS runtime

| Component | Version | Where it is | Licence | Licence text |
| --- | --- | --- | --- | --- |
| Linux kernel (Alpine `linux-virt`, from `linux-lts`) | 6.12.114-r0 | `driver/microvm/guest/Image`, modules in `initramfs.img` | GPL-2.0-only with the Linux syscall note | `licenses/GPL-2.0.txt`, `licenses/Linux-syscall-note.txt` |
| BusyBox (Alpine `busybox-static`) | 1.37.0-r20 | `driver/microvm/guest/initramfs.img` | GPL-2.0-only | `licenses/GPL-2.0.txt` |
| GNU C Library (Debian `libc6`) | 2.36-9+deb12u14 | `driver/microvm/guest/x86/lib`, `lib64` | LGPL-2.1-or-later | `licenses/LGPL-2.1.txt`, `licenses/debian-glibc-2.36.copyright.txt` |
| GCC runtime `libgcc_s` (Debian `libgcc-s1`) | 12.2.0-14+deb12u1 | `driver/microvm/guest/x86/lib` | GPL-3.0-or-later with the GCC Runtime Library Exception 3.1 | `licenses/GPL-3.0.txt`, `licenses/debian-gcc-12.copyright.txt` (contains the exception) |
| GNU C++ library `libstdc++` (Debian `libstdc++6`) | 12.2.0-14+deb12u1 | `driver/microvm/guest/x86/lib` | GPL-3.0-or-later with the GCC Runtime Library Exception 3.1 | as above |
| libusb | 1.0.29 | statically linked into `driver/bridge/bin/darwin-arm64/ftdi-bridge` | LGPL-2.1-or-later | `licenses/LGPL-2.1.txt` |
| libftdi1 | 1.5 | statically linked into `driver/bridge/bin/darwin-arm64/ftdi-bridge` | LGPL-2.0 (GNU Library GPL v2) | `licenses/LGPL-2.0.txt`, `licenses/libftdi1.LICENSE.txt` |

Apple's Rosetta is not included. The launcher asks macOS to share the copy
installed on the user's Mac with the guest.

Exact package digests are recorded in `driver/microvm/guest/MANIFEST` and
`driver/microvm/guest/x86/MANIFEST`.

## Corresponding source

Each GitHub Release of this plugin carries, next to the plugin zip, an archive
named `signal-hound-sa44b-<version>-sources.tar`. It holds the complete
corresponding source for every component above, built by
`scripts/fetch-sources.sh` from these exact inputs:

- **Linux**: Alpine aports commit `6a0c60d347a1193d1d7ebb41a6e72dc0da1e8137`,
  directory `main/linux-lts` (build recipe, patches and kernel config), plus
  the upstream `linux-6.12.114.tar.xz` from kernel.org.
- **BusyBox**: Alpine aports commit `2e97d754a30d558f15524b8e422303c8a96832df`,
  directory `main/busybox`, plus the upstream `busybox-1.37.0.tar.bz2` from
  busybox.net.
- **glibc**: the Debian source package `glibc` 2.36-9+deb12u14.
- **libgcc_s and libstdc++**: the Debian source package `gcc-12`
  12.2.0-14+deb12u1.
- **libusb** 1.0.29 and **libftdi1** 1.5: the upstream release tarballs.

## Relinking ftdi-bridge

libusb and libftdi1 are linked statically into `ftdi-bridge`. The bridge's
full source is in this plugin at `driver/bridge/`, and the build script that
links it, `scripts/build-bridge.sh`, is in the plugin's public repository at
the same release tag. Together with the library sources above they let you
rebuild the bridge against modified versions of either library, and the
plugin uses whatever binary is at `driver/bridge/bin/darwin-arm64/ftdi-bridge`.
