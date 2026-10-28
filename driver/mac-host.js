// Running Signal Hound's x86-64 Linux SA API on a Mac, with nothing installed.
//
// Signal Hound never shipped a macOS build of the SA API. What they did ship,
// in 2016 and now marked obsolete, is libsa_api.so for x86-64 Linux, which
// talks to the SA44B through FTDI's D2XX library. This module runs that
// library on Apple Silicon out of the plugin folder alone:
//
//   ftdi-bridge (driver/bridge/bin/)      holds the SA44B's two FTDI ports via
//                                         libusb (statically linked) and serves
//                                         D2XX calls over TCP on 127.0.0.1
//   sa44b-vm (driver/microvm/bin/)        a Virtualization.framework launcher
//                                         that boots a tiny Linux guest from
//                                         driver/microvm/guest/ (arm64 kernel +
//                                         busybox initramfs), shares Rosetta
//                                         and two host directories with it,
//                                         and exposes a vsock
//   the guest                             registers Rosetta for x86-64 ELFs and
//                                         runs vsock-agent, which starts one
//                                         sa44b-worker per host connection;
//                                         the worker loads libsa_api.so, whose
//                                         D2XX calls go through the shim
//                                         libftd2xx.so over the vsock to the
//                                         launcher, which proxies them to the
//                                         bridge
//   this module                           starts the bridge, fetches the
//                                         library from Signal Hound's SDK on
//                                         first use, makes sure Rosetta is
//                                         installed, boots the guest, and
//                                         hands the adapter a unix socket on
//                                         which a fresh worker answers
//
// The guest lives and dies with this plugin process: the launcher exits when
// its stdin closes, and the agent kills a worker the moment the host drops
// its connection, so no worker ever outlives the plugin that started it.
// The library and the calibration files it pulls from the device are kept in
// a cache directory shared into the guest.

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, symlinkSync, readlinkSync, unlinkSync, renameSync, createWriteStream, rmSync, cpSync } from 'node:fs';
import { createConnection } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const execFileP = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));

export const BRIDGE_PORT = Number(process.env.SB_SA44B_BRIDGE_PORT) || 7788;
export const AGENT_PORT = Number(process.env.SB_SA44B_AGENT_PORT) || 7790;
export const SDK_URL =
  process.env.SB_SA44B_SDK_URL || 'https://signalhound.com/sigdownloads/SDK/signal_hound_sdk_10_05_26.zip';
// the Linux SDK inside the SDK zip, and the library inside that
const SDK_INNER_ZIP = 'signal_hound_sdk/device_apis/sa_series/lib/_obsolete/linux (obsolete)/sa_linux_sdk_3011.zip';
const SDK_INNER_FILES = ['sa_linux_sdk/lib/libsa_api.so.3.0.11', 'sa_linux_sdk/include/sa_api.h', 'sa_linux_sdk/README.txt', 'sa_linux_sdk/software_license/*'];
export const LIBRARY_FILE = 'libsa_api.so.3.0.11';

export const CACHE_DIR = process.env.SB_SA44B_CACHE_DIR || join(homedir(), 'Library', 'Caches', 'signal-hound-sa44b');
// where scripts/vm/provision.sh used to cache the SDK zip; reused if present
const LEGACY_ZIP_DIR = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'signal-hound-sa44b');
const STATE_DIR = join(CACHE_DIR, 'state'); // shared into the guest as /host/state
const SDK_DIR = join(STATE_DIR, 'sdk');
const CAL_DIR = join(STATE_DIR, 'cal');

const RUNTIME_DIR = join(HERE, 'microvm');
export const RUNTIME = {
  bridge: join(HERE, 'bridge', 'bin', `darwin-${process.arch}`, 'ftdi-bridge'),
  launcher: join(RUNTIME_DIR, 'bin', 'sa44b-vm'),
  kernel: join(RUNTIME_DIR, 'guest', 'Image'),
  initrd: join(RUNTIME_DIR, 'guest', 'initramfs.img'),
  payload: join(RUNTIME_DIR, 'guest', 'x86', 'bin', 'sa44b-worker'),
};
const PAYLOAD_DIR = join(RUNTIME_DIR, 'guest', 'x86');

const OP_PING = 0;
const OP_LIST = 1;
const OP_DETAIL = 2;

