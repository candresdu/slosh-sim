import { describe, expect, it } from 'vitest';
import { TelemetryRing } from '../../src/runtime/telemetry-ring';
import { makeTel } from './helpers';

describe('TelemetryRing', () => {
  it('is empty at start', () => {
    const r = new TelemetryRing();
    expect(r.capacity).toBe(3000);
    expect(r.length).toBe(0);
    expect(r.latest()).toBeNull();
    expect(r.view('t').length).toBe(0);
    expect(r.detections()).toEqual([]);
  });

  it('orders data chronologically after wrap-around (4500 samples, capacity 3000)', () => {
    const r = new TelemetryRing(3000);
    const tel = makeTel(0);
    for (let i = 1; i <= 4500; i++) {
      tel.t = i * 0.01;
      tel.theta = i;
      r.push(tel); // same object reused, like Sim does
    }
    const t = r.view('t');
    expect(t.length).toBe(3000);
    expect(t[0]).toBeCloseTo(1501 * 0.01, 12); // the 1501st sample
    expect(t[2999]).toBeCloseTo(4500 * 0.01, 12);
    for (let i = 1; i < t.length; i++) expect(t[i] as number).toBeGreaterThan(t[i - 1] as number);
    const th = r.view('theta');
    expect(th[0]).toBe(1501);
    expect(th[2999]).toBe(4500);
    expect(r.latest()?.theta).toBe(4500);
  });

  it('orders data before wrap-around and reuses its buffer', () => {
    const r = new TelemetryRing(10);
    for (let i = 1; i <= 4; i++) r.push(makeTel(i));
    const a = r.view('t');
    expect(Array.from(a)).toEqual([1, 2, 3, 4]);
    const b = r.view('t');
    expect(b.buffer).toBe(a.buffer);
  });

  it('stores every channel', () => {
    const r = new TelemetryRing(4);
    r.push(
      makeTel(1, {
        massRel: [0.1, 0.2, 0.3],
        kT: [0.4, 0.5],
        kTApplied: [1, 0.9],
        ySD: [2, 3],
        motorCmd: [0.1, 0.2, 0.3, 0.4],
        motorOmega: [10, 20, 30, 40],
        gainShift: 2.3,
        detect: [false, true],
      }),
    );
    expect(r.view('massY')[0]).toBe(0.2);
    expect(r.view('kTRoll')[0]).toBe(0.5);
    expect(r.view('kTAppliedRoll')[0]).toBe(0.9);
    expect(r.view('ySDRoll')[0]).toBe(3);
    expect(r.view('motorCmd3')[0]).toBe(0.4);
    expect(r.view('motorOmega2')[0]).toBe(30);
    expect(r.view('gainShift')[0]).toBe(2.3);
    expect(r.view('detectPitch')[0]).toBe(0);
    expect(r.view('detectRoll')[0]).toBe(1);
  });

  it('reports rising-edge detections inside the window only', () => {
    const r = new TelemetryRing(100);
    for (let i = 1; i <= 300; i++) {
      // pitch latched on 10..20 and 50..60; roll on 150..160
      const p = (i >= 10 && i <= 20) || (i >= 50 && i <= 60);
      r.push(makeTel(i * 0.01, { detect: [p, i >= 150 && i <= 160] }));
    }
    // window = samples 201..300 -> nothing
    expect(r.detections()).toEqual([]);

    const r2 = new TelemetryRing(100);
    for (let i = 1; i <= 120; i++) {
      const p = (i >= 10 && i <= 20) || (i >= 50 && i <= 60);
      r2.push(makeTel(i * 0.01, { detect: [p, i >= 55] }));
    }
    // window = samples 21..120: edge at 10 dropped, pitch edge at 50 and roll edge at 55 kept
    const d = r2.detections();
    expect(d.map((x) => x.axis)).toEqual([0, 1]);
    expect(d[0]?.t).toBeCloseTo(0.5, 12);
    expect(d[1]?.t).toBeCloseTo(0.55, 12);
  });

  it('clears when time goes backwards (reset / preset load)', () => {
    const r = new TelemetryRing(100);
    for (let i = 1; i <= 50; i++) r.push(makeTel(i * 0.01, { detect: [i > 40, false] }));
    expect(r.detections().length).toBe(1);
    r.push(makeTel(0.01));
    expect(r.length).toBe(1);
    expect(r.detections()).toEqual([]);
    expect(r.view('t')[0]).toBe(0.01);
  });
});
