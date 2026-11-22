// Light and dark palettes for the whole component: CSS (controls, text), the 3D scene and the charts.
// Series colours are Okabe-Ito (colour-vision-deficiency safe). Each chart also gives every series
// its own dash pattern, so colour is never the only cue. In the dark palette Okabe-Ito black becomes
// light grey and the axes and grid get a lighter stroke.

/** Colours for the 3D scene (CSS colour strings accepted by THREE.Color). */
export interface ScenePalette {
  background: string;
  gridMajor: string;
  gridMinor: string;
  body: string;
  arm: string;
  /** Front arms/rotors, to show heading. */
  armFront: string;
  rotor: string;
  rod: string;
  mass: string;
  trail: string;
  hemiSky: string;
  hemiGround: string;
  hemiIntensity: number;
  dirIntensity: number;
}

export const DEFAULT_LIGHT_PALETTE: ScenePalette = {
  background: '#f4f6f8',
  gridMajor: '#9aa5b1',
  gridMinor: '#d3d9df',
  body: '#3b4a5a',
  arm: '#56687a',
  armFront: '#d9480f',
  rotor: '#1c7ed6',
  rod: '#495057',
  mass: '#e8590c',
  trail: '#e8590c',
  hemiSky: '#ffffff',
  hemiGround: '#b8c0c8',
  hemiIntensity: 1.1,
  dirIntensity: 1.6,
};

export const DEFAULT_DARK_PALETTE: ScenePalette = {
  background: '#14181d',
  gridMajor: '#56616d',
  gridMinor: '#2a323a',
  body: '#aab7c4',
  arm: '#8795a3',
  armFront: '#ff922b',
  rotor: '#74c0fc',
  rod: '#ced4da',
  mass: '#ffa94d',
  trail: '#ffa94d',
  hemiSky: '#c5d4e8',
  hemiGround: '#20262d',
  hemiIntensity: 0.9,
  dirIntensity: 1.4,
};


/** Okabe-Ito colours. */
export const OKABE_ITO = {
  black: '#000000',
  orange: '#E69F00',
  skyBlue: '#56B4E9',
  bluishGreen: '#009E73',
  yellow: '#F0E442',
  blue: '#0072B2',
  vermillion: '#D55E00',
  reddishPurple: '#CC79A7',
} as const;

/** Dash patterns (CSS px on/off lengths). An empty array is a solid line. Distinct per series role. */
export const DASH = {
  solid: [] as number[],
  dashed: [8, 4] as number[],
  dotted: [2, 3] as number[],
  dashDot: [10, 3, 2, 3] as number[],
  sparse: [3, 6] as number[],
} as const;

/** Colours used by the charts. */
export interface ChartPalette {
  /** Axis text, axis line and tick colour. */
  axis: string;
  grid: string;
  /** Single-series primary colour (theta, replaces Okabe-Ito black). */
  primary: string;
  /** Pitch (x) channel: state series. */
  pitch: string;
  /** Pitch channel: applied-gain series (K_T chart). */
  pitchApplied: string;
  roll: string;
  rollApplied: string;
  threshold: string;
  /** Motor 1..4. */
  motors: readonly [string, string, string, string];
  /** Detector-trip marker: dashed line and the ▲ glyph (the alert colour). */
  trip: string;
  /** Translucent fill of the region after the trip. */
  detectFill: string;
  /** Solid vertical lines (and their labels) at regime transitions and reader actions. */
  transition: string;
  /** Background shading by regime: low-alpha fill plus a stroke for the strip along the top edge. */
  bands: { nominal: BandColor; gainShift: BandColor; engaged: BandColor };
}

export interface BandColor {
  fill: string;
  stroke: string;
}

/** Colours for the CSS of the controls, banner and text summary. */
export interface CssPalette {
  bg: string;
  surface: string;
  fg: string;
  muted: string;
  border: string;
  accent: string;
  accentFg: string;
  danger: string;
  dangerBg: string;
  focus: string;
}

export interface Palette {
  name: 'light' | 'dark';
  css: CssPalette;
  scene: ScenePalette;
  chart: ChartPalette;
}

const O = OKABE_ITO;

export const LIGHT_PALETTE: Palette = {
  name: 'light',
  css: {
    bg: '#f4f6f8',
    surface: '#ffffff',
    fg: '#1a1d21',
    muted: '#4a5561',
    border: '#c3cad2',
    accent: '#0b5cad',
    accentFg: '#ffffff',
    danger: '#b3290a',
    dangerBg: '#fdece7',
    focus: '#0b5cad',
  },
  scene: DEFAULT_LIGHT_PALETTE,
  chart: {
    axis: '#3d4650',
    grid: 'rgba(60, 70, 80, 0.16)',
    primary: O.black,
    pitch: O.vermillion,
    pitchApplied: O.orange,
    roll: O.blue,
    rollApplied: O.skyBlue,
    threshold: O.reddishPurple,
    motors: [O.black, O.vermillion, O.blue, O.bluishGreen],
    trip: '#b3290a',
    detectFill: 'rgba(213, 94, 0, 0.08)',
    transition: '#3d4650',
    // neutral grey / Okabe-Ito orange / Okabe-Ito blue: separable by hue-independent luminance and by
    // the orange-blue axis that deuteranopia, protanopia and tritanopia all keep
    bands: {
      nominal: { fill: 'rgba(120, 130, 140, 0.10)', stroke: '#6b7782' },
      gainShift: { fill: 'rgba(230, 159, 0, 0.24)', stroke: '#b07800' },
      engaged: { fill: 'rgba(0, 114, 178, 0.16)', stroke: '#0072b2' },
    },
  },
};

