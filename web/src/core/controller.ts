// Two-loop PD controller, altitude/yaw hold, saturations, latency and noise.
// Mirror of python/src/slosh/core/controller.py. Runs once per control tick (100 Hz, ZOH).
// Frames: world NED, body FRD. x is north (pitch channel), y is east (roll channel) after
// rotating the position error into the yaw-aligned frame.
//
//   u_a     = kT_a * gs * (Kp_pos e_a + Kd_pos ed_a)      lateral accel command [m/s^2]
//   pitch_c = clamp(-u_x / g, +-attMax),  roll_c = clamp(+u_y / g, +-attMax)
//   tau_x   = J_xx (Kp_att (roll_c - roll)  - Kd_att p)
//   tau_y   = J_yy (Kp_att (pitch_c - pitch) - Kd_att q)
//   f       = m_T (g - Kp_z e_z - Kd_z ed_z) / max(cos roll cos pitch, 0.5), clamped
//   tau_z   = J_zz (Kp_yaw (yaw_ref - yaw) - Kd_yaw r)
// Measurement path: optional Gaussian noise (seeded Rng, only when enabled), then a delay of
// round(latencyMs / tick) whole ticks through a FIFO (oldest available sample until it is full).
import { eulerZyx } from './dynamics';
import { makeMixerConsts, mix, motorSaturated, type MixerConsts } from './mixer';
import type { SimParams, Vec3 } from './params';
import { Rng } from './rng';
import { roundHalfEven } from './aac';

export type Vec4 = [number, number, number, number];

/** Raw measurement from the plant state: NED position/velocity, quaternion (w,x,y,z), body rates. */
export interface Meas {
  pos: ArrayLike<number>;
  vel: ArrayLike<number>;
  q: ArrayLike<number>;
  wB: ArrayLike<number>;
}

/** Position reference in NED [m] and yaw reference [rad]. */
export interface Ref {
  pos: ArrayLike<number>;
  yaw: number;
}

/** What the control law actually sees (Euler angles, after optional noise and latency). */
export interface Sensed {
  pos: Vec3;
  vel: Vec3;
  roll: number;
  pitch: number;
  yaw: number;
  rates: Vec3;
}

export interface CtrlOut {
  /** (u_x, u_y) lateral accel command [m/s^2], after kT*gs, before saturation. */
  u: [number, number];
  pitchC: number;
  rollC: number;
  /** Total thrust [N]. */
  f: number;
  /** Body torque command [N m]. */
  tau: Vec3;
  /** Rotor speed commands [rad/s]. */
  omegaCmd: Vec4;
  sensed: Sensed;
  /** Debug only: an attitude command was clamped at +-attMax. */
  satAtt: boolean;
  /** Debug only: a motor command was clamped at omegaMin/omegaMax. */
  satMotor: boolean;
}

/** Extract a {@link Meas} (views, no copy) from the 23-element plant state. */
export function measFromState(x: ArrayLike<number>): Meas {
  const at = (i: number): number => x[i] as number;
  return {
    pos: [at(0), at(1), at(2)],
    vel: [at(3), at(4), at(5)],
    q: [at(6), at(7), at(8), at(9)],
    wB: [at(10), at(11), at(12)],
  };
}

function clamp(v: number, lim: number): number {
  return Math.max(-lim, Math.min(lim, v));
}

export class Controller {
  private readonly p: SimParams;
  private readonly kpAtt: number;
  private readonly kdAtt: number;
  private readonly kpPos: number;
  private readonly kdPos: number;
  private readonly kpZ: number;
  private readonly kdZ: number;
  private readonly kpYaw: number;
  private readonly kdYaw: number;
  private readonly mT: number;
  private readonly fMin: number;
  private readonly fMax: number;
  private readonly mc: MixerConsts;
  readonly delayTicks: number;
  private rng: Rng;
  private fifo: Sensed[] = [];

  constructor(p: SimParams, seed?: number) {
    const c = p.control;
    for (const g of [c.inner, c.outer, c.alt, c.yaw]) {
      if (g.Kp === null || g.Kd === null || g.Kp === undefined || g.Kd === undefined) {
        throw new Error('control gains are not set in the parameter file');
      }
    }
    this.p = p;
    this.kpAtt = c.inner.Kp;
    this.kdAtt = c.inner.Kd;
    this.kpPos = c.outer.Kp;
    this.kdPos = c.outer.Kd;
    this.kpZ = c.alt.Kp;
    this.kdZ = c.alt.Kd;
    this.kpYaw = c.yaw.Kp;
    this.kdYaw = c.yaw.Kd;
    this.mT = p.vehicle.m_q + p.pendulum.m_p;
    const kF = p.vehicle.k_f;
    this.fMin = 4.0 * kF * (p.motor.omegaMin * p.motor.omegaMin);
    this.fMax = 4.0 * kF * (p.motor.omegaMax * p.motor.omegaMax);
    this.mc = makeMixerConsts(p);
    const tick = p.sim.controlDecimation * p.sim.dt;
    this.delayTicks = Math.max(0, roundHalfEven((p.sensing.latencyMs * 1e-3) / tick));
    this.rng = new Rng(seed === undefined ? p.sim.seed : seed);
  }

