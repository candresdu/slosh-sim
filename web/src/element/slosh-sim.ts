// <slosh-sim>: the whole simulation (sim core, runner, 3D view, charts, controls) as one Web Component.
// Open Shadow DOM, all styles inside it. The only coupling to the host page is reading the site's
// light/dark state (ThemeController) and the optional --slosh-* / al-folio --global-* custom properties.
import { DEFAULT_PARAMS } from '../core/params';
import { PRESET_IDS, type PresetId } from '../core/presets';
import { Sim, type SimCommand, type Telemetry } from '../core/sim';
import { Runner, TelemetryRing, type Axis } from '../runtime';
import { regimeOf, type Band, type Marker, type Regime } from '../runtime/telemetry-ring';
import { BANNER_CSS, createBanner, type BannerHandle, type BannerPhase } from '../view/banner';
import { createAbout, ABOUT_CSS, type AboutHandle } from '../view/about';
import { createCharts, type ChartsHandle } from '../view/charts';
import { CONTROLS_CSS, applyCssPalette, createControls, type ControlsHandle } from '../view/controls';
import { FULLSCREEN_OVERLAY_CSS, FullscreenController, type FullscreenState } from '../view/fullscreen';
import { PLAYER_CSS, createPlayer, type PlayerHandle } from '../view/player';
import { WebGLUnavailableError, createScene, type SceneHandle } from '../view/scene';
import { StoryNarrator, ringThetaEnvelope, storyCommands, type StoryAction } from '../view/story';
import { SUMMARY_CSS, createSummary, type SummaryHandle } from '../view/summary';
import { ThemeController, type Palette } from '../view/theme';
import styles from './styles.css?inline';

export type ElementPreset = PresetId | 'free';
export type LayoutAttr = 'auto' | 'full' | 'compact';
export type ResolvedLayout = 'compact' | 'column' | 'wide';

const PRESET_VALUES: readonly ElementPreset[] = [...PRESET_IDS, 'free'];
const COMPACT_MAX = 640; // container width below which the layout is compact
const WIDE_MIN = 1100; // container width from which the 3D view sits left of the charts
const AXES = ['pitch', 'roll'] as const;
/** Charts that fold into <details> in the compact layout (θ, K_T and y_SD stay expanded). */
/** Plot heights [px]: short charts in the article (the three key charts only), tall ones in full screen (all six). */
const CHART_H_INLINE = 96;
const CHART_H_FULL = 150;
const FOLDED: ReadonlyArray<{ id: string; title: string }> = [
  { id: 'mass', title: 'Mass position' },
  { id: 'attitude', title: 'Quad roll and pitch' },
  { id: 'motors', title: 'Motor commands' },
];

const TEMPLATE = `
<style>${styles}\n${CONTROLS_CSS}\n${SUMMARY_CSS}\n${ABOUT_CSS}\n${BANNER_CSS}\n${PLAYER_CSS}\n${FULLSCREEN_OVERLAY_CSS}</style>
<div class="frame" data-mode="auto" data-layout="column" data-fs="false" part="frame">
  <button class="exit" type="button" hidden aria-label="Exit full screen">Exit full screen ✕</button>
  <div class="grid">
    <div class="view sc-view">
      <div class="scene" tabindex="0" role="group" aria-label="3D view. Space or K plays and pauses. Drag to orbit.">
        <canvas role="img" aria-label="3D view of the quadrotor with a hanging mass"></canvas>
        <div class="fallback" hidden><slot name="fallback">3D view unavailable (WebGL2 is required). Controls and charts still work.</slot></div>
      </div>
      <div class="sc-dock"></div>
    </div>
    <div class="ctl"></div>
    <div class="charts"></div>
    <p class="sc-more">Full screen shows all six charts, larger.</p>
  </div>
</div>`;