export const DARK_PALETTE: Palette = {
  name: 'dark',
  css: {
    bg: '#14181d',
    surface: '#1c2229',
    fg: '#e6e9ec',
    muted: '#aab4bf',
    border: '#3a444e',
    accent: '#74c0fc',
    accentFg: '#0b1117',
    danger: '#ff8f6b',
    dangerBg: '#3a1f17',
    focus: '#74c0fc',
  },
  scene: DEFAULT_DARK_PALETTE,
  chart: {
    axis: '#c4ccd4',
    grid: 'rgba(200, 210, 220, 0.20)',
    primary: '#d9d9d9', // Okabe-Ito black -> light grey
    pitch: O.orange,
    pitchApplied: O.yellow,
    roll: O.skyBlue,
    rollApplied: '#4fd1a5', // lightened bluish green (the original is dim on dark)
    threshold: O.reddishPurple,
    motors: ['#d9d9d9', O.orange, O.skyBlue, '#4fd1a5'],
    trip: '#ff8f6b',
    detectFill: 'rgba(255, 143, 107, 0.10)',
    transition: '#e0e5ea',
    bands: {
      nominal: { fill: 'rgba(170, 180, 190, 0.10)', stroke: '#9aa5b1' },
      gainShift: { fill: 'rgba(230, 159, 0, 0.26)', stroke: '#e69f00' },
      engaged: { fill: 'rgba(86, 180, 233, 0.22)', stroke: '#56b4e9' },
    },
  },
};

export function paletteFor(dark: boolean): Palette {
  return dark ? DARK_PALETTE : LIGHT_PALETTE;
}

// ---------------------------------------------------------------------------------------------
// ThemeController: follows the component's `theme` attribute, al-folio's data-theme, or the OS.
// ---------------------------------------------------------------------------------------------

/**
 * Attribute al-folio sets on <html> for its light/dark toggle. Kept in one constant because
 * theme versions may differ; confirm it on the live site.
 */
export const SITE_THEME_ATTRIBUTE = 'data-theme';
/** Component attribute that forces a theme ("light" | "dark"; anything else means follow the page). */
export const COMPONENT_THEME_ATTRIBUTE = 'theme';

export type ThemeName = 'light' | 'dark';

export interface MediaQueryListLike {
  matches: boolean;
  addEventListener(type: 'change', listener: () => void): void;
  removeEventListener(type: 'change', listener: () => void): void;
}

export interface ThemeObserverLike {
  observe(target: Node, options: MutationObserverInit): void;
  disconnect(): void;
}

export interface ThemeControllerOptions {
  /** Called with the new palette whenever the effective theme changes (not on construction). */
  onChange: (palette: Palette) => void;
  /** Document whose root carries the site's data-theme. Default: host.ownerDocument. */
  doc?: Document;
  /** Element that receives data-theme (the shadow-root container). Default: host. */
  container?: Element;
  /** Injected matchMedia. Default: the document's window.matchMedia. */
  matchMedia?: (query: string) => MediaQueryListLike;
  /** Injected MutationObserver factory. Default: the document's window.MutationObserver. */
  createObserver?: (cb: () => void) => ThemeObserverLike;
}

function asTheme(v: string | null | undefined): ThemeName | null {
  return v === 'light' || v === 'dark' ? v : null;
}

export class ThemeController {
  private readonly host: Element;
  private readonly doc: Document;
  private readonly container: Element;
  private readonly opts: ThemeControllerOptions;
  private readonly mql: MediaQueryListLike | null;
  private readonly observers: ThemeObserverLike[] = [];
  private readonly onMql = (): void => this.refresh();
  private disposed = false;
  private theme: ThemeName;

  constructor(host: Element, opts: ThemeControllerOptions) {
    this.host = host;
    this.opts = opts;
    this.doc = opts.doc ?? host.ownerDocument;
    this.container = opts.container ?? host;
    const win = this.doc.defaultView;
    const mm = opts.matchMedia ?? (win?.matchMedia ? win.matchMedia.bind(win) : undefined);
    this.mql = mm ? mm('(prefers-color-scheme: dark)') : null;
    this.mql?.addEventListener('change', this.onMql);

    const make =
      opts.createObserver ??
      (win?.MutationObserver ? (cb: () => void) => new win.MutationObserver(cb) : undefined);
    if (make) {
      const siteObs = make(() => this.refresh());
      siteObs.observe(this.doc.documentElement, {
        attributes: true,
        attributeFilter: [SITE_THEME_ATTRIBUTE],
      });
      const hostObs = make(() => this.refresh());
      hostObs.observe(this.host, { attributes: true, attributeFilter: [COMPONENT_THEME_ATTRIBUTE] });
      this.observers.push(siteObs, hostObs);
    }
    this.theme = this.resolve();
    this.container.setAttribute('data-theme', this.theme);
  }

  /** Effective theme: component attribute, then the site attribute, then the OS preference. */
  resolve(): ThemeName {
    const own = asTheme(this.host.getAttribute(COMPONENT_THEME_ATTRIBUTE));
    if (own) return own;
    const site = asTheme(this.doc.documentElement.getAttribute(SITE_THEME_ATTRIBUTE));
    if (site) return site;
    return this.mql?.matches ? 'dark' : 'light';
  }

  current(): ThemeName {
    return this.theme;
  }

  palette(): Palette {
    return paletteFor(this.theme === 'dark');
  }

  /** Re-resolve the theme; applies it and calls onChange only if it changed. */
  refresh(): void {
    if (this.disposed) return;
    const next = this.resolve();
    if (next === this.theme) return;
    this.theme = next;
    this.container.setAttribute('data-theme', next);
    this.opts.onChange(this.palette());
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const o of this.observers) o.disconnect();
    this.observers.length = 0;
    this.mql?.removeEventListener('change', this.onMql);
  }
}
