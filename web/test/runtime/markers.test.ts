import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS } from '../../src/core/params';
import { Sim, type SimCommand } from '../../src/core/sim';
import { Runner } from '../../src/runtime/runner';
import { TelemetryRing, regimeOf, type LogEntry } from '../../src/runtime/telemetry-ring';
import { FakeClock, makeTel } from './helpers';

const cmd = (tick: number, c: SimCommand): LogEntry => [tick, c];

describe('TelemetryRing markers', () => {
  it('labels and times each command kind (time = the sample the command shows up in)', () => {
    const r = new TelemetryRing();
    r.push(makeTel(0.01));
    r.push(makeTel(0.02), [cmd(1, { type: 'setGainShift', value: 2.3 })]);
    r.push(makeTel(0.03), [cmd(2, { type: 'rampGainShift', to: 2, durationS: 1.5 })]);
    r.push(makeTel(0.04), [cmd(3, { type: 'setAacMode', mode: 'monitor' })]);
    r.push(makeTel(0.05), [cmd(4, { type: 'setAacMode', mode: 'engaged' })]);
    r.push(makeTel(0.06), [cmd(5, { type: 'setAacMode', mode: 'off' })]);
    r.push(makeTel(0.07), [cmd(6, { type: 'kick' })]);
    expect(r.markers()).toEqual([
      { t: 0.02, kind: 'gainShift', label: 'Gain shift → 2.3' },
      { t: 0.03, kind: 'gainShift', label: 'Gain shift → 2' },
      { t: 0.04, kind: 'aacMode', label: 'AAC monitoring' },
      { t: 0.05, kind: 'aacMode', label: 'AAC engaged' },
      { t: 0.06, kind: 'aacMode', label: 'AAC off' },
      { t: 0.07, kind: 'kick', label: 'Disturbance' },
    ]);
  });

  it('several commands in one tick give several markers; clearSchedule gives none', () => {
    const r = new TelemetryRing();
    r.push(makeTel(0.01), [
      cmd(0, { type: 'clearSchedule' }),
      cmd(0, { type: 'setAacMode', mode: 'engaged' }),
      cmd(0, { type: 'kick' }),
    ]);
    expect(r.markers().map((m) => m.label)).toEqual(['AAC engaged', 'Disturbance']);
    r.push(makeTel(0.02), [cmd(1, { type: 'clearSchedule' })]);
    expect(r.markers()).toHaveLength(2);
  });

  it('reset and loadPreset produce no marker and clear the ring, markers and bands', () => {
    for (const c of [{ type: 'reset' }, { type: 'loadPreset', id: 'fig13' }] as SimCommand[]) {
      const r = new TelemetryRing();
      for (let i = 1; i <= 50; i++) r.push(makeTel(i * 0.01, { aacMode: 'engaged' }), i === 10 ? [cmd(9, { type: 'kick' })] : []);
      expect(r.markers()).toHaveLength(1);
      expect(r.bands()).toHaveLength(1);
      // the sample right after a reset can even have a later time than the old data: still a new run
      r.push(makeTel(0.51), [cmd(50, c)]);
      expect(r.markers()).toEqual([]);
      expect(r.length).toBe(1);
      expect(r.bands()).toEqual([{ t0: 0.51, t1: 0.51, regime: 'nominal' }]);
    }
  });

  it('keeps markers of commands that follow a loadPreset in the same tick (preset events at t = 0)', () => {
    const r = new TelemetryRing();
    r.push(makeTel(5));
    r.push(makeTel(0.01, { aacMode: 'monitor' }), [
      cmd(500, { type: 'loadPreset', id: 'vb' }),
      cmd(500, { type: 'rampGainShift', to: 2, durationS: 20 }),
    ]);
    expect(r.markers()).toEqual([{ t: 0.01, kind: 'gainShift', label: 'Gain shift → 2' }]);
    expect(r.length).toBe(1);
  });

  it('also clears when time goes backwards without a command (direct push)', () => {
    const r = new TelemetryRing();
    r.push(makeTel(1), [cmd(0, { type: 'kick' })]);
    r.push(makeTel(0.5));
    expect(r.markers()).toEqual([]);
  });

  it('trip markers come from rising edges only, with the axis', () => {
    const r = new TelemetryRing();
    const d = (a: boolean, b: boolean) => ({ detect: [a, b] as [boolean, boolean], aacMode: 'monitor' as const });
    r.push(makeTel(0.01, d(false, false)));
    r.push(makeTel(0.02, d(true, false)));
    r.push(makeTel(0.03, d(true, false))); // latched, no new edge
    r.push(makeTel(0.04, d(true, true)));
    r.push(makeTel(0.05, d(false, true)));
    r.push(makeTel(0.06, d(true, true))); // pitch re-trips
    expect(r.markers()).toEqual([
      { t: 0.02, kind: 'trip', label: 'Detector tripped (pitch)', axis: 0 },
      { t: 0.04, kind: 'trip', label: 'Detector tripped (roll)', axis: 1 },
      { t: 0.06, kind: 'trip', label: 'Detector tripped (pitch)', axis: 0 },
    ]);
  });

  it('has no trip markers in Off mode', () => {
    const r = new TelemetryRing();
    r.push(makeTel(0.01, { aacMode: 'off', detect: [false, false] }));
    r.push(makeTel(0.02, { aacMode: 'off', detect: [true, true] }));
    expect(r.markers()).toEqual([]);
  });

  it('evicts markers older than the 30 s window', () => {
    const r = new TelemetryRing();
    r.push(makeTel(0.01), [cmd(0, { type: 'kick' })]);
    r.push(makeTel(10), [cmd(0, { type: 'setAacMode', mode: 'monitor' })]);
    for (let i = 1; i <= 3000; i++) r.push(makeTel(10 + i * 0.01, { aacMode: 'monitor' }));
    // oldest sample is now t = 10.01 + ... : the kick is gone, the monitor marker at t = 10 too
    expect(r.view('t')[0]).toBeCloseTo(10.01, 9);
    expect(r.markers()).toEqual([]);
    r.push(makeTel(40.02), [cmd(0, { type: 'kick' })]);
    for (let i = 1; i <= 2999; i++) r.push(makeTel(40.02 + i * 0.01));
    expect(r.markers().map((m) => m.t)).toEqual([40.02]); // exactly at the window start: kept
    r.push(makeTel(70.02));
    expect(r.markers()).toEqual([]);
  });

  it('returns copies', () => {
    const r = new TelemetryRing();
    r.push(makeTel(0.01), [cmd(0, { type: 'kick' })]);
    r.markers()[0]!.label = 'x';
    r.bands()[0]!.regime = 'engaged';
    expect(r.markers()[0]!.label).toBe('Disturbance');
    expect(r.bands()[0]!.regime).toBe('nominal');
  });
});

