import { describe, expect, it } from 'vitest';
import fixture from '../../../golden/fixtures/filters.json';
import { Biquad, Sos } from '../../src/core/filters';
import { loadParams } from '../../src/core/params';
import { expectClose } from './helpers';

describe('filters fixtures', () => {
  it('has the four cases', () => {
    expect(fixture.cases.map((c) => c.name)).toEqual(['hp', 'lp', 'hp_then_lp', 'identity']);
    expect(fixture.x.length).toBe(fixture.chirp.n);
  });

  for (const cs of fixture.cases) {
    it(`matches case ${cs.name} (rel 1e-12)`, () => {
      const f = new Sos(cs.sos);
      const y = fixture.x.map((x) => f.step(x));
      expectClose(y, cs.y, cs.name);
    });
  }

  it('fixture hp/lp sos equal the params snapshot', () => {
    const { params } = loadParams(fixture.params);
    expect(fixture.cases[0]?.sos).toEqual(params.aac.hp.sos);
    expect(fixture.cases[1]?.sos).toEqual(params.aac.lp.sos);
  });

  it('reset clears state', () => {
    const f = new Sos(fixture.cases[2]?.sos ?? []);
    const first = fixture.x.slice(0, 50).map((x) => f.step(x));
    f.reset();
    const second = fixture.x.slice(0, 50).map((x) => f.step(x));
    expect(second).toEqual(first);
  });

  it('empty cascade is identity; bad row throws', () => {
    expect(new Sos([]).step(3.5)).toBe(3.5);
    expect(() => new Sos([[1, 2, 3]])).toThrow();
    expect(new Biquad(1, 0, 0, 0, 0).step(2)).toBe(2);
  });
});