const VM_READY_TIMEOUT_MS = 60_000;
const ROSETTA_INSTALL_TIMEOUT_MS = 15 * 60_000;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => process.stderr.write(`[signal-hound-sa44b] mac-host: ${msg}\n`);

export const isMacHost = () => process.platform === 'darwin';

/** Pieces of the macOS runtime that are missing from this plugin folder. */
export function missingRuntime() {
  return Object.entries(RUNTIME)
    .filter(([, path]) => !existsSync(path))
    .map(([name]) => name);
}

/** True when the bridge, the launcher and the guest image are all here. */
export function runtimeAvailable() {
  return missingRuntime().length === 0;
}

// ---------------------------------------------------------------------------
// The bridge wire protocol (driver/bridge/protocol.h)
// ---------------------------------------------------------------------------

/** One request frame: u32 len | u8 op | u32 handle | payload. */
export function encodeRequest(op, payload = Buffer.alloc(0), handle = 0) {
  const hdr = Buffer.alloc(9);
  hdr.writeUInt32LE(5 + payload.length, 0);
  hdr.writeUInt8(op, 4);
  hdr.writeUInt32LE(handle, 5);
  return Buffer.concat([hdr, payload]);
}

/**
 * Parse one response frame (u32 len | u32 ft_status | payload) from the
 * front of `buf`; null while incomplete.
 */
export function decodeResponse(buf) {
  if (buf.length < 4) return null;
  const len = buf.readUInt32LE(0);
  if (len < 4 || buf.length < 4 + len) return null;
  return { status: buf.readUInt32LE(4), payload: buf.subarray(8, 4 + len), rest: buf.subarray(4 + len) };
}

/** A D2XX device-info record as the bridge lays it out (96 bytes). */
export function decodeDeviceInfo(payload) {
  if (payload.length < 96) return null;
  const cstr = (b) => b.toString('latin1').replace(/\0.*$/s, '');
  return {
    flags: payload.readUInt32LE(0),
    type: payload.readUInt32LE(4),
    id: payload.readUInt32LE(8),
    locid: payload.readUInt32LE(12),
    serial: cstr(payload.subarray(16, 32)),
    description: cstr(payload.subarray(32, 96)),
  };
}

/** One request to the bridge over a fresh connection. */
function bridgeCall(op, payload = Buffer.alloc(0), { timeoutMs = 3000, port = BRIDGE_PORT } = {}) {
  return new Promise((resolve, reject) => {
    const sock = createConnection({ host: '127.0.0.1', port });
    const chunks = [];
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('ftdi-bridge did not answer'));
    }, timeoutMs);
    sock.on('connect', () => sock.write(encodeRequest(op, payload)));
    sock.on('data', (d) => {
      chunks.push(d);
      const frame = decodeResponse(Buffer.concat(chunks));
      if (!frame) return;
      clearTimeout(timer);
      sock.end();
      resolve({ status: frame.status, payload: frame.payload });
    });
    sock.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

let bridgeChild = null;

async function bridgeAlive() {
  try {
    const { status } = await bridgeCall(OP_PING, Buffer.alloc(0), { timeoutMs: 1000 });
    return status === 0;
  } catch {
    return false;
  }
}

export async function ensureBridge() {
  if (await bridgeAlive()) return;
  if (!existsSync(RUNTIME.bridge)) {
    throw new Error(`ftdi-bridge is not built: run scripts/build-bridge.sh`);
  }
  log(`starting ftdi-bridge on 127.0.0.1:${BRIDGE_PORT}`);
  const args = ['-b', '127.0.0.1', '-p', String(BRIDGE_PORT)];
  // SB_SA44B_BRIDGE_TRACE=<file>: log every bridge op and the bytes of every
  // USB read and write there, for debugging the vendor library's behaviour
  if (process.env.SB_SA44B_BRIDGE_TRACE) args.push('-v', '-t', process.env.SB_SA44B_BRIDGE_TRACE);
  bridgeChild = spawn(RUNTIME.bridge, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  bridgeChild.stderr.on('data', (d) => {
    for (const line of String(d).split('\n')) if (line.trim()) log(line.trim());
  });
  bridgeChild.on('error', (err) => log(`ftdi-bridge failed to start: ${err.message}`));
  bridgeChild.on('exit', (code, sig) => {
    log(`ftdi-bridge exited (${sig ?? code})`);
    bridgeChild = null;
  });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await bridgeAlive()) return;
    await delay(100);
  }
  throw new Error('ftdi-bridge did not come up');
}

