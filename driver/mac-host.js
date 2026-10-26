// Running Signal Hound's x86-64 Linux SA API on a Mac.
//
// Signal Hound never shipped a macOS build of the SA API. What they did ship,
// in 2016 and now marked obsolete, is libsa_api.so for x86-64 Linux, which
// talks to the SA44B through FTDI's D2XX library. This module runs that
// library on Apple Silicon:
//
//   ftdi-bridge (macOS, driver/bridge/)   holds the SA44B's two FTDI ports via
//                                         libusb and serves D2XX calls over TCP
//                                         on 127.0.0.1
//   ssh -R                                reverse-tunnels that port into the VM
//   Lima VM "sa44b" (arm64 Ubuntu, Rosetta) runs an x86-64 Ubuntu chroot at
//                                         /amd64 where libsa_api.so loads a shim
//                                         libftd2xx.so (driver/shim/) that
//                                         forwards every D2XX call to the bridge
//   sa44b-worker (x86-64, in the chroot)  the same worker as on Windows, talking
//                                         JSON lines to this plugin over the
//                                         limactl shell stdio
//
// scripts/vm/provision.sh sets the VM up once. This module makes sure the
// pieces are up each time a device is needed, and kills stale workers.

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const execFileP = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));

export const LIMA_INSTANCE = process.env.SB_SA44B_LIMA_INSTANCE || 'sa44b';
export const BRIDGE_PORT = Number(process.env.SB_SA44B_BRIDGE_PORT) || 7788;
const VM_PLUGIN_DIR = '$HOME/sa44b'; // where provision.sh puts the driver in the VM
const CHROOT_PLUGIN_DIR = '/plugin'; // the same directory, seen from inside the chroot
const BRIDGE_BIN = join(HERE, 'bridge', 'bin', 'ftdi-bridge');

const OP_PING = 0;
const OP_LIST = 1;
const OP_DETAIL = 2;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => process.stderr.write(`[signal-hound-sa44b] mac-host: ${msg}\n`);

export const isMacHost = () => process.platform === 'darwin';

/** True once provision.sh has run: the bridge is built and limactl exists. */
export function provisioned() {
  return existsSync(BRIDGE_BIN);
}

// ---------------------------------------------------------------------------
// The bridge
// ---------------------------------------------------------------------------

