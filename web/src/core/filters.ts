// Biquad filters (mirror of python/src/slosh/core/filters.py).
//
// Direct-form-II-transposed, coefficients [b0, b1, b2, a1, a2] with a0 = 1:
//   y = b0 x + z1;  z1' = b1 x - a1 y + z2;  z2' = b2 x - a2 y
// The coefficients come from aac.hp.sos / aac.lp.sos in the shared parameter file.

export class Biquad {
  readonly b0: number;
  readonly b1: number;
  readonly b2: number;
  readonly a1: number;
  readonly a2: number;
  private z1 = 0.0;
  private z2 = 0.0;

  constructor(b0: number, b1: number, b2: number, a1: number, a2: number) {
    this.b0 = b0;
    this.b1 = b1;
    this.b2 = b2;
    this.a1 = a1;
    this.a2 = a2;
  }

  step(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }

  reset(): void {
    this.z1 = 0.0;
    this.z2 = 0.0;
  }
}

/** Cascade of biquads; an empty cascade is the identity. */
export class Sos {
  private readonly sections: Biquad[] = [];

  constructor(rows: ReadonlyArray<ArrayLike<number>>) {
    for (const row of rows) {
      if (row.length !== 5) throw new Error(`biquad row needs 5 coefficients, got ${row.length}`);
      this.sections.push(
        new Biquad(row[0] as number, row[1] as number, row[2] as number, row[3] as number, row[4] as number),
      );
    }
  }

  step(x: number): number {
    let v = x;
    for (const s of this.sections) v = s.step(v);
    return v;
  }

  reset(): void {
    for (const s of this.sections) s.reset();
  }
}