/** FTDI ports the bridge sees, as D2XX lists them. */
export async function listPorts({ port = BRIDGE_PORT } = {}) {
  const { status, payload } = await bridgeCall(OP_LIST, Buffer.alloc(0), { port });
  if (status !== 0) throw new Error(`ftdi-bridge list failed (${status})`);
  const count = payload.readUInt32LE(0);
  const ports = [];
  for (let i = 0; i < count; i++) {
    const idx = Buffer.alloc(4);
    idx.writeUInt32LE(i, 0);
    const r = await bridgeCall(OP_DETAIL, idx, { port });
    const info = r.status === 0 ? decodeDeviceInfo(r.payload) : null;
    if (info) ports.push({ index: i, ...info });
  }
  return ports;
}

/** Signal Hound SA serial numbers attached right now, from FTDI port A. */
export function saSerialsFromPorts(ports) {
  const serials = [];
  for (const p of ports) {
    if (!/signal hound/i.test(p.description)) continue;
    const m = /^(\d+)A$/.exec(p.serial);
    if (m) serials.push(Number(m[1]));
  }
  return serials;
}

export async function listSerials() {
  await ensureBridge();
  return saSerialsFromPorts(await listPorts());
}

// ---------------------------------------------------------------------------
// Signal Hound's library: fetched from their SDK zip on first use
// ---------------------------------------------------------------------------

function ensureSymlink(target, path) {
  try {
    if (readlinkSync(path) === target) return;
    unlinkSync(path);
  } catch {
    /* absent, or not a link */
  }
  try {
    unlinkSync(path);
  } catch {
    /* absent */
  }
  symlinkSync(target, path);
}

