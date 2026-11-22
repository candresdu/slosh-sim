// Video-style player controls inside the 3D view: a player bar (play/pause, speed, full screen), a centred
// play overlay while the reader has paused, and tap-to-toggle on the view. A tap (pointer moves < 8 px and lasts
// < 300 ms) toggles play/pause; a longer or wider gesture is an OrbitControls drag and does not.
// DOM-light: creates only its own elements. Colours come from the --sc-* custom properties.

/** Largest pointer movement [px] that still counts as a tap. */
export const TAP_MAX_MOVE_PX = 8;
/** Longest press [ms] that still counts as a tap. */
export const TAP_MAX_MS = 300;

/** Tap/drag discrimination for one pointer at a time. Pure: no DOM, time is passed in. */
export class TapDetector {
  private id: number | null = null;
  private x0 = 0;
  private y0 = 0;
  private t0 = 0;
  private moved = false;

  down(id: number, x: number, y: number, t: number): void {
    if (this.id !== null && this.id !== id) {
      this.cancel(); // a second finger: a pinch or two-finger gesture, never a tap
      this.moved = true;
      return;
    }
    this.id = id;
    this.x0 = x;
    this.y0 = y;
    this.t0 = t;
    this.moved = false;
  }

  move(id: number, x: number, y: number): void {
    if (id !== this.id) return;
    if (Math.hypot(x - this.x0, y - this.y0) >= TAP_MAX_MOVE_PX) this.moved = true;
  }

  /** True if the release completes a tap. */
  up(id: number, x: number, y: number, t: number): boolean {
    if (id !== this.id) return false;
    const tap = !this.moved && Math.hypot(x - this.x0, y - this.y0) < TAP_MAX_MOVE_PX && t - this.t0 < TAP_MAX_MS;
    this.cancel();
    return tap;
  }

  cancel(): void {
    this.id = null;
    this.moved = false;
  }
}

/** The part of the runner the player drives. */
export interface PlayerHost {
  pause(): void;
  resume(): void;
  setSpeed(s: 1 | 0.5): void;
}

export interface PlayerOptions {
  host: PlayerHost;
  /** The 3D view's frame; the player bar is appended to `dock` (or here when no dock is given). */
  view: HTMLElement;
  /** Where the player bar goes (above the info banner). Default: `view`. */
  dock?: HTMLElement;
  /** The surface taps and Space/K act on (the scene box). The play overlay is attached to it. */
  surface: HTMLElement;
  onFullscreenToggle?: () => void;
  showFullscreen?: boolean;
  /** Clock for tap timing [ms] (default performance.now). */
  now?: () => number;
}

export interface PlayerHandle {
  readonly bar: HTMLElement;
  /** The play button on the overlay (aria-label "Play"). */
  readonly overlay: HTMLButtonElement;
  /** The overlay's scrim (hidden unless the reader has paused). */
  readonly scrim: HTMLElement;
  /** Show the user-pause state: Play label, aria-pressed and the overlay. Off-screen and tab-hidden pauses must not call this. */
  setPaused(paused: boolean): void;
  isPaused(): boolean;
  /** Show the speed toggle state without sending a command. */
  setSpeed(s: 1 | 0.5): void;
  setFullscreenActive(active: boolean): void;
  setFullscreenVisible(visible: boolean): void;
  dispose(): void;
}

export const PLAYER_CSS = `
.sc-player { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 6px; z-index: 3;
  font: 14px/1.4 system-ui, sans-serif; color: var(--sc-fg, inherit);
  background: color-mix(in srgb, var(--sc-surface, #fff) 80%, transparent); }
.sc-player * { box-sizing: border-box; }
.sc-player button { font: inherit; min-height: 40px; min-width: 40px; padding: 4px 12px; border-radius: 6px; cursor: pointer;
  color: var(--sc-fg, inherit); background: var(--sc-surface, transparent); border: 1px solid var(--sc-border, currentColor); }
.sc-player button:hover { border-color: var(--sc-accent, currentColor); }
.sc-player button[aria-pressed="true"] { background: var(--sc-accent, #0b5cad); color: var(--sc-accent-fg, #fff); border-color: var(--sc-accent, #0b5cad); }
.sc-player button[hidden] { display: none; }
.sc-player .sc-grow { flex: 1 1 8px; }
.sc-player :focus-visible, .sc-play-overlay :focus-visible { outline: 3px solid var(--sc-focus, #0b5cad); outline-offset: 2px; }
.sc-play-overlay { position: absolute; inset: 0; z-index: 2; display: flex; align-items: center; justify-content: center;
  background: color-mix(in srgb, var(--sc-bg, #000) 45%, transparent); pointer-events: none; }
.sc-play-overlay[hidden] { display: none; }
.sc-play-disc { pointer-events: auto; width: 72px; height: 72px; padding: 0 0 0 6px; border-radius: 50%; cursor: pointer; font-size: 32px; line-height: 1;
  color: var(--sc-accent-fg, #fff); background: var(--sc-accent, #0b5cad); border: 3px solid var(--sc-accent-fg, #fff); }
`;

