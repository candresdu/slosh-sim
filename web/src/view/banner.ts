// Info banner attached to the bottom edge of the 3D view: what the phase is, which R-1 figure it
// reproduces, and the live narration caption (which becomes the detector trip message after a trip).
// DOM-light: only creates its own elements. Colours come from the --sc-* custom properties.

export type BannerPhase = 'nominal' | 'gainShift' | 'engaged' | 'replay';

export interface BannerText {
  /** Title including the figure reference. */
  title: string;
  /** What the phase is and what the reader should see. */
  body: string;
}

/** Texts per phase (reconstruction wording; the figure references name the qualitative reproduction targets). */
export const BANNER_TEXTS: Readonly<Record<BannerPhase, BannerText>> = {
  nominal: {
    title: 'Nominal · Fig 12',
    body:
      'Gain shift 1 and the AAC off. The PD controller alone damps the hanging mass, so the slosh oscillation dies out, as in R-1 Fig 12.',
  },
  gainShift: {
    title: 'Gain shift · Fig 13',
    body:
      'We are raising the outer-loop gains on purpose (×2.3) to drive the slosh mode unstable, so the fuel slosh grows. ' +
      'The AAC is only monitoring: K_T is computed but not applied, so the motion is the same as with the AAC off (R-1 Fig 13).',
  },
  engaged: {
    title: 'AAC engaged · Fig 14',
    body:
      'The AAC now applies K_T to the forward loop while the raised gains stay in place. Watch K_T drop and the slosh oscillation decay (R-1 Fig 14).',
  },
  replay: {
    title: 'Replay the paper · Figs 12–14 and the §V.B flight test',
    body:
      'The flight restarts and steps through Nominal (Fig 12), Gain shift (Fig 13) and AAC engaged (Fig 14) on its own, ' +
      'like the flight-test sequence in §V.B of R-1. Tap a regime button to take over.',
  },
};

const AXIS_NAMES = ['pitch', 'roll'] as const;
const TRIP_TITLE = 'Detector';
const TRIP_BODY = 'The spectral-damper detector watches the ~0.5 Hz control activity and flags growing slosh.';

export interface BannerHandle {
  readonly element: HTMLElement;
  /** Show the banner for a phase (also after a dismissal). The caption line is cleared until the next caption. */
  showPhase(phase: BannerPhase): void;
  /** The live narration caption; shown on the third line unless a detector trip message is active. */
  setCaption(text: string): void;
  /** Record the first trip on an axis (0 = pitch, 1 = roll); shows the banner unless the reader dismissed it. */
  showTrip(axis: 0 | 1, t: number): void;
  /** Forget the trips (a new phase or a restart). */
  clearTrips(): void;
  /** Hide the banner and forget trips and the phase (restart / reset). */
  reset(): void;
  /** Hide the banner (the × button); the next showPhase shows it again. */
  dismiss(): void;
  isVisible(): boolean;
  /** The phase shown, or null. */
  phase(): BannerPhase | null;
  dispose(): void;
}

export const BANNER_CSS = `
.sc-info { z-index: 3; display: flex; align-items: flex-start; gap: 8px; padding: 8px 10px; font: 13px/1.4 system-ui, sans-serif;
  color: var(--sc-fg, inherit); background: color-mix(in srgb, var(--sc-surface, #fff) 90%, transparent);
  border-top: 3px solid var(--sc-accent, #0b5cad); }
.sc-info[hidden] { display: none; }
.sc-info * { box-sizing: border-box; }
.sc-info-text { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.sc-info-title { margin: 0; font-size: 14px; font-weight: 700; }
.sc-info-body, .sc-info-caption { margin: 0; }
.sc-info-caption { font-weight: 600; }
.sc-info-caption:empty { display: none; }
.sc-info[data-trip="true"] .sc-info-caption { color: var(--sc-danger, #b3290a); }
.sc-info-close { flex: none; width: 32px; height: 32px; padding: 0; font: inherit; font-size: 18px; line-height: 1; cursor: pointer;
  color: var(--sc-fg, inherit); background: transparent; border: 1px solid var(--sc-border, currentColor); border-radius: 6px; }
.sc-info-close:hover { border-color: var(--sc-accent, currentColor); }
.sc-info-close:focus-visible { outline: 3px solid var(--sc-focus, #0b5cad); outline-offset: 2px; }
/* the info banner is the last item of the view's dock (player bar above it): the dock overlays the lower part of the
   scene on desktop (see styles.css) and sits directly under the scene in the compact layout (below 640 px) */
.sc-dock > .sc-info { position: static; border-radius: 0 0 6px 6px; }
.frame[data-layout='compact'] .sc-dock > .sc-info { background: var(--sc-surface, #fff); }
`;

let uid = 0;

/** Create the banner as the last child of `view` (the 3D view's frame element). */
export function createBanner(view: HTMLElement): BannerHandle {
  const doc = view.ownerDocument;
  const id = `scinfo${++uid}`;
  const root = doc.createElement('div');
  root.className = 'sc-info';
  root.setAttribute('role', 'status');
  root.hidden = true;

  const text = doc.createElement('div');
  text.className = 'sc-info-text';
  const title = doc.createElement('p');
  title.className = 'sc-info-title';
  title.id = `${id}-title`;
  const body = doc.createElement('p');
  body.className = 'sc-info-body';
  const caption = doc.createElement('p');
  caption.className = 'sc-info-caption';
  text.append(title, body, caption);

  const close = doc.createElement('button');
  close.type = 'button';
  close.className = 'sc-info-close';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Dismiss the info banner');
  root.append(text, close);
  view.appendChild(root);

  let phase: BannerPhase | null = null;
  let dismissed = false;
  let narration = '';
  const trips: Array<number | null> = [null, null];

  const tripMessage = (): string => {
    const parts: string[] = [];
    for (let a = 0; a < 2; a++) {
      const t = trips[a];
      if (t !== null && t !== undefined) parts.push(`Slosh anomaly detected on the ${AXIS_NAMES[a]} axis at t = ${t.toFixed(1)} s`);
    }
    return parts.join('. ');
  };
  const render = (): void => {
    const trip = tripMessage();
    const t = phase !== null ? BANNER_TEXTS[phase] : trip !== '' ? { title: TRIP_TITLE, body: TRIP_BODY } : { title: '', body: '' };
    if (title.textContent !== t.title) title.textContent = t.title;
    if (body.textContent !== t.body) body.textContent = t.body;
    const third = trip !== '' ? trip : narration;
    if (caption.textContent !== third) caption.textContent = third;
    root.dataset.trip = String(trip !== '');
  };
  const show = (): void => {
    root.hidden = false;
  };
  const dismiss = (): void => {
    dismissed = true;
    root.hidden = true;
  };
  const onClose = (): void => dismiss();
  close.addEventListener('click', onClose);

  return {
    element: root,
    showPhase(p) {
      phase = p;
      dismissed = false;
      trips[0] = null;
      trips[1] = null;
      narration = '';
      render();
      show();
    },
    setCaption(t) {
      narration = t;
      render();
    },
    showTrip(axis, t) {
      if (trips[axis] === null) trips[axis] = t;
      render();
      if (!dismissed) show();
    },
    clearTrips() {
      trips[0] = null;
      trips[1] = null;
      render();
    },
    reset() {
      phase = null;
      dismissed = false;
      trips[0] = null;
      trips[1] = null;
      render();
      root.hidden = true;
    },
    dismiss,
    isVisible: () => !root.hidden,
    phase: () => phase,
    dispose() {
      close.removeEventListener('click', onClose);
      root.remove();
    },
  };
}