describe('TelemetryRing bands', () => {
  it('regimeOf: engaged > gainShift (GS > 1 or monitor) > nominal', () => {
    expect(regimeOf({ aacMode: 'engaged', gainShift: 1 })).toBe('engaged');
    expect(regimeOf({ aacMode: 'engaged', gainShift: 2.3 })).toBe('engaged');
    expect(regimeOf({ aacMode: 'monitor', gainShift: 1 })).toBe('gainShift');
    expect(regimeOf({ aacMode: 'off', gainShift: 2.3 })).toBe('gainShift');
    expect(regimeOf({ aacMode: 'off', gainShift: 1 + 1e-10 })).toBe('nominal');
    expect(regimeOf({ aacMode: 'off', gainShift: 0.5 })).toBe('nominal');
  });

  it('merges equal consecutive samples and makes adjacent bands touch', () => {
    const r = new TelemetryRing();
    for (let i = 1; i <= 100; i++) r.push(makeTel(i * 0.01));
    for (let i = 101; i <= 250; i++) r.push(makeTel(i * 0.01, { gainShift: 2.3 }));
    for (let i = 251; i <= 300; i++) r.push(makeTel(i * 0.01, { gainShift: 2.3, aacMode: 'engaged' }));
    const b = r.bands();
    expect(b.map((x) => x.regime)).toEqual(['nominal', 'gainShift', 'engaged']);
    expect(b[0]!.t0).toBeCloseTo(0.01, 12);
    expect(b[0]!.t1).toBeCloseTo(1.01, 12);
    expect(b[1]!.t0).toBe(b[0]!.t1);
    expect(b[1]!.t1).toBeCloseTo(2.51, 12);
    expect(b[2]!.t0).toBe(b[1]!.t1);
    expect(b[2]!.t1).toBeCloseTo(3.0, 12);
  });

  it('is empty before any sample', () => {
    expect(new TelemetryRing().bands()).toEqual([]);
  });

  it('evicts bands with the window and clips the oldest to the window start', () => {
    const r = new TelemetryRing();
    for (let i = 1; i <= 500; i++) r.push(makeTel(i * 0.01)); // nominal 0..5 s
    for (let i = 501; i <= 3400; i++) r.push(makeTel(i * 0.01, { aacMode: 'monitor' }));
    let b = r.bands();
    expect(b.map((x) => x.regime)).toEqual(['nominal', 'gainShift']);
    expect(b[0]!.t0).toBeCloseTo(4.01, 9); // window start = oldest sample (t = 4.01)
    for (let i = 3401; i <= 3600; i++) r.push(makeTel(i * 0.01, { aacMode: 'monitor' }));
    b = r.bands();
    expect(b.map((x) => x.regime)).toEqual(['gainShift']); // nominal band ended at 5.01 < window start 6.01
    expect(b[0]!.t0).toBeCloseTo(6.01, 9);
  });

  it('segments the vb preset: gainShift (monitor, GS ramping) then engaged at t = 100 s', () => {
    const sim = new Sim(DEFAULT_PARAMS.params, 1);
    const ring = new TelemetryRing();
    let cursor = 0;
    sim.enqueue({ type: 'loadPreset', id: 'vb' });
    for (let i = 0; i < 10500; i++) {
      const tel = sim.stepControl();
      const log = sim.commandLog();
      ring.push(tel, log.slice(cursor));
      cursor = log.length;
    }
    const b = ring.bands();
    expect(b.map((x) => x.regime)).toEqual(['gainShift', 'engaged']);
    expect(b[0]!.t1).toBeCloseTo(100.01, 6); // engaged from the sample at which the command took effect
    expect(b[1]!.t1).toBeCloseTo(105, 6);
    // the t = 0 ramp / monitor markers are out of the 30 s window by now; the engage marker is in
    const marks = ring.markers();
    expect(marks.map((m) => m.label)).toEqual(['AAC engaged']);
    expect(marks[0]!.t).toBeCloseTo(100.01, 6);
  });

  it('clear() empties bands and markers', () => {
    const r = new TelemetryRing();
    r.push(makeTel(0.01, { aacMode: 'engaged' }), [cmd(0, { type: 'kick' })]);
    r.clear();
    expect(r.bands()).toEqual([]);
    expect(r.markers()).toEqual([]);
  });
});

