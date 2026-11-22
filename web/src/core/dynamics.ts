// Unit-vector pendulum + 6-DOF quadrotor dynamics. Line-by-line mirror of
// python/src/slosh/core/dynamics.py (+ initial.py); keep the operation order identical.
//
// Frames: world NED, body FRD, gravity along +D. State layout: see state.ts.
//   n_dot   = w_p x n
//   F_d     = -(k/L) (w_p x n)
//   T_r     = mu (L |w_p|^2 - (n . F)/m_q)
//   w_p_dot = (1/L) n x (F_d/mu - F/m_q)
//   v_dot   = (F + T_r n - F_d)/m_q + g e_D
//   w_b_dot = J^-1 (tau - w_b x J w_b)
//   q_dot   = 1/2 q (x) [0, w_b]
//   Om_dot  = (Om_cmd - Om)/tau_m
import type { SimParams } from './params';
import { NX } from './state';

/** Zero-order-held controller output: body torque [N m, FRD], rotor commands [rad/s]. */
export interface Hold {
  tau: ArrayLike<number>;
  omegaCmd: ArrayLike<number>;
}

/** Constants derived from SimParams once, so deriv() does no setup work. */
export interface DynConsts {
  mQ: number;
  L: number;
  k: number;
  g: number;
  Jx: number;
  Jy: number;
  Jz: number;
  mu: number;
  kf: number;
  invTm: number;
}

export function makeDynConsts(p: SimParams): DynConsts {
  const mQ = p.vehicle.m_q;
  const mP = p.pendulum.m_p;
  const mT = mQ + mP;
  return {
    mQ,
    L: p.pendulum.L,
    k: p.pendulum.k_damp,
    g: p.sim.g,
    Jx: p.vehicle.J[0],
    Jy: p.vehicle.J[1],
    Jz: p.vehicle.J[2],
    mu: (mQ * mP) / mT,
    kf: p.vehicle.k_f,
    invTm: 1.0 / p.motor.tau,
  };
}

/** Write dx = deriv(x, hold) into `dx` (length NX). No allocation. */
export function deriv(
  dx: Float64Array,
  x: ArrayLike<number>,
  hold: Hold,
  c: DynConsts,
): Float64Array {
  const mQ = c.mQ;
  const L = c.L;
  const mu = c.mu;
  const vn = x[3] as number;
  const ve = x[4] as number;
  const vd = x[5] as number;
  const qw = x[6] as number;
  const qx = x[7] as number;
  const qy = x[8] as number;
  const qz = x[9] as number;
  const wx = x[10] as number;
  const wy = x[11] as number;
  const wz = x[12] as number;
  const nn = x[13] as number;
  const ne = x[14] as number;
  const nd = x[15] as number;
  const pn = x[16] as number;
  const pe = x[17] as number;
  const pd = x[18] as number;
  const o0 = x[19] as number;
  const o1 = x[20] as number;
  const o2 = x[21] as number;
  const o3 = x[22] as number;

  // thrust force in NED: F = R [0, 0, -T]
  const T = c.kf * (o0 * o0 + o1 * o1 + o2 * o2 + o3 * o3);
  const Fn = -T * (2.0 * (qx * qz + qw * qy));
  const Fe = -T * (2.0 * (qy * qz - qw * qx));
  const Fd = -T * (1.0 - 2.0 * (qx * qx + qy * qy));

  // n_dot = w_p x n
  const ndn = pe * nd - pd * ne;
  const nde = pd * nn - pn * nd;
  const ndd = pn * ne - pe * nn;

  // damping force on the mass
  const kL = c.k / L;
  const fdn = -kL * ndn;
  const fde = -kL * nde;
  const fdd = -kL * ndd;

  const wp2 = pn * pn + pe * pe + pd * pd;
  const nDotF = nn * Fn + ne * Fe + nd * Fd;
  const Tr = mu * (L * wp2 - nDotF / mQ);

  // w_p_dot = (1/L) n x (F_d/mu - F/m_q)
  const ax = fdn / mu - Fn / mQ;
  const ay = fde / mu - Fe / mQ;
  const az = fdd / mu - Fd / mQ;
  const wpn = (ne * az - nd * ay) / L;
  const wpe = (nd * ax - nn * az) / L;
  const wpd = (nn * ay - ne * ax) / L;

  // translational acceleration
  const an = (Fn + Tr * nn - fdn) / mQ;
  const ae = (Fe + Tr * ne - fde) / mQ;
  const ad = (Fd + Tr * nd - fdd) / mQ + c.g;

  // rigid-body rotation (FRD)
  const Jx = c.Jx;
  const Jy = c.Jy;
  const Jz = c.Jz;
  const tx = hold.tau[0] as number;
  const ty = hold.tau[1] as number;
  const tz = hold.tau[2] as number;
  const wbx = (tx - (wy * Jz * wz - wz * Jy * wy)) / Jx;
  const wby = (ty - (wz * Jx * wx - wx * Jz * wz)) / Jy;
  const wbz = (tz - (wx * Jy * wy - wy * Jx * wx)) / Jz;

  // quaternion kinematics: q_dot = 1/2 q (x) [0, w_b]
  const qdw = 0.5 * (-qx * wx - qy * wy - qz * wz);
  const qdx = 0.5 * (qw * wx + qy * wz - qz * wy);
  const qdy = 0.5 * (qw * wy + qz * wx - qx * wz);
  const qdz = 0.5 * (qw * wz + qx * wy - qy * wx);

  const invTm = c.invTm;
  const cmd = hold.omegaCmd;

  dx[0] = vn;
  dx[1] = ve;
  dx[2] = vd;
  dx[3] = an;
  dx[4] = ae;
  dx[5] = ad;
  dx[6] = qdw;
  dx[7] = qdx;
  dx[8] = qdy;
  dx[9] = qdz;
  dx[10] = wbx;
  dx[11] = wby;
  dx[12] = wbz;
  dx[13] = ndn;
  dx[14] = nde;
  dx[15] = ndd;
  dx[16] = wpn;
  dx[17] = wpe;
  dx[18] = wpd;
  dx[19] = ((cmd[0] as number) - o0) * invTm;
  dx[20] = ((cmd[1] as number) - o1) * invTm;
  dx[21] = ((cmd[2] as number) - o2) * invTm;
  dx[22] = ((cmd[3] as number) - o3) * invTm;
  return dx;
}

