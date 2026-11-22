// Simulation orchestrator: command queue, preset scheduling and one 10 ms control tick.
// Mirror of python/src/slosh/core/sim.py; the order inside a tick is identical:
//
//  1. Commands: queued ones in order, then preset events due this tick. Each applied command is
//     logged as (tick, cmd) with the index of the tick about to run, so a command enqueued
//     between two stepControl() calls takes effect at the start of the next tick.
//  2. Gain-shift ramp advances one linear step.
//  3. AAC per axis (pitch/x, roll/y) from the PREVIOUS tick's u, with the yaw-aligned position error.
//  4. Controller with kTApplied from step 3 and the current gain shift; its mixer output is held.
//  5. controlDecimation RK4 substeps.
//
// Telemetry is sampled at the end of the tick. `t` counts from the last reset / preset load;
// `tick` counts since construction and never resets (replay key).
import { Aac, roundHalfEven, type AacMode, type AacOut, type AacOverrides } from './aac';
import { Controller, measFromState, type Ref } from './controller';
import {
  eulerZyx,
  initialState,
  makeDynConsts,
  massRelative,
  pendulumVectors,
  thetaPhi,
  type DynConsts,
  type Hold,
} from './dynamics';
import type { SimParams } from './params';
import { loadPreset as getPreset, type Preset, type PresetId } from './presets';
import { Rk4Scratch, rk4Step } from './rk4';
import { NX } from './state';

export const GS_MIN = 0.5;
export const GS_MAX = 3.0;
export const KICK_THETA = 0.2;
export const KICK_PHI_DOT = 0.6;

export type SimCommand =
  | { type: 'setGainShift'; value: number }
  | { type: 'rampGainShift'; to: number; durationS: number }
  | { type: 'setAacMode'; mode: AacMode }
  | { type: 'kick'; theta?: number; phiDot?: number }
  | { type: 'clearSchedule' }
  | { type: 'loadPreset'; id: PresetId }
  | { type: 'reset' };

export interface Telemetry {
  /** Sim time since the last reset / preset load [s]. */
  t: number;
  theta: number;
  phi: number;
  massRel: [number, number, number];
  quadPos: [number, number, number];
  roll: number;
  pitch: number;
  yaw: number;
  /** [pitch (x), roll (y)] */
  kT: [number, number];
  kTApplied: [number, number];
  ySD: [number, number];
  detect: [boolean, boolean];
  gainShift: number;
  aacMode: AacMode;
  /** Normalized 0..1 between omegaMin and omegaMax. */
  motorCmd: [number, number, number, number];
  motorOmega: [number, number, number, number];
}

export function clampGainShift(v: number): number {
  return Math.min(GS_MAX, Math.max(GS_MIN, v));
}

const COMMAND_TYPES: readonly string[] = [
  'setGainShift',
  'rampGainShift',
  'setAacMode',
  'kick',
  'clearSchedule',
  'loadPreset',
  'reset',
];
const AAC_MODES: readonly string[] = ['off', 'monitor', 'engaged'];

interface Ramp {
  gs0: number;
  to: number;
  n: number;
  start: number;
}

/** A command as applied: preset events carry no `t`. */
type AnyCommand = SimCommand;

export class Sim {
  private readonly p: SimParams;
  private readonly seed: number;
  private readonly consts: DynConsts;
  private readonly scratch = new Rk4Scratch();
  private readonly ctrl: Controller;
  private readonly aac: readonly [Aac, Aac];
  private readonly dt: number;
  private readonly substeps: number;
  private readonly dtCtrl: number;
  private readonly omegaMin: number;
  private readonly omegaSpan: number;
  private readonly refTarget: Ref = { pos: [0, 0, 0], yaw: 0 };
  private readonly holdTau = new Float64Array(3);
  private readonly holdCmd = new Float64Array(4);
  private readonly hold: Hold = { tau: this.holdTau, omegaCmd: this.holdCmd };

  private _tick = 0;
  private tOrigin = 0;
  private readonly log: Array<[number, SimCommand]> = [];
  private queue: SimCommand[] = [];
  private scheduled: Array<[number, SimCommand]> = [];
  private preset: Preset | null = null;
  private ramp: Ramp | null = null;
  private x: Float64Array = new Float64Array(NX);
  private gs = 1.0;
  private mode: AacMode = 'off';
  private uPrev0 = 0.0;
  private uPrev1 = 0.0;
  private readonly tel: Telemetry = {
    t: 0,
    theta: 0,
    phi: 0,
    massRel: [0, 0, 0],
    quadPos: [0, 0, 0],
    roll: 0,
    pitch: 0,
    yaw: 0,
    kT: [1, 1],
    kTApplied: [1, 1],
    ySD: [0, 0],
    detect: [false, false],
    gainShift: 1,
    aacMode: 'off',
    motorCmd: [0, 0, 0, 0],
    motorOmega: [0, 0, 0, 0],
  };

