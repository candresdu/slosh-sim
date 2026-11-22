import { expect } from 'vitest';

/** rel error < rel of the larger magnitude, or abs < abs when the value is ~0. */
export function close(got: number, want: number, rel = 1e-12, abs = 1e-15): boolean {
  const err = Math.abs(got - want);
  return err <= abs || err <= rel * Math.max(Math.abs(got), Math.abs(want));
}

export function expectClose(got: ArrayLike<number>, want: ArrayLike<number>, label: string, rel = 1e-12): void {
  expect(got.length, `${label} length`).toBe(want.length);
  for (let i = 0; i < want.length; i++) {
    const g = got[i] as number;
    const w = want[i] as number;
    if (!close(g, w, rel)) {
      throw new Error(`${label}[${i}]: got ${g}, want ${w}, |err|=${Math.abs(g - w)}`);
    }
  }
}

export function expectScalar(got: number, want: number, label: string, rel = 1e-12): void {
  if (!close(got, want, rel)) throw new Error(`${label}: got ${got}, want ${want}, |err|=${Math.abs(got - want)}`);
}