interface Runtime {
  frame: HTMLElement;
  simRef: { cur: Sim };
  runner: Runner;
  ring: TelemetryRing;
  scene: SceneHandle | null;
  charts: ChartsHandle;
  controls: ControlsHandle;
  player: PlayerHandle;
  banner: BannerHandle;
  /** Regime changes of the flight update the banner (while Replay the paper runs). */
  bannerFollow: boolean;
  /** The regime the banner already shows (so a button tap is not announced twice). */
  bannerRegime: Regime | null;
  summary: SummaryHandle;
  narrator: StoryNarrator;
  lastRegime: Regime | null;
  markersSeen: number;
  lastT: number;
  markerKeys: Set<string>;
  about: AboutHandle;
  theme: ThemeController;
  fs: FullscreenController;
  folds: HTMLDetailsElement[];
  exitBtn: HTMLButtonElement;
  cleanups: Array<() => void>;
  palette: Palette;
  userPaused: boolean;
  offscreen: boolean;
  reduced: boolean;
  layout: ResolvedLayout;
  focusBack: HTMLElement | null;
  disposed: boolean;
}

export interface DebugState {
  simTime: number;
  theme: 'light' | 'dark';
  sceneClearColor: string | null;
  fullscreen: boolean;
  fullscreenMode: 'native' | 'overlay' | null;
  layout: ResolvedLayout;
  trailVisible: boolean;
  preset: ElementPreset;
  paused: boolean;
  /** Chart markers (regime transitions, disturbances, detector trips) inside the 30 s window. */
  markers: Marker[];
  /** Regime bands inside the 30 s window. */
  bands: Band[];
  /** Current regime (from the latest telemetry), or null before the first sample. */
  regime: Regime | null;
  /** The story narration caption. */
  caption: string;
}

function parsePreset(v: string | null): ElementPreset {
  return (PRESET_VALUES as readonly string[]).includes(v ?? '') ? (v as ElementPreset) : 'story';
}
function parseLayout(v: string | null): LayoutAttr {
  return v === 'full' || v === 'compact' ? v : 'auto';
}
function parseSpeed(v: string | null): 1 | 0.5 {
  return v !== null && Number(v) === 0.5 ? 0.5 : 1;
}
function parseSeed(v: string | null): number {
  const n = v === null ? NaN : Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 0xffffffff ? n : 1;
}

export class SloshSim extends HTMLElement {
  static readonly observedAttributes = [
    'preset',
    'autoplay',
    'speed',
    'layout',
    'theme',
    'fullscreen-button',
    'seed',
  ] as const;

  private rt: Runtime | null = null;
  private presetNow: ElementPreset = 'story';

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  // ---- reflected properties -------------------------------------------------------------
  get preset(): ElementPreset {
    return parsePreset(this.getAttribute('preset'));
  }
  set preset(v: ElementPreset) {
    this.setAttribute('preset', v);
  }
  get theme(): string {
    const v = this.getAttribute('theme');
    return v === 'light' || v === 'dark' ? v : 'auto';
  }
  set theme(v: string) {
    this.setAttribute('theme', v);
  }
  get layout(): LayoutAttr {
    return parseLayout(this.getAttribute('layout'));
  }
  set layout(v: LayoutAttr) {
    this.setAttribute('layout', v);
  }
  get speed(): 1 | 0.5 {
    return parseSpeed(this.getAttribute('speed'));
  }
  set speed(v: 1 | 0.5) {
    this.setAttribute('speed', String(v));
  }
  get seed(): number {
    return parseSeed(this.getAttribute('seed'));
  }
  set seed(v: number) {
    this.setAttribute('seed', String(v));
  }
  get autoplay(): boolean {
    return this.hasAttribute('autoplay');
  }
  set autoplay(v: boolean) {
    this.toggleAttribute('autoplay', v);
  }
  get fullscreenButton(): boolean {
    return this.getAttribute('fullscreen-button') !== 'false';
  }
  set fullscreenButton(v: boolean) {
    this.setAttribute('fullscreen-button', String(v));
  }

  // ---- lifecycle ------------------------------------------------------------------------
  connectedCallback(): void {
    if (this.rt === null) this.rt = this.build();
  }

  disconnectedCallback(): void {
    const rt = this.rt;
    if (rt === null) return;
    this.rt = null;
    this.teardown(rt);
  }