async function download(url, dest, { onProgress } = {}) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`GET ${url} -> ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let got = 0;
  let lastPct = -1;
  const progress = async function* (src) {
    for await (const chunk of src) {
      got += chunk.length;
      if (total && onProgress) {
        const pct = Math.floor((got / total) * 10) * 10;
        if (pct !== lastPct) {
          lastPct = pct;
          onProgress(pct, got, total);
        }
      }
      yield chunk;
    }
  };
  const part = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body), progress, createWriteStream(part));
  renameSync(part, dest);
}

const unzip = (zip, members, dest) => execFileP('unzip', ['-q', '-o', zip, ...members, '-d', dest], { maxBuffer: 1 << 20 });

/**
 * Make sure libsa_api.so.3.0.11 is in the cache the guest sees. Signal
 * Hound's API licence governs the library; it is downloaded from their site
 * for use with the user's own device and is never part of this plugin.
 */
export async function ensureLibrary() {
  mkdirSync(SDK_DIR, { recursive: true });
  mkdirSync(CAL_DIR, { recursive: true });
  const lib = join(SDK_DIR, LIBRARY_FILE);
  if (!existsSync(lib)) {
    const zipName = new URL(SDK_URL).pathname.split('/').pop() || 'signal_hound_sdk.zip';
    const downloads = join(CACHE_DIR, 'downloads');
    mkdirSync(downloads, { recursive: true });
    let zip = join(downloads, zipName);
    if (!existsSync(zip) && existsSync(join(LEGACY_ZIP_DIR, zipName))) zip = join(LEGACY_ZIP_DIR, zipName);
    if (!existsSync(zip)) {
      log(`downloading Signal Hound's SDK (about 160 MB) from ${SDK_URL} — the Linux SA API inside it is what drives the SA44B on a Mac`);
      await download(SDK_URL, zip, {
        onProgress: (pct, got, total) => log(`SDK download ${pct}% (${(got / 1e6).toFixed(0)} of ${(total / 1e6).toFixed(0)} MB)`),
      });
      log(`SDK zip saved to ${zip}`);
    }
    log(`extracting ${LIBRARY_FILE} from the SDK zip`);
    const tmp = join(CACHE_DIR, `extract-${process.pid}`);
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    try {
      await unzip(zip, [SDK_INNER_ZIP], tmp);
      await unzip(join(tmp, SDK_INNER_ZIP), SDK_INNER_FILES, tmp);
      for (const f of ['lib/libsa_api.so.3.0.11', 'include/sa_api.h', 'README.txt']) {
        cpSync(join(tmp, 'sa_linux_sdk', f), join(SDK_DIR, f.split('/').pop()));
      }
      cpSync(join(tmp, 'sa_linux_sdk', 'software_license'), join(SDK_DIR, 'software_license'), { recursive: true });
    } catch (err) {
      throw new Error(`could not extract ${LIBRARY_FILE} from ${zip}: ${err.message}. Delete the zip to download it again.`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  // the worker dlopens "libsa_api.so"; the file is named by its version
  ensureSymlink(LIBRARY_FILE, join(SDK_DIR, 'libsa_api.so'));
  return lib;
}

// ---------------------------------------------------------------------------
// Rosetta
// ---------------------------------------------------------------------------

async function launcherJson(args) {
  const { stdout } = await execFileP(RUNTIME.launcher, args, { maxBuffer: 1 << 20 }).catch((err) => {
    const line = (err.stdout || '').trim().split('\n').pop();
    throw new Error(line ? JSON.parse(line).message : err.message);
  });
  return JSON.parse(stdout.trim().split('\n').pop());
}

/** Rosetta's availability as the launcher sees it: installed, notInstalled, notSupported. */
export async function rosettaAvailability() {
  const r = await launcherJson(['--check-rosetta']);
  return r.availability;
}

/**
 * Rosetta is what runs the x86-64 library. macOS 27 ships it built in; on
 * macOS 13 to 26 it is an optional install, done here when missing.
 */
export async function ensureRosetta() {
  let availability = await rosettaAvailability();
  if (availability === 'installed') return;
  if (availability === 'notInstalled') {
    log('Rosetta is not installed on this Mac; installing it (softwareupdate --install-rosetta --agree-to-license)');
    try {
      await execFileP('softwareupdate', ['--install-rosetta', '--agree-to-license'], { timeout: ROSETTA_INSTALL_TIMEOUT_MS, maxBuffer: 1 << 20 });
    } catch (err) {
      log(`softwareupdate failed: ${(err.stderr || err.message).trim().split('\n').pop()}`);
    }
    availability = await rosettaAvailability();
    if (availability === 'installed') {
      log('Rosetta installed');
      return;
    }
  }
  if (availability === 'notInstalled') {
    throw new Error(
      'Rosetta is required to run Signal Hound\'s x86-64 library and is not installed. ' +
        'Run `softwareupdate --install-rosetta --agree-to-license` in Terminal, then open the device again.'
    );
  }
  throw new Error('this Mac cannot run x86-64 Linux programs under Rosetta (Apple Silicon and macOS 13 or newer are required)');
}

// ---------------------------------------------------------------------------
// The guest
// ---------------------------------------------------------------------------

/**
 * The launcher's command line for one guest. Pure, so it can be tested; the
 * launcher's own --dry-run parses the same list back.
 */
export function launcherArgs({
  kernel = RUNTIME.kernel,
  initrd = RUNTIME.initrd,
  payloadDir = PAYLOAD_DIR,
  stateDir = STATE_DIR,
  socketPath,
  bridgePort = BRIDGE_PORT,
  agentPort = AGENT_PORT,
  cpus = Number(process.env.SB_SA44B_VM_CPUS) || 2,
  memoryMB = Number(process.env.SB_SA44B_VM_MEMORY_MB) || 1024,
  shimLog = Boolean(process.env.SB_SA44B_SHIM_LOG),
} = {}) {
  if (!socketPath) throw new Error('launcherArgs: socketPath is required');
  const cmdline = ['console=hvc0', 'quiet', `sa44b.agent_port=${agentPort}`, `sa44b.bridge_port=${bridgePort}`];
  // SB_SA44B_SHIM_LOG=1: the shim logs every D2XX call to <cache>/state/shim.log
  if (shimLog) cmdline.push('sa44b.shimlog=1');
  return [
    '--kernel', kernel,
    '--initrd', initrd,
    '--cmdline', cmdline.join(' '),
    '--cpus', String(cpus),
    '--memory', String(memoryMB),
    '--share', `host=payload:${payloadDir}:ro`,
    '--share', `host=state:${stateDir}`,
    '--rosetta',
    // the shim connects to host vsock port <bridgePort>; the launcher proxies it to the bridge's TCP port
    '--vsock-listen', `${bridgePort}:${bridgePort}`,
    // the adapter connects to this unix socket; each connection becomes a worker in the guest
    '--forward', `${socketPath}:${agentPort}`,
    '--ready-marker', 'vsock-agent: listening',
  ];
}

let vmChild = null;
let vmSocketPath = null;
let vmReady = null;

/** Boot the guest (once per plugin process) and wait until the agent listens. */
export async function ensureVm() {
  if (vmChild && vmReady) return vmReady;
  const missing = missingRuntime();
  if (missing.length) {
    throw new Error(`the macOS runtime is incomplete (missing: ${missing.join(', ')}); run npm run build:mac, or reinstall the plugin`);
  }
  // sun_path is 104 bytes on macOS; tmpdir() is short, the plugin folder may not be
  const socketPath = join(tmpdir(), `sa44b-${process.pid}.sock`);
  const args = launcherArgs({ socketPath });
  log(`booting the Linux guest (${RUNTIME.launcher})`);
  const child = spawn(RUNTIME.launcher, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  vmChild = child;
  vmSocketPath = socketPath;
  vmReady = new Promise((resolve, reject) => {
    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      err ? reject(err) : resolve(socketPath);
    };
    const timer = setTimeout(() => {
      done(new Error(`the Linux guest did not become ready within ${VM_READY_TIMEOUT_MS / 1000} s`));
      stopVm();
    }, VM_READY_TIMEOUT_MS);
    timer.unref?.();
    createInterface({ input: child.stdout }).on('line', (line) => {
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        log(`launcher: ${line}`);
        return;
      }
      switch (ev.event) {
        case 'console':
          log(`guest: ${ev.line}`);
          break;
        case 'ready':
          log('the Linux guest is ready');
          done();
          break;
        case 'error':
          done(new Error(`${ev.message} (${ev.code})`));
          break;
        case 'stopped':
          done(new Error(`the Linux guest stopped (${ev.reason ?? 'unknown reason'})`));
          break;
        default:
          break;
      }
    });
    createInterface({ input: child.stderr }).on('line', (line) => line.trim() && log(`launcher: ${line}`));
    child.on('error', (err) => done(new Error(`cannot start the guest launcher: ${err.message}`)));
    child.on('exit', (code, sig) => {
      if (vmChild === child) {
        log(`the Linux guest exited (${sig ?? code}); it will be rebooted on the next open`);
        vmChild = null;
        vmReady = null;
        vmSocketPath = null;
      }
      done(new Error(`the guest launcher exited (${sig ?? code}) before the guest was ready`));
    });
  });
  return vmReady;
}