  /**
   * `aacOverrides` supplies a0, b_s, b_e, threshold while they are still null in the
   * parameter file (the constructor throws otherwise).
   */
  constructor(params: SimParams, seed: number = 1, aacOverrides: AacOverrides = {}) {
    this.p = params;
    this.seed = seed;
    this.consts = makeDynConsts(params);
    this.dt = params.sim.dt;
    this.substeps = params.sim.controlDecimation;
    this.dtCtrl = this.substeps * this.dt;
    this.ctrl = new Controller(params, seed);
    this.aac = [new Aac(params, aacOverrides), new Aac(params, aacOverrides)];
    this.omegaMin = params.motor.omegaMin;
    this.omegaSpan = params.motor.omegaMax - params.motor.omegaMin;
    this.restore();
  }

  /** Current plant state (23 elements). Overwritten every tick: copy if you need to keep it. */
  get state(): Readonly<Float64Array> {
    return this.x;
  }

  /** Control ticks since construction (never resets). */
  get tick(): number {
    return this._tick;
  }

  /** Simulation time since the last reset / preset load [s]. */
  get t(): number {
    return (this._tick - this.tOrigin) * this.dtCtrl;
  }

  /** Applied commands as (tick, command), in order. Scheduled preset events included. */
  commandLog(): ReadonlyArray<readonly [number, SimCommand]> {
    return this.log;
  }

  /** Queue a command; it is applied at the start of the next stepControl(). */
  enqueue(cmd: SimCommand): void {
    const kind = (cmd as { type?: unknown }).type;
    if (typeof kind !== 'string' || !COMMAND_TYPES.includes(kind)) {
      throw new Error(`unknown command type ${String(kind)}`);
    }
    if (cmd.type === 'setAacMode' && !AAC_MODES.includes(cmd.mode)) {
      throw new Error(`unknown AAC mode ${String(cmd.mode)}`);
    }
    this.queue.push({ ...cmd });
  }

  /**
   * Advance one control tick (10 ms) and return its telemetry.
   * The returned object is REUSED on every call (no per-tick allocation): copy values out
   * (e.g. push into a ring buffer) before the next call.
   */
  stepControl(): Telemetry {
    this.applyCommands();
    this.advanceRamp();

    const meas = measFromState(this.x);
    const [eX, eY] = this.refError(meas.q, meas.pos);
    const aP = this.aac[0].step(this.uPrev0, eX, this.mode);
    const aR = this.aac[1].step(this.uPrev1, eY, this.mode);
    const out = this.ctrl.step(meas, this.refTarget, this.gs, [aP.kTApplied, aR.kTApplied]);
    this.uPrev0 = out.u[0];
    this.uPrev1 = out.u[1];

    const hold = this.hold;
    for (let i = 0; i < 3; i++) this.holdTau[i] = out.tau[i] as number;
    for (let i = 0; i < 4; i++) this.holdCmd[i] = out.omegaCmd[i] as number;
    for (let s = 0; s < this.substeps; s++) {
      rk4Step(this.x, this.x, this.dt, hold, this.consts, this.scratch);
    }
    this._tick += 1;
    return this.fillTelemetry(out.omegaCmd, aP, aR);
  }

  // -- commands -------------------------------------------------------------------------

  private applyCommands(): void {
    const pending = this.queue;
    if (pending.length > 0) {
      this.queue = [];
      for (const cmd of pending) this.apply(cmd);
    }
    // Scheduled events due now (re-checked: a loadPreset above may schedule t = 0 events).
    while (this.scheduled.length > 0 && (this.scheduled[0] as [number, SimCommand])[0] <= this._tick) {
      const [, cmd] = this.scheduled.shift() as [number, SimCommand];
      this.apply(cmd);
    }
  }

