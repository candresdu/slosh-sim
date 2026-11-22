// Regime switching on a running simulation (story mode): continuity, ramp shape, schedule
// cancellation, step on engage, command log ordering and replay of the story from the start.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadParams } from '../src/core/params';
import { PRESETS } from '../src/core/presets';
import { Sim, type SimCommand, type Telemetry } from '../src/core/sim';

const ROOT = resolve(__dirname, '../..');
const { params } = loadParams(JSON.parse(readFileSync(resolve(ROOT, 'shared/params/default.json'), 'utf8')));
const DT = 0.01;

interface Golden {
  n: number;
  columns: Record<string, number[]>;
}
const story = JSON.parse(readFileSync(resolve(ROOT, 'golden/story.json'), 'utf8')) as Golden;

function mk(): Sim {
  const sim = new Sim(params, params.sim.seed);
  sim.enqueue({ type: 'loadPreset', id: 'fig12' }); // Fig 12 start: theta 0.2, GS 1, AAC off
  return sim;
}

interface Row {
  tel: Telemetry;
  x: Float64Array;
}
function snap(sim: Sim): Row {
  const t = sim.stepControl();
  return {
    tel: {
      ...t,
      massRel: [...t.massRel],
      quadPos: [...t.quadPos],
      kT: [...t.kT],
      kTApplied: [...t.kTApplied],
      ySD: [...t.ySD],
      detect: [...t.detect],
      motorCmd: [...t.motorCmd],
      motorOmega: [...t.motorOmega],
    } as Telemetry,
    x: Float64Array.from(sim.state),
  };
}

function run(n: number, at?: { tick: number; cmds: SimCommand[] }): Row[] {
  const sim = mk();
  const rows: Row[] = [];
  for (let k = 0; k < n; k++) {
    if (at !== undefined && sim.tick === at.tick) for (const c of at.cmds) sim.enqueue(c);
    rows.push(snap(sim));
  }
  return rows;
}

const bitEq = (a: ArrayLike<number>, b: ArrayLike<number>): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
};

describe('(a) continuity', () => {
  const K = 300; // switch at tick 300 (3 s; the preset load at tick 0 is the first command)
  const N = 500;
  const cmds: SimCommand[] = [
    { type: 'rampGainShift', to: 2.3, durationS: 1.5 },
    { type: 'setAacMode', mode: 'monitor' },
  ];
  const base = run(N);
  const sw = run(N, { tick: K, cmds });

  it('is bit-identical to the unswitched run up to the switch tick', () => {
    for (let k = 0; k < K; k++) {
      expect(bitEq(sw[k]!.x, base[k]!.x), `state at row ${k}`).toBe(true);
      expect(sw[k]!.tel.gainShift).toBe(base[k]!.tel.gainShift);
    }
  });

  it('has no state jump at the switch (only gain shift / mode change)', () => {
    // Row K is the first tick that ran with the new commands. Compare its state increment with the
    // unswitched one: the plant state is continuous, the difference only appears through the (tiny)
    // first gain-shift step, so it must be far below one tick of natural motion.
    const dX = (a: Row, b: Row): number => {
      let m = 0;
      for (let i = 0; i < a.x.length; i++) m = Math.max(m, Math.abs((a.x[i] as number) - (b.x[i] as number)));
      return m;
    };
    const natural = dX(base[K]!, base[K - 1]!);
    expect(dX(sw[K]!, sw[K - 1]!)).toBeLessThan(2 * natural + 1e-9);
    expect(dX(sw[K]!, base[K]!)).toBeLessThan(1e-3);
    // Pendulum unit vector and rod rate keep their continuity exactly through the command tick.
    expect(Math.abs(sw[K]!.tel.theta - sw[K - 1]!.tel.theta)).toBeLessThan(0.01);
    // The command itself did take effect.
    expect(sw[K]!.tel.aacMode).toBe('monitor');
    expect(sw[K]!.tel.gainShift).toBeGreaterThan(1);
    expect(base[K]!.tel.aacMode).toBe('off');
  });
});

