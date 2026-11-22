// Story mode: the command lists behind the story controls and the narration caption.
// DOM-free. The regime buttons change the RUNNING simulation (they never send `reset` or
// `loadPreset`); "Replay the paper" and "Restart" reload the story preset.
import { PRESETS } from '../core/presets';
import type { SimCommand } from '../core/sim';
import { regimeOf, type Regime, type TelemetryRing } from '../runtime/telemetry-ring';
import { thetaAmplitude, type Trend } from './summary';
import type { AacMode } from '../core/aac';

/** Gain-shift ramp of the regime buttons [s]; equal to the ramp in shared/presets/story.json. */
export const STORY_RAMP_S = 1.5;
/** Gain shift of the "Gain shift" regime. */
export const STORY_GAIN_SHIFT = 2.3;
/** Nominal gain shift. */
export const NOMINAL_GAIN_SHIFT = 1;

export type StoryRegime = Regime;

/** Regime buttons: the label cites the R-1 figure each regime reproduces; `name` is the accessible name. */
export const STORY_REGIMES: ReadonlyArray<{ id: StoryRegime; label: string; fig: string; name: string }> = [
  { id: 'nominal', label: 'Nominal \u00b7 Fig 12', fig: 'Fig 12', name: 'Nominal \u00b7 Fig 12' },
  { id: 'gainShift', label: 'Gain shift \u00b7 Fig 13', fig: 'Fig 13', name: 'Gain shift \u00b7 Fig 13' },
  { id: 'engaged', label: 'AAC engaged \u00b7 Fig 14', fig: 'Fig 14', name: 'AAC engaged \u00b7 Fig 14' },
];

/** Label of the "Replay the paper" button. */
export const REPLAY_LABEL = 'Replay the paper';

/** θ envelope [rad] below which a Gain shift tap also applies the standard disturbance (kick). */
export const DISTURBANCE_THETA = 0.05;
/** The standard disturbance: θ [rad] and φ̇ [rad/s] (same as the presets' initial kick). */
export const DISTURBANCE_THETA0 = 0.2;
export const DISTURBANCE_PHI_DOT = 0.6;

export type StoryAction = { kind: 'regime'; regime: StoryRegime } | { kind: 'play' } | { kind: 'restart' };

/**
 * Commands of a regime button; they cancel the remaining scheduled steps and never reset the state.
 * `thetaEnv` is the θ envelope (2 s sliding max): a Gain shift tap on a quiet pendulum (< 0.05 rad)
 * also applies the standard kick in the same command list, so the instability shows up promptly.
 */
export function regimeCommands(regime: StoryRegime, thetaEnv: number = Number.POSITIVE_INFINITY): SimCommand[] {
  switch (regime) {
    case 'nominal':
      return [
        { type: 'clearSchedule' },
        { type: 'rampGainShift', to: NOMINAL_GAIN_SHIFT, durationS: STORY_RAMP_S },
        { type: 'setAacMode', mode: 'off' },
      ];
    case 'gainShift': {
      const cmds: SimCommand[] = [
        { type: 'clearSchedule' },
        { type: 'rampGainShift', to: STORY_GAIN_SHIFT, durationS: STORY_RAMP_S },
        { type: 'setAacMode', mode: 'monitor' },
      ];
      if (thetaEnv < DISTURBANCE_THETA) cmds.push({ type: 'kick', theta: DISTURBANCE_THETA0, phiDot: DISTURBANCE_PHI_DOT });
      return cmds;
    }
    case 'engaged':
      // The current gain shift is kept; K_T is applied as an immediate step.
      return [{ type: 'clearSchedule' }, { type: 'setAacMode', mode: 'engaged' }];
  }
}

/** Replay the paper: reset to the story's initial state, then run its scheduled events. */
export function playStoryCommands(): SimCommand[] {
  return [{ type: 'loadPreset', id: 'story' }];
}

/** Restart: the story's initial state with nothing scheduled. */
export function restartStoryCommands(): SimCommand[] {
  return [{ type: 'loadPreset', id: 'story' }, { type: 'clearSchedule' }];
}

export function storyCommands(a: StoryAction, thetaEnv?: number): SimCommand[] {
  switch (a.kind) {
    case 'regime':
      return regimeCommands(a.regime, thetaEnv);
    case 'play':
      return playStoryCommands();
    case 'restart':
      return restartStoryCommands();
  }
}

