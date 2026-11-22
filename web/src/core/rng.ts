// Seeded RNG: xoshiro128** on uint32, seeded by splitmix32, Gaussian by Box-Muller.
// Exact mirror of python/src/slosh/core/rng.py. The integer stream is bit-exact;
// ln/cos/sin may differ from Python in the last ulp.

const TWO32 = 4294967296;

/** One splitmix32 step. Returns the new state and the output word (both uint32). */
export function splitmix32(state: number): [number, number] {
  const a = (state + 0x9e3779b9) >>> 0;
  let t = (a ^ (a >>> 16)) >>> 0;
  t = Math.imul(t, 0x21f0aaad) >>> 0;
  t = (t ^ (t >>> 15)) >>> 0;
  t = Math.imul(t, 0x735a2d97) >>> 0;
  return [a, (t ^ (t >>> 15)) >>> 0];
}

function rotl(v: number, r: number): number {
  return ((v << r) | (v >>> (32 - r))) >>> 0;
}

export class Rng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;
  private cache: number | null = null;

  constructor(seed: number) {
    let a = seed >>> 0;
    const s: number[] = [];
    for (let i = 0; i < 4; i++) {
      const [na, out] = splitmix32(a);
      a = na;
      s.push(out);
    }
    if (s[0] === 0 && s[1] === 0 && s[2] === 0 && s[3] === 0) s[0] = 1;
    this.s0 = s[0] as number;
    this.s1 = s[1] as number;
    this.s2 = s[2] as number;
    this.s3 = s[3] as number;
  }

  /** Next uint32 of xoshiro128**. */
  nextU32(): number {
    const result = Math.imul(rotl(Math.imul(this.s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (this.s1 << 9) >>> 0;
    this.s2 = (this.s2 ^ this.s0) >>> 0;
    this.s3 = (this.s3 ^ this.s1) >>> 0;
    this.s1 = (this.s1 ^ this.s2) >>> 0;
    this.s0 = (this.s0 ^ this.s3) >>> 0;
    this.s2 = (this.s2 ^ t) >>> 0;
    this.s3 = rotl(this.s3, 11);
    return result;
  }

  /** Uniform in the open interval (0, 1). */
  uniform(): number {
    return (this.nextU32() + 0.5) / TWO32;
  }

  /** Standard normal via Box-Muller; the sine partner is cached for the next call. */
  normal(): number {
    if (this.cache !== null) {
      const z = this.cache;
      this.cache = null;
      return z;
    }
    const u1 = this.uniform();
    const u2 = this.uniform();
    const r = Math.sqrt(-2.0 * Math.log(u1));
    const ang = 2.0 * Math.PI * u2;
    this.cache = r * Math.sin(ang);
    return r * Math.cos(ang);
  }
}
