// Adaptive augmenting control: per-axis K_T law, spectral damper, detector, modes.
// Mirror of python/src/slosh/core/aac.py. One Aac instance serves one axis (pitch/x or roll/y),
// stepped once per control tick (100 Hz).
//
//   y_SD = LP( HP(u_a)^2 )
//   k_T' = -a0 (k_T - 1) + b_e e_ref^2 (kMax - k_T) - b_s y_SD (k_T - kMin)   (forward Euler, dt = 0.01, clamp)
//
// Detector: trips (latched) when y_SD > threshold; clears once y_SD < clearRatio * threshold for
// clearHoldS seconds continuously. tripEdge is true on each rising edge.
// Modes: off (reset, k_T = 1), monitor (run, kT_applied = 1), engaged (run, kT_applied = k_T,
// rate-limited from 1 after switching to engaged when engageRampS > 0).
import { Sos } from './filters';
import type { SimParams } from './params';

export const AAC_DT = 0.01;

export type AacMode = 'off' | 'monitor' | 'engaged';

export interface AacOut {
  /** Adaptive state. */
  kT: number;
  /** What the forward loop uses. */
  kTApplied: number;
  ySD: number;
  /** Detector latch. */
  detect: boolean;
  /** True on the tick the latch goes from clear to tripped. */
  tripEdge: boolean;
}

export interface AacOverrides {
  a0?: number;
  b_s?: number;
  b_e?: number;
  threshold?: number;
}

/** Python-style round(): half to even. */
export function roundHalfEven(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** (tl s + 1)/(tg s + 1) via Tustin; unity DC gain; direct form II transposed. */
export class LeadLag {
  private readonly b0: number;
  private readonly b1: number;
  private readonly a1: number;
  private z = 0.0;

  constructor(tLead: number, tLag: number, dt: number = AAC_DT) {
    const c = 2.0 / dt;
    const den = c * tLag + 1.0;
    this.b0 = (c * tLead + 1.0) / den;
    this.b1 = (1.0 - c * tLead) / den;
    this.a1 = (1.0 - c * tLag) / den;
  }

  step(x: number): number {
    const y = this.b0 * x + this.z;
    this.z = this.b1 * x - this.a1 * y;
    return y;
  }

  reset(): void {
    this.z = 0.0;
  }
}

function pick(name: string, override: number | undefined, dflt: number | null): number {
  const v = override === undefined ? dflt : override;
  if (v === null) throw new Error(`aac.${name} is not tuned yet; pass it explicitly`);
  return v;
}

export class Aac {
  readonly a0: number;
  readonly bS: number;
  readonly bE: number;
  readonly threshold: number;
  private readonly kMin: number;
  private readonly kMax: number;
  private readonly clearLevel: number;
  private readonly clearTicks: number;
  private readonly slew: number;
  private readonly hp: Sos;
  private readonly lp: Sos;
  private readonly eFilt: LeadLag;

  // state
  private k = 1.0;
  private kApplied = 1.0;
  private y = 0.0;
  private detect = false;
  private calm = 0;
  private mode: AacMode = 'off';

  constructor(p: SimParams, ov: AacOverrides = {}) {
    const a = p.aac;
    this.a0 = pick('a0', ov.a0, a.a0);
    this.bS = pick('b_s', ov.b_s, a.b_s);
    this.bE = ov.b_e === undefined ? a.b_e : ov.b_e;
    this.threshold = pick('threshold', ov.threshold, a.threshold);
    this.kMin = a.kMin;
    this.kMax = a.kMax;
    this.clearLevel = a.clearRatio * this.threshold;
    this.clearTicks = roundHalfEven(a.clearHoldS / AAC_DT);
    this.slew = a.engageRampS > 0.0 ? ((a.kMax - a.kMin) / a.engageRampS) * AAC_DT : Infinity;
    this.hp = new Sos(a.hp.sos);
    this.lp = new Sos(a.lp.sos);
    this.eFilt = new LeadLag(a.refLeadS, a.refLagS);
    this.reset();
  }

  /** Back to the Off state: filters cleared, k_T = 1, detector clear. */
  reset(): void {
    this.hp.reset();
    this.lp.reset();
    this.eFilt.reset();
    this.k = 1.0;
    this.kApplied = 1.0;
    this.y = 0.0;
    this.detect = false;
    this.calm = 0;
    this.mode = 'off';
  }

  /** Advance one control tick (0.01 s). */
  step(uA: number, eRefA: number, mode: AacMode): AacOut {
    if (mode !== 'off' && mode !== 'monitor' && mode !== 'engaged') {
      throw new Error(`unknown AAC mode ${String(mode)}`);
    }
    if (mode === 'off') {
      this.reset();
      return { kT: 1.0, kTApplied: 1.0, ySD: 0.0, detect: false, tripEdge: false };
    }

    // Spectral damper and reference-error filter (monitor and engaged).
    const h = this.hp.step(uA);
    this.y = this.lp.step(h * h);
    const e = this.eFilt.step(eRefA);

    // Adaptive law: forward Euler, then clamp.
    let k = this.k;
    const kd =
      -this.a0 * (k - 1.0) +
      this.bE * e * e * (this.kMax - k) -
      this.bS * this.y * (k - this.kMin);
    k += AAC_DT * kd;
    this.k = Math.min(this.kMax, Math.max(this.kMin, k));

    // Detector with hysteresis.
    let edge = false;
    if (this.y > this.threshold) {
      edge = !this.detect;
      this.detect = true;
      this.calm = 0;
    } else if (this.detect) {
      if (this.y < this.clearLevel) {
        this.calm += 1;
        if (this.calm >= this.clearTicks) {
          this.detect = false;
          this.calm = 0;
        }
      } else {
        this.calm = 0;
      }
    }

    // Applied gain: 1 in monitor; in engaged, k_T (rate-limited from 1 right after engaging).
    if (mode === 'monitor') {
      this.kApplied = 1.0;
    } else {
      const cur = this.mode === 'engaged' ? this.kApplied : 1.0;
      if (this.slew === Infinity) {
        this.kApplied = this.k;
      } else {
        this.kApplied =
          this.k > cur ? Math.min(this.k, cur + this.slew) : Math.max(this.k, cur - this.slew);
      }
    }
    this.mode = mode;
    return { kT: this.k, kTApplied: this.kApplied, ySD: this.y, detect: this.detect, tripEdge: edge };
  }
}
