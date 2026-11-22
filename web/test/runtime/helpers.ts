import type { SimCommand, Telemetry } from '../../src/core/sim';
import type { SimLike } from '../../src/runtime/runner';

export function makeTel(t: number, over: Partial<Telemetry> = {}): Telemetry {
  return {
    t,
    theta: 0.1,
    phi: 0,
    massRel: [0, 0, 1],
    quadPos: [0, 0, 0],
    roll: 0,
    pitch: 0,
    yaw: 0,
    kT: [1, 1],
    kTApplied: [1, 1],
    ySD: [0, 0],
    detect: [false, false],
    gainShift: 1,
    aacMode: 'off',
    motorCmd: [0.5, 0.5, 0.5, 0.5],
    motorOmega: [0, 0, 0, 0],
    ...over,
  };
}

/** Fake sim: counts ticks, optional detector script by tick index, reuses one telemetry object. */
export class FakeSim implements SimLike {
  ticks = 0;
  commands: SimCommand[] = [];
  private tel = makeTel(0);
  constructor(private readonly detect: (tick: number) => [boolean, boolean] = () => [false, false]) {}
  get t(): number {
    return this.ticks * 0.01;
  }
  enqueue(cmd: SimCommand): void {
    this.commands.push(cmd);
    if (cmd.type === 'reset' || cmd.type === 'loadPreset') this.ticks = -1; // next tick -> t = 0.00 +1 tick
  }
  stepControl() {
    this.ticks += 1;
    this.tel.t = this.ticks * 0.01;
    this.tel.detect = this.detect(this.ticks);
    return this.tel;
  }
}

export class FakeClock {
  ms = 0;
  cb: ((t: number) => void) | null = null;
  now = (): number => this.ms;
  raf = (cb: (t: number) => void): number => {
    this.cb = cb;
    return 1;
  };
  caf = (): void => {
    this.cb = null;
  };
  /** Advance wall time by dtMs and run the pending rAF callback. */
  frame(dtMs: number): void {
    this.ms += dtMs;
    const cb = this.cb;
    this.cb = null;
    cb?.(this.ms);
  }
}
