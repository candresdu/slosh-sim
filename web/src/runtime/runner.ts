// Real-time runner: fixed-step accumulator over Sim.stepControl() driven by requestAnimationFrame.
// DOM-free apart from optional defaults (rAF, document.hidden), all injectable for tests.
import { loadPreset, type PresetId } from '../core/presets';
import type { SimCommand, Telemetry } from '../core/sim';
import type { Perf } from './perf';
import type { Axis, LogEntry, TelemetryRing } from './telemetry-ring';

/** What the runner needs from the simulation (the real `Sim` satisfies it). */
export interface SimLike {
  stepControl(): Telemetry;
  enqueue(cmd: SimCommand): void;
  /** Applied commands as (tick, command); optional (the ring then gets no command markers). */
  commandLog?(): ReadonlyArray<LogEntry>;
}

export interface RunnerOptions {
  now?: () => number; // ms
  raf?: (cb: (t: number) => void) => number;
  caf?: (id: number) => void;
  /** Max 10 ms batches advanced per frame (default 10, NFR-2). */
  maxBatchesPerFrame?: number;
  /** Tab hidden? Default reads `document.hidden`. */
  isHidden?: () => boolean;
  /** Subscribe to visibility changes; returns an unsubscribe. Default uses `document`. */
  onVisibilityChange?: (cb: () => void) => () => void;
  perf?: Perf | null;
}

export interface FrameInfo {
  /** Control ticks advanced in this frame. */
  ticks: number;
}

export interface RunnerEvents {
  frame: (latest: Telemetry, info: FrameInfo) => void;
  detect: (axis: Axis, t: number) => void;
  'preset-done': (id: PresetId) => void;
}
export type RunnerEvent = keyof RunnerEvents;

const DT = 0.01; // control tick [s]
const EPS = 1e-9; // absorbs accumulated float error in the accumulator

const defaultHidden = (): boolean => typeof document !== 'undefined' && document.hidden;
const defaultVisibility = (cb: () => void): (() => void) => {
  if (typeof document === 'undefined') return () => undefined;
  document.addEventListener('visibilitychange', cb);
  return () => document.removeEventListener('visibilitychange', cb);
};

export class Runner {
  private readonly now: () => number;
  private readonly raf: (cb: (t: number) => void) => number;
  private readonly caf: (id: number) => void;
  private readonly maxBatches: number;
  private readonly isHidden: () => boolean;
  private readonly subscribeVisibility: (cb: () => void) => () => void;
  private readonly perf: Perf | null;
  private readonly handlers: { [K in RunnerEvent]: Array<RunnerEvents[K]> } = {
    frame: [],
    detect: [],
    'preset-done': [],
  };

  private running = false;
  private paused = false;
  private speed: 1 | 0.5 = 1;
  private timeScale = 1;
  private acc = 0;
  private last = 0;
  private rafId: number | null = null;
  private unsubVisibility: (() => void) | null = null;
  private prevDetect: [boolean, boolean] = [false, false];
  private activePreset: PresetId | null = null;
  private presetDoneFired = false;
  private logRef: ReadonlyArray<LogEntry> | null = null;
  private logCursor = 0;
  private readonly onFrameBound = (): void => this.onFrame(this.now());

  constructor(
    private readonly sim: SimLike,
    private readonly ring: TelemetryRing,
    opts: RunnerOptions = {},
  ) {
    this.now = opts.now ?? ((): number => performance.now());
    this.raf = opts.raf ?? ((cb): number => requestAnimationFrame(cb));
    this.caf = opts.caf ?? ((id): void => cancelAnimationFrame(id));
    this.maxBatches = opts.maxBatchesPerFrame ?? 10;
    this.isHidden = opts.isHidden ?? defaultHidden;
    this.subscribeVisibility = opts.onVisibilityChange ?? defaultVisibility;
    this.perf = opts.perf ?? null;
  }

  get isPaused(): boolean {
    return this.paused;
  }
  get isRunning(): boolean {
    return this.running;
  }
  get currentSpeed(): 1 | 0.5 {
    return this.speed;
  }

