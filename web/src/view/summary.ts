// Accessible text summary of the current state: a visually hidden aria-live="polite" region,
// refreshed at most once per second of simulation time.
import type { AacMode } from '../core/aac';
import type { Telemetry } from '../core/sim';
import type { Detection, TelemetryRing } from '../runtime/telemetry-ring';

/** Length of the amplitude window and of the previous window used for the trend [s]. */
export const SUMMARY_WINDOW_S = 2;
/** Minimum update interval in simulation time [s]. */
export const SUMMARY_PERIOD_S = 1;
/** Amplitude ratio (current / previous window) beyond which the trend is growing or decaying. */
export const TREND_RATIO = 1.1;

export type Trend = 'growing' | 'decaying' | 'steady' | null;

export const SUMMARY_CSS = `
.sc-summary { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden;
  clip-path: inset(50%); white-space: nowrap; border: 0; }
`;

const MODE_NAMES: Readonly<Record<AacMode, string>> = { off: 'Off', monitor: 'Monitor', engaged: 'Engaged' };
const AXIS_NAMES = ['pitch', 'roll'] as const;

export interface SummaryInput {
  /** Sample times [s], oldest first. */
  t: ArrayLike<number>;
  /** θ samples [rad], same length as `t`. */
  theta: ArrayLike<number>;
  aacMode: AacMode;
  /** Detector latch per axis right now. */
  detect: readonly [boolean, boolean];
  /** Detector rising edges inside the window. */
  trips: readonly Detection[];
}

/** Max |θ| over samples with time in (t1 - windowS, t1]. NaN if there are none. */
function windowMax(t: ArrayLike<number>, theta: ArrayLike<number>, t0: number, t1: number): number {
  let m = Number.NaN;
  for (let i = t.length - 1; i >= 0; i--) {
    const ti = t[i] as number;
    if (ti > t1 + 1e-9) continue;
    if (ti <= t0 + 1e-9) break;
    const a = Math.abs(theta[i] as number);
    if (!(a <= m)) m = a;
  }
  return m;
}

/** θ amplitude [rad] (max over the last 2 s) and the trend against the 2 s before it. */
export function thetaAmplitude(
  t: ArrayLike<number>,
  theta: ArrayLike<number>,
): { amplitude: number; trend: Trend } {
  const n = t.length;
  if (n === 0) return { amplitude: 0, trend: null };
  const tEnd = t[n - 1] as number;
  const amp = windowMax(t, theta, tEnd - SUMMARY_WINDOW_S, tEnd);
  // one control tick of slack: a ring that starts at t = 0.01 s has a full 4 s at t = 4.00 s
  const hasPrev = (t[0] as number) <= tEnd - 2 * SUMMARY_WINDOW_S + 0.015;
  if (!hasPrev) return { amplitude: amp, trend: null };
  const prev = windowMax(t, theta, tEnd - 2 * SUMMARY_WINDOW_S, tEnd - SUMMARY_WINDOW_S);
  let trend: Trend = 'steady';
  if (amp > prev * TREND_RATIO) trend = 'growing';
  else if (amp < prev / TREND_RATIO) trend = 'decaying';
  return { amplitude: amp, trend };
}

function axisList(flags: readonly boolean[]): string {
  return flags
    .map((f, i) => (f ? AXIS_NAMES[i] : null))
    .filter((x): x is 'pitch' | 'roll' => x !== null)
    .join(' and ');
}

/** The sentence, e.g. "θ amplitude 0.24 rad and growing; AAC Monitor; detector tripped on pitch." */
export function describeState(inp: SummaryInput): string {
  const { amplitude, trend } = thetaAmplitude(inp.t, inp.theta);
  let s = `θ amplitude ${amplitude.toFixed(2)} rad`;
  if (trend !== null) s += ` and ${trend}`;
  s += `; AAC ${MODE_NAMES[inp.aacMode]}`;
  const now = axisList(inp.detect);
  if (now !== '') {
    s += `; detector tripped on ${now}`;
  } else if (inp.trips.length > 0) {
    const seen: boolean[] = [false, false];
    for (const d of inp.trips) seen[d.axis] = true;
    s += `; detector tripped earlier on ${axisList(seen)}, now clear`;
  } else {
    s += '; detector not tripped';
  }
  return `${s}.`;
}

export interface SummaryHandle {
  readonly element: HTMLElement;
  /** Call every frame: refreshes the text if at least 1 s of sim time has passed (or the sim restarted). Returns true if it did. */
  maybeUpdate(ring: TelemetryRing): boolean;
  /** Force an update now. */
  update(ring: TelemetryRing): void;
  /** Set the story narration caption; it is appended to the text and announced. Returns false (and does nothing) if unchanged. */
  setCaption(caption: string): boolean;
  dispose(): void;
}

export function createSummary(container: HTMLElement): SummaryHandle {
  const el = container.ownerDocument.createElement('div');
  el.className = 'sc-summary';
  el.setAttribute('aria-live', 'polite');
  el.setAttribute('aria-atomic', 'true');
  el.setAttribute('role', 'status');
  el.setAttribute('aria-label', 'Simulation state summary');
  container.appendChild(el);
  let lastT = Number.NEGATIVE_INFINITY;
  let caption = '';
  let lastRing: TelemetryRing | null = null;

  const render = (ring: TelemetryRing, latest: Readonly<Telemetry>): void => {
    const text = describeState({
      t: ring.view('t'),
      theta: ring.view('theta'),
      aacMode: latest.aacMode,
      detect: latest.detect,
      trips: ring.detections(),
    });
    const full = caption === '' ? text : `${text} ${caption}`;
    if (el.textContent !== full) el.textContent = full;
    lastT = latest.t;
  };

  return {
    element: el,
    maybeUpdate(ring) {
      lastRing = ring;
      const latest = ring.latest();
      if (latest === null) return false;
      if (latest.t >= lastT + SUMMARY_PERIOD_S - 1e-9 || latest.t < lastT) {
        render(ring, latest);
        return true;
      }
      return false;
    },
    update(ring) {
      lastRing = ring;
      const latest = ring.latest();
      if (latest !== null) render(ring, latest);
    },
    setCaption(next) {
      if (next === caption) return false;
      caption = next;
      const latest = lastRing?.latest();
      if (lastRing !== null && latest !== null && latest !== undefined) render(lastRing, latest);
      else el.textContent = caption;
      return true;
    },
    dispose() {
      el.remove();
    },
  };
}
