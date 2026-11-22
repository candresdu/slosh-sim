// X-configuration mixer (mirror of python/src/slosh/core/mixer.py).
//
// Layout (FRD body frame): M1 rear-left, M2 rear-right, M3 front-right, M4 front-left, each at
// body position (+-d, +-d) with d = arm / sqrt(2). Sign rules:
//   +roll  raises M1, M4 and lowers M2, M3;  +pitch raises M3, M4 and lowers M1, M2;
//   +yaw   raises M1, M3 and lowers M2, M4.
// With T_i = k_f w_i^2 and kappa = k_tau / k_f:
//   f = sum T_i,  tau_x = d (T1 + T4 - T2 - T3),  tau_y = d (T3 + T4 - T1 - T2),
//   tau_z = kappa (T1 - T2 + T3 - T4).
// Operation order mirrors the Python code so results agree to ~1 ulp.
import type { SimParams } from './params';

/** Sign vectors per motor (index 0..3 = M1..M4). */
export const S_ROLL: readonly number[] = [+1, -1, -1, +1];
export const S_PITCH: readonly number[] = [-1, -1, +1, +1];
export const S_YAW: readonly number[] = [+1, -1, +1, -1];

export interface MixerConsts {
  kF: number;
  kappa: number;
  /** Moment arm d = arm / sqrt(2) [m]. */
  d: number;
  tLo: number;
  tHi: number;
}

export function makeMixerConsts(p: SimParams): MixerConsts {
  const kF = p.vehicle.k_f;
  return {
    kF,
    kappa: p.vehicle.k_tau / kF,
    d: p.vehicle.arm / Math.sqrt(2.0),
    tLo: kF * p.motor.omegaMin * p.motor.omegaMin,
    tHi: kF * p.motor.omegaMax * p.motor.omegaMax,
  };
}

/** Total thrust and body torques [f, tau_x, tau_y, tau_z] from rotor speeds [rad/s]. */
export function forcesTorques(
  out: Float64Array | number[],
  omega: ArrayLike<number>,
  c: MixerConsts,
): void {
  const kF = c.kF;
  const w1 = omega[0] as number;
  const w2 = omega[1] as number;
  const w3 = omega[2] as number;
  const w4 = omega[3] as number;
  const t1 = kF * w1 * w1;
  const t2 = kF * w2 * w2;
  const t3 = kF * w3 * w3;
  const t4 = kF * w4 * w4;
  out[0] = t1 + t2 + t3 + t4;
  out[1] = c.d * (t1 + t4 - t2 - t3);
  out[2] = c.d * (t3 + t4 - t1 - t2);
  out[3] = c.kappa * (t1 - t2 + t3 - t4);
}

/** Rotor speed commands [rad/s] for thrust f and torques; per-motor thrust is clamped. */
export function mix(
  out: Float64Array | number[],
  f: number,
  tauX: number,
  tauY: number,
  tauZ: number,
  c: MixerConsts,
): void {
  const base = f / 4.0;
  const aR = tauX / (4.0 * c.d);
  const aP = tauY / (4.0 * c.d);
  const aY = tauZ / (4.0 * c.kappa);
  for (let i = 0; i < 4; i++) {
    let t = base + (S_ROLL[i] as number) * aR + (S_PITCH[i] as number) * aP + (S_YAW[i] as number) * aY;
    t = Math.min(Math.max(t, c.tLo), c.tHi);
    out[i] = Math.sqrt(t / c.kF);
  }
}

/** Debug only: true if {@link mix} clamps any motor thrust at omegaMin or omegaMax. */
export function motorSaturated(
  f: number,
  tauX: number,
  tauY: number,
  tauZ: number,
  c: MixerConsts,
): boolean {
  const base = f / 4.0;
  const aR = tauX / (4.0 * c.d);
  const aP = tauY / (4.0 * c.d);
  const aY = tauZ / (4.0 * c.kappa);
  for (let i = 0; i < 4; i++) {
    const t = base + (S_ROLL[i] as number) * aR + (S_PITCH[i] as number) * aP + (S_YAW[i] as number) * aY;
    if (t < c.tLo || t > c.tHi) return true;
  }
  return false;
}
