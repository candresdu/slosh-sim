import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS } from '../../src/core/params';
import { Sim } from '../../src/core/sim';
import { Perf, perfEnabled } from '../../src/runtime/perf';
import { Runner } from '../../src/runtime/runner';
import { TelemetryRing } from '../../src/runtime/telemetry-ring';
import { FakeClock, FakeSim } from './helpers';

function setup(opts: { hidden?: () => boolean; sim?: FakeSim; max?: number } = {}) {
  const clock = new FakeClock();
  const sim = opts.sim ?? new FakeSim();
  const ring = new TelemetryRing();
  const runner = new Runner(sim, ring, {
    now: clock.now,
    raf: clock.raf,
    caf: clock.caf,
    isHidden: opts.hidden ?? (() => false),
    onVisibilityChange: () => () => undefined,
    maxBatchesPerFrame: opts.max,
  });
  return { clock, sim, ring, runner };
}

describe('Runner timing', () => {
  it('tracks wall time at 1x', () => {
    const { clock, sim, runner } = setup();
    runner.start();
    for (let i = 0; i < 600; i++) clock.frame(10);
    expect(sim.t).toBeCloseTo(6.0, 9);
  });

  it('carries fractional frames (16.7 ms frames)', () => {
    const { clock, sim, runner } = setup();
    runner.start();
    for (let i = 0; i < 600; i++) clock.frame(1000 / 60);
    expect(sim.ticks).toBe(1000);
  });

  it('caps catch-up: a 2 s stall advances exactly 0.100 s (10 batches)', () => {
    const { clock, sim, runner } = setup();
    runner.start();
    clock.frame(2000);
    expect(sim.ticks).toBe(10);
    expect(sim.t).toBeCloseTo(0.1, 12);
    clock.frame(10); // the excess was dropped, not queued
    expect(sim.ticks).toBe(11);
  });

  it('never exceeds the batch cap even with a fractional leftover', () => {
    const { clock, sim, runner } = setup({ max: 10 });
    runner.start();
    clock.frame(19); // 1 tick, 0.009 left
    const before = sim.ticks;
    clock.frame(5000);
    expect(sim.ticks - before).toBeLessThanOrEqual(10);
  });

  it('honours a custom maxBatchesPerFrame', () => {
    const { clock, sim, runner } = setup({ max: 3 });
    runner.start();
    clock.frame(1000);
    expect(sim.ticks).toBe(3);
  });

  it('does not advance while the tab is hidden and does not jump on return', () => {
    let hidden = false;
    const { clock, sim, runner } = setup({ hidden: () => hidden });
    runner.start();
    for (let i = 0; i < 10; i++) clock.frame(10);
    expect(sim.ticks).toBe(10);
    hidden = true;
    for (let i = 0; i < 500; i++) clock.frame(10); // 5 s hidden
    expect(sim.ticks).toBe(10);
    hidden = false;
    clock.frame(10);
    expect(sim.ticks).toBe(11); // only the normal 10 ms, no 5 s catch-up
    clock.frame(10);
    expect(sim.ticks).toBe(12);
  });

  it('resets its clock on visibilitychange', () => {
    const clock = new FakeClock();
    const sim = new FakeSim();
    let fire: () => void = () => undefined;
    const runner = new Runner(sim, new TelemetryRing(), {
      now: clock.now,
      raf: clock.raf,
      caf: clock.caf,
      isHidden: () => false,
      onVisibilityChange: (cb) => {
        fire = cb;
        return () => undefined;
      },
    });
    runner.start();
    clock.ms += 5000; // rAF was throttled without our callback running
    fire();
    clock.frame(10);
    expect(sim.ticks).toBe(1);
  });

  it('speed 0.5: 1000 frames of 10 ms advance 5.00 ± 0.01 s', () => {
    const { clock, sim, runner } = setup();
    runner.setSpeed(0.5);
    runner.start();
    for (let i = 0; i < 1000; i++) clock.frame(10);
    expect(Math.abs(sim.t - 5.0)).toBeLessThanOrEqual(0.01);
    expect(sim.ticks).toBe(500);
  });

  it('test-only time scale multiplies the speed and is validated', () => {
    const { clock, sim, runner } = setup();
    runner.setTimeScale(4);
    runner.start();
    for (let i = 0; i < 100; i++) clock.frame(10);
    expect(sim.t).toBeCloseTo(4.0, 9);
    expect(() => runner.setTimeScale(0)).toThrow();
    expect(() => runner.setTimeScale(100)).toThrow();
  });

  it('pause freezes sim time and resume does not catch up', () => {
    const { clock, sim, runner } = setup();
    runner.start();
    for (let i = 0; i < 10; i++) clock.frame(10);
    runner.pause();
    for (let i = 0; i < 100; i++) clock.frame(10);
    expect(sim.ticks).toBe(10);
    runner.resume();
    clock.frame(10);
    expect(sim.ticks).toBe(11);
  });

  it('rejects unsupported speeds', () => {
    const { runner } = setup();
    expect(() => runner.setSpeed(2 as unknown as 1)).toThrow();
  });

  it('stop cancels the loop', () => {
    const { clock, sim, runner } = setup();
    runner.start();
    clock.frame(10);
    runner.stop();
    clock.frame(10);
    expect(sim.ticks).toBe(1);
  });

  it('runs the real Sim in real time', () => {
    const clock = new FakeClock();
    const sim = new Sim(DEFAULT_PARAMS.params, 1, { a0: 0.1, b_s: 1, b_e: 0, threshold: 1 });
    const ring = new TelemetryRing();
    const runner = new Runner(sim, ring, { now: clock.now, raf: clock.raf, isHidden: () => false, onVisibilityChange: () => () => undefined });
    runner.start();
    for (let i = 0; i < 100; i++) clock.frame(10);
    expect(sim.t).toBeCloseTo(1.0, 9);
    expect(ring.length).toBe(100);
    expect(ring.latest()?.t).toBeCloseTo(1.0, 9);
  });
});

