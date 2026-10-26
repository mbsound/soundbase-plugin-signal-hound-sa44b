// The process boundary between this plugin and the Signal Hound SA API.
//
// One WorkerClient owns one `sa44b-worker` child process and speaks JSON
// lines to it over stdio. Every call has a deadline; a worker that does not
// answer in time is SIGKILLed and the call rejects, so a wedged USB transfer
// inside the vendor library can never take the plugin process with it.
// See docs/native-runtimes.md for why this shape.
//
// The worker binary is picked per platform from driver/worker/bin/. With
// SB_SA44B_MOCK=1 the worker is started in mock mode and produces a synthetic
// spectrum, which is how the tests and `npm run smoke` run with no hardware.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_TIMEOUT_MS = 15_000;
// saOpenDevice takes ~5 s, and "much longer" the first time a unit is opened
// on a PC, because the API downloads that unit's calibration file.
export const OPEN_TIMEOUT_MS = 90_000;

export class WorkerError extends Error {
  constructor(message, { code = 'worker_error', fatal = false } = {}) {
    super(message);
    this.name = 'WorkerError';
    this.code = code;
    this.fatal = fatal;
  }
}

/** True when the plugin should run against the synthetic worker. */
export function mockRequested(env = process.env) {
  const v = env.SB_SA44B_MOCK;
  return v !== undefined && v !== '' && v !== '0' && v !== 'false';
}

/** Path of the worker binary for this platform, or null if none was built. */
export function workerBinaryPath(platform = process.platform, arch = process.arch) {
  const name = platform === 'win32' ? 'sa44b-worker.exe' : 'sa44b-worker';
  const path = join(HERE, 'worker', 'bin', `${platform}-${arch}`, name);
  return existsSync(path) ? path : null;
}

export class WorkerClient {
  /**
   * @param {object} [options]
   * @param {boolean} [options.mock]     start the worker with --mock
   * @param {string}  [options.sdkDir]   folder holding sa_api.dll + ftd2xx.dll
   * @param {string}  [options.binary]   explicit worker path (tests)
   * @param {string[]} [options.args]    arguments placed before the worker's own (tests)
   * @param {string} [options.socketPath]
   *        a unix socket instead of a child process (macOS, where the worker
   *        runs inside the Linux guest: driver/mac-host.js hands one out, and
   *        every connection to it is a fresh worker whose stdio is the socket);
   *        when given, binary/args/--sdk are not used
   * @param {(msg: string) => void} [options.log]
   */
  constructor({ mock = mockRequested(), sdkDir, binary, args = [], socketPath, log } = {}) {
    this.mock = mock;
    this.sdkDir = sdkDir;
    this.socketPath = socketPath ?? null;
    this.sock = null;
    this.binary = binary ?? workerBinaryPath();
    this.extraArgs = args;
    this.log = log ?? (() => {});
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.exited = false;
    this.exitError = null;
    /** assigned by the owner; called once when the worker dies unprompted */
    this.onExit = null;
  }

  get alive() {
    return (this.child !== null || this.sock !== null) && !this.exited;
  }

  start() {
    if (this.child || this.sock) return;
    if (this.socketPath) {
      this.sock = createConnection(this.socketPath);
      this.sock.setNoDelay(true);
      this.sock.on('error', (err) => this.die(err));
      this.sock.on('close', () =>
        this.die(
          new WorkerError('sa44b-worker connection closed', { code: 'worker_exited', fatal: true })
        )
      );
      createInterface({ input: this.sock }).on('line', (line) => this.onLine(line));
      return;
    }
    if (!this.binary) {
      throw new WorkerError(
        `no sa44b-worker binary for ${process.platform}-${process.arch}; ` +
          'run scripts/build-worker.sh, or set SB_SA44B_MOCK=1 to use the synthetic device',
        { code: 'no_worker_binary', fatal: true }
      );
    }
    const args = [...this.extraArgs];
    if (this.mock) args.push('--mock');
    if (this.sdkDir) args.push('--sdk', this.sdkDir);
    this.child = spawn(this.binary, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, SB_SA44B_MOCK: this.mock ? '1' : '' },
    });
    this.wire();
  }

  wire() {
    this.child.on('error', (err) => this.die(err));
    // a write to a worker that just died surfaces here, not in the write
    // callback; without a listener it is an uncaught exception
    this.child.stdin.on('error', (err) => this.die(err));
    this.child.on('exit', (code, signal) => {
      this.die(
        new WorkerError(`sa44b-worker exited (${signal ?? `code ${code}`})`, {
          code: 'worker_exited',
          fatal: true,
        })
      );
    });
    createInterface({ input: this.child.stdout }).on('line', (line) =>
      this.onLine(line)
    );
    createInterface({ input: this.child.stderr }).on('line', (line) =>
      this.log(line)
    );
  }

  onLine(line) {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this.log(`unparseable worker line: ${line.slice(0, 200)}`);
      return;
    }
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.ok) {
      entry.resolve(msg);
    } else {
      entry.reject(
        new WorkerError(msg.error ?? 'worker error', {
          code: msg.code ?? 'worker_error',
          fatal: Boolean(msg.fatal),
        })
      );
    }
  }

  /** The worker's stdin: a pipe, or the socket it was started from. */
  get input() {
    return this.sock ?? this.child?.stdin;
  }

  /** Send one request; resolves with the worker's reply object. */
  call(op, fields = {}, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (!this.child && !this.sock) this.start();
    if (this.exited) {
      return Promise.reject(
        this.exitError ??
          new WorkerError('sa44b-worker is not running', {
            code: 'worker_exited',
            fatal: true,
          })
      );
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // a call that does not come back is the vendor library wedged; the
        // only safe recovery is to kill the process and start over
        this.kill();
        reject(
          new WorkerError(`sa44b-worker did not answer "${op}" within ${timeoutMs} ms`, {
            code: 'worker_timeout',
            fatal: true,
          })
        );
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.input.write(JSON.stringify({ id, op, ...fields }) + '\n', (err) => {
        if (err) this.die(err);
      });
    });
  }

  /** Fail every outstanding call and mark the client dead. */
  die(err) {
    if (this.exited) return;
    this.exited = true;
    this.exitError =
      err instanceof WorkerError
        ? err
        : new WorkerError(err?.message ?? String(err), { code: 'worker_exited', fatal: true });
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(this.exitError);
    }
    this.pending.clear();
    this.onExit?.(this.exitError);
  }

  /** Hard stop. Never blocks: the whole point is that this always works. */
  kill() {
    if (this.sock) {
      // dropping the connection is the kill: the guest agent SIGKILLs the
      // worker the moment the host hangs up
      this.sock.destroy();
      return;
    }
    const child = this.child;
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
      /* already gone */
    }
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }

  /** Polite stop: ask the worker to close the device and exit, then kill. */
  async stop() {
    if ((!this.child && !this.sock) || this.exited) return;
    try {
      await this.call('exit', {}, { timeoutMs: 5_000 });
    } catch {
      /* the kill below covers it */
    }
    this.kill();
  }
}

/**
 * One-shot enumeration: start a worker, ask it which SA units are attached,
 * stop it. Used by discoverDevices, which must not hold a device open.
 */
export async function listSerials({ mock = mockRequested(), sdkDir, log } = {}) {
  const client = new WorkerClient({ mock, sdkDir, log });
  try {
    const reply = await client.call('list', {}, { timeoutMs: 10_000 });
    return reply.serials ?? [];
  } finally {
    await client.stop();
  }
}