  attributeChangedCallback(name: string, oldV: string | null, newV: string | null): void {
    const rt = this.rt;
    if (rt === null || oldV === newV) return;
    switch (name) {
      case 'preset':
        this.loadPreset(parsePreset(newV));
        break;
      case 'speed':
        rt.runner.setSpeed(parseSpeed(newV));
        rt.player.setSpeed(parseSpeed(newV));
        break;
      case 'layout':
        this.applyLayout(rt);
        break;
      case 'fullscreen-button':
        rt.player.setFullscreenVisible(newV !== 'false');
        break;
      case 'seed':
        this.replaceSim(rt);
        this.loadPreset(this.presetNow);
        break;
      case 'theme':
        this.applyPalette(rt.palette); // re-evaluate "follow the page" vs forced; the ThemeController swaps palettes
        break;
      default:
        break; // autoplay: only read at connect time
    }
  }

  // ---- public API -----------------------------------------------------------------------
  play(): void {
    const rt = this.rt;
    if (rt === null) return;
    rt.userPaused = false;
    rt.player.setPaused(false);
    this.applyRunState(rt);
  }

  pause(): void {
    const rt = this.rt;
    if (rt === null) return;
    rt.userPaused = true;
    rt.player.setPaused(true);
    this.applyRunState(rt);
  }

  reset(): void {
    const rt = this.rt;
    if (rt === null) return;
    rt.runner.send({ type: 'reset' });
    this.resetBanner(rt);
    this.renderOnce(rt);
  }

  loadPreset(id: ElementPreset): void {
    const rt = this.rt;
    if (rt === null) return;
    if (!(PRESET_VALUES as readonly string[]).includes(id)) throw new Error(`unknown preset ${String(id)}`);
    this.presetNow = id;
    if (id === 'free') {
      this.replaceSim(rt);
      rt.runner.send({ type: 'reset' });
    } else if (id === 'story') {
      rt.runner.send(storyCommands({ kind: 'restart' })); // the story's initial state, nothing scheduled
    } else {
      rt.runner.send({ type: 'loadPreset', id });
    }
    this.resetBanner(rt);
    this.renderOnce(rt);
  }

  /**
   * Move the running flight to a regime (story mode): nominal = gain shift 1 and AAC off, gainShift =
   * gain shift 2.3 and AAC Monitor (both ramped over 1.5 s), engaged = AAC engaged with K_T applied as
   * a step. The vehicle is not reset; a running "Replay the paper" is cancelled.
   */
  setRegime(regime: Regime): void {
    const rt = this.rt;
    if (rt === null) return;
    this.storyAction(rt, { kind: 'regime', regime });
  }

  /** Replay the paper: reset to the story's initial state, then run Nominal, Gain shift, AAC engaged. */
  playStory(): void {
    const rt = this.rt;
    if (rt === null) return;
    this.presetNow = 'story';
    this.storyAction(rt, { kind: 'play' });
  }

  enterFullscreen(): Promise<void> {
    const rt = this.rt;
    return rt === null ? Promise.resolve() : rt.fs.enter();
  }

  exitFullscreen(): Promise<void> {
    const rt = this.rt;
    return rt === null ? Promise.resolve() : rt.fs.exit();
  }

  /** State snapshot for E2E tests. */
  debugState(): DebugState {
    const rt = this.rt;
    const info = rt?.scene?.debugInfo();
    return {
      simTime: rt?.ring.latest()?.t ?? 0,
      theme: rt?.theme.current() ?? 'light',
      sceneClearColor: info?.clearColor ?? null,
      fullscreen: rt?.fs.isActive() ?? false,
      fullscreenMode: rt?.fs.mode() ?? null,
      layout: rt?.layout ?? 'column',
      trailVisible: info?.trailVisible ?? false,
      preset: this.presetNow,
      paused: rt === null ? true : rt.userPaused || rt.offscreen,
      markers: rt?.ring.markers() ?? [],
      bands: rt?.ring.bands() ?? [],
      regime: rt?.lastRegime ?? null,
      caption: rt?.narrator.caption ?? '',
    };
  }