describe('Runner events', () => {
  it("fires 'detect' once per rising edge with axis and t", () => {
    // pitch: ticks 20..40 and 100..110; roll: 60..70
    const sim = new FakeSim((k) => [(k >= 20 && k <= 40) || (k >= 100 && k <= 110), k >= 60 && k <= 70]);
    const { clock, runner } = setup({ sim });
    const got: Array<[number, number]> = [];
    runner.on('detect', (axis, t) => got.push([axis, t]));
    runner.start();
    for (let i = 0; i < 200; i++) clock.frame(10);
    expect(got.length).toBe(3);
    expect(got[0]).toEqual([0, 0.2]);
    expect(got[1]?.[0]).toBe(1);
    expect(got[1]?.[1]).toBeCloseTo(0.6, 12);
    expect(got[2]?.[0]).toBe(0);
    expect(got[2]?.[1]).toBeCloseTo(1.0, 12);
  });

  it('detect edges across frame boundaries and multi-tick frames are not duplicated', () => {
    const sim = new FakeSim((k) => [k >= 25, false]);
    const { clock, runner } = setup({ sim });
    let n = 0;
    runner.on('detect', () => n++);
    runner.start();
    for (let i = 0; i < 20; i++) clock.frame(33);
    expect(n).toBe(1);
  });

  it("emits 'frame' after the ticks with the latest telemetry", () => {
    const { clock, runner } = setup();
    const seen: Array<[number, number]> = [];
    runner.on('frame', (tel, info) => seen.push([tel.t, info.ticks]));
    runner.start();
    clock.frame(30);
    clock.frame(5);
    clock.frame(5);
    expect(seen.length).toBe(3);
    expect(seen[0]?.[0]).toBeCloseTo(0.03, 12);
    expect(seen[0]?.[1]).toBe(3);
    expect(seen[1]?.[1]).toBe(0);
    expect(seen[2]?.[1]).toBe(1);
  });

  it('does not emit frame while paused or hidden', () => {
    let hidden = false;
    const { clock, runner } = setup({ hidden: () => hidden });
    let n = 0;
    runner.on('frame', () => n++);
    runner.start();
    clock.frame(10);
    runner.pause();
    clock.frame(10);
    runner.resume();
    hidden = true;
    clock.frame(10);
    expect(n).toBe(1);
  });

  it('on() returns an unsubscribe function', () => {
    const { clock, runner } = setup();
    let n = 0;
    const off = runner.on('frame', () => n++);
    runner.start();
    clock.frame(10);
    off();
    clock.frame(10);
    expect(n).toBe(1);
  });

  it("fires 'preset-done' once when the preset duration is reached", () => {
    const { clock, runner } = setup();
    const done: string[] = [];
    runner.on('preset-done', (id) => done.push(id));
    runner.start();
    runner.send({ type: 'loadPreset', id: 'fig12' }); // 60 s
    for (let i = 0; i < 6100; i++) clock.frame(10);
    expect(done).toEqual(['fig12']);
  });

  it('send accepts a list (in order) and a clearSchedule cancels preset-done', () => {
    const { clock, runner, sim } = setup();
    const done: string[] = [];
    runner.on('preset-done', (id) => done.push(id));
    runner.start();
    runner.send([{ type: 'loadPreset', id: 'story' }, { type: 'clearSchedule' }]); // Restart
    expect(sim.commands.map((c) => c.type)).toEqual(['loadPreset', 'clearSchedule']);
    for (let i = 0; i < 5300; i++) clock.frame(10);
    expect(done).toEqual([]);
  });

  it('send forwards commands to the sim', () => {
    const { runner, sim } = setup();
    runner.send({ type: 'kick' });
    runner.send({ type: 'setGainShift', value: 2 });
    expect(sim.commands.map((c) => c.type)).toEqual(['kick', 'setGainShift']);
  });

  it('clears the ring when a reset restarts sim time', () => {
    const { clock, runner, ring } = setup();
    runner.start();
    for (let i = 0; i < 50; i++) clock.frame(10);
    runner.send({ type: 'reset' });
    clock.frame(10);
    expect(ring.length).toBe(1);
  });
});

describe('Perf', () => {
  it('is enabled only by ?perf=1', () => {
    expect(perfEnabled('?perf=1')).toBe(true);
    expect(perfEnabled('?a=1&perf=1')).toBe(true);
    expect(perfEnabled('?perf=0')).toBe(false);
    expect(perfEnabled('')).toBe(false);
    expect(Perf.fromLocation()).toBeNull(); // no location in node
  });

  it('logs frame percentiles and the sim/scene/charts split every 10 s', () => {
    const clock = new FakeClock();
    const lines: string[] = [];
    const perf = new Perf({ now: clock.now, log: (l) => lines.push(l) });
    const sim = new FakeSim();
    const runner = new Runner(sim, new TelemetryRing(), {
      now: clock.now,
      raf: clock.raf,
      isHidden: () => false,
      onVisibilityChange: () => () => undefined,
      perf,
    });
    runner.on('frame', () => {
      perf.add('scene', 2);
      perf.add('charts', 1);
    });
    runner.start();
    for (let i = 0; i < 1100; i++) clock.frame(10); // 11 s
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/p50\/p95\/p99 10\.00\/10\.00\/10\.00/);
    expect(lines[0]).toMatch(/scene 2\.00\/2\.00\/2\.00/);
    expect(lines[0]).toMatch(/charts 1\.00\/1\.00\/1\.00/);
    expect(lines[0]).toMatch(/sim /);
  });
});
