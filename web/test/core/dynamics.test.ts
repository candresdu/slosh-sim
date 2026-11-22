import { describe, expect, it } from 'vitest';
import fixture from '../../../golden/fixtures/deriv.json';
import { deriv, eulerZyx, initialState, makeDynConsts, thetaPhi, type Hold } from '../../src/core/dynamics';
import { loadParams } from '../../src/core/params';
import { Rk4Scratch, rk4Step } from '../../src/core/rk4';
import { NX } from '../../src/core/state';

const { params: P } = loadParams(fixture.params);
const C = makeDynConsts(P);

interface Case {
  x: number[];
  uHold: { tau: number[]; omegaCmd: number[] };
}

/** rel error < 1e-12 of the larger magnitude, or abs < 1e-15 when the value is ~0. */
function close(got: number, want: number, rel = 1e-12, abs = 1e-15): boolean {
  const err = Math.abs(got - want);
  return err <= abs || err <= rel * Math.max(Math.abs(got), Math.abs(want));
}

function expectClose(got: ArrayLike<number>, want: number[], label: string, rel = 1e-12): void {
  expect(got.length).toBe(want.length);
  for (let i = 0; i < want.length; i++) {
    const g = got[i] as number;
    const w = want[i] as number;
    if (!close(g, w, rel)) {
      throw new Error(`${label}[${i}]: got ${g}, want ${w}, |err|=${Math.abs(g - w)}`);
    }
  }
}

describe('deriv fixtures', () => {
  it('has 200 deriv and 20 rk4 cases', () => {
    expect(fixture.deriv.length).toBe(200);
    expect(fixture.rk4.length).toBe(20);
  });

  it('matches all deriv cases (rel 1e-12)', () => {
    const dx = new Float64Array(NX);
    fixture.deriv.forEach((cs: Case & { dx: number[] }, i) => {
      deriv(dx, cs.x, cs.uHold, C);
      expectClose(dx, cs.dx, `deriv case ${i}`);
    });
  });

  it('matches all rk4 cases (rel 1e-12)', () => {
    const s = new Rk4Scratch();
    const out = new Float64Array(NX);
    fixture.rk4.forEach((cs: Case & { dt: number; xNext: number[] }, i) => {
      rk4Step(out, cs.x, cs.dt, cs.uHold, C, s);
      expectClose(out, cs.xNext, `rk4 case ${i}`);
    });
  });

  it('rk4Step may alias its input', () => {
    const s = new Rk4Scratch();
    const cs = fixture.rk4[0] as Case & { dt: number; xNext: number[] };
    const x = Float64Array.from(cs.x);
    rk4Step(x, x, cs.dt, cs.uHold, C, s);
    expectClose(x, cs.xNext, 'aliased rk4');
  });
});

describe('display helpers and initial state', () => {
  it('thetaPhi recovers the initial angles', () => {
    const x = initialState(P, 0.2, 0, 0.7, 0.6);
    const [th, ph] = thetaPhi(x);
    expect(th).toBeCloseTo(0.2, 12);
    expect(ph).toBeCloseTo(0.7, 12);
  });

  it('thetaPhi clamps n_D slightly outside [-1, 1]', () => {
    const x = new Float64Array(NX);
    x[15] = 1.0000000000000002;
    expect(thetaPhi(x)[0]).toBe(0);
  });

  it('eulerZyx recovers roll, pitch, yaw', () => {
    const r = 0.1;
    const p = -0.2;
    const y = 0.3;
    const [cr, sr, cp, sp, cy, sy] = [r, p, y].flatMap((a) => [Math.cos(a / 2), Math.sin(a / 2)]) as number[];
    const q: [number, number, number, number] = [
      cr! * cp! * cy! + sr! * sp! * sy!,
      sr! * cp! * cy! - cr! * sp! * sy!,
      cr! * sp! * cy! + sr! * cp! * sy!,
      cr! * cp! * sy! - sr! * sp! * cy!,
    ];
    const [er, ep, ey] = eulerZyx(...q);
    expect(er).toBeCloseTo(r, 12);
    expect(ep).toBeCloseTo(p, 12);
    expect(ey).toBeCloseTo(y, 12);
  });

  it('hover with level quad and hanging mass is an equilibrium (derivatives ~ 0)', () => {
    const x = initialState(P);
    const mT = P.vehicle.m_q + P.pendulum.m_p;
    const om = x[19] as number;
    const hold: Hold = { tau: [0, 0, 0], omegaCmd: [om, om, om, om] };
    const dx = deriv(new Float64Array(NX), x, hold, C);
    for (let i = 0; i < NX; i++) expect(Math.abs(dx[i] as number)).toBeLessThan(1e-9);
    expect(mT).toBeGreaterThan(0);
  });

  it('renormalizes n, w_p and q over many RK4 steps', () => {
    const x = initialState(P, 0.2, 0, 0, 0.6);
    const om = x[19] as number;
    const hold: Hold = { tau: [0, 0, 0], omegaCmd: [om, om, om, om] };
    const s = new Rk4Scratch();
    for (let i = 0; i < 2000; i++) rk4Step(x, x, 0.001, hold, C, s);
    const n = Math.hypot(x[13] as number, x[14] as number, x[15] as number);
    const q = Math.hypot(x[6] as number, x[7] as number, x[8] as number, x[9] as number);
    const wn = (x[16] as number) * (x[13] as number) + (x[17] as number) * (x[14] as number) + (x[18] as number) * (x[15] as number);
    expect(Math.abs(n - 1)).toBeLessThan(1e-14);
    expect(Math.abs(q - 1)).toBeLessThan(1e-14);
    expect(Math.abs(wn)).toBeLessThan(1e-14);
  });
});

describe('micro-benchmark', () => {
  it('deriv call cost (informational; fails only above 50 us)', () => {
    const cs = fixture.deriv[0] as Case;
    const x = Float64Array.from(cs.x);
    const dx = new Float64Array(NX);
    const N = 200_000;
    for (let i = 0; i < 20_000; i++) deriv(dx, x, cs.uHold, C); // warm-up
    const t0 = performance.now();
    for (let i = 0; i < N; i++) deriv(dx, x, cs.uHold, C);
    const us = ((performance.now() - t0) * 1000) / N;
    console.log(`deriv: mean ${us.toFixed(3)} us/call over ${N} calls`);
    expect(us).toBeLessThan(50);
  });
});