function stopVm() {
  const child = vmChild;
  if (!child) return;
  vmChild = null;
  vmReady = null;
  vmSocketPath = null;
  try {
    child.stdin.end(); // the launcher exits, and the guest with it
  } catch {
    /* gone */
  }
  const t = setTimeout(() => child.kill('SIGKILL'), 3000);
  t.unref?.();
}

/**
 * A worker left behind by a killed plugin would hold the device. With this
 * runtime that cannot happen — the guest is a child of this process and the
 * agent kills a worker when its connection drops — so this only has to make
 * sure no bridge connection from a worker of ours is still alive, which a
 * fresh guest guarantees. Kept as the explicit step it was.
 */
export async function killStaleWorkers() {
  // a guest from a previous open in this process is reused; its workers died
  // with their connections when the adapter closed them
}

let readyPromise = null;

/** Bring every piece up (idempotent, cached while it holds). */
export function ensureReady() {
  if (!readyPromise) {
    readyPromise = (async () => {
      await ensureBridge();
      await ensureLibrary();
      await ensureRosetta();
      await ensureVm();
      await killStaleWorkers();
    })().catch((err) => {
      readyPromise = null;
      throw err;
    });
  }
  return readyPromise;
}

/** Where the adapter connects to get a worker; valid after ensureReady(). */
export function workerSocketPath() {
  if (!vmSocketPath) throw new Error('the Linux guest is not running');
  return vmSocketPath;
}

export function shutdown() {
  stopVm();
  bridgeChild?.kill('SIGTERM');
}

// Node does not take children down with it; the launcher exits on its own
// when our stdin pipe to it closes, but a clean exit should not rely on that.
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.once(sig, () => {
    shutdown();
    process.exit(0);
  });
}
process.once('exit', shutdown);
