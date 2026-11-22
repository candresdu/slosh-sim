// Reader controls: regime buttons (Experiment mode), Replay the paper, Restart (the regime bar, mounted inside the
// 3D view when `regimeContainer` is given) and the Fine-tune panel (gain-shift slider, AAC mode radios).
// The video-style play/pause, speed and full screen controls live in player.ts, the info banner in banner.ts.
// Native elements only. Colours come from CSS custom properties (--sc-*), so the theme can switch them
// by calling `setPalette` (or by setting the properties on any ancestor).
import { PRESETS } from '../core/presets';
import type { AacMode } from '../core/aac';
import type { SimCommand, Telemetry } from '../core/sim';
import { regimeOf } from '../runtime/telemetry-ring';
import { REPLAY_LABEL, STORY_REGIMES, storyCommands, type StoryAction, type StoryRegime } from './story';
import type { CssPalette } from './theme';

/** The part of the runner the controls drive. `Runner` satisfies this structurally. */
export interface ControlsHost {
  /** A list is applied in order at one control-tick boundary. */
  send(cmd: SimCommand | readonly SimCommand[]): void;
}

export interface ControlsOptions {
  host: ControlsHost;
  /** Where the regime bar goes (the 3D view's frame). Default: inside the controls root. */
  regimeContainer?: HTMLElement;
  /** Called after a story control was used (its commands are already sent), so the owner can emit events. */
  onStoryAction?: (action: StoryAction) => void;
  /** The θ envelope (2 s sliding max) [rad], read when a regime button is tapped; without it no disturbance is added. */
  thetaEnvelope?: () => number;
  /** Initial controls state (default: gain shift 1, AAC off). */
  initial?: { gainShift?: number; aacMode?: AacMode };
}

export interface ControlsHandle {
  readonly element: HTMLElement;
  /** The regime bar: regime buttons, Replay the paper, Restart. */
  readonly regimeBar: HTMLElement;
  /** Container inside Fine-tune (advanced) for the parameter panel. */
  readonly aboutSlot: HTMLElement;
  /** Follow the simulation: move the slider and the mode radio to the telemetry state. */
  sync(tel: Readonly<Telemetry>): void;
  setPalette(css: CssPalette): void;
  dispose(): void;
}

export const GAIN_SHIFT_MIN = 0.5;
export const GAIN_SHIFT_MAX = 3.0;
export const GAIN_SHIFT_STEP = 0.05;

const MODES: ReadonlyArray<{ id: AacMode; label: string }> = [
  { id: 'off', label: 'Off' },
  { id: 'monitor', label: 'Monitor' },
  { id: 'engaged', label: 'Engaged' },
];

/** If the sim has not confirmed a pending change after this much sim time, follow the sim again. */
const HOLD_TIMEOUT_S = 0.5;

export const CONTROLS_CSS = `
.sc-controls { display: flex; flex-direction: column; gap: 10px; font: 14px/1.4 system-ui, sans-serif; color: var(--sc-fg, inherit); }
.sc-controls * { box-sizing: border-box; }
.sc-row { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; }
.sc-controls button, .sc-controls input, .sc-controls summary { font: inherit; }
.sc-controls.sc-regime { flex-direction: row; gap: 6px; }
.sc-controls button { min-height: 36px; padding: 4px 12px; border-radius: 6px; cursor: pointer;
  color: var(--sc-fg, inherit); background: var(--sc-surface, transparent); border: 1px solid var(--sc-border, currentColor); }
.sc-controls button:hover { border-color: var(--sc-accent, currentColor); }
.sc-controls button[aria-pressed="true"] { background: var(--sc-accent, #0b5cad); color: var(--sc-accent-fg, #fff); border-color: var(--sc-accent, #0b5cad); }
.sc-controls button[hidden] { display: none; }
.sc-controls :focus-visible { outline: 3px solid var(--sc-focus, #0b5cad); outline-offset: 2px; }
.sc-gs { display: flex; align-items: center; gap: 8px; flex: 1 1 260px; }
.sc-gs input[type=range] { flex: 1 1 auto; min-width: 120px; accent-color: var(--sc-accent, #0b5cad); }
.sc-gs output { min-width: 3.2em; font-variant-numeric: tabular-nums; font-weight: 600; }
.sc-controls fieldset { border: 1px solid var(--sc-border, currentColor); border-radius: 6px; margin: 0; padding: 4px 10px 6px; }
.sc-controls legend { padding: 0 4px; color: var(--sc-muted, inherit); }
.sc-controls fieldset label { margin-right: 12px; white-space: nowrap; }
.sc-regime { display: flex; flex-wrap: wrap; gap: 6px; align-items: stretch; padding: 6px; }
.sc-regime button { min-height: 40px; min-width: 40px; line-height: 1.2; }
.sc-regime button .sc-fig { white-space: nowrap; }
.sc-exp > summary { cursor: pointer; font-weight: 700; padding: 6px 0; }
.sc-exp > .sc-exp-body { display: flex; flex-direction: column; gap: 10px; padding-top: 4px; }
`;

