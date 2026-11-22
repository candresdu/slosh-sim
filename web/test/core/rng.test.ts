/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest';
import { Rng, splitmix32 } from '../../src/core/rng';

interface RngSeedFixture {
  seed: number;
  u32: number[];
  normals: number[];
}

const files = import.meta.glob('../../../golden/fixtures/rng.json', { eager: true, import: 'default' });
const fixture = Object.values(files)[0] as { seeds: RngSeedFixture[] } | undefined;

describe('rng', () => {
  it('splitmix32 is deterministic and uint32', () => {
    const [a, out] = splitmix32(1);
    expect(a).toBe(0x9e3779b9 + 1);
    expect(Number.isInteger(out) && out >= 0 && out < 2 ** 32).toBe(true);
  });

  it('uniform stays strictly inside (0, 1)', () => {
    const r = new Rng(7);
    for (let i = 0; i < 1000; i++) {
      const u = r.uniform();
      expect(u).toBeGreaterThan(0);
      expect(u).toBeLessThan(1);
    }
  });

  it('same seed gives same stream, different seeds differ', () => {
    const a = new Rng(5);
    const b = new Rng(5);
    const c = new Rng(6);
    expect(a.nextU32()).toBe(b.nextU32());
    expect(a.normal()).toBe(b.normal());
    expect(new Rng(5).nextU32()).not.toBe(c.nextU32());
  });

  // TODO: skipped automatically when golden/fixtures/rng.json does not exist.
  const golden = it.skipIf(fixture === undefined);

  golden('matches the Python u32 stream exactly (seeds 1 and 42)', () => {
    const seeds = fixture!.seeds;
    expect(seeds.map((s) => s.seed)).toEqual(expect.arrayContaining([1, 42]));
    for (const s of seeds) {
      expect(s.u32).toHaveLength(1000);
      const r = new Rng(s.seed);
      const got = Array.from({ length: s.u32.length }, () => r.nextU32());
      expect(got).toEqual(s.u32);
    }
  });

  golden('matches the Python normals within 1e-15 (seeds 1 and 42)', () => {
    for (const s of fixture!.seeds) {
      expect(s.normals).toHaveLength(1000);
      const r = new Rng(s.seed);
      let maxErr = 0;
      for (const z of s.normals) maxErr = Math.max(maxErr, Math.abs(r.normal() - z));
      expect(maxErr).toBeLessThanOrEqual(1e-15);
    }
  });
});
