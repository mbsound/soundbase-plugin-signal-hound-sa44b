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
   * @param {{command: string, args: string[]}} [options.spec]
   *        a complete launch command (used on macOS, where the worker runs
   *        inside the Linux VM); when given, binary/args/--sdk are not used
   * @param {(msg: string) => void} [options.log]
   */
  constructor({ mock = mockRequested(), sdkDir, binary, args = [], spec, log } = {}) {
    this.mock = mock;
    this.sdkDir = sdkDir;
    this.spec = spec ?? null;
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
    return this.child !== null && !this.exited;
  }

  start() {
    if (this.child) return;
    if (this.spec) {
      this.child = spawn(this.spec.command, this.spec.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });
      this.wire();
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

  /** Send one request; resolves with the worker's reply object. */
  call(op, fields = {}, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (!this.child) this.start();
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
      this.child.stdin.write(JSON.stringify({ id, op, ...fields }) + '\n', (err) => {
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
    if (!this.child || this.exited) return;
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