  /** Clear the measurement FIFO and re-seed the noise RNG. */
  reset(seed?: number): void {
    this.fifo = [];
    this.rng = new Rng(seed === undefined ? this.p.sim.seed : seed);
  }

  private sense(meas: Meas): Sensed {
    let [roll, pitch, yaw] = eulerZyx(
      meas.q[0] as number,
      meas.q[1] as number,
      meas.q[2] as number,
      meas.q[3] as number,
    );
    let pos: Vec3 = [meas.pos[0] as number, meas.pos[1] as number, meas.pos[2] as number];
    let vel: Vec3 = [meas.vel[0] as number, meas.vel[1] as number, meas.vel[2] as number];
    let rates: Vec3 = [meas.wB[0] as number, meas.wB[1] as number, meas.wB[2] as number];
    const n = this.p.sensing.noise;
    if (n.enabled) {
      const r = (): number => this.rng.normal();
      // Draw order (must match Python): pos x3, vel x3, roll, pitch, yaw, rates x3.
      pos = [pos[0] + n.pos * r(), pos[1] + n.pos * r(), pos[2] + n.pos * r()];
      vel = [vel[0] + n.rate * r(), vel[1] + n.rate * r(), vel[2] + n.rate * r()];
      roll += n.att * r();
      pitch += n.att * r();
      yaw += n.att * r();
      rates = [rates[0] + n.rate * r(), rates[1] + n.rate * r(), rates[2] + n.rate * r()];
    }
    return { pos, vel, roll, pitch, yaw, rates };
  }

  private delayed(s: Sensed): Sensed {
    this.fifo.push(s);
    if (this.fifo.length > this.delayTicks + 1) this.fifo.shift();
    return this.fifo[0] as Sensed;
  }

  /** One control tick. kTApplied = [pitch/x, roll/y] forward-loop gains. */
  step(
    meas: Meas,
    ref: Ref,
    gs: number,
    kTApplied: readonly [number, number] = [1.0, 1.0],
  ): CtrlOut {
    const g = this.p.sim.g;
    const attMax = this.p.control.attMax;
    const s = this.delayed(this.sense(meas));
    const { roll, pitch, yaw } = s;

    // outer loop, yaw-aligned frame
    const eN = (ref.pos[0] as number) - s.pos[0];
    const eE = (ref.pos[1] as number) - s.pos[1];
    const edN = -s.vel[0];
    const edE = -s.vel[1];
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const eX = cy * eN + sy * eE;
    const eY = -sy * eN + cy * eE;
    const edX = cy * edN + sy * edE;
    const edY = -sy * edN + cy * edE;
    const uX = kTApplied[0] * gs * (this.kpPos * eX + this.kdPos * edX);
    const uY = kTApplied[1] * gs * (this.kpPos * eY + this.kdPos * edY);
    const pitchC = clamp(-uX / g, attMax);
    const rollC = clamp(uY / g, attMax);
    const satAtt = Math.abs(uX / g) > attMax || Math.abs(uY / g) > attMax;

    // inner loop
    const [jx, jy, jz] = this.p.vehicle.J;
    const tauX = jx * (this.kpAtt * (rollC - roll) - this.kdAtt * s.rates[0]);
    const tauY = jy * (this.kpAtt * (pitchC - pitch) - this.kdAtt * s.rates[1]);

    // yaw hold
    const tauZ = jz * (this.kpYaw * (ref.yaw - yaw) - this.kdYaw * s.rates[2]);

    // altitude hold (NED: down positive)
    const eZ = (ref.pos[2] as number) - s.pos[2];
    const edZ = -s.vel[2];
    const tilt = Math.max(Math.cos(roll) * Math.cos(pitch), 0.5);
    let f = (this.mT * (g - this.kpZ * eZ - this.kdZ * edZ)) / tilt;
    const fClamped = f < this.fMin || f > this.fMax;
    f = Math.min(Math.max(f, this.fMin), this.fMax);

    const omegaCmd: Vec4 = [0, 0, 0, 0];
    mix(omegaCmd, f, tauX, tauY, tauZ, this.mc);
    return {
      u: [uX, uY],
      pitchC,
      rollC,
      f,
      tau: [tauX, tauY, tauZ],
      omegaCmd,
      sensed: s,
      satAtt,
      satMotor: fClamped || motorSaturated(f, tauX, tauY, tauZ, this.mc),
    };
  }
}
