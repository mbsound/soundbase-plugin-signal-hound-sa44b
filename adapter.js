// Signal Hound SA44B (and the rest of the SA series) as a SoundBase spectrum
// analyzer.
//
// The vendor library (sa_api.dll) is Windows-only and blocking, so all of it
// lives behind a child process — driver/worker/ — that this adapter talks to
// through driver/worker-client.js. This file holds the device logic: what the
// hardware can do, how a requested configuration is clamped to it, and the
// sweep loop. Nothing here touches the SA API directly.
//
// With SB_SA44B_MOCK=1 the worker produces a synthetic spectrum and this
// adapter runs unchanged on any platform; that is how the tests and the smoke
// check work with no hardware attached.

import {
  WorkerClient,
  WorkerError,
  listSerials,
  mockRequested,
  OPEN_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
} from './driver/worker-client.js';
import * as macHost from './driver/mac-host.js';

// On macOS the vendor library runs inside a Linux VM (see driver/mac-host.js);
// everywhere else, and in mock mode, the worker is a local child process.
const viaMacHost = () => macHost.isMacHost() && !mockRequested();

// Must be a `deviceTypeId` declared in soundbase-plugin.json. The SA API
// reports serial numbers only until a unit is opened, so every unit is
// announced as this product; `identity.model` carries the real type.
export const PRODUCT = 'plugin:signal-hound-sa44b/sa44b';

const ID_PREFIX = 'usb:sa:';

// ---------------------------------------------------------------------------
// What the hardware can do (SA API manual, sa_api.h)
// ---------------------------------------------------------------------------

const DEVICE_TYPES = {
  1: { model: 'SA44', minHz: 1, maxHz: 4.4e9, preamp: false, attenStepDb: 5, rbw6M: false },
  2: { model: 'SA44B', minHz: 1, maxHz: 4.4e9, preamp: true, attenStepDb: 5, rbw6M: false },
  3: { model: 'SA124A', minHz: 100e3, maxHz: 13e9, preamp: false, attenStepDb: 10, rbw6M: true },
  4: { model: 'SA124B', minHz: 100e3, maxHz: 13e9, preamp: false, attenStepDb: 10, rbw6M: true },
};
const UNKNOWN_TYPE = DEVICE_TYPES[2];

// Discrete RBWs offered to the user. The API accepts any value from 0.1 Hz to
// 100 kHz plus 250 kHz (and 6 MHz on the SA124); these are the useful ones.
const RBW_HZ = [1_000, 3_000, 10_000, 30_000, 100_000, 250_000];
// RBW/VBW must be at least this when the span is 100 MHz or more, or when the
// span exceeds 200 kHz and the start frequency is below 16 MHz.
const WIDE_SPAN_MIN_RBW_HZ = 6_500;
const MIN_REF_DBM = -100;
const MAX_REF_DBM = 20;
const MIN_POINTS = 2;
const MAX_POINTS = 10_000;
const DEFAULT_START_HZ = 470_000_000;
const DEFAULT_STOP_HZ = 616_000_000;
const DEFAULT_POINTS = 451;
// SoundBase's live-scan dialog has no reference-level field, so the level is
// a device control here. -50 dBm is where a coordination sweep belongs: the
// API picks attenuation and gain for signals at or below the reference, and
// at -20 dBm the displayed floor sits around -80 dBm, which hides everything a
// coordinator cares about.
const DEFAULT_REF_DBM = -50;
// Spent learning the real sweep rate: a first guess, refined from every sweep.
const DEFAULT_MS_PER_BIN = 0.03;
const SWEEP_OVERHEAD_MS = 250;
const DISCOVERY_CACHE_MS = 5_000;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const nearest = (list, v) =>
  list.reduce((best, c) => (Math.abs(c - v) < Math.abs(best - v) ? c : best));

/** The smallest RBW the API will accept for this sweep geometry. */
export function minRbwFor(startHz, stopHz) {
  const span = stopHz - startHz;
  if (span >= 100e6) return WIDE_SPAN_MIN_RBW_HZ;
  if (span > 200e3 && startHz < 16e6) return WIDE_SPAN_MIN_RBW_HZ;
  return 0.1;
}

