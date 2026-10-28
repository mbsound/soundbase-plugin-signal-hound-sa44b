// The macOS runtime, without a Mac, a device or a guest: the bridge wire
// protocol the launcher proxies over the vsock (encoded and decoded here
// exactly as driver/bridge/protocol.h lays it out), the launcher's command
// line, and — on a Mac with the launcher built — the launcher's own parsing
// of that command line in --dry-run mode, which starts nothing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

const macHost = await import('../driver/mac-host.js');
const { encodeRequest, decodeResponse, decodeDeviceInfo, listPorts, saSerialsFromPorts, launcherArgs, RUNTIME } = macHost;

// ---------------------------------------------------------------------------
// framing
// ---------------------------------------------------------------------------

test('a request frame is u32 len | u8 op | u32 handle | payload, little-endian', () => {
  const frame = encodeRequest(11, Buffer.from([0x10, 0, 0, 0]), 7);
  assert.equal(frame.length, 13);
  assert.equal(frame.readUInt32LE(0), 9, 'len counts op, handle and payload');
  assert.equal(frame[4], 11);
  assert.equal(frame.readUInt32LE(5), 7);
  assert.deepEqual([...frame.subarray(9)], [0x10, 0, 0, 0]);
  assert.equal(encodeRequest(0).readUInt32LE(0), 5, 'an empty payload is len 5');
});

test('a response frame is decoded only once complete, and the rest is kept', () => {
  const body = Buffer.from([1, 2, 3]);
  const frame = Buffer.alloc(8 + body.length);
  frame.writeUInt32LE(4 + body.length, 0);
  frame.writeUInt32LE(17, 4);
  body.copy(frame, 8);
  assert.equal(decodeResponse(frame.subarray(0, 3)), null, 'no length yet');
  assert.equal(decodeResponse(frame.subarray(0, 9)), null, 'payload incomplete');
  const next = Buffer.from([9, 9]);
  const r = decodeResponse(Buffer.concat([frame, next]));
  assert.equal(r.status, 17);
  assert.deepEqual([...r.payload], [1, 2, 3]);
  assert.deepEqual([...r.rest], [9, 9]);
  assert.equal(decodeResponse(Buffer.from([2, 0, 0, 0])), null, 'a len below 4 is not a frame');
});

test('a device-info record is 96 bytes with NUL-padded strings', () => {
  const rec = Buffer.alloc(96);
  rec.writeUInt32LE(2, 0);
  rec.writeUInt32LE(6, 4);
  rec.writeUInt32LE(0x04036010, 8);
  rec.write('21235737A', 16, 'latin1');
  rec.write('Signal Hound A', 32, 'latin1');
  assert.deepEqual(decodeDeviceInfo(rec), {
    flags: 2,
    type: 6,
    id: 0x04036010,
    locid: 0,
    serial: '21235737A',
    description: 'Signal Hound A',
  });
  assert.equal(decodeDeviceInfo(rec.subarray(0, 95)), null);
});