  // ---- construction ---------------------------------------------------------------------
  private build(): Runtime {
    const root = this.shadowRoot as ShadowRoot;
    root.innerHTML = TEMPLATE;
    const q = <T extends Element>(sel: string): T => root.querySelector(sel) as T;
    const frame = q<HTMLElement>('.frame');
    const canvas = q<HTMLCanvasElement>('canvas');
    const sceneBox = q<HTMLElement>('.scene');
    const viewBox = q<HTMLElement>('.view');
    const fallback = q<HTMLElement>('.fallback');
    const dockBox = q<HTMLElement>('.sc-dock');
    const ctlBox = q<HTMLElement>('.ctl');
    const chartsBox = q<HTMLElement>('.charts');
    const exitBtn = q<HTMLButtonElement>('.exit');
    const cleanups: Array<() => void> = [];

    const win = this.ownerDocument.defaultView;
    const reducedMql = win?.matchMedia ? win.matchMedia('(prefers-reduced-motion: reduce)') : null;
    const reduced = reducedMql?.matches ?? false;

    this.presetNow = this.preset;
    const ring = new TelemetryRing();
    const sim = new Sim(DEFAULT_PARAMS.params, this.seed);
    // The runner talks to the current Sim through this indirection, so 'free' can swap in a fresh one.
    const simRef = { cur: sim };
    const runner = new Runner(
      {
        stepControl: () => simRef.cur.stepControl(),
        enqueue: (c: SimCommand) => simRef.cur.enqueue(c),
        commandLog: () => simRef.cur.commandLog(),
      },
      ring,
    );
    runner.setSpeed(this.speed);
    // Test-only hook for the E2E suite: `?testSpeed=4` on the page URL runs the sim 4x faster than wall time.
    const testSpeed = Number(new URLSearchParams(win?.location?.search ?? '').get('testSpeed'));
    if (testSpeed > 0 && testSpeed <= 8) runner.setTimeScale(testSpeed);

    const theme = new ThemeController(this, {
      container: frame,
      onChange: (p) => this.applyPalette(p),
    });
    const palette = theme.palette();

    let scene: SceneHandle | null = null;
    try {
      scene = createScene(canvas, { palette: palette.scene, reducedMotion: reduced });
    } catch (e) {
      if (!(e instanceof WebGLUnavailableError)) throw e;
      canvas.hidden = true;
      fallback.hidden = false;
    }

    const rt: Runtime = {
      frame,
      simRef,
      runner,
      ring,
      scene,
      charts: null as unknown as ChartsHandle,
      controls: null as unknown as ControlsHandle,
      player: null as unknown as PlayerHandle,
      banner: null as unknown as BannerHandle,
      bannerFollow: false,
      bannerRegime: null,
      summary: null as unknown as SummaryHandle,
      narrator: new StoryNarrator(),
      lastRegime: null,
      markersSeen: -1,
      lastT: 0,
      markerKeys: new Set<string>(),
      about: null as unknown as AboutHandle,
      theme,
      fs: null as unknown as FullscreenController,
      folds: [],
      exitBtn,
      cleanups,
      palette,
      userPaused: true,
      offscreen: false,
      reduced,
      layout: 'column',
      focusBack: null,
      disposed: false,
    };
    this.rt = rt;

    rt.controls = createControls(ctlBox, {
      host: { send: (c) => runner.send(c) },
      regimeContainer: viewBox, // the regime bar sits inside the 3D view's frame
      onStoryAction: (a) => this.afterStoryAction(rt, a),
      thetaEnvelope: () => ringThetaEnvelope(ring),
    });
    rt.player = createPlayer({
      host: {
        pause: () => this.pause(),
        resume: () => this.play(),
        setSpeed: (s) => runner.setSpeed(s),
      },
      view: viewBox,
      dock: dockBox,
      surface: sceneBox,
      showFullscreen: this.fullscreenButton,
      onFullscreenToggle: () => {
        rt.focusBack = (root.activeElement as HTMLElement | null) ?? null;
        void rt.fs.toggle();
      },
    });
    rt.player.setSpeed(this.speed);
    rt.banner = createBanner(dockBox);
    rt.summary = createSummary(ctlBox);
    rt.charts = createCharts(chartsBox, ring, {
      palette,
      threshold: DEFAULT_PARAMS.params.aac.threshold ?? 1,
    });
    rt.about = createAbout(rt.controls.aboutSlot, DEFAULT_PARAMS.provenance, DEFAULT_PARAMS.params);
    this.foldCharts(rt, chartsBox);
    this.applyChartHeight(rt);

    rt.fs = new FullscreenController(this, { onChange: (s) => this.onFullscreen(rt, s) });
    exitBtn.addEventListener('click', () => void rt.fs.exit());

    // events
    runner.on('detect', (axis: Axis, t: number) => {
      rt.banner.showTrip(axis, t);
      this.emit('slosh-detect', { axis: AXES[axis], t });
    });
    runner.on('preset-done', (id) => this.emit('slosh-preset-done', { id }));
    runner.on('frame', (tel) => {
      scene?.update(tel);
      rt.charts.redraw();
      rt.summary.maybeUpdate(ring);
      rt.controls.sync(tel);
      this.followStory(rt, tel);
    });

    // size tracking: scene canvas and layout
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => {
        this.applyLayout(rt);
        if (scene !== null && sceneBox.clientWidth > 0) scene.resize(sceneBox.clientWidth, sceneBox.clientHeight);
      });
      ro.observe(frame);
      ro.observe(sceneBox);
      cleanups.push(() => ro.disconnect());
    }
    this.applyLayout(rt);
    if (scene !== null) {
      scene.resize(Math.max(1, sceneBox.clientWidth || 640), Math.max(1, sceneBox.clientHeight || 360));
      // OrbitControls only re-render with the frame loop; keep the view live while paused
      const rerender = (): void => {
        if (rt.userPaused || rt.offscreen) {
          const last = ring.latest();
          if (last !== null) scene?.update(last as Parameters<SceneHandle['update']>[0]);
        }
      };
      for (const ev of ['pointermove', 'wheel'] as const) {
        canvas.addEventListener(ev, rerender, { passive: true });
        cleanups.push(() => canvas.removeEventListener(ev, rerender));
      }
    }
    this.applyPalette(palette);

    // reduced motion
    if (reducedMql) {
      const onMotion = (): void => {
        rt.reduced = reducedMql.matches;
        rt.scene?.setReducedMotion(rt.reduced);
      };
      reducedMql.addEventListener('change', onMotion);
      cleanups.push(() => reducedMql.removeEventListener('change', onMotion));
    }

    // pause while off-screen
    if (typeof IntersectionObserver !== 'undefined') {
      const io = new IntersectionObserver((entries) => {
        const last = entries[entries.length - 1];
        if (last === undefined) return;
        rt.offscreen = !last.isIntersecting;
        this.applyRunState(rt);
      });
      io.observe(this);
      cleanups.push(() => io.disconnect());
    }

    // first frame, then run (paused unless autoplay)
    // story: the initial state with nothing scheduled (like Restart); autoplay replays the paper from the start
    if (this.presetNow === 'story') {
      runner.send(storyCommands({ kind: this.autoplay && !reduced ? 'play' : 'restart' }));
    } else {
      runner.send(this.presetNow === 'free' ? { type: 'reset' } : { type: 'loadPreset', id: this.presetNow });
    }
    this.renderOnce(rt);
    runner.start();
    if (this.autoplay && !reduced) {
      rt.userPaused = false;
    }
    rt.player.setPaused(rt.userPaused);
    this.applyRunState(rt);
    return rt;
  }

  /** Move the compact-layout charts into <details> (always open outside the compact layout). */
  private foldCharts(rt: Runtime, chartsBox: HTMLElement): void {
    const doc = this.ownerDocument;
    for (const f of FOLDED) {
      const fig = chartsBox.querySelector(`figure[data-chart="${f.id}"]`);
      if (fig === null) continue;
      const d = doc.createElement('details');
      d.className = 'sc-fold';
      d.open = rt.layout !== 'compact'; // open outside the compact layout (applyLayout only acts on changes)
      const s = doc.createElement('summary');
      s.textContent = f.title;
      fig.replaceWith(d);
      d.append(s, fig);
      const onToggle = (): void => rt.charts.resize();
      d.addEventListener('toggle', onToggle);
      rt.cleanups.push(() => d.removeEventListener('toggle', onToggle));
      rt.folds.push(d);
    }
  }

  private resolveLayout(width: number): ResolvedLayout {
    const mode = this.layout;
    if (mode === 'compact') return 'compact';
    if (width >= WIDE_MIN) return 'wide';
    if (mode === 'full') return 'column';
    return width < COMPACT_MAX ? 'compact' : 'column';
  }

  private applyLayout(rt: Runtime): void {
    const width = rt.frame.clientWidth;
    // before layout (width 0, e.g. jsdom) keep the desktop default unless compact is forced
    const next = width === 0 && this.layout !== 'compact' ? 'column' : this.resolveLayout(width);
    rt.frame.dataset.mode = this.layout;
    if (next === rt.layout && rt.frame.dataset.layout === next) return;
    rt.layout = next;
    rt.frame.dataset.layout = next;
    for (const d of rt.folds) d.open = next !== 'compact';
    rt.charts.resize();
  }

  /** Chart height follows full screen: short in the article, tall in full screen. */
  private applyChartHeight(rt: Runtime): void {
    rt.charts.setHeight(rt.frame.dataset.fs === 'true' ? CHART_H_FULL : CHART_H_INLINE);
  }

  private applyPalette(p: Palette): void {
    const rt = this.rt;
    // called from the ThemeController before `rt` is assigned during build: fall back to the shadow root
    const frame = rt?.frame ?? (this.shadowRoot?.querySelector('.frame') as HTMLElement | null);
    if (frame === null || frame === undefined) return;
    if (rt) rt.palette = p;
    applyCssPalette(frame, p.css);
    const s = frame.style;
    // The page's custom properties win when the theme follows the page; a forced theme uses the palette.
    const follow = this.theme === 'auto';
    const v = (slosh: string, global: string, fallback: string): string =>
      follow ? `var(${slosh}, var(${global}, ${fallback}))` : `var(${slosh}, ${fallback})`;
    s.setProperty('--sc-bg', v('--slosh-bg', '--global-bg-color', p.css.bg));
    s.setProperty('--sc-fg', v('--slosh-fg', '--global-text-color', p.css.fg));
    s.setProperty('--sc-accent', v('--slosh-accent', '--global-theme-color', p.css.accent));
    rt?.scene?.setTheme(p.scene);
    rt?.charts?.setTheme(p);
  }

  private applyRunState(rt: Runtime): void {
    if (rt.userPaused || rt.offscreen) rt.runner.pause();
    else rt.runner.resume();
  }

  /** Swap in a fresh Sim (same params, current seed). */
  private replaceSim(rt: Runtime): void {
    rt.simRef.cur = new Sim(DEFAULT_PARAMS.params, this.seed);
  }

  /** Advance one control tick and draw it, so a command shows even while paused. */
  private renderOnce(rt: Runtime): void {
    const tel = rt.simRef.cur.stepControl();
    rt.runner.ingest(tel);
    rt.scene?.update(tel);
    rt.charts.redraw(true);
    rt.summary.update(rt.ring);
    rt.controls.sync(tel);
    this.followStory(rt, tel, true);
  }

  private storyAction(rt: Runtime, a: StoryAction): void {
    rt.runner.send(storyCommands(a, a.kind === 'regime' ? ringThetaEnvelope(rt.ring) : undefined));
    this.afterStoryAction(rt, a);
  }

  /** After a story control: keep the UI live while paused (one tick shows the command), forget old narration on a reload. */
  private afterStoryAction(rt: Runtime, a: StoryAction): void {
    this.updateBanner(rt, a);
    if (a.kind !== 'regime') this.presetNow = 'story';
    // Replay the paper and the regime buttons start the flight; only Restart leaves it paused
    if (a.kind !== 'restart' && rt.userPaused) this.play();
    else if (rt.userPaused || rt.offscreen) this.renderOnce(rt);
  }

  private resetBanner(rt: Runtime): void {
    rt.banner.reset();
    rt.bannerFollow = false;
    rt.bannerRegime = null;
  }

  /** A story control was used: show the matching phase text; Replay the paper keeps following the flight's phases. */
  private updateBanner(rt: Runtime, a: StoryAction): void {
    if (a.kind === 'restart') {
      this.resetBanner(rt);
      return;
    }
    rt.banner.reset();
    const phase: BannerPhase = a.kind === 'play' ? 'replay' : a.regime;
    // Only the guided sequence follows the flight's phases; the replay starts in Nominal, so its own title stays until the next phase.
    rt.bannerFollow = a.kind === 'play';
    rt.bannerRegime = 'nominal';
    rt.narrator.reset();
    rt.banner.showPhase(phase);
    rt.banner.setCaption('');
  }

  /** Per frame: narration caption (at most 2 Hz), regime and marker events. */
  private followStory(rt: Runtime, tel: Readonly<Telemetry>, force = false): void {
    const text = rt.narrator.update(rt.ring, force);
    if (text !== null) {
      rt.banner.setCaption(text);
      rt.summary.setCaption(text);
    }
    if (tel.t < rt.lastT) {
      rt.markersSeen = -1; // the sim restarted: the ring was cleared
      rt.markerKeys.clear();
      rt.banner.clearTrips();
    }
    rt.lastT = tel.t;
    const regime = regimeOf(tel);
    if (regime !== rt.lastRegime) {
      const first = rt.lastRegime === null;
      rt.lastRegime = regime;
      if (!first && rt.bannerFollow && regime !== rt.bannerRegime) {
        rt.bannerRegime = regime;
        rt.narrator.reset();
        rt.banner.showPhase(regime);
      }
      this.emit('slosh-regime', { regime });
    }
    // markers are a sliding window: announce each one once (they are time-ordered, so compare against the latest seen time)
    const marks = rt.ring.markers();
    for (const m of marks) {
      const key = m.t;
      if (key > rt.markersSeen - 1e-9 && !(key === rt.markersSeen && rt.markerKeys.has(`${m.kind}|${m.label}`))) {
        this.emit('slosh-marker', { t: m.t, kind: m.kind, label: m.label });
        if (key > rt.markersSeen) rt.markerKeys.clear();
        rt.markersSeen = key;
        rt.markerKeys.add(`${m.kind}|${m.label}`);
      }
    }
  }

  private onFullscreen(rt: Runtime, s: FullscreenState): void {
    rt.exitBtn.hidden = !s.active;
    rt.frame.dataset.fs = String(s.active);
    rt.player.setFullscreenActive(s.active);
    if (s.active) {
      rt.exitBtn.focus();
    } else {
      const back = rt.focusBack;
      rt.focusBack = null;
      const target =
        back !== null && back.isConnected
          ? back
          : (rt.player.bar.querySelector('button[aria-label$="Full screen" i], button[aria-label$="full screen" i]') as HTMLElement | null);
      target?.focus();
    }
    // the box changed size: let the canvas and charts follow
    this.applyChartHeight(rt);
    this.applyLayout(rt);
    rt.charts.resize();
    this.emit('slosh-fullscreen', { active: s.active, mode: s.mode });
  }

  private emit(name: string, detail: unknown): void {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }

  private teardown(rt: Runtime): void {
    rt.disposed = true;
    rt.runner.stop();
    for (const c of rt.cleanups) c();
    rt.cleanups.length = 0;
    rt.fs.dispose();
    rt.theme.dispose();
    rt.charts.dispose();
    rt.scene?.dispose();
    rt.summary.dispose();
    rt.banner.dispose();
    rt.about.dispose();
    rt.controls.dispose();
    rt.player.dispose();
    (this.shadowRoot as ShadowRoot).innerHTML = '';
  }
}

export function defineSloshSim(tag = 'slosh-sim'): void {
  if (typeof customElements !== 'undefined' && !customElements.get(tag)) customElements.define(tag, SloshSim);
}

defineSloshSim();

declare global {
  interface HTMLElementTagNameMap {
    'slosh-sim': SloshSim;
  }
}