/** Auto RBW: about four bins per point, from the offered list. */
export function autoRbwFor(startHz, stopHz, pointCount) {
  const perPoint = (stopHz - startHz) / Math.max(1, pointCount - 1);
  return nearest(RBW_HZ, perPoint / 2);
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

let discoveryCache = { at: 0, devices: [] };
let discoveryInFlight = null;

/**
 * Attached SA units, by serial number. Called once a second while SoundBase
 * is enumerating; the one-shot worker that answers it costs a process spawn
 * and a USB enumeration, so results are cached for a few seconds.
 */
export async function discoverDevices(pluginConfig = {}) {
  const now = Date.now();
  if (now - discoveryCache.at < DISCOVERY_CACHE_MS) return discoveryCache.devices;
  if (discoveryInFlight) return discoveryInFlight;
  discoveryInFlight = (async () => {
    let devices = [];
    try {
      const serials = viaMacHost()
        ? await macHost.listSerials()
        : await listSerials({ mock: mockRequested(), sdkDir: sdkDirOf(pluginConfig) });
      devices = serials.map((serial) => ({
        id: `${ID_PREFIX}${serial}`,
        name: `Signal Hound SA (SN ${serial})`,
        product: PRODUCT,
        transport: { kind: 'usb', serial },
      }));
    } catch {
      // No worker for this platform, no sa_api.dll, or nothing attached: a
      // normal, empty result. open() reports the specific reason when a user
      // actually asks for a device.
    }
    discoveryCache = { at: Date.now(), devices };
    return devices;
  })().finally(() => {
    discoveryInFlight = null;
  });
  return discoveryInFlight;
}

function sdkDirOf(pluginConfig) {
  const v = pluginConfig?.sdkPath;
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** Serial from `device.config.serial` (added by hand) or from the id. */
function serialOf(device) {
  const configured = Number(device?.config?.serial);
  if (Number.isInteger(configured) && configured > 0) return configured;
  const id = device?.id ?? '';
  if (id.startsWith(ID_PREFIX)) {
    const n = Number(id.slice(ID_PREFIX.length));
    if (Number.isInteger(n) && n > 0) return n;
  }
  return undefined; // open whichever unit the API finds first
}

// ---------------------------------------------------------------------------
// SpectrumAnalyzer adapter
// ---------------------------------------------------------------------------

export function createSpectrumAnalyzerAdapter(device, pluginConfig) {
  return new SignalHoundAdapter(device, pluginConfig);
}

class SignalHoundAdapter {
  constructor(device, pluginConfig = {}) {
    this.device = device;
    this.serial = serialOf(device);
    // sdkPath names a Windows folder; inside the VM the library has a fixed place
    this.sdkDir = viaMacHost() ? undefined : sdkDirOf(pluginConfig);
    this.worker = null;
    this.type = UNKNOWN_TYPE;
    this.identity = null;
    this.effective = null;
    this.sweeping = false;
    this.sweepLength = 0;
    this.msPerBin = DEFAULT_MS_PER_BIN;
    /** assigned by the shell; call it when the transport dies unprompted */
    this.onFatal = null;
  }

  log(msg) {
    process.stderr.write(`[signal-hound-sa44b] ${this.device.id}: ${msg}\n`);
  }

  async open() {
    let spec = null;
    if (viaMacHost()) {
      try {
        await macHost.ensureReady();
      } catch (err) {
        throw new Error(`Mac host setup failed: ${err.message}`);
      }
      spec = macHost.workerSpec({ sdkDir: this.sdkDir });
    }
    const worker = new WorkerClient({
      mock: mockRequested(),
      sdkDir: this.sdkDir,
      spec,
      log: (line) => this.log(line),
    });
    worker.onExit = (err) => {
      if (this.worker !== worker) return; // we closed it ourselves
      this.worker = null;
      this.sweeping = false;
      this.onFatal?.(err);
    };
    this.worker = worker;

    let info;
    try {
      info = await worker.call(
        'open',
        this.serial ? { serial: this.serial } : {},
        { timeoutMs: OPEN_TIMEOUT_MS }
      );
    } catch (err) {
      this.worker = null;
      await worker.stop();
      throw new Error(describeOpenFailure(err, this.serial));
    }

    this.type = DEVICE_TYPES[info.typeId] ?? UNKNOWN_TYPE;
    this.serial = info.serial;
    const model = info.type === 'unknown' ? 'Signal Hound SA' : info.type;
    this.identity = {
      // names a device the user added by hand; a discovered one keeps discovery's name
      name: `Signal Hound ${model} (SN ${info.serial})`,
      model,
      firmware: info.firmware || undefined,
      manufacturer: 'Signal Hound',
      serial: String(info.serial),
    };
    this.log(`opened ${this.identity.model} SN ${info.serial} (firmware ${info.firmware || '?'})`);

    return {
      capabilities: {
        minFrequencyHz: this.type.minHz,
        maxFrequencyHz: this.type.maxHz,
        rbwHz: this.type.rbw6M ? [...RBW_HZ, 6_000_000] : [...RBW_HZ],
        // VBW is arbitrary in the API (at most the RBW); offered as the same
        // steps so the form draws a VBW field. Omitted means equal to RBW.
        vbwHz: this.type.rbw6M ? [...RBW_HZ, 6_000_000] : [...RBW_HZ],
        minRefLevelDbm: MIN_REF_DBM,
        maxRefLevelDbm: MAX_REF_DBM,
        controls: this.controls(),
      },
      identity: this.identity,
    };
  }

  controls() {
    const step = this.type.attenStepDb;
    const controls = [
      {
        id: 'refLevelDbm',
        type: 'number',
        label: 'Reference level',
        unit: 'dBm',
        default: DEFAULT_REF_DBM,
        min: MIN_REF_DBM,
        max: MAX_REF_DBM,
        step: 5,
        help: 'Set a little above the strongest signal you expect. Lower is more sensitive; too low and strong transmitters compress the front end.',
      },
      {
        // SoundBase draws no VBW field of its own from capabilities.vbwHz, so
        // the knob lives here too; the two are the same setting
        id: 'vbw',
        type: 'dropdown',
        label: 'VBW',
        default: 'auto',
        choices: [
          { id: 'auto', label: 'Auto (= RBW)' },
          ...(this.type.rbw6M ? [...RBW_HZ, 6_000_000] : RBW_HZ).map((hz) => ({
            id: String(hz),
            label: hz >= 1e6 ? `${hz / 1e6} MHz` : `${hz / 1e3} kHz`,
          })),
        ],
        help: 'Video bandwidth, at most the RBW. Narrower smooths the trace and slows the sweep; Auto keeps it equal to the RBW, which the API recommends.',
      },
      {
        id: 'atten',
        type: 'dropdown',
        label: 'Attenuation',
        default: 'auto',
        choices: [
          { id: 'auto', label: 'Auto (from reference level)' },
          { id: '0', label: '0 dB' },
          { id: '1', label: `${step} dB` },
          { id: '2', label: `${step * 2} dB` },
          { id: '3', label: `${step * 3} dB` },
        ],
        help: 'Leave on Auto: the API picks attenuation and gain for the best dynamic range at the reference level.',
      },
      {
        id: 'gain',
        type: 'dropdown',
        label: 'Gain',
        default: 'auto',
        choices: [
          { id: 'auto', label: 'Auto (from reference level)' },
          { id: '0', label: 'Low (16 dB attenuation)' },
          { id: '1', label: 'Mid-range' },
          { id: '2', label: 'High (12 dB digital gain)' },
        ],
      },
      {
        id: 'detector',
        type: 'dropdown',
        label: 'Detector',
        default: 'minmax',
        choices: [
          { id: 'minmax', label: 'Peak (min/max)' },
          { id: 'average', label: 'Average' },
        ],
      },
      {
        id: 'imageReject',
        type: 'checkbox',
        label: 'Image rejection',
        default: true,
        help: 'The SA series rejects image responses in software. Keep this on for continuous signals; turn it off to catch short bursts at a known frequency.',
      },
      {
        id: 'rbwShape',
        type: 'dropdown',
        label: 'RBW filter',
        default: 'flattop',
        choices: [
          { id: 'flattop', label: 'Flat-top (3 dB)' },
          { id: 'cispr', label: 'Gaussian / CISPR (6 dB)' },
        ],
      },
      {
        id: 'procUnits',
        type: 'dropdown',
        label: 'Video processing',
        default: 'log',
        choices: [
          { id: 'log', label: 'Log (dBm), like a classic analyzer' },
          { id: 'power', label: 'Power (mW), for average power' },
          { id: 'volt', label: 'Voltage (mV), cleans up AM' },
          { id: 'bypass', label: 'Bypass (no video filtering)' },
        ],
        help: 'The units the VBW filter averages in. Log is the traditional choice; Power for true average-power readings.',
      },
      {
        id: 'timebase',
        type: 'dropdown',
        label: 'Timebase',
        default: 'internal',
        choices: [
          { id: 'internal', label: 'Internal' },
          { id: 'external', label: 'External 10 MHz in (BNC)' },
          { id: 'internal-out', label: 'Internal, 10 MHz out (BNC)' },
        ],
        help: 'With External selected and no reference on the BNC port the device stays on its internal clock. Once locked to an external reference it stays there until the device is reopened.',
      },
      {
        id: 'minTrace',
        type: 'checkbox',
        label: 'Min-detector curve',
        default: false,
        help: 'Also report the minimum-detector trace as a second curve named Min. Only meaningful with the Peak (min/max) detector.',
      },
    ];
    if (this.type.preamp) {
      controls.push({
        id: 'preamp',
        type: 'checkbox',
        label: 'Preamplifier',
        default: false,
        help: 'Enable the internal preamp for weak signals. Strong local transmitters can compress it.',
      });
    }
    return controls;
  }

  /**
   * Clamp the request to what the unit accepts, apply it, and echo what is
   * actually in force. `cfg` is a patch: absent fields keep their value.
   */
  async applyConfig(cfg = {}) {
    if (!this.worker) throw new Error('device is not open');
    const prev = this.effective ?? {
      startHz: DEFAULT_START_HZ,
      stopHz: DEFAULT_STOP_HZ,
      pointCount: DEFAULT_POINTS,
      refLevelDbm: DEFAULT_REF_DBM,
      fieldVbw: undefined,
      controls: {
        refLevelDbm: DEFAULT_REF_DBM,
        vbw: 'auto',
        atten: 'auto',
        gain: 'auto',
        detector: 'minmax',
        imageReject: true,
        rbwShape: 'flattop',
        procUnits: 'log',
        timebase: 'internal',
        minTrace: false,
        preamp: false,
      },
    };

    const { minHz, maxHz } = this.type;
    let startHz = clamp(isNum(cfg.startHz) ? cfg.startHz : prev.startHz, minHz, maxHz - 1);
    let stopHz = clamp(isNum(cfg.stopHz) ? cfg.stopHz : prev.stopHz, startHz + 1, maxHz);
    const span = stopHz - startHz;

    let pointCount;
    if (isNum(cfg.pointCount)) pointCount = Math.round(cfg.pointCount);
    else if (isNum(cfg.stepHz) && cfg.stepHz > 0) pointCount = Math.round(span / cfg.stepHz) + 1;
    else pointCount = prev.pointCount;
    pointCount = clamp(pointCount, MIN_POINTS, MAX_POINTS);

    // RBW: explicit (clamped to the offered list and the span rule) or auto.
    // The shell hands over its whole desired configuration on every call and
    // leaves rbwHz out when the user chose auto, so absent means auto here —
    // not "unchanged".
    const rbwList = this.type.rbw6M ? [...RBW_HZ, 6_000_000] : RBW_HZ;
    const minRbw = minRbwFor(startHz, stopHz);
    let rbwHz;
    let rbwAuto = false;
    if (isNum(cfg.rbwHz)) {
      rbwHz = Math.max(nearest(rbwList, cfg.rbwHz), minRbw);
    } else {
      rbwAuto = true;
      rbwHz = Math.max(autoRbwFor(startHz, stopHz, pointCount), minRbw);
    }
    // VBW: at most the RBW and subject to the same floor; auto means equal to
    // the RBW, which is what the API recommends for speed. The control (what
    // the user sees) wins over the top-level field.
    // Two knobs name one setting (the host's vbwHz field and this control),
    // and the host resends both on every call, so the one that changed since
    // last time is the user's latest intent; the control wins a tie.
    const controls = mergeControls(prev.controls, cfg.controls, this.type);
    const fieldVbw = isNum(cfg.vbwHz) ? cfg.vbwHz : undefined;
    const fieldChanged = fieldVbw !== prev.fieldVbw;
    const controlChanged = controls.vbw !== prev.controls.vbw;
    let vbwRequested;
    if (controlChanged || !fieldChanged) {
      vbwRequested = controls.vbw !== 'auto' ? Number(controls.vbw) : undefined;
    } else {
      vbwRequested = fieldVbw;
    }
    const vbwAuto = !isNum(vbwRequested);
    const vbwHz = vbwAuto ? rbwHz : clamp(vbwRequested, minRbw, rbwHz);
    // the control keeps the user's choice (the host stores and resends it);
    // what the device really runs is under resolved when that differs
    controls.vbw = vbwAuto ? 'auto' : String(vbwRequested);

    // the control wins over the top-level field, since it is the one the user
    // can see; both are the same knob
    const refRequested = isNum(controls.refLevelDbm)
      ? controls.refLevelDbm
      : isNum(cfg.refLevelDbm)
        ? cfg.refLevelDbm
        : prev.refLevelDbm;
    const refLevelDbm = clamp(Math.round(refRequested), MIN_REF_DBM, MAX_REF_DBM);
    controls.refLevelDbm = refLevelDbm;

    const reply = await this.worker.call(
      'config',
      {
        startHz,
        stopHz,
        pointCount,
        rbwHz,
        vbwHz,
        refLevelDbm,
        atten: controls.atten === 'auto' ? -1 : Number(controls.atten),
        gain: controls.gain === 'auto' ? -1 : Number(controls.gain),
        preamp: Boolean(controls.preamp),
        detector: controls.detector,
        imageReject: Boolean(controls.imageReject),
        rbwShape: controls.rbwShape,
        procUnits: controls.procUnits,
        timebase: controls.timebase,
        minTrace: Boolean(controls.minTrace),
      },
      { timeoutMs: Math.max(DEFAULT_TIMEOUT_MS, 30_000) }
    );
    if (reply.warnings > 0) this.log(`API warning: ${reply.warning}`);
    // the device reports what it is really clocked from
    if (typeof reply.timebase === 'string') controls.timebase = reply.timebase;

    this.sweepLength = reply.sweepLength;
    const effective = {
      fieldVbw, // remembered to tell a changed field from a sticky control
      // the API picks the exact first bin; echo what it chose
      startHz: reply.startHz,
      stopHz: reply.stopHz,
      pointCount: reply.pointCount,
      refLevelDbm,
      controls,
      resolved: {
        sweepTimeMs: this.estimateSweepMs(),
        binSizeHz: reply.binSizeHz,
      },
    };
    if (rbwAuto) effective.resolved.rbwHz = rbwHz;
    else effective.rbwHz = rbwHz;
    // the host echoes the requested VBW itself, so a clamp is only visible
    // under resolved
    if (vbwAuto || vbwHz !== vbwRequested) effective.resolved.vbwHz = vbwHz;
    if (!vbwAuto) effective.vbwHz = vbwHz;
    this.effective = effective;
    const { fieldVbw: _omit, ...reported } = effective;
    return reported;
  }

  estimateSweepMs() {
    return Math.round(SWEEP_OVERHEAD_MS + this.sweepLength * this.msPerBin);
  }

  sweepTimeoutMs() {
    return clamp(this.estimateSweepMs() * 4 + 5_000, DEFAULT_TIMEOUT_MS, 600_000);
  }

  /** Sweep until stopped, one `onTrace(amplitudesDbm)` per completed sweep. */
  async startSweep(onTrace) {
    if (this.sweeping) return;
    if (!this.worker) throw new Error('device is not open');
    if (!this.effective) await this.applyConfig({});
    this.sweeping = true;
    const worker = this.worker;
    (async () => {
      let consecutiveErrors = 0;
      while (this.sweeping && this.worker === worker) {
        try {
          const reply = await worker.call('sweep', {}, { timeoutMs: this.sweepTimeoutMs() });
          consecutiveErrors = 0;
          if (isNum(reply.sweepMs) && this.sweepLength > 0) {
            // learn the real rate, smoothed
            const measured = Math.max(0, reply.sweepMs - 20) / this.sweepLength;
            this.msPerBin = this.msPerBin * 0.7 + measured * 0.3;
          }
          if (this.sweeping && this.worker === worker) {
            const series = Array.isArray(reply.mins)
              ? [{ name: 'Min', amplitudesDbm: reply.mins }]
              : undefined;
            onTrace(reply.amps, series);
          }
        } catch (err) {
          if (!this.sweeping || this.worker !== worker) return;
          consecutiveErrors += 1;
          const fatal = err instanceof WorkerError ? err.fatal : true;
          if (fatal || consecutiveErrors >= 3) {
            this.log(`sweep failed: ${err.message}`);
            this.sweeping = false;
            this.onFatal?.(err);
            return;
          }
          this.log(`sweep error (${consecutiveErrors}/3): ${err.message}`);
        }
      }
    })();
  }

  async stopSweep() {
    this.sweeping = false;
    if (this.worker) {
      try {
        await this.worker.call('abort', {}, { timeoutMs: 10_000 });
      } catch {
        /* a dead worker is reported through onExit */
      }
    }
  }

  async close() {
    this.sweeping = false;
    const worker = this.worker;
    this.worker = null;
    this.effective = null;
    if (worker) await worker.stop();
  }
}

/** Merge a controls patch by id, normalising each value to what the worker takes. */
function mergeControls(previous, patch, type) {
  const out = { ...previous };
  if (!patch || typeof patch !== 'object') return out;
  const enumOr = (v, allowed, fallback) =>
    allowed.includes(String(v)) ? String(v) : fallback;
  if ('refLevelDbm' in patch) {
    const v = Number(patch.refLevelDbm);
    out.refLevelDbm = patch.refLevelDbm === null || !Number.isFinite(v) ? DEFAULT_REF_DBM : v;
  }
  if ('vbw' in patch) {
    const v = Number(patch.vbw);
    out.vbw = patch.vbw === null || patch.vbw === 'auto' || !Number.isFinite(v) || v <= 0 ? 'auto' : String(v);
  }
  if ('atten' in patch) out.atten = patch.atten === null ? 'auto' : enumOr(patch.atten, ['auto', '0', '1', '2', '3'], 'auto');
  if ('gain' in patch) out.gain = patch.gain === null ? 'auto' : enumOr(patch.gain, ['auto', '0', '1', '2'], 'auto');
  if ('detector' in patch) out.detector = enumOr(patch.detector, ['minmax', 'average'], 'minmax');
  if ('rbwShape' in patch) out.rbwShape = enumOr(patch.rbwShape, ['flattop', 'cispr'], 'flattop');
  if ('procUnits' in patch) out.procUnits = enumOr(patch.procUnits, ['log', 'power', 'volt', 'bypass'], 'log');
  if ('timebase' in patch) out.timebase = enumOr(patch.timebase, ['internal', 'external', 'internal-out'], 'internal');
  if ('minTrace' in patch) out.minTrace = patch.minTrace === null ? false : Boolean(patch.minTrace);
  if ('imageReject' in patch) out.imageReject = patch.imageReject === null ? true : Boolean(patch.imageReject);
  if ('preamp' in patch) out.preamp = type.preamp && Boolean(patch.preamp);
  if (!type.preamp) out.preamp = false;
  return out;
}

function describeOpenFailure(err, serial) {
  const which = serial ? `SA unit with serial ${serial}` : 'an SA unit';
  switch (err?.code) {
    case 'no_worker_binary':
      return (
        `Signal Hound's SA API is available for Windows only, and this plugin has no ` +
        `worker for ${process.platform}-${process.arch}. ${err.message}`
      );
    case 'library_unavailable':
      return `Cannot load the Signal Hound SA API: ${err.message}`;
    case 'worker_timeout':
      return (
        `Opening ${which} timed out. The first open of a unit on a PC downloads its ` +
        `calibration file and needs internet access; check the USB cable and that Spike is not using the device.`
      );
    default:
      return `Could not open ${which}: ${err?.message ?? err}`;
  }
}