// a fake ftdi-bridge speaking the real protocol: ping, list, detail
function fakeBridge(ports) {
  return new Promise((resolve) => {
    const server = createServer((sock) => {
      let buf = Buffer.alloc(0);
      sock.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        while (buf.length >= 4) {
          const len = buf.readUInt32LE(0);
          if (buf.length < 4 + len) return;
          const op = buf[4];
          const payload = buf.subarray(9, 4 + len);
          buf = buf.subarray(4 + len);
          let body = Buffer.alloc(0);
          let status = 0;
          if (op === 0) body = Buffer.from([1, 0, 0, 0]);
          else if (op === 1) {
            body = Buffer.alloc(4);
            body.writeUInt32LE(ports.length, 0);
          } else if (op === 2) {
            const i = payload.readUInt32LE(0);
            if (i >= ports.length) status = 2;
            else {
              body = Buffer.alloc(96);
              body.write(ports[i].serial, 16, 'latin1');
              body.write(ports[i].description, 32, 'latin1');
            }
          } else status = 17;
          const hdr = Buffer.alloc(8);
          hdr.writeUInt32LE(4 + body.length, 0);
          hdr.writeUInt32LE(status, 4);
          sock.write(Buffer.concat([hdr, body]));
        }
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

test('listPorts walks the bridge: one list call, one detail call per port', async () => {
  const { server, port } = await fakeBridge([
    { serial: '21235737A', description: 'Signal Hound A' },
    { serial: '21235737B', description: 'Signal Hound B' },
  ]);
  try {
    const ports = await listPorts({ port });
    assert.deepEqual(
      ports.map((p) => [p.index, p.serial, p.description]),
      [
        [0, '21235737A', 'Signal Hound A'],
        [1, '21235737B', 'Signal Hound B'],
      ]
    );
    assert.deepEqual(saSerialsFromPorts(ports), [21235737]);
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// the launcher's command line
// ---------------------------------------------------------------------------

test('launcherArgs wires the shares, the vsock proxy and the worker forward', () => {
  const args = launcherArgs({
    kernel: '/k/Image',
    initrd: '/k/initramfs.img',
    payloadDir: '/p/x86',
    stateDir: '/s/state',
    socketPath: '/tmp/w.sock',
    bridgePort: 7788,
    agentPort: 7790,
    cpus: 2,
    memoryMB: 1024,
    shimLog: false,
  });
  const value = (flag) => args[args.indexOf(flag) + 1];
  const values = (flag) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
  assert.equal(value('--kernel'), '/k/Image');
  assert.equal(value('--initrd'), '/k/initramfs.img');
  assert.ok(args.includes('--rosetta'), 'Rosetta is shared');
  assert.deepEqual(values('--share'), ['host=payload:/p/x86:ro', 'host=state:/s/state'], 'payload read-only, state writable, one virtiofs tag');
  assert.equal(value('--vsock-listen'), '7788:7788', 'the shim reaches the bridge through host vsock port 7788');
  assert.equal(value('--forward'), '/tmp/w.sock:7790', 'the adapter reaches the agent through a unix socket');
  assert.match(value('--cmdline'), /console=hvc0/);
  assert.match(value('--cmdline'), /sa44b\.agent_port=7790/);
  assert.match(value('--cmdline'), /sa44b\.bridge_port=7788/);
  assert.doesNotMatch(value('--cmdline'), /shimlog/);
  assert.match(launcherArgs({ socketPath: '/tmp/w.sock', shimLog: true }).join(' '), /sa44b\.shimlog=1/);
  assert.throws(() => launcherArgs({}), /socketPath/);
});

const onMacWithLauncher = process.platform === 'darwin' && existsSync(RUNTIME.launcher);

test('the launcher parses that command line the same way (--dry-run)', { skip: !onMacWithLauncher && 'needs the built launcher on macOS' }, async () => {
  const args = launcherArgs({
    kernel: '/k/Image',
    initrd: '/k/initramfs.img',
    payloadDir: '/p/x86',
    stateDir: '/s/state',
    socketPath: '/tmp/w.sock',
    bridgePort: 7788,
    agentPort: 7790,
    cpus: 3,
    memoryMB: 768,
  });
  const { stdout } = await promisify(execFile)(RUNTIME.launcher, ['--dry-run', ...args]);
  const ev = JSON.parse(stdout.trim());
  assert.equal(ev.event, 'config');
  const c = ev.config;
  assert.equal(c.kernel, '/k/Image');
  assert.equal(c.cpus, 3);
  assert.equal(c.memoryMB, 768);
  assert.equal(c.rosetta, true);
  assert.deepEqual(c.shares.host, [
    { name: 'payload', path: '/p/x86', readOnly: true },
    { name: 'state', path: '/s/state', readOnly: false },
  ]);
  assert.deepEqual(c.vsockListens, [{ guestPort: 7788, tcpPort: 7788 }]);
  assert.deepEqual(c.forwards, [{ path: '/tmp/w.sock', guestPort: 7790 }]);
  assert.equal(c.readyMarker, 'vsock-agent: listening');
});

test('the launcher refuses a bad command line with a usage error', { skip: !onMacWithLauncher && 'needs the built launcher on macOS' }, async () => {
  const run = (a) => promisify(execFile)(RUNTIME.launcher, a).then(() => null, (err) => ({ code: err.code, out: err.stdout }));
  const noKernel = await run(['--dry-run', '--initrd', '/x']);
  assert.equal(noKernel.code, 2);
  assert.match(JSON.parse(noKernel.out.trim()).message, /--kernel/);
  const badShare = await run(['--dry-run', '--kernel', '/k', '--initrd', '/i', '--share', 'host=relative/path']);
  assert.equal(badShare.code, 2);
  assert.match(JSON.parse(badShare.out.trim()).message, /--share/);
  const badPort = await run(['--dry-run', '--kernel', '/k', '--initrd', '/i', '--forward', '/tmp/x.sock:abc']);
  assert.equal(badPort.code, 2);
});