/** The current θ envelope (2 s sliding max) of the ring [rad]; 0 for an empty ring. */
export function ringThetaEnvelope(ring: TelemetryRing): number {
  return thetaAmplitude(ring.view('t'), ring.view('theta')).amplitude;
}

/** The story preset's initial state (shown at mount and after Restart). */
export const STORY_INITIAL = PRESETS.story.initial;

// ---- narration ------------------------------------------------------------------------

/** K_T (applied) below this counts as "lowered". */
export const KT_LOWERED = 0.95;
/** Narration is evaluated at most this often [s of sim time]. */
export const NARRATION_PERIOD_S = 0.5;

export interface NarrationInput {
  regime: StoryRegime;
  /** Sim time since the current regime began [s]. */
  tSinceEntry: number;
  /** θ envelope: 2 s sliding max [rad]. */
  thetaEnv: number;
  thetaTrend: Trend;
  /** Seconds from the regime entry to the first detector trip since then; undefined if none. */
  tripSinceEntry?: number | undefined;
  /** Smallest applied K_T over both axes. */
  kTApplied: number;
  aacMode: AacMode;
}

/** The caption for the current regime. Pure. */
export function narrate(i: NarrationInput): string {
  let s: string;
  switch (i.regime) {
    case 'nominal':
      s = 'Nominal: the PD controller damps the slosh.';
      break;
    case 'gainShift':
      if (i.tripSinceEntry !== undefined) {
        s = `Detector tripped ${i.tripSinceEntry.toFixed(1)} s after the shift. K_T is computed but not applied.`;
      } else if (i.aacMode === 'off') {
        s =
          i.thetaTrend === 'growing'
            ? 'The slosh oscillation is now growing; the AAC is off, so nothing is watching.'
            : 'Gain shift applied with the AAC off; nothing is watching the slosh.';
      } else if (i.thetaTrend === 'growing') {
        s = 'The slosh oscillation is now growing; the detector is watching.';
      } else {
        s = 'Gain shift applied; the detector is watching the slosh.';
      }
      break;
    case 'engaged':
      if (i.kTApplied < KT_LOWERED) {
        s =
          i.thetaTrend === 'decaying'
            ? 'K_T lowered, oscillation decays.'
            : `K_T lowered to ${i.kTApplied.toFixed(2)}; the AAC is suppressing the oscillation.`;
      } else {
        s = 'AAC engaged: K_T is applied; it drops when the detector sees the slosh grow.';
      }
      break;
  }
  return s;
}

/**
 * Evaluates the caption from the ring at most every NARRATION_PERIOD_S of sim time and reports
 * only changes (so the accessible summary is not re-announced for an unchanged caption).
 */
export class StoryNarrator {
  private lastEval = Number.NEGATIVE_INFINITY;
  private _caption = '';

  get caption(): string {
    return this._caption;
  }

  /** Returns the new caption if it changed, else null. `force` skips the 2 Hz throttle. */
  update(ring: TelemetryRing, force = false): string | null {
    const latest = ring.latest();
    if (latest === null) return null;
    if (latest.t < this.lastEval) force = true; // the sim restarted
    if (!force && latest.t < this.lastEval + NARRATION_PERIOD_S - 1e-9) return null;
    this.lastEval = latest.t;

    const regime = regimeOf(latest);
    const bands = ring.bands();
    const band = bands[bands.length - 1];
    const entry = band !== undefined && band.regime === regime ? band.t0 : latest.t;
    const trip = ring.detections().find((d) => d.t >= entry - 1e-9);
    const { amplitude, trend } = thetaAmplitude(ring.view('t'), ring.view('theta'));
    const text = narrate({
      regime,
      tSinceEntry: latest.t - entry,
      thetaEnv: amplitude,
      thetaTrend: trend,
      tripSinceEntry: trip === undefined ? undefined : trip.t - entry,
      kTApplied: Math.min(latest.kTApplied[0], latest.kTApplied[1]),
      aacMode: latest.aacMode,
    });
    if (text === this._caption) return null;
    this._caption = text;
    return text;
  }

  reset(): void {
    this.lastEval = Number.NEGATIVE_INFINITY;
    this._caption = '';
  }
}