describe('Runner passes new command-log entries to the ring', () => {
  it('story-like run: gain shift, monitor, engaged, kick and a trip show up once each', () => {
    const clock = new FakeClock();
    const sim = new Sim(DEFAULT_PARAMS.params, 1);
    const ring = new TelemetryRing();
    const runner = new Runner(sim, ring, {
      now: clock.now,
      raf: clock.raf,
      caf: clock.caf,
      isHidden: () => false,
      onVisibilityChange: () => () => undefined,
    });
    runner.send({ type: 'loadPreset', id: 'fig12' });
    runner.start();
    const run = (s: number): void => {
      for (let i = 0; i < s * 100; i++) clock.frame(10);
    };
    run(2);
    runner.send({ type: 'rampGainShift', to: 2.3, durationS: 1.5 });
    runner.send({ type: 'setAacMode', mode: 'monitor' });
    run(10);
    runner.send({ type: 'kick' });
    run(1);
    const m = ring.markers();
    expect(m.filter((x) => x.kind === 'gainShift')).toHaveLength(1);
    expect(m.filter((x) => x.kind === 'aacMode').map((x) => x.label)).toEqual(['AAC monitoring']);
    expect(m.filter((x) => x.kind === 'kick')).toHaveLength(1);
    expect(m.find((x) => x.kind === 'gainShift')!.t).toBeCloseTo(2.01, 6);
    expect(ring.bands().map((b) => b.regime)).toEqual(['nominal', 'gainShift']);
    // reset starts afresh
    runner.send({ type: 'reset' });
    run(0.5);
    expect(ring.markers()).toEqual([]);
    expect(ring.bands().map((b) => b.regime)).toEqual(['nominal']);
  });
});