// --- display helpers ---------------------------------------------------------------------------

/** Display-only spherical angles: theta = acos(clamp(n_D)), phi = atan2(n_E, n_N). */
export function thetaPhi(x: ArrayLike<number>): [number, number] {
  const nd = Math.max(-1.0, Math.min(1.0, x[15] as number));
  return [Math.acos(nd), Math.atan2(x[14] as number, x[13] as number)];
}

/** Mass position relative to the quad CG, NED [m]. */
export function massRelative(x: ArrayLike<number>, L: number): [number, number, number] {
  return [L * (x[13] as number), L * (x[14] as number), L * (x[15] as number)];
}

/** ZYX Euler angles [roll, pitch, yaw] from a quaternion (w, x, y, z). */
export function eulerZyx(w: number, x: number, y: number, z: number): [number, number, number] {
  const roll = Math.atan2(2.0 * (w * x + y * z), 1.0 - 2.0 * (x * x + y * y));
  const s = Math.max(-1.0, Math.min(1.0, 2.0 * (w * y - z * x)));
  const pitch = Math.asin(s);
  const yaw = Math.atan2(2.0 * (w * z + x * y), 1.0 - 2.0 * (y * y + z * z));
  return [roll, pitch, yaw];
}

// --- initial conditions (mirror of initial.py) ---------------------------------------------------

/** Returns [n, w_p] (NED) for pendulum angles (theta, thetaDot, phi, phiDot). theta = 0 hangs down. */
export function pendulumVectors(
  theta: number,
  thetaDot: number,
  phi: number,
  phiDot: number,
): [[number, number, number], [number, number, number]] {
  const st = Math.sin(theta);
  const ct = Math.cos(theta);
  const sp = Math.sin(phi);
  const cp = Math.cos(phi);
  const n: [number, number, number] = [st * cp, st * sp, ct];
  const thx = ct * cp;
  const thy = ct * sp;
  const thz = -st;
  const phx = -sp;
  const phy = cp;
  const ndx = thetaDot * thx + st * phiDot * phx;
  const ndy = thetaDot * thy + st * phiDot * phy;
  const ndz = thetaDot * thz;
  const w: [number, number, number] = [
    n[1] * ndz - n[2] * ndy,
    n[2] * ndx - n[0] * ndz,
    n[0] * ndy - n[1] * ndx,
  ];
  return [n, w];
}

/** Rotor speed [rad/s] at which total thrust balances the weight of quad + mass. */
export function hoverOmega(p: SimParams): number {
  const mT = p.vehicle.m_q + p.pendulum.m_p;
  return Math.sqrt((mT * p.sim.g) / (4.0 * p.vehicle.k_f));
}

/** Level, at-rest quad at pQ with hover rotor speeds and the given pendulum state. */
export function initialState(
  p: SimParams,
  theta = 0.0,
  thetaDot = 0.0,
  phi = 0.0,
  phiDot = 0.0,
  pQ: readonly [number, number, number] = [0.0, 0.0, 0.0],
): Float64Array {
  const [n, w] = pendulumVectors(theta, thetaDot, phi, phiDot);
  const x = new Float64Array(NX);
  x[0] = pQ[0];
  x[1] = pQ[1];
  x[2] = pQ[2];
  x[6] = 1.0;
  x[13] = n[0];
  x[14] = n[1];
  x[15] = n[2];
  x[16] = w[0];
  x[17] = w[1];
  x[18] = w[2];
  const om = hoverOmega(p);
  x[19] = om;
  x[20] = om;
  x[21] = om;
  x[22] = om;
  return x;
}
