import { describe, expect, it } from 'vitest';
import { loadParams } from '../../src/core/params';
import { PRESETS, PRESET_IDS } from '../../src/core/presets';
import { Sim, type SimCommand, type Telemetry } from '../../src/core/sim';

// a0, b_s and threshold are still null in the parameter file; any finite values do for these tests.
const AAC = { a0: 0.2, b_s: 5.0, threshold: 0.02 };

function make(seed?: number): Sim {
  return new Sim(loadParams().params, seed, AAC);
}

/** Flatten the telemetry of one tick into numbers (copy: the Telemetry object is reused). */
function flat(t: Telemetry, out: number[]): void {
  out.push(
    t.t, t.theta, t.phi, ...t.massRel, ...t.quadPos, t.roll, t.pitch, t.yaw,
    ...t.kT, ...t.kTApplied, ...t.ySD, t.detect[0] ? 1 : 0, t.detect[1] ? 1 : 0,
    t.gainShift, ...t.motorCmd, ...t.motorOmega,
  );
}

function run(sim: Sim, seconds: number): Float64Array {
  const n = Math.round(seconds / 0.01);
  const out: number[] = [];
  for (let i = 0; i < n; i++) flat(sim.stepControl(), out);
  return Float64Array.from(out);
}

describe('presets', () => {
  it('loads all four presets with sorted events', () => {
    for (const id of PRESET_IDS) {
      const p = PRESETS[id];
      expect(p.id).toBe(id);
      const ts = p.events.map((e) => e.t);
      expect(ts).toEqual([...ts].sort((a, b) => a - b));
    }
    expect(PRESETS.vb.events.map((e) => e.type)).toEqual(['rampGainShift', 'setAacMode']);
  });
});

describe('Sim', () => {
  it('advances exactly 10 ms per stepControl and keeps tick', () => {
    const s = make();
    expect(s.tick).toBe(0);
    const t = s.stepControl();
    expect(s.tick).toBe(1);
    expect(t.t).toBeCloseTo(0.01, 12);
    expect(s.state.length).toBe(23);
  });

  it('reuses the telemetry object', () => {
    const s = make();
    expect(s.stepControl()).toBe(s.stepControl());
  });

  it('is deterministic: two fig13 runs of 30 s are bit-identical', () => {
    const go = (): Float64Array => {
      const s = make(1);
      s.enqueue({ type: 'loadPreset', id: 'fig13' });
      return run(s, 30);
    };
    const a = go();
    const b = go();
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      if (!Object.is(a[i], b[i])) throw new Error(`mismatch at ${i}: ${a[i]} vs ${b[i]}`);
    }
  });

  it('logs a command enqueued between ticks with the next tick index and applies it then', () => {
    const s = make();
    run(s, 0.05); // 5 ticks
    expect(s.tick).toBe(5);
    s.enqueue({ type: 'setGainShift', value: 2.5 });
    expect(s.commandLog().length).toBe(0); // not yet applied
    const t = s.stepControl();
    expect(s.commandLog()).toEqual([[5, { type: 'setGainShift', value: 2.5 }]]);
    expect(t.gainShift).toBe(2.5);
  });

  it('clamps gain shift to 0.5..3.0', () => {
    const s = make();
    s.enqueue({ type: 'setGainShift', value: 9 });
    expect(s.stepControl().gainShift).toBe(3.0);
    s.enqueue({ type: 'setGainShift', value: -1 });
    expect(s.stepControl().gainShift).toBe(0.5);
  });

  it('ramps gain shift 1 -> 2 over 20 s: 1.5 at t = 10 s, 2 at 20 s', () => {
    const s = make();
    s.enqueue({ type: 'rampGainShift', to: 2, durationS: 20 });
    let t = s.stepControl();
    for (let i = 1; i < 1000; i++) t = s.stepControl();
    expect(t.t).toBeCloseTo(10, 9);
    expect(Math.abs(t.gainShift - 1.5)).toBeLessThan(0.005);
    for (let i = 0; i < 1000; i++) t = s.stepControl();
    expect(t.gainShift).toBe(2);
  });

  it('setGainShift cancels a ramp', () => {
    const s = make();
    s.enqueue({ type: 'rampGainShift', to: 2, durationS: 20 });
    run(s, 1);
    s.enqueue({ type: 'setGainShift', value: 1.2 });
    run(s, 1);
    expect(s.stepControl().gainShift).toBe(1.2);
  });

  it('kick sets theta = 0.2 and phiDot = 0.6 by default', () => {
    const s = make();
    s.enqueue({ type: 'kick' });
    const t = s.stepControl();
    expect(t.theta).toBeCloseTo(0.2, 2);
    s.enqueue({ type: 'kick', theta: 0.1, phiDot: 0 });
    const t2 = s.stepControl();
    expect(t2.theta).toBeCloseTo(0.1, 2);
  });

  it('rejects unknown commands and modes', () => {
    const s = make();
    expect(() => s.enqueue({ type: 'nope' } as unknown as SimCommand)).toThrow();
    expect(() => s.enqueue({ type: 'setAacMode', mode: 'x' } as unknown as SimCommand)).toThrow();
  });

  it('loadPreset sets initial state; t restarts, tick does not', () => {
    const s = make();
    run(s, 0.5);
    s.enqueue({ type: 'loadPreset', id: 'fig14' });
    const t = s.stepControl();
    expect(s.tick).toBe(51);
    expect(t.t).toBeCloseTo(0.01, 12);
    expect(t.gainShift).toBe(2.3);
    expect(t.aacMode).toBe('engaged');
    expect(s.commandLog()[0]).toEqual([50, { type: 'loadPreset', id: 'fig14' }]);
  });

  it('reset restores the active preset', () => {
    const a = make();
    a.enqueue({ type: 'loadPreset', id: 'fig13' });
    const ref = run(a, 1);
    const b = make();
    b.enqueue({ type: 'loadPreset', id: 'fig13' });
    run(b, 2);
    b.enqueue({ type: 'reset' });
    const again = run(b, 1);
    // t differs (origin moves) but every other value must repeat; t is column 0 of each sample
    const w = ref.length / 100;
    for (let k = 0; k < 100; k++) {
      for (let c = 1; c < w; c++) {
        expect(Object.is(again[k * w + c], ref[k * w + c])).toBe(true);
      }
    }
  });

  it('vb schedules its events through the queue (logged)', () => {
    const s = make();
    s.enqueue({ type: 'loadPreset', id: 'vb' });
    run(s, 101);
    const log = s.commandLog();
    expect(log.map(([, c]) => c.type)).toEqual(['loadPreset', 'rampGainShift', 'setAacMode']);
    expect(log[1]?.[0]).toBe(0);
    expect(log[2]?.[0]).toBe(10000);
    expect(s.stepControl().aacMode).toBe('engaged');
  });

  it('runs vb for 130 s of sim time in < 5 s wall time', () => {
    const s = make();
    s.enqueue({ type: 'loadPreset', id: 'vb' });
    const t0 = performance.now();
    let last: Telemetry = s.stepControl();
    for (let i = 1; i < 13000; i++) last = s.stepControl();
    const wall = (performance.now() - t0) / 1000;
    expect(last.t).toBeCloseTo(130, 6);
    expect(Number.isFinite(last.theta)).toBe(true);
    expect(wall).toBeLessThan(5);
  });
});
