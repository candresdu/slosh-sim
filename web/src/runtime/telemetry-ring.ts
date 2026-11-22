// Fixed-capacity telemetry ring buffer: one Float64Array per channel (structure of arrays).
// Capacity 3000 = 30 s at the 100 Hz telemetry rate.
import type { SimCommand, Telemetry } from '../core/sim';

export const CHANNELS = [
  't',
  'theta',
  'phi',
  'massX',
  'massY',
  'massZ',
  'quadX',
  'quadY',
  'quadZ',
  'roll',
  'pitch',
  'yaw',
  'kTPitch',
  'kTRoll',
  'kTAppliedPitch',
  'kTAppliedRoll',
  'ySDPitch',
  'ySDRoll',
  'detectPitch',
  'detectRoll',
  'gainShift',
  'motorCmd0',
  'motorCmd1',
  'motorCmd2',
  'motorCmd3',
  'motorOmega0',
  'motorOmega1',
  'motorOmega2',
  'motorOmega3',
] as const;

export type ChannelId = (typeof CHANNELS)[number];

/** 0 = pitch (x), 1 = roll (y), the same order as Telemetry.kT / ySD / detect. */
export type Axis = 0 | 1;

export interface Detection {
  t: number;
  axis: Axis;
}

export type MarkerKind = 'gainShift' | 'aacMode' | 'kick' | 'trip';

/** A labelled event on the time axis: a reader action / regime transition, or a detector trip. */
export interface Marker {
  t: number;
  kind: MarkerKind;
  label: string;
  /** Only for kind 'trip'. */
  axis?: Axis;
}

export type Regime = 'nominal' | 'gainShift' | 'engaged';

/** A time span of one regime; consecutive equal regimes are merged and adjacent bands touch. */
export interface Band {
  t0: number;
  t1: number;
  regime: Regime;
}

/** A command-log entry as returned by `Sim.commandLog()`: (control tick, command). */
export type LogEntry = readonly [number, SimCommand];

const AXIS_NAME = ['pitch', 'roll'] as const;
const NO_COMMANDS: readonly LogEntry[] = [];

function fmtGain(v: number): string {
  return String(Number(v.toFixed(2)));
}

/** The marker a command produces, or null (clearSchedule, loadPreset, reset). */
function commandMarker(cmd: SimCommand, t: number): Marker | null {
  switch (cmd.type) {
    case 'setGainShift':
      return { t, kind: 'gainShift', label: `Gain shift \u2192 ${fmtGain(cmd.value)}` };
    case 'rampGainShift':
      return { t, kind: 'gainShift', label: `Gain shift \u2192 ${fmtGain(cmd.to)}` };
    case 'setAacMode': {
      const label = cmd.mode === 'off' ? 'AAC off' : cmd.mode === 'monitor' ? 'AAC monitoring' : 'AAC engaged';
      return { t, kind: 'aacMode', label };
    }
    case 'kick':
      return { t, kind: 'kick', label: 'Disturbance' };
    default:
      return null;
  }
}

/** Regime of one telemetry sample (drives the background shading). */
export function regimeOf(s: Pick<Telemetry, 'aacMode' | 'gainShift'>): Regime {
  if (s.aacMode === 'engaged') return 'engaged';
  if (s.gainShift > 1 + 1e-9 || s.aacMode === 'monitor') return 'gainShift';
  return 'nominal';
}

const CH = Object.fromEntries(CHANNELS.map((c, i) => [c, i])) as Record<ChannelId, number>;

export class TelemetryRing {
  readonly capacity: number;
  private readonly data: Float64Array[];
  private readonly out: Float64Array[];
  private head = 0; // next write slot
  private n = 0; // samples held
  private _latest: Telemetry | null = null;
  private lastT = -Infinity;
  private prevDetect: [boolean, boolean] = [false, false];
  private trips: Detection[] = [];
  private marks: Marker[] = [];
  private bandList: Band[] = [];
  private _pushes = 0;