/** One request to the bridge over a fresh connection. */
function bridgeCall(op, payload = Buffer.alloc(0), { timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = createConnection({ host: '127.0.0.1', port: BRIDGE_PORT });
    const chunks = [];
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('ftdi-bridge did not answer'));
    }, timeoutMs);
    sock.on('connect', () => {
      const hdr = Buffer.alloc(9);
      hdr.writeUInt32LE(5 + payload.length, 0);
      hdr.writeUInt8(op, 4);
      hdr.writeUInt32LE(0, 5);
      sock.write(Buffer.concat([hdr, payload]));
    });
    sock.on('data', (d) => {
      chunks.push(d);
      const buf = Buffer.concat(chunks);
      if (buf.length < 4) return;
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) return;
      clearTimeout(timer);
      sock.end();
      resolve({ status: buf.readUInt32LE(4), payload: buf.subarray(8, 4 + len) });
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
  if (!existsSync(BRIDGE_BIN)) {
    throw new Error(`ftdi-bridge is not built: run scripts/vm/provision.sh (needs brew install libftdi)`);
  }
  log(`starting ftdi-bridge on 127.0.0.1:${BRIDGE_PORT}`);
  bridgeChild = spawn(BRIDGE_BIN, ['-b', '127.0.0.1', '-p', String(BRIDGE_PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  bridgeChild.stderr.on('data', (d) => {
    for (const line of String(d).split('\n')) if (line.trim()) log(line.trim());
  });
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
export async function listPorts() {
  const { status, payload } = await bridgeCall(OP_LIST);
  if (status !== 0) throw new Error(`ftdi-bridge list failed (${status})`);
  const count = payload.readUInt32LE(0);
  const ports = [];
  for (let i = 0; i < count; i++) {
    const idx = Buffer.alloc(4);
    idx.writeUInt32LE(i, 0);
    const r = await bridgeCall(OP_DETAIL, idx);
    if (r.status !== 0 || r.payload.length < 96) continue;
    const cstr = (b) => b.toString('latin1').replace(/\0.*$/s, '');
    ports.push({
      index: i,
      flags: r.payload.readUInt32LE(0),
      type: r.payload.readUInt32LE(4),
      id: r.payload.readUInt32LE(8),
      serial: cstr(r.payload.subarray(16, 32)),
      description: cstr(r.payload.subarray(32, 96)),
    });
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
// The VM
// ---------------------------------------------------------------------------

const limactl = (args, opts = {}) =>
  execFileP('limactl', args, { maxBuffer: 1 << 20, ...opts }).then(
    (r) => r,
    (err) => {
      throw new Error(`limactl ${args[0]} failed: ${(err.stderr || err.message).trim().split('\n').pop()}`);
    }
  );

export async function vmStatus() {
  const { stdout } = await limactl(['list', '--json']);
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (row.name === LIMA_INSTANCE) return row.status;
  }
  return 'Missing';
}

export async function ensureVm() {
  const status = await vmStatus();
  if (status === 'Running') return;
  if (status === 'Missing') {
    throw new Error(`Lima instance "${LIMA_INSTANCE}" does not exist: run scripts/vm/provision.sh`);
  }
  log(`starting Lima VM "${LIMA_INSTANCE}" (${status})`);
  await limactl(['start', '--tty=false', LIMA_INSTANCE], { timeout: 180_000 });
}

/** The chroot's bind mounts do not survive a VM reboot; this is idempotent and fast. */
export async function ensureChroot() {
  await limactl(
    ['shell', LIMA_INSTANCE, '--', 'bash', '-c',
      `sudo bash "${VM_PLUGIN_DIR}/scripts/vm/setup-chroot.sh" "${VM_PLUGIN_DIR}" >/dev/null`],
    { timeout: 120_000 }
  );
}

let tunnelChild = null;

export async function ensureTunnel() {
  if (tunnelChild && tunnelChild.exitCode === null) return;
  const { stdout: sshConfig } = await limactl(['show-ssh', '--format', 'config', LIMA_INSTANCE]);
  const { writeFile, mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'sa44b-ssh-'));
  const cfg = join(dir, 'config');
  await writeFile(cfg, sshConfig);
  log(`opening reverse tunnel ${BRIDGE_PORT} into "${LIMA_INSTANCE}"`);
  tunnelChild = spawn(
    'ssh',
    // no multiplexing: through Lima's control master the forward would outlive
    // this process (and this process would exit at once)
    ['-F', cfg, '-N', '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
      '-o', 'ExitOnForwardFailure=yes', '-R', `${BRIDGE_PORT}:127.0.0.1:${BRIDGE_PORT}`, `lima-${LIMA_INSTANCE}`],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );
  tunnelChild.stderr.on('data', (d) => log(`ssh: ${String(d).trim()}`));
  tunnelChild.on('exit', (code, sig) => {
    log(`tunnel exited (${sig ?? code})`);
    tunnelChild = null;
  });
  // ExitOnForwardFailure makes a port clash fatal; give it a moment to fail
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await delay(250);
    if (!tunnelChild) {
      // a tunnel from a previous plugin instance may already be in place
      const { stdout } = await limactl(['shell', LIMA_INSTANCE, '--', 'bash', '-c',
        `(exec 3<>/dev/tcp/127.0.0.1/${BRIDGE_PORT}) 2>/dev/null && echo open || echo closed`]);
      if (stdout.includes('open')) return;
      throw new Error('could not open the ssh tunnel into the VM');
    }
    const { stdout } = await limactl(['shell', LIMA_INSTANCE, '--', 'bash', '-c',
      `(exec 3<>/dev/tcp/127.0.0.1/${BRIDGE_PORT}) 2>/dev/null && echo open || echo closed`]);
    if (stdout.includes('open')) return;
  }
  throw new Error('the ssh tunnel into the VM never became reachable');
}

/** A worker left behind by a killed plugin would hold the device; remove it. */
export async function killStaleWorkers() {
  // -x matches the process name exactly; -f would match this very shell
  await limactl(['shell', LIMA_INSTANCE, '--', 'bash', '-c', 'sudo pkill -9 -x sa44b-worker; true']);
}

let readyPromise = null;

/** Bring every piece up (idempotent, cached while it holds). */
export function ensureReady() {
  if (!readyPromise) {
    readyPromise = (async () => {
      await ensureBridge();
      await ensureVm();
      await ensureChroot();
      await ensureTunnel();
      await killStaleWorkers();
    })().catch((err) => {
      readyPromise = null;
      throw err;
    });
  }
  return readyPromise;
}

/** How to spawn the worker so it runs inside the VM's x86-64 chroot. */
export function workerSpec({ sdkDir } = {}) {
  const sdk = sdkDir || `${CHROOT_PLUGIN_DIR}/sdk`;
  const inner =
    `cd ${CHROOT_PLUGIN_DIR}/driver/worker/bin/linux-x64 && ` +
    `exec env LD_LIBRARY_PATH=${CHROOT_PLUGIN_DIR}/driver/shim/bin/linux-x64:${sdk} ` +
    `FTDI_BRIDGE_HOST=127.0.0.1 FTDI_BRIDGE_PORT=${BRIDGE_PORT} ` +
    `./sa44b-worker --sdk ${sdk}`;
  return {
    command: 'limactl',
    args: ['shell', LIMA_INSTANCE, '--', 'sudo', 'chroot', '/amd64', '/bin/bash', '-c', inner],
  };
}

export function shutdown() {
  tunnelChild?.kill('SIGTERM');
  bridgeChild?.kill('SIGTERM');
}

// Node does not take children down with it; a bridge or tunnel left behind
// is reused by the next plugin instance, but a clean exit should not leave one.
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.once(sig, () => {
    shutdown();
    process.exit(0);
  });
}
process.once('exit', shutdown);