  private apply(cmd: AnyCommand): void {
    this.log.push([this._tick, cmd]);
    switch (cmd.type) {
      case 'setGainShift':
        this.gs = clampGainShift(cmd.value);
        this.ramp = null;
        break;
      case 'rampGainShift': {
        const n = roundHalfEven(cmd.durationS / this.dtCtrl);
        const to = clampGainShift(cmd.to);
        if (n <= 0) {
          this.gs = to;
          this.ramp = null;
        } else {
          this.ramp = { gs0: this.gs, to, n, start: this._tick };
        }
        break;
      }
      case 'setAacMode':
        this.mode = cmd.mode;
        break;
      case 'kick':
        this.kick(cmd.theta ?? KICK_THETA, cmd.phiDot ?? KICK_PHI_DOT);
        break;
      case 'clearSchedule':
        // Runtime only: state, gain shift, mode and a running ramp are untouched.
        this.scheduled = [];
        break;
      case 'loadPreset':
        this.preset = getPreset(cmd.id);
        this.restore();
        break;
      case 'reset':
        this.restore();
        break;
    }
  }

  /** Set n and w_p from (theta, 0, current phi, phiDot); the rest of the state is kept. */
  private kick(theta: number, phiDot: number): void {
    const x = this.x;
    const phi = Math.atan2(x[14] as number, x[13] as number);
    const [n, w] = pendulumVectors(theta, 0.0, phi, phiDot);
    x[13] = n[0];
    x[14] = n[1];
    x[15] = n[2];
    x[16] = w[0];
    x[17] = w[1];
    x[18] = w[2];
  }

  private advanceRamp(): void {
    const r = this.ramp;
    if (r === null) return;
    const k = this._tick - r.start + 1;
    if (k >= r.n) {
      this.gs = r.to;
      this.ramp = null;
    } else {
      this.gs = r.gs0 + (r.to - r.gs0) * (k / r.n);
    }
  }

  /** Reset plant, controller, AAC, gain shift and schedule; apply the active preset. */
  private restore(): void {
    this.ctrl.reset(this.seed);
    for (const a of this.aac) a.reset();
    this.ramp = null;
    this.scheduled = [];
    this.uPrev0 = 0.0;
    this.uPrev1 = 0.0;
    this.tOrigin = this._tick;
    const pre = this.preset;
    if (pre === null) {
      this.x = initialState(this.p);
      this.gs = 1.0;
      this.mode = 'off';
      return;
    }
    const i = pre.initial;
    this.x = initialState(this.p, i.theta, i.thetaDot, i.phi, i.phiDot);
    this.gs = clampGainShift(i.gainShift);
    this.mode = i.aacMode;
    for (const ev of pre.events) {
      const { t, ...cmd } = ev;
      this.scheduled.push([this._tick + roundHalfEven(t / this.dtCtrl), cmd as unknown as SimCommand]);
    }
    this.scheduled.sort((a, b) => a[0] - b[0]); // stable
  }

  // -- helpers --------------------------------------------------------------------------

  /** True position error in the yaw-aligned frame (input to the AAC reference-error path). */
  private refError(q: ArrayLike<number>, pos: ArrayLike<number>): [number, number] {
    const yaw = eulerZyx(q[0] as number, q[1] as number, q[2] as number, q[3] as number)[2];
    const en = (this.refTarget.pos[0] as number) - (pos[0] as number);
    const ee = (this.refTarget.pos[1] as number) - (pos[1] as number);
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    return [cy * en + sy * ee, -sy * en + cy * ee];
  }

  private fillTelemetry(omegaCmd: ArrayLike<number>, aP: AacOut, aR: AacOut): Telemetry {
    const x = this.x;
    const tel = this.tel;
    const [theta, phi] = thetaPhi(x);
    const [mx, my, mz] = massRelative(x, this.p.pendulum.L);
    const [roll, pitch, yaw] = eulerZyx(
      x[6] as number,
      x[7] as number,
      x[8] as number,
      x[9] as number,
    );
    tel.t = this.t;
    tel.theta = theta;
    tel.phi = phi;
    tel.massRel[0] = mx;
    tel.massRel[1] = my;
    tel.massRel[2] = mz;
    tel.quadPos[0] = x[0] as number;
    tel.quadPos[1] = x[1] as number;
    tel.quadPos[2] = x[2] as number;
    tel.roll = roll;
    tel.pitch = pitch;
    tel.yaw = yaw;
    tel.kT[0] = aP.kT;
    tel.kT[1] = aR.kT;
    tel.kTApplied[0] = aP.kTApplied;
    tel.kTApplied[1] = aR.kTApplied;
    tel.ySD[0] = aP.ySD;
    tel.ySD[1] = aR.ySD;
    tel.detect[0] = aP.detect;
    tel.detect[1] = aR.detect;
    tel.gainShift = this.gs;
    tel.aacMode = this.mode;
    for (let i = 0; i < 4; i++) {
      tel.motorCmd[i] = ((omegaCmd[i] as number) - this.omegaMin) / this.omegaSpan;
      tel.motorOmega[i] = x[19 + i] as number;
    }
    return tel;
  }
}
