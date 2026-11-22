// Classic fixed-step RK4 with constraint renormalization. Mirror of python/src/slosh/core/rk4.py.
import { deriv, type DynConsts, type Hold } from './dynamics';
import { NX } from './state';

/** Preallocated scratch for rk4Step: create once, reuse for every step. */
export class Rk4Scratch {
  readonly k1 = new Float64Array(NX);
  readonly k2 = new Float64Array(NX);
  readonly k3 = new Float64Array(NX);
  readonly k4 = new Float64Array(NX);
  readonly tmp = new Float64Array(NX);
}

/**
 * Advance `x` by `dt` with held input, writing into `out` (may alias `x`).
 * After the step: n <- n/|n|, w_p <- w_p - (w_p.n) n, q_att <- q_att/|q_att|.
 */
export function rk4Step(
  out: Float64Array,
  x: ArrayLike<number>,
  dt: number,
  hold: Hold,
  c: DynConsts,
  s: Rk4Scratch,
): Float64Array {
  const { k1, k2, k3, k4, tmp } = s;
  deriv(k1, x, hold, c);
  const h2 = 0.5 * dt;
  for (let i = 0; i < NX; i++) tmp[i] = (x[i] as number) + h2 * (k1[i] as number);
  deriv(k2, tmp, hold, c);
  for (let i = 0; i < NX; i++) tmp[i] = (x[i] as number) + h2 * (k2[i] as number);
  deriv(k3, tmp, hold, c);
  for (let i = 0; i < NX; i++) tmp[i] = (x[i] as number) + dt * (k3[i] as number);
  deriv(k4, tmp, hold, c);
  const dt6 = dt / 6.0;
  for (let i = 0; i < NX; i++) {
    out[i] =
      (x[i] as number) +
      dt6 * ((k1[i] as number) + 2.0 * (k2[i] as number) + 2.0 * (k3[i] as number) + (k4[i] as number));
  }
  normalize(out);
  return out;
}

/** In-place projection: unit n, w_p perpendicular to n, unit quaternion. */
export function normalize(y: Float64Array): void {
  let inv = 1.0 / Math.sqrt(nsq(y));
  y[13] = (y[13] as number) * inv;
  y[14] = (y[14] as number) * inv;
  y[15] = (y[15] as number) * inv;
  const d = (y[16] as number) * (y[13] as number) + (y[17] as number) * (y[14] as number) + (y[18] as number) * (y[15] as number);
  y[16] = (y[16] as number) - d * (y[13] as number);
  y[17] = (y[17] as number) - d * (y[14] as number);
  y[18] = (y[18] as number) - d * (y[15] as number);
  inv =
    1.0 /
    Math.sqrt(
      (y[6] as number) * (y[6] as number) +
        (y[7] as number) * (y[7] as number) +
        (y[8] as number) * (y[8] as number) +
        (y[9] as number) * (y[9] as number),
    );
  y[6] = (y[6] as number) * inv;
  y[7] = (y[7] as number) * inv;
  y[8] = (y[8] as number) * inv;
  y[9] = (y[9] as number) * inv;
}

function nsq(y: Float64Array): number {
  return (y[13] as number) * (y[13] as number) + (y[14] as number) * (y[14] as number) + (y[15] as number) * (y[15] as number);
}