let uid = 0;

/** Set the --sc-* custom properties of the component CSS on `el`. */
export function applyCssPalette(el: HTMLElement, c: CssPalette): void {
  const s = el.style;
  s.setProperty('--sc-bg', c.bg);
  s.setProperty('--sc-surface', c.surface);
  s.setProperty('--sc-fg', c.fg);
  s.setProperty('--sc-muted', c.muted);
  s.setProperty('--sc-border', c.border);
  s.setProperty('--sc-accent', c.accent);
  s.setProperty('--sc-accent-fg', c.accentFg);
  s.setProperty('--sc-danger', c.danger);
  s.setProperty('--sc-danger-bg', c.dangerBg);
  s.setProperty('--sc-focus', c.focus);
}

function clampGs(v: number): number {
  return Math.min(GAIN_SHIFT_MAX, Math.max(GAIN_SHIFT_MIN, v));
}

function fmtGs(v: number): string {
  return v.toFixed(2);
}

interface Hold<T> {
  value: T;
  t0: number;
}

export function createControls(container: HTMLElement, opts: ControlsOptions): ControlsHandle {
  const doc = container.ownerDocument;
  const host = opts.host;
  const id = `sc${++uid}`;
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string): HTMLElementTagNameMap[K] => {
    const e = doc.createElement(tag);
    if (cls !== undefined) e.className = cls;
    return e;
  };

  const root = el('div', 'sc-controls');
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'Simulation controls');

  // --- gain shift + AAC mode ---
  const rowA = el('div', 'sc-row');
  const gsWrap = el('div', 'sc-gs');
  const gsLabel = el('label');
  gsLabel.htmlFor = `${id}-gs`;
  gsLabel.textContent = 'Gain shift';
  const slider = el('input');
  slider.type = 'range';
  slider.id = `${id}-gs`;
  slider.min = String(GAIN_SHIFT_MIN);
  slider.max = String(GAIN_SHIFT_MAX);
  slider.step = String(GAIN_SHIFT_STEP);
  slider.setAttribute('aria-label', 'Gain shift');
  const gsOut = el('output');
  gsOut.htmlFor = slider.id;
  gsOut.setAttribute('aria-live', 'off');
  gsWrap.append(gsLabel, slider, gsOut);

  const fieldset = el('fieldset');
  const legend = el('legend');
  legend.textContent = 'AAC mode';
  fieldset.appendChild(legend);
  const radios = new Map<AacMode, HTMLInputElement>();
  for (const m of MODES) {
    const lab = el('label');
    const r = el('input');
    r.type = 'radio';
    r.name = `${id}-mode`;
    r.value = m.id;
    lab.append(r, doc.createTextNode(` ${m.label}`));
    fieldset.appendChild(lab);
    radios.set(m.id, r);
  }
  rowA.append(gsWrap, fieldset);

  const button = (text: string, label: string): HTMLButtonElement => {
    const b = el('button');
    b.type = 'button';
    b.textContent = text;
    b.setAttribute('aria-label', label);
    return b;
  };

  // --- story mode (first, always expanded) ---
  const storyBar = el('div', 'sc-controls sc-regime');
  storyBar.setAttribute('role', 'group');
  storyBar.setAttribute('aria-label', 'Regime');
  const regimeBtns = new Map<StoryRegime, HTMLButtonElement>();
  for (const r of STORY_REGIMES) {
    const b = button(r.label, r.name);
    // "Gain shift · Fig 13": the figure stays visible when the label wraps to two lines (below 640 px)
    const cut = r.label.indexOf(' · ');
    if (cut > 0) {
      const fig = el('span', 'sc-fig');
      const dot = el('span', 'sc-dot');
      dot.textContent = ' · ';
      fig.append(dot, doc.createTextNode(r.label.slice(cut + 3)));
      b.textContent = '';
      b.append(el('span', 'sc-name'), fig);
      (b.firstChild as HTMLElement).textContent = r.label.slice(0, cut);
    }
    b.dataset.regime = r.id;
    b.setAttribute('aria-pressed', 'false');
    regimeBtns.set(r.id, b);
    storyBar.appendChild(b);
  }
  const playBtn = button(REPLAY_LABEL, REPLAY_LABEL);
  playBtn.dataset.story = 'play';
  const restartBtn = button('Restart', 'Restart');
  restartBtn.dataset.story = 'restart';
  storyBar.append(playBtn, restartBtn);

  // --- Fine-tune (advanced): a <details>, closed by default ---
  const expBox = el('details', 'sc-exp');
  expBox.open = false;
  const expSummary = el('summary');
  expSummary.textContent = 'Fine-tune (advanced)';
  const expBody = el('div', 'sc-exp-body');
  const aboutSlot = el('div', 'sc-exp-about');
  expBody.append(rowA, aboutSlot);
  expBox.append(expSummary, expBody);

  root.append(expBox);
  container.appendChild(root);
  (opts.regimeContainer ?? root).prepend(storyBar);

  // --- state ---
  let lastT = 0;
  let gsHold: Hold<number> | null = null;
  let modeHold: Hold<AacMode> | null = null;
  let presetHold: Hold<null> | null = null;

  const showGs = (v: number): void => {
    const txt = fmtGs(v);
    if (gsOut.textContent !== txt) gsOut.textContent = txt;
    if (slider.value !== String(v)) slider.value = String(v);
  };
  const showMode = (m: AacMode): void => {
    for (const [k, r] of radios) r.checked = k === m;
  };
  showGs(clampGs(opts.initial?.gainShift ?? 1));
  showMode(opts.initial?.aacMode ?? 'off');

  const storyAction = (action: StoryAction): void => {
    host.send(storyCommands(action, action.kind === 'regime' ? (opts.thetaEnvelope?.() ?? Number.POSITIVE_INFINITY) : undefined));
    gsHold = null;
    modeHold = null;
    if (action.kind !== 'regime') {
      presetHold = { value: null, t0: lastT };
      const init = PRESETS.story.initial;
      showGs(clampGs(init.gainShift));
      showMode(init.aacMode);
    }
    opts.onStoryAction?.(action);
  };
  for (const [r, b] of regimeBtns) b.addEventListener('click', () => storyAction({ kind: 'regime', regime: r }));
  playBtn.addEventListener('click', () => storyAction({ kind: 'play' }));
  restartBtn.addEventListener('click', () => storyAction({ kind: 'restart' }));

  const onSlider = (): void => {
    const v = clampGs(Number(slider.value));
    gsOut.textContent = fmtGs(v);
    gsHold = { value: v, t0: lastT };
    host.send({ type: 'setGainShift', value: v });
  };
  slider.addEventListener('input', onSlider);

  for (const [m, r] of radios) {
    r.addEventListener('change', () => {
      if (!r.checked) return;
      modeHold = { value: m, t0: lastT };
      host.send({ type: 'setAacMode', mode: m });
    });
  }

  const handle: ControlsHandle = {
    element: root,
    regimeBar: storyBar,
    aboutSlot,
    sync(tel) {
      const restarted = tel.t < lastT;
      if (restarted) {
        gsHold = null;
        modeHold = null;
        presetHold = null;
      }
      lastT = tel.t;
      const cur = regimeOf(tel);
      for (const [r, b] of regimeBtns) {
        const on = String(r === cur);
        if (b.getAttribute('aria-pressed') !== on) b.setAttribute('aria-pressed', on);
      }
      if (presetHold !== null && (tel.t <= presetHold.t0 || tel.t > presetHold.t0 + HOLD_TIMEOUT_S)) presetHold = null;
      if (gsHold !== null && (Math.abs(tel.gainShift - gsHold.value) < 1e-9 || tel.t > gsHold.t0 + HOLD_TIMEOUT_S)) {
        gsHold = null;
      }
      if (modeHold !== null && (tel.aacMode === modeHold.value || tel.t > modeHold.t0 + HOLD_TIMEOUT_S)) {
        modeHold = null;
      }
      if (gsHold === null && presetHold === null) {
        showGs(clampGs(tel.gainShift));
      }
      if (modeHold === null && presetHold === null) showMode(tel.aacMode);
    },
    setPalette(css) {
      applyCssPalette(root, css);
      applyCssPalette(storyBar, css);
    },
    dispose() {
      storyBar.remove();
      root.remove();
    },
  };
  return handle;
}