describe('(b) ramp shape', () => {
  it('is linear over round(durationS / 0.01) ticks, monotone, ends exactly on target', () => {
    const sim = mk();
    for (let k = 0; k < 50; k++) sim.stepControl();
    const gs0 = 1.0;
    const n = Math.round(1.5 / DT);
    sim.enqueue({ type: 'rampGainShift', to: 2.3, durationS: 1.5 });
    const g: number[] = [];
    for (let k = 0; k < n + 5; k++) g.push(sim.stepControl().gainShift);
    for (let k = 0; k < n; k++) {
      expect(Math.abs((g[k] as number) - (gs0 + (2.3 - gs0) * ((k + 1) / n)))).toBeLessThan(1e-12);
      if (k > 0) expect(g[k] as number).toBeGreaterThan(g[k - 1] as number);
    }
    expect(g[n - 1]).toBe(2.3);
    for (let k = n; k < g.length; k++) expect(g[k]).toBe(2.3);
  });

  it('ramps down monotonically too', () => {
    const sim = mk();
    sim.enqueue({ type: 'setGainShift', value: 2.0 });
    sim.stepControl();
    sim.enqueue({ type: 'rampGainShift', to: 1.0, durationS: 1.0 });
    const g: number[] = [];
    for (let k = 0; k < 105; k++) g.push(sim.stepControl().gainShift);
    for (let k = 1; k < 100; k++) expect(g[k] as number).toBeLessThan(g[k - 1] as number);
    expect(g[99]).toBe(1.0);
    expect(g[104]).toBe(1.0);
  });

  it('a mid-ramp rampGainShift re-targets from the current value, linear, ending exactly on target', () => {
    const sim = mk();
    sim.enqueue({ type: 'rampGainShift', to: 2.3, durationS: 1.5 });
    for (let k = 0; k < 60; k++) sim.stepControl(); // 60 of 150 steps done
    const gMid = sim.stepControl().gainShift; // 61 of 150
    expect(gMid).toBeCloseTo(1 + 1.3 * (61 / 150), 12);
    sim.enqueue({ type: 'rampGainShift', to: 1.5, durationS: 1.0 }); // n = 100
    const g: number[] = [];
    for (let k = 0; k < 105; k++) g.push(sim.stepControl().gainShift);
    for (let k = 0; k < 100; k++) {
      expect(Math.abs((g[k] as number) - (gMid + (1.5 - gMid) * ((k + 1) / 100)))).toBeLessThan(1e-12);
      if (k > 0) expect(g[k] as number).toBeLessThan(g[k - 1] as number);
    }
    expect(g[99]).toBe(1.5);
    expect(g[104]).toBe(1.5);
  });
});

describe('(c) schedule', () => {
  it('clearSchedule after loadPreset(story) in the same tick leaves no scheduled events', () => {
    const sim = new Sim(params, params.sim.seed);
    sim.enqueue({ type: 'loadPreset', id: 'story' });
    sim.enqueue({ type: 'clearSchedule' });
    for (let k = 0; k < 2400; k++) sim.stepControl(); // past the engage event (t = 22 s)
    const kinds = sim.commandLog().map(([, c]) => c.type);
    expect(kinds).toEqual(['loadPreset', 'clearSchedule']);
    const tel = sim.stepControl();
    expect(tel.gainShift).toBe(1);
    expect(tel.aacMode).toBe('off');
  });

  it('clearSchedule mid-story cancels the remaining events without changing the state', () => {
    const ev = PRESETS.story.events;
    expect(ev.length).toBeGreaterThanOrEqual(3);
    const tShift = ev[0]!.t;
    const A = new Sim(params, params.sim.seed);
    const B = new Sim(params, params.sim.seed);
    for (const s of [A, B]) s.enqueue({ type: 'loadPreset', id: 'story' });
    const nPre = Math.round(tShift / DT) - 100; // 1 s before the shift
    for (let k = 0; k < nPre; k++) {
      A.stepControl();
      B.stepControl();
    }
    B.enqueue({ type: 'clearSchedule' });
    // The clear tick itself leaves the plant on the same trajectory.
    A.stepControl();
    B.stepControl();
    expect(bitEq(A.state, B.state)).toBe(true);
    let tA!: Telemetry;
    let tB!: Telemetry;
    for (let k = 0; k < 3000; k++) {
      tA = A.stepControl();
      tB = B.stepControl();
    }
    // A got the scheduled shift and engage, B stayed in the regime it was in.
    expect(tA.aacMode).toBe('engaged');
    expect(tA.gainShift).toBe(2.3);
    expect(tB.aacMode).toBe('off');
    expect(tB.gainShift).toBe(1);
    expect(B.commandLog().map(([, c]) => c.type)).toEqual(['loadPreset', 'clearSchedule']);
  });

  it('keeps a gain-shift ramp already running when the schedule is cleared', () => {
    const sim = new Sim(params, params.sim.seed);
    sim.enqueue({ type: 'loadPreset', id: 'story' });
    const nShift = Math.round(PRESETS.story.events[0]!.t / DT);
    for (let k = 0; k < nShift + 1; k++) sim.stepControl(); // ramp command applied on the last tick
    const g1 = sim.stepControl().gainShift;
    expect(g1).toBeGreaterThan(1);
    sim.enqueue({ type: 'clearSchedule' });
    let g = g1;
    for (let k = 0; k < 200; k++) g = sim.stepControl().gainShift;
    expect(g).toBe(2.3);
  });
});

