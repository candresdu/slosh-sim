import { describe, expect, it } from 'vitest';
import fixture from '../../../golden/fixtures/aac.json';
import { Aac, roundHalfEven, type AacMode } from '../../src/core/aac';
import { loadParams } from '../../src/core/params';
import { expectScalar } from './helpers';

function edges(detect: boolean[]): { trips: number[]; clears: number[] } {
  const trips: number[] = [];
  const clears: number[] = [];
  let prev = false;
  detect.forEach((d, i) => {
    if (d && !prev) trips.push(i);
    if (!d && prev) clears.push(i);
    prev = d;
  });
  return { trips, clears };
}

describe('aac fixtures', () => {
  it('has 6 cases of 2000 ticks', () => {
    expect(fixture.cases.map((c) => c.name)).toEqual([
      'off', 'monitor', 'engaged', 'engaged_b_e', 'switching', 'switching_ramp',
    ]);
    expect(fixture.ticks).toBe(2000);
  });

  for (const cs of fixture.cases) {
    it(`matches case ${cs.name} (rel 1e-12; detector ticks exact)`, () => {
      const { params } = loadParams(fixture.params);
      params.aac.engageRampS = cs.engageRampS;
      const aac = new Aac(params, { b_e: cs.bE });
      const sched = new Map<number, AacMode>(cs.modeSchedule.map(([t, m]) => [t as number, m as AacMode]));
      let mode: AacMode = 'off';
      const o = cs.outputs;
      const detect: boolean[] = [];
      const edgeTicks: number[] = [];
      for (let i = 0; i < fixture.ticks; i++) {
        mode = sched.get(i) ?? mode;
        const r = aac.step(cs.u[i] as number, cs.eRef[i] as number, mode);
        expectScalar(r.kT, o.kT[i] as number, `${cs.name} kT[${i}]`);
        expectScalar(r.kTApplied, o.kTApplied[i] as number, `${cs.name} kTApplied[${i}]`);
        expectScalar(r.ySD, o.ySD[i] as number, `${cs.name} ySD[${i}]`);
        expect(r.detect, `${cs.name} detect[${i}]`).toBe(o.detect[i]);
        expect(r.tripEdge, `${cs.name} tripEdge[${i}]`).toBe(o.tripEdge[i]);
        detect.push(r.detect);
        if (r.tripEdge) edgeTicks.push(i);
      }
      const want = edges(o.detect);
      const got = edges(detect);
      expect(got.trips).toEqual(want.trips);
      expect(got.clears).toEqual(want.clears);
      expect(edgeTicks).toEqual(o.tripEdge.flatMap((e, i) => (e ? [i] : [])));
    });
  }

  it('the fixture exercises trips and clears', () => {
    const e = edges(fixture.cases.find((c) => c.name === 'engaged')?.outputs.detect ?? []);
    expect(e.trips.length).toBeGreaterThan(0);
    expect(e.clears.length).toBeGreaterThan(0);
  });
});

describe('aac behaviour', () => {
  it('throws on null tuned values unless overridden', () => {
    const { params } = loadParams(fixture.params);
    params.aac.a0 = null;
    expect(() => new Aac(params)).toThrow(/a0/);
    expect(() => new Aac(params, { a0: 0.2 })).not.toThrow();
  });

  it('rejects unknown modes', () => {
    const { params } = loadParams(fixture.params);
    expect(() => new Aac(params).step(0, 0, 'bogus' as AacMode)).toThrow();
  });

  it('roundHalfEven matches Python round()', () => {
    expect([0.5, 1.5, 2.5, 3.5, -0.5, -1.5, 2.4, 2.6, 3].map(roundHalfEven)).toEqual([0, 2, 2, 4, -0, -2, 2, 3, 3]);
  });
});
