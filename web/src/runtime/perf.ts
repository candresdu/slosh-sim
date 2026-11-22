// Optional frame-time instrumentation, enabled with `?perf=1` in the page URL.
// Records the frame interval and the per-frame split (sim, scene, charts) and logs
// p50 / p95 / p99 to the console every `reportEveryS` seconds.

export type PerfSection = 'sim' | 'scene' | 'charts';
const SECTIONS: readonly PerfSection[] = ['sim', 'scene', 'charts'];

export interface PerfOptions {
  now?: () => number; // ms
  log?: (line: string) => void;
  reportEveryS?: number; // default 10
  maxSamples?: number; // per series, default 2048
}

export function perfEnabled(search: string): boolean {
  return new URLSearchParams(search).get('perf') === '1';
}

class Series {
  private readonly buf: Float64Array;
  private n = 0;
  private i = 0;
  constructor(cap: number) {
    this.buf = new Float64Array(cap);
  }
  add(v: number): void {
    this.buf[this.i] = v;
    this.i = (this.i + 1) % this.buf.length;
    if (this.n < this.buf.length) this.n += 1;
  }
  reset(): void {
    this.n = 0;
    this.i = 0;
  }
  get count(): number {
    return this.n;
  }
  percentiles(): [number, number, number] {
    const a = this.buf.slice(0, this.n).sort();
    const at = (p: number): number => (a.length === 0 ? NaN : (a[Math.min(a.length - 1, Math.floor(p * a.length))] as number));
    return [at(0.5), at(0.95), at(0.99)];
  }
}

export class Perf {
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly everyMs: number;
  private readonly frames: Series;
  private readonly sections: Record<PerfSection, Series>;
  private readonly acc: Record<PerfSection, number> = { sim: 0, scene: 0, charts: 0 };
  private lastFrame = NaN;
  private lastReport = NaN;

  constructor(opts: PerfOptions = {}) {
    this.now = opts.now ?? (() => performance.now());
    this.log = opts.log ?? ((l) => console.log(l));
    this.everyMs = (opts.reportEveryS ?? 10) * 1000;
    const cap = opts.maxSamples ?? 2048;
    this.frames = new Series(cap);
    this.sections = { sim: new Series(cap), scene: new Series(cap), charts: new Series(cap) };
  }

  /** A Perf when the URL query has perf=1, otherwise null. */
  static fromLocation(opts: PerfOptions = {}): Perf | null {
    const search = typeof location !== 'undefined' ? location.search : '';
    return perfEnabled(search) ? new Perf(opts) : null;
  }

  /** Time `fn` and add it to this frame's `section` total. */
  time<T>(section: PerfSection, fn: () => T): T {
    const t0 = this.now();
    try {
      return fn();
    } finally {
      this.acc[section] += this.now() - t0;
    }
  }

  /** Add an externally measured duration [ms] to this frame's `section` total. */
  add(section: PerfSection, ms: number): void {
    this.acc[section] += ms;
  }

  /** Call once per animation frame, after the frame's work: closes the frame and maybe reports. */
  endFrame(): void {
    const t = this.now();
    if (!Number.isNaN(this.lastFrame)) this.frames.add(t - this.lastFrame);
    this.lastFrame = t;
    for (const s of SECTIONS) {
      this.sections[s].add(this.acc[s]);
      this.acc[s] = 0;
    }
    if (Number.isNaN(this.lastReport)) this.lastReport = t;
    if (t - this.lastReport >= this.everyMs) {
      this.log(this.report());
      this.lastReport = t;
      this.frames.reset();
      for (const s of SECTIONS) this.sections[s].reset();
    }
  }

  /** Forget the previous frame time (after a pause / hidden tab) so the gap is not counted. */
  skip(): void {
    this.lastFrame = NaN;
  }

  report(): string {
    const f = (p: [number, number, number]): string => p.map((v) => v.toFixed(2)).join('/');
    const parts = [`[perf] frames=${this.frames.count} frame ms p50/p95/p99 ${f(this.frames.percentiles())}`];
    for (const s of SECTIONS) parts.push(`${s} ${f(this.sections[s].percentiles())}`);
    return parts.join(' | ');
  }
}