describe('(d) step on engage (no ramp)', () => {
  it('kTApplied equals kT on the next tick after setAacMode engaged', () => {
    const sim = new Sim(params, params.sim.seed);
    sim.enqueue({ type: 'loadPreset', id: 'fig13' }); // GS 2.3, Monitor
    let tel!: Telemetry;
    for (let k = 0; k < 3000; k++) {
      tel = sim.stepControl();
      expect(tel.kTApplied).toEqual([1, 1]); // monitor: computed, not applied
    }
    expect(Math.min(tel.kT[0], tel.kT[1])).toBeLessThan(0.9);
    sim.enqueue({ type: 'setAacMode', mode: 'engaged' });
    tel = sim.stepControl();
    expect(tel.aacMode).toBe('engaged');
    expect(tel.kTApplied[0]).toBe(tel.kT[0]);
    expect(tel.kTApplied[1]).toBe(tel.kT[1]);
    expect(tel.kTApplied[0]).toBeLessThan(0.9);
  });
});

describe('(e) command log', () => {
  it('holds regime commands at the expected ticks, in enqueue order within a tick', () => {
    const sim = mk();
    for (let k = 0; k < 120; k++) sim.stepControl();
    const t0 = sim.tick;
    sim.enqueue({ type: 'setAacMode', mode: 'monitor' });
    sim.enqueue({ type: 'rampGainShift', to: 2.3, durationS: 1.5 });
    sim.enqueue({ type: 'setAacMode', mode: 'engaged' });
    for (let k = 0; k < 30; k++) sim.stepControl();
    const t1 = sim.tick;
    sim.enqueue({ type: 'clearSchedule' });
    sim.stepControl();
    const log = sim.commandLog();
    expect(log.map(([k, c]) => [k, c.type])).toEqual([
      [0, 'loadPreset'],
      [t0, 'setAacMode'],
      [t0, 'rampGainShift'],
      [t0, 'setAacMode'],
      [t1, 'clearSchedule'],
    ]);
    expect((log[1]![1] as { mode: string }).mode).toBe('monitor');
    expect((log[3]![1] as { mode: string }).mode).toBe('engaged'); // last one wins
  });

  it('applies same-tick commands in enqueue order (last mode wins)', () => {
    const sim = mk();
    sim.enqueue({ type: 'setAacMode', mode: 'engaged' });
    sim.enqueue({ type: 'setAacMode', mode: 'off' });
    expect(sim.stepControl().aacMode).toBe('off');
    sim.enqueue({ type: 'setAacMode', mode: 'off' });
    sim.enqueue({ type: 'setAacMode', mode: 'monitor' });
    expect(sim.stepControl().aacMode).toBe('monitor');
  });
});

describe('(f) replay from the start (loadPreset story mid-run)', () => {
  it('reproduces golden/story.json from t = 0 after an arbitrary mid-run history', () => {
    const sim = mk();
    for (let k = 0; k < 377; k++) sim.stepControl();
    sim.enqueue({ type: 'rampGainShift', to: 2.8, durationS: 1.5 });
    sim.enqueue({ type: 'setAacMode', mode: 'engaged' });
    for (let k = 0; k < 200; k++) sim.stepControl();
    sim.enqueue({ type: 'kick' });
    for (let k = 0; k < 53; k++) sim.stepControl();
    sim.enqueue({ type: 'loadPreset', id: 'story' });
    const n = 1500; // 15 s: covers shift (8 s) and trip
    const col = (k: string): number[] => story.columns[k] as number[];
    let worst = 0;
    for (let k = 1; k <= n; k++) {
      const t = sim.stepControl();
      expect(t.t).toBeCloseTo(k * DT, 9);
      worst = Math.max(
        worst,
        Math.abs(t.theta - (col('theta')[k] as number)),
        Math.abs(t.roll - (col('roll')[k] as number)),
        Math.abs(t.pitch - (col('pitch')[k] as number)),
        Math.abs(t.ySD[0] - (col('ySD_pitch')[k] as number)),
        Math.abs(t.kT[0] - (col('kT_pitch')[k] as number)),
        Math.abs(t.motorCmd[0] - (col('m1')[k] as number)),
      );
    }
    expect(worst).toBeLessThan(1e-9);
  });

  it('is bit-identical to a fresh story run (same ticks since load)', () => {
    const fresh = new Sim(params, params.sim.seed);
    fresh.enqueue({ type: 'loadPreset', id: 'story' });
    const replay = mk();
    for (let k = 0; k < 431; k++) replay.stepControl();
    replay.enqueue({ type: 'loadPreset', id: 'story' });
    for (let k = 0; k < 1200; k++) {
      const a = fresh.stepControl();
      const b = replay.stepControl();
      expect(Object.is(a.theta, b.theta), `theta @${k}`).toBe(true);
      expect(Object.is(a.kT[0], b.kT[0]), `kT @${k}`).toBe(true);
    }
  });
});