export function createPlayer(opts: PlayerOptions): PlayerHandle {
  const { host, view, surface } = opts;
  const doc = view.ownerDocument;
  const now = opts.now ?? ((): number => performance.now());
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string): HTMLElementTagNameMap[K] => {
    const e = doc.createElement(tag);
    if (cls !== undefined) e.className = cls;
    return e;
  };
  const button = (text: string, label: string): HTMLButtonElement => {
    const b = el('button');
    b.type = 'button';
    b.textContent = text;
    b.setAttribute('aria-label', label);
    return b;
  };

  // --- player bar ---
  const bar = el('div', 'sc-player');
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', 'Player');
  const playBtn = button('Play', 'Play');
  playBtn.setAttribute('aria-pressed', 'true');
  playBtn.dataset.player = 'play';
  const spacer = el('span', 'sc-grow');
  const speedBtn = button('Speed 1×', 'Speed 1×, press for half speed');
  speedBtn.setAttribute('aria-pressed', 'false');
  const fsBtn = button('Full screen', 'Full screen');
  fsBtn.setAttribute('aria-pressed', 'false');
  if (opts.showFullscreen === false) fsBtn.hidden = true;
  bar.append(playBtn, spacer, speedBtn, fsBtn);
  (opts.dock ?? view).appendChild(bar);

  // --- play overlay: translucent scrim, the disc is the button; the scrim lets taps through to the view ---
  const overlay = el('div', 'sc-play-overlay');
  const disc = el('button', 'sc-play-disc');
  disc.type = 'button';
  disc.textContent = '▶';
  disc.setAttribute('aria-label', 'Play');
  disc.dataset.player = 'overlay';
  overlay.appendChild(disc);
  surface.appendChild(overlay);

  let paused = true;
  let half = false;

  const render = (): void => {
    overlay.hidden = !paused;
    const label = paused ? 'Play' : 'Pause';
    playBtn.textContent = label;
    playBtn.setAttribute('aria-label', label);
    playBtn.setAttribute('aria-pressed', String(paused));
  };
  const setPaused = (p: boolean): void => {
    paused = p;
    render();
  };
  const toggle = (): void => {
    const next = !paused;
    setPaused(next);
    if (next) host.pause();
    else host.resume();
  };
  render();

  playBtn.addEventListener('click', toggle);
  disc.addEventListener('click', toggle);

  const showSpeed = (): void => {
    const txt = half ? 'Speed 0.5×' : 'Speed 1×';
    speedBtn.textContent = txt;
    speedBtn.setAttribute('aria-label', `${txt}, press for ${half ? 'normal' : 'half'} speed`);
    speedBtn.setAttribute('aria-pressed', String(half));
  };
  speedBtn.addEventListener('click', () => {
    half = !half;
    showSpeed();
    host.setSpeed(half ? 0.5 : 1);
  });
  fsBtn.addEventListener('click', () => opts.onFullscreenToggle?.());

  // --- tap on the view toggles; a drag orbits ---
  const tap = new TapDetector();
  const onButton = (e: Event): boolean => (e.target as Element | null)?.closest?.('button, a, input, summary') != null;
  const onDown = (e: PointerEvent): void => {
    if (onButton(e)) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    tap.down(e.pointerId, e.clientX, e.clientY, now());
  };
  const onMove = (e: PointerEvent): void => tap.move(e.pointerId, e.clientX, e.clientY);
  const onUp = (e: PointerEvent): void => {
    if (tap.up(e.pointerId, e.clientX, e.clientY, now())) toggle();
  };
  const onCancel = (): void => tap.cancel();
  const onKey = (e: KeyboardEvent): void => {
    if (e.target !== surface || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === ' ' || e.code === 'Space' || e.key === 'k' || e.key === 'K') {
      e.preventDefault();
      toggle();
    }
  };
  surface.addEventListener('pointerdown', onDown);
  surface.addEventListener('pointermove', onMove);
  surface.addEventListener('pointerup', onUp);
  surface.addEventListener('pointercancel', onCancel);
  surface.addEventListener('keydown', onKey);

  return {
    bar,
    overlay: disc,
    scrim: overlay,
    setPaused,
    isPaused: () => paused,
    setSpeed(s) {
      half = s === 0.5;
      showSpeed();
    },
    setFullscreenActive(active) {
      fsBtn.textContent = active ? 'Exit full screen' : 'Full screen';
      fsBtn.setAttribute('aria-label', active ? 'Exit full screen' : 'Full screen');
      fsBtn.setAttribute('aria-pressed', String(active));
    },
    setFullscreenVisible(visible) {
      fsBtn.hidden = !visible;
    },
    dispose() {
      surface.removeEventListener('pointerdown', onDown);
      surface.removeEventListener('pointermove', onMove);
      surface.removeEventListener('pointerup', onUp);
      surface.removeEventListener('pointercancel', onCancel);
      surface.removeEventListener('keydown', onKey);
      bar.remove();
      overlay.remove();
    },
  };
}
