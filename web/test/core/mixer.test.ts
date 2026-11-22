import { describe, expect, it } from 'vitest';
import fixture from '../../../golden/fixtures/mixer.json';
import { forcesTorques, makeMixerConsts, mix, motorSaturated, S_PITCH, S_ROLL, S_YAW } from '../../src/core/mixer';
import { loadParams } from '../../src/core/params';
import { expectClose } from './helpers';

const { params: P } = loadParams(fixture.params);
const C = makeMixerConsts(P);

describe('mixer fixtures', () => {
  it('has 100 mix and 100 forcesTorques cases', () => {
    expect(fixture.mix.length).toBe(100);
    expect(fixture.forcesTorques.length).toBe(100);
  });

  it('matches mix cases (rel 1e-12)', () => {
    const out = new Float64Array(4);
    fixture.mix.forEach((cs, i) => {
      mix(out, cs.f, cs.tau[0] as number, cs.tau[1] as number, cs.tau[2] as number, C);
      expectClose(out, cs.omegaCmd, `mix case ${i}`);
    });
  });

  it('matches forcesTorques cases (rel 1e-12)', () => {
    const out = new Float64Array(4);
    fixture.forcesTorques.forEach((cs, i) => {
      forcesTorques(out, cs.omega, C);
      expectClose(out, [cs.f, ...cs.tau], `forcesTorques case ${i}`);
    });
  });
});

describe('mixer structure', () => {
  it('uses the R-1 sign vectors', () => {
    expect([...S_ROLL]).toEqual([1, -1, -1, 1]);
    expect([...S_PITCH]).toEqual([-1, -1, 1, 1]);
    expect([...S_YAW]).toEqual([1, -1, 1, -1]);
  });

  it('d = arm/sqrt(2) and kappa = k_tau/k_f', () => {
    expect(C.d).toBeCloseTo(P.vehicle.arm / Math.SQRT2, 15);
    expect(C.kappa).toBeCloseTo(P.vehicle.k_tau / P.vehicle.k_f, 20);
  });

  it('mix inverts forcesTorques when unsaturated', () => {
    const f = 15;
    const out = new Float64Array(4);
    mix(out, f, 0.05, -0.03, 0.0005, C);
    const ft = new Float64Array(4);
    forcesTorques(ft, out, C);
    expectClose(ft, [f, 0.05, -0.03, 0.0005], 'roundtrip', 1e-9);
    expect(motorSaturated(f, 0.05, -0.03, 0.0005, C)).toBe(false);
  });

  it('clamps thrust to omegaMin/omegaMax', () => {
    const out = new Float64Array(4);
    mix(out, 0, 0, 0, 0, C);
    for (const w of out) expect(w).toBeCloseTo(P.motor.omegaMin, 9);
    mix(out, 1e4, 0, 0, 0, C);
    for (const w of out) expect(w).toBeCloseTo(P.motor.omegaMax, 9);
    expect(motorSaturated(1e4, 0, 0, 0, C)).toBe(true);
  });
});
