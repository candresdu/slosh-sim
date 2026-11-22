// Scenario presets, imported at build time from shared/presets/*.json.
// Mirror of python/src/slosh/presets.py (events sorted by time, stable).
import fig12 from '../../../shared/presets/fig12.json';
import fig13 from '../../../shared/presets/fig13.json';
import fig14 from '../../../shared/presets/fig14.json';
import story from '../../../shared/presets/story.json';
import vb from '../../../shared/presets/vb.json';
import type { AacMode } from './aac';

export type PresetId = 'story' | 'fig12' | 'fig13' | 'fig14' | 'vb';
export const PRESET_IDS: readonly PresetId[] = ['story', 'fig12', 'fig13', 'fig14', 'vb'];

/** A command scheduled at preset time `t` [s]; the remaining keys are the command fields. */
export interface PresetEvent {
  t: number;
  type: 'setGainShift' | 'rampGainShift' | 'setAacMode' | 'kick';
  [key: string]: unknown;
}

export interface Preset {
  id: PresetId;
  title: string;
  caption: string;
  durationS: number;
  initial: {
    theta: number;
    thetaDot: number;
    phi: number;
    phiDot: number;
    gainShift: number;
    aacMode: AacMode;
  };
  events: readonly PresetEvent[];
}

function make(data: unknown, id: PresetId): Preset {
  const d = data as Preset & { schema: string };
  if (d.id !== id) throw new Error(`preset ${id} has id ${String(d.id)}`);
  const events = d.events.map((e) => ({ ...e })).sort((a, b) => a.t - b.t); // Array.sort is stable
  return {
    id: d.id,
    title: d.title,
    caption: d.caption,
    durationS: d.durationS,
    initial: { ...d.initial },
    events,
  };
}

export const PRESETS: Readonly<Record<PresetId, Preset>> = {
  story: make(story, 'story'),
  fig12: make(fig12, 'fig12'),
  fig13: make(fig13, 'fig13'),
  fig14: make(fig14, 'fig14'),
  vb: make(vb, 'vb'),
};

export function loadPreset(id: PresetId): Preset {
  const p = PRESETS[id];
  if (p === undefined) throw new Error(`unknown preset ${String(id)}`);
  return p;
}