  /** Begin the frame loop (idempotent). */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = this.now();
    this.acc = 0;
    this.unsubVisibility = this.subscribeVisibility(() => {
      this.last = this.now();
      this.perf?.skip();
    });
    this.schedule();
  }

  /** Stop the loop and detach listeners. */
  stop(): void {
    this.running = false;
    if (this.rafId !== null) this.caf(this.rafId);
    this.rafId = null;
    this.unsubVisibility?.();
    this.unsubVisibility = null;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.last = this.now(); // no catch-up for the time spent paused
    this.perf?.skip();
  }

  setSpeed(s: 1 | 0.5): void {
    if (s !== 1 && s !== 0.5) throw new Error(`unsupported speed ${String(s)}`);
    this.speed = s;
  }

  /**
   * Test-only multiplier on top of the 1x / 0.5x speed (E2E runs use `?testSpeed=4`). It is never set
   * by the UI; the per-frame cap of `maxBatchesPerFrame` still applies.
   */
  setTimeScale(k: number): void {
    if (!(k > 0 && k <= 8)) throw new Error(`unsupported time scale ${String(k)}`);
    this.timeScale = k;
  }

  /**
   * Queue a command, or a list of commands, for the sim. A list is applied in order at one
   * control-tick boundary. A `clearSchedule` cancels the active preset's remaining events, so
   * 'preset-done' is no longer reported for it.
   */
  send(cmd: SimCommand | readonly SimCommand[]): void {
    const list: readonly SimCommand[] = Array.isArray(cmd) ? (cmd as readonly SimCommand[]) : [cmd as SimCommand];
    for (const c of list) {
      if (c.type === 'loadPreset') {
        this.activePreset = c.id;
        this.presetDoneFired = false;
      } else if (c.type === 'reset' || c.type === 'clearSchedule') {
        this.activePreset = null;
      }
      this.sim.enqueue(c);
    }
  }

  on<K extends RunnerEvent>(ev: K, fn: RunnerEvents[K]): () => void {
    const list = this.handlers[ev] as Array<RunnerEvents[K]>;
    list.push(fn);
    return () => {
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    };
  }

  /**
   * Push a sample just returned by the sim's `stepControl()` into the ring, together with the
   * command-log entries applied since the previous call (they become the chart markers).
   */
  ingest(tel: Telemetry): void {
    const log = this.sim.commandLog?.();
    if (log === undefined) {
      this.ring.push(tel);
      return;
    }
    if (log !== this.logRef) {
      this.logRef = log; // a different Sim: its log starts empty
      this.logCursor = 0;
    }
    if (log.length > this.logCursor) {
      const fresh = log.slice(this.logCursor);
      this.logCursor = log.length;
      this.ring.push(tel, fresh);
    } else {
      this.ring.push(tel);
    }
  }

  private schedule(): void {
    this.rafId = this.raf(this.onFrameBound);
  }

  /** One animation frame at wall time `now` [ms]. Public for tests; normally rAF-driven. */
  onFrame(now: number): void {
    if (!this.running) return;
    this.rafId = null;
    try {
      this.frame(now);
    } finally {
      if (this.running) this.schedule();
    }
  }

  private frame(now: number): void {
    if (this.paused || this.isHidden()) {
      this.last = now;
      return;
    }
    const delta = Math.max(0, (now - this.last) / 1000);
    this.last = now;
    this.acc += Math.min(delta * this.speed * this.timeScale, this.maxBatches * DT);

    const perf = this.perf;
    const t0 = perf !== null ? this.now() : 0;
    let ticks = 0;
    while (this.acc >= DT - EPS && ticks < this.maxBatches) {
      const tel = this.sim.stepControl();
      this.ingest(tel);
      this.acc -= DT;
      ticks += 1;
      this.afterTick(tel);
    }
    if (this.acc < 0) this.acc = 0;
    perf?.add('sim', this.now() - t0);

    const latest = this.ring.latest();
    if (latest !== null) for (const fn of this.handlers.frame.slice()) fn(latest as Telemetry, { ticks });
    perf?.endFrame();
  }

  private afterTick(tel: Telemetry): void {
    for (let a = 0; a < 2; a++) {
      const on = tel.detect[a] as boolean;
      if (on && !this.prevDetect[a]) {
        for (const fn of this.handlers.detect.slice()) fn(a as Axis, tel.t);
      }
      this.prevDetect[a] = on;
    }
    const id = this.activePreset;
    if (id !== null && !this.presetDoneFired && tel.t >= loadPreset(id).durationS - EPS) {
      this.presetDoneFired = true;
      for (const fn of this.handlers['preset-done'].slice()) fn(id);
    }
  }
}