  constructor(capacity = 3000) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('capacity must be a positive integer');
    this.capacity = capacity;
    this.data = CHANNELS.map(() => new Float64Array(capacity));
    this.out = CHANNELS.map(() => new Float64Array(capacity));
  }

  /** Number of samples currently held (≤ capacity). */
  get length(): number {
    return this.n;
  }

  /** Total pushes since construction / clear (changes whenever the content changes). */
  get version(): number {
    return this._pushes;
  }

  /**
   * Append a sample (values are copied; the argument may be reused by the caller).
   * A sample whose time is not later than the previous one means the simulation was reset or a
   * preset was loaded: the buffer is cleared first, so the window never mixes two runs.
   */
  push(s: Telemetry, newCommands: readonly LogEntry[] = NO_COMMANDS): void {
    // A reset / preset load among the commands applied at the start of this tick starts a new run:
    // the sample (taken after the tick) is its first. Markers from commands after it are kept.
    let fresh = -1;
    for (let k = 0; k < newCommands.length; k++) {
      const type = (newCommands[k] as LogEntry)[1].type;
      if (type === 'reset' || type === 'loadPreset') fresh = k;
    }
    if (fresh >= 0 || s.t <= this.lastT) this.clear();
    for (let k = fresh + 1; k < newCommands.length; k++) {
      const m = commandMarker((newCommands[k] as LogEntry)[1], s.t);
      if (m !== null) this.marks.push(m);
    }
    this.lastT = s.t;
    const i = this.head;
    const d = this.data;
    (d[CH.t] as Float64Array)[i] = s.t;
    (d[CH.theta] as Float64Array)[i] = s.theta;
    (d[CH.phi] as Float64Array)[i] = s.phi;
    (d[CH.massX] as Float64Array)[i] = s.massRel[0];
    (d[CH.massY] as Float64Array)[i] = s.massRel[1];
    (d[CH.massZ] as Float64Array)[i] = s.massRel[2];
    (d[CH.quadX] as Float64Array)[i] = s.quadPos[0];
    (d[CH.quadY] as Float64Array)[i] = s.quadPos[1];
    (d[CH.quadZ] as Float64Array)[i] = s.quadPos[2];
    (d[CH.roll] as Float64Array)[i] = s.roll;
    (d[CH.pitch] as Float64Array)[i] = s.pitch;
    (d[CH.yaw] as Float64Array)[i] = s.yaw;
    (d[CH.kTPitch] as Float64Array)[i] = s.kT[0];
    (d[CH.kTRoll] as Float64Array)[i] = s.kT[1];
    (d[CH.kTAppliedPitch] as Float64Array)[i] = s.kTApplied[0];
    (d[CH.kTAppliedRoll] as Float64Array)[i] = s.kTApplied[1];
    (d[CH.ySDPitch] as Float64Array)[i] = s.ySD[0];
    (d[CH.ySDRoll] as Float64Array)[i] = s.ySD[1];
    (d[CH.detectPitch] as Float64Array)[i] = s.detect[0] ? 1 : 0;
    (d[CH.detectRoll] as Float64Array)[i] = s.detect[1] ? 1 : 0;
    (d[CH.gainShift] as Float64Array)[i] = s.gainShift;
    for (let k = 0; k < 4; k++) {
      (d[CH.motorCmd0 + k] as Float64Array)[i] = s.motorCmd[k] as number;
      (d[CH.motorOmega0 + k] as Float64Array)[i] = s.motorOmega[k] as number;
    }
    this.head = (i + 1) % this.capacity;
    if (this.n < this.capacity) this.n += 1;
    this._pushes += 1;

    // detector rising edges, kept while their time is inside the window
    for (let a = 0; a < 2; a++) {
      const on = s.detect[a] as boolean;
      if (on && !this.prevDetect[a]) {
        this.trips.push({ t: s.t, axis: a as Axis });
        if (s.aacMode !== 'off') {
          this.marks.push({ t: s.t, kind: 'trip', label: `Detector tripped (${AXIS_NAME[a] as string})`, axis: a as Axis });
        }
      }
      this.prevDetect[a] = on;
    }

    // regime bands: extend the open band, or close it at this sample and open the next one
    const regime = regimeOf(s);
    const bl = this.bandList;
    const lastBand = bl[bl.length - 1];
    if (lastBand === undefined) bl.push({ t0: s.t, t1: s.t, regime });
    else if (lastBand.regime === regime) lastBand.t1 = s.t;
    else {
      lastBand.t1 = s.t;
      bl.push({ t0: s.t, t1: s.t, regime });
    }

    // eviction with the window
    const t0 = (d[CH.t] as Float64Array)[(this.head - this.n + this.capacity) % this.capacity] as number;
    evictBefore(this.trips, t0, (x) => x.t);
    evictBefore(this.marks, t0, (x) => x.t);
    evictBefore(bl, t0, (x) => x.t1);

    // latest(): own copy so the caller's reused Telemetry object never aliases it
    const l = this._latest;
    if (l === null) {
      this._latest = {
        t: s.t,
        theta: s.theta,
        phi: s.phi,
        massRel: [...s.massRel],
        quadPos: [...s.quadPos],
        roll: s.roll,
        pitch: s.pitch,
        yaw: s.yaw,
        kT: [...s.kT],
        kTApplied: [...s.kTApplied],
        ySD: [...s.ySD],
        detect: [...s.detect],
        gainShift: s.gainShift,
        aacMode: s.aacMode,
        motorCmd: [...s.motorCmd],
        motorOmega: [...s.motorOmega],
      };
    } else {
      l.t = s.t;
      l.theta = s.theta;
      l.phi = s.phi;
      l.roll = s.roll;
      l.pitch = s.pitch;
      l.yaw = s.yaw;
      l.gainShift = s.gainShift;
      l.aacMode = s.aacMode;
      for (let k = 0; k < 3; k++) {
        l.massRel[k] = s.massRel[k] as number;
        l.quadPos[k] = s.quadPos[k] as number;
      }
      for (let k = 0; k < 2; k++) {
        l.kT[k] = s.kT[k] as number;
        l.kTApplied[k] = s.kTApplied[k] as number;
        l.ySD[k] = s.ySD[k] as number;
        l.detect[k] = s.detect[k] as boolean;
      }
      for (let k = 0; k < 4; k++) {
        l.motorCmd[k] = s.motorCmd[k] as number;
        l.motorOmega[k] = s.motorOmega[k] as number;
      }
    }
  }

  /**
   * Chronologically ordered (oldest first) samples of one channel, length `length`.
   * The returned array is a view of a per-channel buffer that is overwritten by the next
   * `view()` call for the same channel.
   */
  view(channel: ChannelId): Float64Array {
    const c = CH[channel];
    if (c === undefined) throw new Error(`unknown channel ${String(channel)}`);
    const src = this.data[c] as Float64Array;
    const dst = this.out[c] as Float64Array;
    const n = this.n;
    if (n < this.capacity) {
      dst.set(src.subarray(0, n));
    } else {
      const h = this.head; // oldest sample
      const tail = this.capacity - h;
      dst.set(src.subarray(h), 0);
      dst.set(src.subarray(0, h), tail);
    }
    return dst.subarray(0, n);
  }

  /** Detector rising edges whose time lies inside the current window, oldest first. */
  detections(): Detection[] {
    return this.trips.map((d) => ({ t: d.t, axis: d.axis }));
  }

  /** Markers (command transitions and detector trips) inside the window, oldest first. */
  markers(): Marker[] {
    return this.marks.map((m) => ({ ...m }));
  }

  /** Regime bands inside the window (the oldest is clipped to the window start), oldest first. */
  bands(): Band[] {
    if (this.n === 0) return [];
    const t0 = (this.data[CH.t] as Float64Array)[(this.head - this.n + this.capacity) % this.capacity] as number;
    return this.bandList.map((b) => ({ t0: Math.max(b.t0, t0), t1: b.t1, regime: b.regime }));
  }

  /** The most recent sample (an internal copy, valid until the next push), or null if empty. */
  latest(): Readonly<Telemetry> | null {
    return this.n === 0 ? null : this._latest;
  }

  clear(): void {
    this.head = 0;
    this.n = 0;
    this.lastT = -Infinity;
    this.prevDetect = [false, false];
    this.trips = [];
    this.marks = [];
    this.bandList = [];
    this._pushes += 1;
  }
}

/** Remove the leading items whose key is < t0 (the list is time-ordered). */
function evictBefore<T>(list: T[], t0: number, key: (x: T) => number): void {
  let k = 0;
  while (k < list.length && key(list[k] as T) < t0) k++;
  if (k > 0) list.splice(0, k);
}
