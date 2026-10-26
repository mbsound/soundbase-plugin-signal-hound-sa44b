// Contract tests for the Signal Hound SA adapter, driven through the real
// shell over real HTTP, against the worker in mock mode.
//
// SB_SA44B_MOCK=1 makes driver/worker/bin/<platform>/sa44b-worker produce a
// synthetic spectrum instead of loading sa_api.dll, so everything below —
// discovery, the process boundary, JSON-lines RPC, clamping, resampling,
// trace geometry, the fatal path — runs with no hardware and on platforms
// Signal Hound does not support. Only the vendor library itself is swapped
// out; the worker binary is the real one.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HANDSHAKE_PREFIX } from '@soundbase/plugin-contract';

process.env.SB_SA44B_MOCK = '1';

const { PRODUCT, minRbwFor, autoRbwFor } = await import('../adapter.js');
const { WorkerClient, workerBinaryPath } = await import('../driver/worker-client.js');

const manifest = JSON.parse(
  readFileSync(new URL('../soundbase-plugin.json', import.meta.url), 'utf8')
);

const MOCK_SERIAL = 12345678;
const DEVICE_ID = `usb:sa:${MOCK_SERIAL}`;
const DEVICE_PATH = `/devices/${encodeURIComponent(DEVICE_ID)}`;
const START_HZ = 470_000_000;
const STOP_HZ = 616_000_000;
const POINT_COUNT = 451;

assert.ok(
  workerBinaryPath(),
  `no worker binary for ${process.platform}-${process.arch}: run scripts/build-worker.sh first`
);

// boots under the real shell, exactly as the host spawns it
const handle = await (await import('../main.js')).default;

