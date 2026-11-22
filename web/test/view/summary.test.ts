// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import type { Telemetry } from '../../src/core/sim';
import { TelemetryRing } from '../../src/runtime/telemetry-ring';
import { createSummary, describeState, thetaAmplitude, type SummaryHandle } from '../../src/view/summary';

function tel(t: number, theta: number, p: Partial<Telemetry> = {}): Telemetry {
  return {
    t,
    theta,
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
    motorCmd: [0, 0, 0, 0],
    motorOmega: [0, 0, 0, 0],
    ...p,
  };
}

/** Push 100 Hz samples from tFrom (exclusive) to tTo (inclusive) with theta = f(t). */
function fill(ring: TelemetryRing, tFrom: number, tTo: number, f: (t: number) => number, p: Partial<Telemetry> = {}): void {
  for (let k = Math.round(tFrom * 100) + 1; k <= Math.round(tTo * 100); k++) ring.push(tel(k / 100, f(k / 100), p));
}

let host: HTMLElement;
let sum: SummaryHandle;
let ring: TelemetryRing;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  sum = createSummary(host);
  ring = new TelemetryRing();
});

describe('thetaAmplitude', () => {
  it('is the max over the last 2 s and compares with the 2 s before', () => {
    const t: number[] = [];
    const th: number[] = [];
    for (let k = 1; k <= 400; k++) {
      t.push(k / 100);
      th.push(k <= 200 ? 0.1 : 0.2);
    }
    expect(thetaAmplitude(t, th)).toEqual({ amplitude: 0.2, trend: 'growing' });
    expect(thetaAmplitude(t.slice(0, 300), th.slice(0, 300)).trend).toBeNull();
    expect(thetaAmplitude(t.slice(0, 250), th.slice(0, 250)).trend).toBeNull(); // < 4 s of data
    const dec = th.map((v) => 0.3 - v);
    expect(thetaAmplitude(t, dec).trend).toBe('decaying');
    expect(thetaAmplitude(t, th.map(() => 0.1)).trend).toBe('steady');
    expect(thetaAmplitude([], [])).toEqual({ amplitude: 0, trend: null });
  });

  it('uses |θ|', () => {
    expect(thetaAmplitude([0.01, 0.02], [-0.3, 0.1]).amplitude).toBe(0.3);
  });
});

describe('describeState', () => {
  const t = Array.from({ length: 400 }, (_, i) => (i + 1) / 100);
  const theta = t.map((x) => (x <= 2 ? 0.1 : 0.24));
  it('builds the documented sentence', () => {
    expect(
      describeState({ t, theta, aacMode: 'monitor', detect: [true, false], trips: [{ t: 3, axis: 0 }] }),
    ).toBe('θ amplitude 0.24 rad and growing; AAC Monitor; detector tripped on pitch.');
  });
  it('covers no trip and an earlier trip', () => {
    expect(describeState({ t, theta, aacMode: 'off', detect: [false, false], trips: [] })).toContain(
      'AAC Off; detector not tripped.',
    );
    expect(
      describeState({ t, theta, aacMode: 'engaged', detect: [false, false], trips: [{ t: 1, axis: 1 }] }),
    ).toContain('AAC Engaged; detector tripped earlier on roll, now clear.');
    expect(describeState({ t, theta, aacMode: 'engaged', detect: [true, true], trips: [] })).toContain(
      'tripped on pitch and roll',
    );
  });
});

describe('createSummary', () => {
  it('is a visually hidden aria-live=polite region', () => {
    expect(sum.element.getAttribute('aria-live')).toBe('polite');
    expect(host.contains(sum.element)).toBe(true);
  });

  it('does nothing while the ring is empty', () => {
    expect(sum.maybeUpdate(ring)).toBe(false);
    expect(sum.element.textContent).toBe('');
  });

  it('updates at most once per 1000 ms of sim time', () => {
    const writes: string[] = [];
    let updates = 0;
    for (let k = 1; k <= 500; k++) {
      ring.push(tel(k / 100, 0.1 + k / 1000));
      if (sum.maybeUpdate(ring)) {
        updates++;
        writes.push(sum.element.textContent ?? '');
      }
    }
    // t = 0.01 (first), 1.01, 2.01, 3.01, 4.01
    expect(updates).toBe(5);
    expect(writes[1]).toContain('θ amplitude 0.20 rad');
  });

  it('contains the θ amplitude, the AAC mode and the detector state', () => {
    fill(ring, 0, 6, () => 0.24, { aacMode: 'monitor', detect: [true, false] });
    sum.update(ring);
    const text = sum.element.textContent ?? '';
    expect(text).toMatch(/θ amplitude 0\.24 rad/);
    expect(text).toContain('AAC Monitor');
    expect(text).toContain('detector tripped on pitch');
  });

  it('updates immediately after a restart (time goes back)', () => {
    fill(ring, 0, 5, () => 0.3);
    sum.maybeUpdate(ring);
    ring.push(tel(0.01, 0.2)); // preset load: the ring clears
    expect(sum.maybeUpdate(ring)).toBe(true);
    expect(sum.element.textContent).toContain('θ amplitude 0.20 rad');
  });
});