const request = async (method, path, body) => {
  const res = await fetch(`${handle.url}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test.after(() => handle.close());

// ---------------------------------------------------------------------------
// pure device rules
// ---------------------------------------------------------------------------

test('the API rule for minimum RBW on wide and low spans is encoded', () => {
  assert.equal(minRbwFor(470e6, 616e6), 6_500); // 146 MHz span
  assert.equal(minRbwFor(100e6, 199e6), 0.1); // 99 MHz span, above 16 MHz
  assert.equal(minRbwFor(1e6, 2e6), 6_500); // 1 MHz span starting below 16 MHz
  assert.equal(minRbwFor(1e6, 1.1e6), 0.1); // 100 kHz span starting below 16 MHz
});

test('auto RBW tracks the point spacing', () => {
  assert.equal(autoRbwFor(470e6, 616e6, 451), 100_000); // ~324 kHz per point
  assert.equal(autoRbwFor(500e6, 501e6, 451), 1_000); // ~2.2 kHz per point
});

// ---------------------------------------------------------------------------
// the process boundary
// ---------------------------------------------------------------------------

test('a worker that stops answering is killed and the call rejects as fatal', { skip: process.platform === 'win32' && 'needs a POSIX shell' }, async () => {
  // a "worker" that swallows requests and never answers: the vendor library
  // wedged inside a USB transfer, as seen from outside
  const client = new WorkerClient({
    mock: true,
    binary: '/bin/sh',
    args: ['-c', 'cat > /dev/null'],
  });
  let exited = null;
  client.onExit = (err) => {
    exited = err;
  };
  await assert.rejects(client.call('ping', {}, { timeoutMs: 300 }), (err) => {
    assert.equal(err.code, 'worker_timeout');
    assert.equal(err.fatal, true);
    return true;
  });
  const deadline = Date.now() + 2_000;
  while (!exited && Date.now() < deadline) await delay(20);
  assert.ok(exited, 'the kill reaches onExit');
  assert.equal(client.alive, false);
});

// ---------------------------------------------------------------------------
// through the shell
// ---------------------------------------------------------------------------

test('the manifest is valid and the handshake reports a real port', () => {
  assert.equal(handle.manifest.id, manifest.id);
  assert.ok(handle.port > 0);
  assert.equal(HANDSHAKE_PREFIX, 'SB_PLUGIN_READY ');
  assert.deepEqual(manifest.platforms, ['win32-x64']);
});

test('the product the adapter announces is declared in the manifest', () => {
  const declared = manifest.products.map((p) => p.deviceTypeId);
  assert.ok(declared.includes(PRODUCT), `${PRODUCT} not in ${declared.join(', ')}`);
  assert.ok(PRODUCT.startsWith(`plugin:${manifest.id}/`));
});

test('the attached unit is discovered by serial number', async () => {
  const { status, body } = await request('GET', '/devices');
  assert.equal(status, 200);
  const device = body.devices.find((d) => d.id === DEVICE_ID);
  assert.ok(device, JSON.stringify(body.devices));
  assert.equal(device.product, PRODUCT);
  assert.equal(device.discovered, true);
  assert.equal(device.transport.serial, MOCK_SERIAL);
  assert.ok(!device.capabilities, 'discovered, not yet opened');
});

test('open() reports what this unit can do, including its controls', async () => {
  await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: START_HZ,
    stopHz: STOP_HZ,
  });
  const { body } = await request('GET', '/devices');
  const device = body.devices.find((d) => d.id === DEVICE_ID);
  const caps = device.capabilities;
  assert.ok(caps, 'capabilities appear once the device has been opened');
  assert.equal(caps.minFrequencyHz, 1);
  assert.equal(caps.maxFrequencyHz, 4.4e9);
  assert.deepEqual(caps.rbwHz, [1_000, 3_000, 10_000, 30_000, 100_000, 250_000]);
  assert.equal(caps.maxRefLevelDbm, 20);
  assert.deepEqual([...caps.traceModes].sort(), [
    'average',
    'clear-write',
    'max-hold',
    'min-hold',
  ]);
  const ids = caps.controls.map((c) => c.id);
  assert.deepEqual(ids, ['atten', 'gain', 'detector', 'imageReject', 'rbwShape', 'preamp']);
  assert.equal(device.name, `Signal Hound SA (SN ${MOCK_SERIAL})`);
});

test('config, start and trace produce a plausible spectrum', async (t) => {
  const applied = await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: START_HZ,
    stopHz: STOP_HZ,
    pointCount: POINT_COUNT,
    rbwHz: 100_000,
    refLevelDbm: -30,
  });
  assert.equal(applied.status, 200);
  assert.equal(applied.body.startHz, START_HZ);
  assert.equal(applied.body.stopHz, STOP_HZ);
  assert.equal(applied.body.pointCount, POINT_COUNT);
  assert.equal(applied.body.rbwHz, 100_000);
  assert.equal(applied.body.refLevelDbm, -30);
  assert.ok(applied.body.resolved.sweepTimeMs > 0, 'sweep time is estimated');
  assert.ok(applied.body.resolved.binSizeHz > 0, 'the device bin size is reported');

  const started = await request('POST', `${DEVICE_PATH}/sweep/start`);
  assert.equal(started.status, 200);
  assert.equal(started.body.sweeping, true);
  t.after(async () => {
    await request('POST', `${DEVICE_PATH}/sweep/stop`);
  });

  const trace = await request('GET', `${DEVICE_PATH}/trace`);
  assert.equal(trace.status, 200);
  assert.equal(trace.body.pointCount, POINT_COUNT);
  assert.equal(trace.body.amplitudesDbm.length, POINT_COUNT);
  assert.equal(trace.body.startHz, START_HZ);
  assert.equal(trace.body.stopHz, STOP_HZ);
  assert.equal(trace.body.stepHz, (STOP_HZ - START_HZ) / (POINT_COUNT - 1));
  assert.equal(trace.body.unit, 'dBm');
  assert.ok(trace.body.sweepId >= 1);

  const amps = trace.body.amplitudesDbm;
  // carriers sit at 33% and 66% of the span; the once-in-seven transient at 50%
  const bins = (from, to) => amps.slice(from, to);
  const floorBins = [...bins(10, 100), ...bins(360, 440)];
  const floorMin = Math.min(...floorBins);
  const floorMax = Math.max(...floorBins);
  assert.ok(floorMin >= -106, `noise floor dipped to ${floorMin}`);
  assert.ok(floorMax <= -94, `noise floor rose to ${floorMax}`);
  const floorMean = floorBins.reduce((a, b) => a + b, 0) / floorBins.length;
  const carrierA = Math.max(...bins(140, 160));
  const carrierB = Math.max(...bins(290, 306));
  assert.ok(carrierA >= floorMean + 20, `carrier A only reached ${carrierA}`);
  assert.ok(carrierB >= floorMean + 20, `carrier B only reached ${carrierB}`);
});

test('out-of-range configuration is clamped, not rejected', async () => {
  const applied = await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: -5,
    stopHz: 4.4e9 * 10,
    pointCount: 50_000,
    refLevelDbm: 99,
  });
  assert.equal(applied.status, 200, 'a request outside the range is still a 200');
  assert.equal(applied.body.startHz, 1);
  // the API quantizes the sweep to whole bins, so the last bin sits within
  // one RBW of the requested stop
  assert.ok(applied.body.stopHz <= 4.4e9, `stop ${applied.body.stopHz}`);
  assert.ok(applied.body.stopHz > 4.4e9 - 250_000, `stop ${applied.body.stopHz}`);
  assert.equal(applied.body.pointCount, 10_000);
  // the reference level the device was given is clamped too (the shell echoes
  // the requested value in the configuration, so it is checked at the worker)
});

test('an RBW the API would refuse on a wide span is clamped to 6.5 kHz', async () => {
  const applied = await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: START_HZ,
    stopHz: STOP_HZ,
    pointCount: POINT_COUNT,
    rbwHz: 1_000,
  });
  assert.equal(applied.status, 200);
  assert.equal(applied.body.rbwHz, 6_500);
  const trace = await request('GET', `${DEVICE_PATH}/configuration`);
  assert.equal(trace.body.rbwHz, 6_500, 'the echo is what GET reports');
});

test('a narrow span accepts the small RBWs', async () => {
  const applied = await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: 500e6,
    stopHz: 501e6,
    pointCount: 201,
    rbwHz: 1_000,
  });
  assert.equal(applied.body.rbwHz, 1_000);
});

test('omitting RBW means auto, reported under resolved', async () => {
  // an explicit null is how the host says "back to auto"
  const applied = await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: START_HZ,
    stopHz: STOP_HZ,
    pointCount: POINT_COUNT,
    rbwHz: null,
  });
  assert.equal(applied.status, 200);
  assert.equal(applied.body.rbwHz, undefined);
  assert.equal(applied.body.resolved.rbwHz, 100_000);
});

test('a partial request leaves the rest in force; controls merge by id', async () => {
  const first = await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: START_HZ,
    stopHz: STOP_HZ,
    pointCount: POINT_COUNT,
    rbwHz: 10_000,
    controls: { atten: '2', preamp: true, detector: 'average' },
  });
  assert.equal(first.body.controls.atten, '2');
  assert.equal(first.body.controls.preamp, true);
  assert.equal(first.body.controls.detector, 'average');
  assert.equal(first.body.controls.gain, 'auto', 'untouched control keeps its default');

  const second = await request('POST', `${DEVICE_PATH}/configuration`, {
    controls: { gain: '1' },
  });
  assert.equal(second.body.rbwHz, 10_000, 'RBW untouched by a controls-only patch');
  assert.equal(second.body.pointCount, POINT_COUNT);
  assert.equal(second.body.controls.atten, '2', 'other controls stay in force');
  assert.equal(second.body.controls.gain, '1');

  const third = await request('POST', `${DEVICE_PATH}/configuration`, {
    controls: { atten: 'bogus', gain: null },
  });
  assert.equal(third.body.controls.atten, 'auto', 'an unknown choice settles on auto');
  assert.equal(third.body.controls.gain, 'auto', 'null means auto');

  const config = await request('GET', `${DEVICE_PATH}/configuration`);
  assert.deepEqual(config.body.controls, third.body.controls);
});

test('successive polls see successive sweeps', async (t) => {
  await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: START_HZ,
    stopHz: STOP_HZ,
    pointCount: POINT_COUNT,
    rbwHz: 100_000,
  });
  await request('POST', `${DEVICE_PATH}/sweep/start`);
  t.after(async () => {
    await request('POST', `${DEVICE_PATH}/sweep/stop`);
  });
  const first = await request('GET', `${DEVICE_PATH}/trace`);
  const startedAt = Date.now();
  const second = await request('GET', `${DEVICE_PATH}/trace`);
  const elapsed = Date.now() - startedAt;
  assert.ok(second.body.sweepId > first.body.sweepId);
  assert.ok(elapsed < 2000, `waited ${elapsed}ms for the next sweep`);
});

test('max-hold keeps the peak of every sweep, including the transient', async (t) => {
  await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: START_HZ,
    stopHz: STOP_HZ,
    pointCount: POINT_COUNT,
    rbwHz: 100_000,
    traceMode: 'max-hold',
  });
  await request('POST', `${DEVICE_PATH}/sweep/start`);
  t.after(async () => {
    await request('POST', `${DEVICE_PATH}/sweep/stop`);
  });
  let trace = await request('GET', `${DEVICE_PATH}/trace`);
  const target = trace.body.sweepId + 10;
  const deadline = Date.now() + 10_000;
  while (trace.body.sweepId < target && Date.now() < deadline) {
    trace = await request('GET', `${DEVICE_PATH}/trace`);
  }
  assert.ok(trace.body.sweepId >= target, `only reached sweep ${trace.body.sweepId}`);
  const midband = Math.max(...trace.body.amplitudesDbm.slice(220, 232));
  assert.ok(midband >= -70, `transient never accumulated (peak ${midband})`);
});

test('a worker that dies mid-sweep marks the device failed, not healthy', async () => {
  await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: START_HZ,
    stopHz: STOP_HZ,
    pointCount: POINT_COUNT,
    rbwHz: 100_000,
  });
  await request('POST', `${DEVICE_PATH}/sweep/start`);

  // the USB cable comes out: from here, the vendor library's process is gone
  const { execSync } = await import('node:child_process');
  const pids = execSync('pgrep -f "sa44b-worker.* --mock" || true', { encoding: 'utf8' })
    .split('\n')
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
  assert.ok(pids.length > 0, 'a worker process is running while sweeping');
  for (const pid of pids) process.kill(pid, 'SIGKILL');

  const deadline = Date.now() + 5_000;
  let status = null;
  while (Date.now() < deadline) {
    const { body } = await request('GET', '/devices');
    status = body.devices.find((d) => d.id === DEVICE_ID)?.status?.status;
    if (status === 'failed') break;
    await delay(50);
  }
  assert.equal(status, 'failed', 'onFatal turns a dead worker into a device SoundBase reports as broken');
});
