// Live uPlot charts (6 instances) over the telemetry ring, rolling 30 s window.
//
// - One shared sim-time x axis per chart, showing the last `windowS` seconds.
// - redraw() is cheap to call every frame: it throttles itself to <= 30 Hz and only calls
//   uPlot.setData with the ring's reused buffers.
// - Colours come from the current palette through functions (series stroke, axis, grid), so
//   setTheme() only swaps the palette and redraws: no instance is recreated, the ring is kept.
// - Every series on a chart has its own colour AND dash pattern (colour-vision-deficiency safe).
import uPlot from 'uplot';
import uplotCss from 'uplot/dist/uPlot.min.css?inline';
import type { Band, ChannelId, Detection, Marker, Regime, TelemetryRing } from '../runtime/telemetry-ring';
import { DASH, LIGHT_PALETTE, type ChartPalette, type Palette } from './theme';

const R2D = 180 / Math.PI;
/** Minimum time between chart redraws: 30 Hz. */
export const MIN_REDRAW_INTERVAL_MS = 1000 / 30;

export type ChartId = 'theta' | 'mass' | 'attitude' | 'kT' | 'ySD' | 'motors';

/** Which colour of the chart palette a series uses. */
type Role = 'primary' | 'pitch' | 'pitchApplied' | 'roll' | 'rollApplied' | 'threshold' | 'motor0' | 'motor1' | 'motor2' | 'motor3';

function roleColor(p: ChartPalette, r: Role): string {
  switch (r) {
    case 'primary':
      return p.primary;
    case 'pitch':
      return p.pitch;
    case 'pitchApplied':
      return p.pitchApplied;
    case 'roll':
      return p.roll;
    case 'rollApplied':
      return p.rollApplied;
    case 'threshold':
      return p.threshold;
    case 'motor0':
      return p.motors[0];
    case 'motor1':
      return p.motors[1];
    case 'motor2':
      return p.motors[2];
    case 'motor3':
      return p.motors[3];
  }
}

interface SeriesSpec {
  label: string;
  role: Role;
  dash: readonly number[];
  /** Ring channel, or 'threshold' for the constant detection-threshold line. */
  channel: ChannelId | 'threshold';
  /** Convert the channel from radians to degrees. */
  toDeg?: boolean;
  /** Only shown while the AAC mode is 'monitor' (the applied-gain lines). */
  monitorOnly?: boolean;
}

interface ChartSpec {
  id: ChartId;
  title: string;
  description: string;
  yLabel: string;
  series: SeriesSpec[];
}

export const CHART_SPECS: readonly ChartSpec[] = [
  {
    id: 'theta',
    title: 'Pendulum angle θ',
    description: 'Angle of the hanging mass from straight down, in radians (right axis: degrees).',
    yLabel: 'θ [rad]',
    series: [{ label: 'θ', role: 'primary', dash: DASH.solid, channel: 'theta' }],
  },
  {
    id: 'mass',
    title: 'Mass position relative to the quad',
    description: 'Mass offset from the quad along north (x) and east (y), in metres.',
    yLabel: 'position [m]',
    series: [
      { label: 'x (north)', role: 'pitch', dash: DASH.solid, channel: 'massX' },
      { label: 'y (east)', role: 'roll', dash: DASH.dashed, channel: 'massY' },
    ],
  },
  {
    id: 'attitude',
    title: 'Quad roll and pitch',
    description: 'Quadrotor roll and pitch angles in degrees.',
    yLabel: 'angle [deg]',
    series: [
      { label: 'pitch', role: 'pitch', dash: DASH.solid, channel: 'pitch', toDeg: true },
      { label: 'roll', role: 'roll', dash: DASH.dashed, channel: 'roll', toDeg: true },
    ],
  },
  {
    id: 'kT',
    title: 'Adaptive forward-loop gain K_T',
    description:
      'AAC gain state per axis (solid and dashed). In Monitor mode the dotted lines show the gain that would be applied.',
    yLabel: 'K_T',
    series: [
      { label: 'pitch K_T', role: 'pitch', dash: DASH.solid, channel: 'kTPitch' },
      { label: 'roll K_T', role: 'roll', dash: DASH.dashed, channel: 'kTRoll' },
      { label: 'pitch applied', role: 'pitchApplied', dash: DASH.dotted, channel: 'kTAppliedPitch', monitorOnly: true },
      { label: 'roll applied', role: 'rollApplied', dash: DASH.dashDot, channel: 'kTAppliedRoll', monitorOnly: true },
    ],
  },
  {
    id: 'ySD',
    title: 'Spectral damper output y_SD',
    description: 'Detector signal per axis against the detection threshold.',
    yLabel: 'y_SD',
    series: [
      { label: 'pitch y_SD', role: 'pitch', dash: DASH.solid, channel: 'ySDPitch' },
      { label: 'roll y_SD', role: 'roll', dash: DASH.dashed, channel: 'ySDRoll' },
      { label: 'threshold', role: 'threshold', dash: DASH.sparse, channel: 'threshold' },
    ],
  },
  {
    id: 'motors',
    title: 'Motor commands',
    description: 'Normalized commands of the four motors, from 0 to 1.',
    yLabel: 'command [0..1]',
    series: [
      { label: 'motor 1', role: 'motor0', dash: DASH.solid, channel: 'motorCmd0' },
      { label: 'motor 2', role: 'motor1', dash: DASH.dashed, channel: 'motorCmd1' },
      { label: 'motor 3', role: 'motor2', dash: DASH.dotted, channel: 'motorCmd2' },
      { label: 'motor 4', role: 'motor3', dash: DASH.dashDot, channel: 'motorCmd3' },
    ],
  },
];

// ---------------------------------------------------------------------------------------------
// detectionMarkers plugin
// ---------------------------------------------------------------------------------------------

export interface DetectionMarkerOptions {
  /** Trip times to draw (normally `() => ring.detections()`). */
  trips: () => readonly Detection[];
  palette: () => ChartPalette;
}

/**
 * uPlot plugin: a dashed vertical line in the alert colour with a ▲ glyph at every detector trip
 * (the glyph sits a little lower for roll than for pitch), and a translucent highlight from the first
 * trip to the right edge of the plot area. Dash, colour and glyph differ from the transition lines.
 */
export function detectionMarkers(opts: DetectionMarkerOptions): uPlot.Plugin {
  return {
    hooks: {
      draw: (u: uPlot) => {
        const trips = opts.trips();
        if (trips.length === 0) return;
        const pal = opts.palette();
        const ctx = u.ctx;
        const { left, top, width, height } = u.bbox;
        const pr = typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1;

        ctx.save();
        ctx.beginPath();
        ctx.rect(left, top, width, height);
        ctx.clip();

        let first = Infinity;
        for (const d of trips) if (d.t < first) first = d.t;
        const xFirst = Math.max(left, u.valToPos(first, 'x', true));
        ctx.fillStyle = pal.detectFill;
        ctx.fillRect(xFirst, top, left + width - xFirst, height);

        ctx.strokeStyle = pal.trip;
        ctx.fillStyle = pal.trip;
        ctx.lineWidth = 1.5 * pr;
        ctx.font = `${10 * pr}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        for (const d of trips) {
          const x = u.valToPos(d.t, 'x', true);
          if (x < left || x > left + width) continue;
          ctx.setLineDash([6 * pr, 4 * pr]);
          ctx.beginPath();
          ctx.moveTo(x, top);
          ctx.lineTo(x, top + height);
          ctx.stroke();
          ctx.fillText('\u25B2', x, top + 1 * pr + d.axis * 11 * pr);
        }
        ctx.restore();
      },
    },
  };
}

// ---------------------------------------------------------------------------------------------
// regimeMarkers plugin: background bands (behind the series) and labelled transition lines
// ---------------------------------------------------------------------------------------------

export interface RegimeMarkerOptions {
  bands: () => readonly Band[];
  /** All markers; trip markers are skipped here (detectionMarkers draws them). */
  markers: () => readonly Marker[];
  palette: () => ChartPalette;
  /** Draw the text labels of the transition lines on this chart? (top chart of each column) */
  showLabels: (u: uPlot) => boolean;
}

/**
 * uPlot plugin: low-alpha regime bands behind the series (with a 3 px strip along the top edge) and
 * solid vertical transition lines at reader actions and regime changes. Colours are read from the
 * current palette at draw time.
 */
export function regimeMarkers(opts: RegimeMarkerOptions): uPlot.Plugin {
  const pxr = (): number => (typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1);
  return {
    hooks: {
      drawClear: (u: uPlot) => {
        const bands = opts.bands();
        if (bands.length === 0) return;
        const pal = opts.palette().bands;
        const ctx = u.ctx;
        const { left, top, width, height } = u.bbox;
        const pr = pxr();
        ctx.save();
        ctx.beginPath();
        ctx.rect(left, top, width, height);
        ctx.clip();
        for (const b of bands) {
          const x0 = Math.max(left, u.valToPos(b.t0, 'x', true));
          const x1 = Math.min(left + width, u.valToPos(b.t1, 'x', true));
          if (!(x1 > x0)) continue;
          const c = pal[b.regime as Regime];
          ctx.fillStyle = c.fill;
          ctx.fillRect(x0, top, x1 - x0, height);
          ctx.fillStyle = c.stroke;
          ctx.fillRect(x0, top, x1 - x0, 3 * pr);
        }
        ctx.restore();
      },
      draw: (u: uPlot) => {
        const marks = opts.markers().filter((m) => m.kind !== 'trip');
        if (marks.length === 0) return;
        const pal = opts.palette();
        const ctx = u.ctx;
        const { left, top, width, height } = u.bbox;
        const pr = pxr();
        const labels = opts.showLabels(u);
        ctx.save();
        ctx.beginPath();
        ctx.rect(left, top, width, height);
        ctx.clip();
        ctx.strokeStyle = pal.transition;
        ctx.fillStyle = pal.transition;
        ctx.lineWidth = 1.5 * pr;
        ctx.setLineDash([]);
        ctx.font = `${10 * pr}px system-ui, sans-serif`;
        ctx.textBaseline = 'top';
        const rowEnd = [-Infinity, -Infinity, -Infinity]; // right end of the last label in each row [px]
        const right = left + width;
        for (const m of marks) {
          const x = u.valToPos(m.t, 'x', true);
          if (x < left || x > right) continue;
          ctx.beginPath();
          ctx.moveTo(x, top);
          ctx.lineTo(x, top + height);
          ctx.stroke();
          if (!labels) continue;
          const w = ctx.measureText(m.label).width;
          const flip = x + 4 * pr + w > right; // no room on the right: put the text left of the line
          const x0 = flip ? x - 4 * pr - w : x + 4 * pr;
          let row = rowEnd.findIndex((e) => x0 > e);
          if (row < 0) row = 0;
          rowEnd[row] = x0 + w + 4 * pr;
          ctx.textAlign = 'left';
          ctx.fillText(m.label, x0, top + (5 + row * 12) * pr);
        }
        ctx.restore();
      },
    },
  };
}

// ---------------------------------------------------------------------------------------------
// createCharts
// ---------------------------------------------------------------------------------------------

export interface ChartsOptions {
  palette?: Palette;
  /** Initial detection threshold shown on the y_SD chart. */
  threshold?: number;
  /** Rolling window length [s] (default 30). */
  windowS?: number;
  /** Height of each chart in CSS px (default 150). */
  chartHeight?: number;
  /** Injectable clock in ms (tests). Default performance.now. */
  now?: () => number;
  /** Observe the container size and call resize() (default true). */
  observeResize?: boolean;
}

export interface ChartsHandle {
  /** Call every frame: throttled to <= 30 Hz; `force` bypasses the throttle. */
  redraw(force?: boolean): void;
  resize(): void;
  dispose(): void;
  setThreshold(v: number): void;
  setTheme(palette: Palette): void;
  /** Plot height [px] of every chart (the in-article strip uses short charts, full screen tall ones). */
  setHeight(px: number): void;
  /** The uPlot instances, in the order of CHART_SPECS (for tests and tooling). */
  readonly plots: readonly uPlot[];
  /** The element holding the charts. */
  readonly root: HTMLElement;
}

type Range = [number, number];

function pad(lo: number | null, hi: number | null, minSpan: number, include?: number): Range {
  let a = lo ?? 0;
  let b = hi ?? 0;
  if (include !== undefined) {
    a = Math.min(a, include);
    b = Math.max(b, include);
  }
  const span = Math.max(b - a, minSpan);
  const mid = (a + b) / 2;
  return [mid - span * 0.55, mid + span * 0.55];
}

function symmetric(lo: number | null, hi: number | null, minHalf: number): Range {
  const m = Math.max(Math.abs(lo ?? 0), Math.abs(hi ?? 0), minHalf) * 1.1;
  return [-m, m];
}

function svgKey(dash: readonly number[], color: string): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', '30');
  svg.setAttribute('height', '8');
  svg.setAttribute('aria-hidden', 'true');
  const line = document.createElementNS(ns, 'line');
  line.setAttribute('x1', '0');
  line.setAttribute('x2', '30');
  line.setAttribute('y1', '4');
  line.setAttribute('y2', '4');
  line.setAttribute('stroke', color);
  line.setAttribute('stroke-width', '2');
  if (dash.length > 0) line.setAttribute('stroke-dasharray', dash.join(' '));
  svg.appendChild(line);
  return svg;
}

const CSS = `
.slosh-charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr)); gap: 10px; color: var(--sc-fg, inherit); }
.slosh-charts figure { margin: 0; min-width: 0; }
.slosh-charts figcaption { font: 12px/1.3 system-ui, sans-serif; margin-top: 2px; color: var(--sc-fg, inherit); }
.slosh-charts .sc-title { font-weight: 600; display: block; }
.slosh-charts .sc-key { display: inline-flex; align-items: center; gap: 4px; margin-right: 10px; color: var(--sc-muted, inherit); white-space: nowrap; }
.slosh-charts .sc-key[hidden] { display: none; }
.slosh-charts .sc-plot { min-height: 20px; }
.slosh-charts .sc-regimes { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 4px 14px; font: 12px/1.3 system-ui, sans-serif; color: var(--sc-muted, inherit); }
.slosh-charts .sc-regimes > span { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
.slosh-charts .sc-swatch { display: inline-block; width: 16px; height: 10px; box-sizing: border-box; border-top: 3px solid; }
.slosh-charts .sc-trans { display: inline-block; width: 0; height: 12px; border-left: 2px solid; }
.slosh-charts .sc-trip { font-size: 11px; }
`;

/** Charts shorter than this [px] draw regime lines without their text labels. */
const LABEL_MIN_HEIGHT = 130;

export function createCharts(container: HTMLElement, ring: TelemetryRing, opts: ChartsOptions = {}): ChartsHandle {
  const doc = container.ownerDocument;
  const now = opts.now ?? (() => performance.now());
  const windowS = opts.windowS ?? 30;
  let height = opts.chartHeight ?? 150;
  let palette: Palette = opts.palette ?? LIGHT_PALETTE;
  let threshold = opts.threshold ?? 1;
  let disposed = false;

  const root = doc.createElement('div');
  root.className = 'slosh-charts';
  const style = doc.createElement('style');
  style.textContent = uplotCss + CSS;
  root.appendChild(style);
  container.appendChild(root);

  // regime legend: band swatches, transition line, trip glyph
  const legend = doc.createElement('div');
  legend.className = 'sc-regimes';
  const regimeKeys: Array<{ swatch: HTMLElement; regime: Regime }> = [];
  const mkKey = (cls: string, text: string): HTMLElement => {
    const k = doc.createElement('span');
    const sw = doc.createElement('span');
    sw.className = cls;
    sw.setAttribute('aria-hidden', 'true');
    k.appendChild(sw);
    k.appendChild(doc.createTextNode(text));
    legend.appendChild(k);
    return sw;
  };
  const REGIME_LABELS: ReadonlyArray<[Regime, string]> = [
    ['nominal', 'Nominal'],
    ['gainShift', 'Gain shift'],
    ['engaged', 'AAC engaged'],
  ];
  for (const [regime, text] of REGIME_LABELS) regimeKeys.push({ swatch: mkKey('sc-swatch', text), regime });
  const transKey = mkKey('sc-trans', 'regime change / reader action');
  const tripKey = mkKey('sc-trip', ' detector trip');
  tripKey.textContent = '\u25B2';
  root.appendChild(legend);

  // reusable buffers
  const cap = ring.capacity;
  const degBuf = new Map<ChannelId, Float64Array>();
  const thrBuf = new Float64Array(cap);
  let thrFilledFor = -1;
  let thrFilledN = -1;

  // marker/band snapshot, rebuilt only when the ring changed (6 charts draw per redraw)
  let snapVersion = -1;
  let snapMarks: Marker[] = [];
  let snapBands: Band[] = [];
  let snapTrips: Detection[] = [];
  const snap = (): void => {
    if (snapVersion === ring.version) return;
    snapVersion = ring.version;
    snapMarks = ring.markers();
    snapBands = ring.bands();
    snapTrips = [];
    for (const m of snapMarks) if (m.kind === 'trip') snapTrips.push({ t: m.t, axis: m.axis ?? 0 });
  };
  const labelFlags = new Map<ChartId, boolean>();
  const detPlugin = detectionMarkers({
    trips: () => (snap(), snapTrips),
    palette: () => palette.chart,
  });
  const regimePlugin = (id: ChartId): uPlot.Plugin =>
    regimeMarkers({
      bands: () => (snap(), snapBands),
      markers: () => (snap(), snapMarks),
      palette: () => palette.chart,
      // small charts (the in-article strip) keep the lines but drop the text labels, which would cover the data
      showLabels: () => height >= LABEL_MIN_HEIGHT && (labelFlags.get(id) ?? true),
    });

  interface Entry {
    spec: ChartSpec;
    u: uPlot;
    host: HTMLElement;
    keys: Array<{ el: HTMLElement; svg: SVGLineElement; spec: SeriesSpec }>;
    width: number;
  }
  const entries: Entry[] = [];

  const axisCommon = {
    stroke: () => palette.chart.axis,
    grid: { stroke: () => palette.chart.grid, width: 1 },
    ticks: { stroke: () => palette.chart.axis, width: 1, size: 4 },
    font: '11px system-ui, sans-serif',
    labelFont: '11px system-ui, sans-serif',
  };

  const yRange = (id: ChartId) => (_u: uPlot, lo: number, hi: number): Range => {
    const a = Number.isFinite(lo) ? lo : null;
    const b = Number.isFinite(hi) ? hi : null;
    switch (id) {
      case 'theta': {
        return [0, Math.max(0.1, (b ?? 0) * 1.1)];
      }
      case 'mass':
        return symmetric(a, b, 0.1);
      case 'attitude':
        return symmetric(a, b, 2);
      case 'kT':
        return pad(a, b, 0.2, 1);
      case 'ySD':
        return [0, Math.max(threshold * 1.5, (b ?? 0) * 1.1)];
      case 'motors':
        return [0, 1];
    }
  };

  const widthOf = (host: HTMLElement): number => Math.max(120, Math.floor(host.clientWidth) || 300);

  for (const spec of CHART_SPECS) {
    const fig = doc.createElement('figure');
    fig.setAttribute('aria-label', spec.title);
    fig.dataset.chart = spec.id;
    const host = doc.createElement('div');
    host.className = 'sc-plot';
    host.setAttribute('role', 'img');
    host.setAttribute('aria-label', `${spec.title}. ${spec.description}`);
    const cap_ = doc.createElement('figcaption');
    const title = doc.createElement('span');
    title.className = 'sc-title';
    title.textContent = spec.title;
    cap_.appendChild(title);
    const keys: Entry['keys'] = [];
    for (const s of spec.series) {
      const k = doc.createElement('span');
      k.className = 'sc-key';
      const svg = svgKey(s.dash, roleColor(palette.chart, s.role));
      k.appendChild(svg);
      k.appendChild(doc.createTextNode(s.label));
      cap_.appendChild(k);
      keys.push({ el: k, svg: svg.firstChild as SVGLineElement, spec: s });
    }
    fig.appendChild(host);
    fig.appendChild(cap_);
    root.appendChild(fig);

    const hasDeg = spec.id === 'theta';
    const o: uPlot.Options = {
      width: widthOf(host),
      height,
      padding: [8, 8, 0, 0],
      legend: { show: false },
      cursor: { show: false },
      select: { show: false, left: 0, top: 0, width: 0, height: 0 },
      plugins: [regimePlugin(spec.id), detPlugin],
      scales: {
        x: {
          time: false,
          range: (_u, _lo, hi) => {
            const end = Math.max(Number.isFinite(hi) ? hi : 0, windowS);
            return [end - windowS, end];
          },
        },
        y: { range: yRange(spec.id) },
        ...(hasDeg ? { deg: { from: 'y', range: (_u: uPlot, lo: number, hi: number): Range => [lo * R2D, hi * R2D] } } : {}),
      },
      axes: [
        { ...axisCommon, scale: 'x', size: 36, label: 'sim time [s]', labelSize: 14, incrs: [1, 2, 5, 10] },
        { ...axisCommon, scale: 'y', size: 54, label: spec.yLabel, labelSize: 14 },
        ...(hasDeg ? [{ ...axisCommon, scale: 'deg', side: 1 as const, size: 44, label: 'θ [deg]', labelSize: 14, grid: { show: false } }] : []),
      ],
      series: [
        {},
        ...spec.series.map(
          (s): uPlot.Series => ({
            label: s.label,
            scale: 'y',
            stroke: () => roleColor(palette.chart, s.role),
            width: 1.6,
            dash: [...s.dash],
            points: { show: false },
            show: s.monitorOnly ? false : true,
          }),
        ),
      ],
    };
    const empty: uPlot.AlignedData = [[], ...spec.series.map(() => [])] as uPlot.AlignedData;
    const u = new uPlot(o, empty, host);
    entries.push({ spec, u, host, keys, width: o.width });
  }

  // --- data ---
  const chanCache = new Map<ChannelId, Float64Array>();
  const channelData = (ch: ChannelId, toDeg: boolean): Float64Array => {
    const key = ch;
    let v = chanCache.get(key);
    if (v === undefined) {
      v = ring.view(ch);
      chanCache.set(key, v);
    }
    if (!toDeg) return v;
    let buf = degBuf.get(ch);
    if (buf === undefined) {
      buf = new Float64Array(cap);
      degBuf.set(ch, buf);
    }
    for (let i = 0; i < v.length; i++) buf[i] = (v[i] as number) * R2D;
    return buf.subarray(0, v.length);
  };

  const thresholdData = (n: number): Float64Array => {
    if (thrFilledFor !== threshold || thrFilledN !== n) {
      thrBuf.fill(threshold, 0, n);
      thrFilledFor = threshold;
      thrFilledN = n;
    }
    return thrBuf.subarray(0, n);
  };

  const applyDomPalette = (): void => {
    const c = palette.css;
    root.style.setProperty('--sc-fg', c.fg);
    root.style.setProperty('--sc-muted', c.muted);
    for (const e of entries) {
      for (const k of e.keys) k.svg.setAttribute('stroke', roleColor(palette.chart, k.spec.role));
    }
    for (const k of regimeKeys) {
      const c = palette.chart.bands[k.regime];
      k.swatch.style.background = c.fill;
      k.swatch.style.borderTopColor = c.stroke;
    }
    transKey.style.borderLeftColor = palette.chart.transition;
    tripKey.style.color = palette.chart.trip;
  };
  applyDomPalette();

  /** Labels go on the top visible chart of each column of the chart grid. */
  const updateLabelFlags = (): void => {
    const rects = entries.map((e) => (e.host.parentElement as HTMLElement).getBoundingClientRect());
    entries.forEach((e, i) => {
      const r = rects[i] as DOMRect;
      const hidden = r.height === 0 && r.width === 0 && rects.some((q) => q.height > 0);
      let top = !hidden;
      if (top) {
        rects.forEach((q, j) => {
          if (j !== i && q.height > 0 && Math.abs(q.left - r.left) < 4 && q.top < r.top - 1) top = false;
        });
      }
      labelFlags.set(e.spec.id, top);
    });
  };

  const pushData = (): void => {
    chanCache.clear();
    updateLabelFlags();
    const n = ring.length;
    const t = channelData('t', false);
    const mode = ring.latest()?.aacMode;
    const showApplied = mode === 'monitor';
    for (const e of entries) {
      const cols = e.spec.series.map((s) =>
        s.channel === 'threshold' ? thresholdData(n) : channelData(s.channel, s.toDeg === true),
      );
      e.u.setData([t, ...cols] as uPlot.AlignedData, true);
      e.spec.series.forEach((s, i) => {
        if (s.monitorOnly === true) {
          const ser = e.u.series[i + 1];
          if (ser !== undefined && ser.show !== showApplied) e.u.setSeries(i + 1, { show: showApplied });
          const key = e.keys[i];
          if (key !== undefined) key.el.hidden = !showApplied;
        }
      });
    }
  };
  // applied-gain keys start hidden (shown only in Monitor mode)
  for (const e of entries) for (const k of e.keys) if (k.spec.monitorOnly === true) k.el.hidden = true;

  // --- throttle: <= 30 Hz, drift-corrected so jittery frame times still average <= 30 Hz ---
  let nextDue = -Infinity;
  let lastVersion = -1;
  let dirty = true;

  const redraw = (force = false): void => {
    if (disposed) return;
    const t = now();
    if (!force) {
      if (t + 1e-3 < nextDue) return;
      if (ring.version === lastVersion && !dirty) return;
    }
    // advance the schedule by one interval; if we are more than one interval late, restart it
    nextDue = t - nextDue > MIN_REDRAW_INTERVAL_MS ? t + MIN_REDRAW_INTERVAL_MS : nextDue + MIN_REDRAW_INTERVAL_MS;
    pushData();
    lastVersion = ring.version;
    dirty = false;
  };

  const resize = (): void => {
    if (disposed) return;
    let changed = false;
    for (const e of entries) {
      const w = widthOf(e.host);
      if (w !== e.width) {
        e.width = w;
        e.u.setSize({ width: w, height });
        changed = true;
      }
    }
    if (changed) redraw(true);
  };

  let observer: ResizeObserver | null = null;
  if (opts.observeResize !== false && typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(() => resize());
    observer.observe(container);
  }

  return {
    redraw,
    resize,
    setThreshold(v: number): void {
      threshold = v;
      dirty = true;
      redraw(true);
    },
    setHeight(px: number): void {
      if (px === height) return;
      height = px;
      for (const e of entries) e.u.setSize({ width: e.width, height });
      dirty = true;
      redraw(true);
    },
    setTheme(p: Palette): void {
      palette = p;
      applyDomPalette();
      dirty = true;
      redraw(true);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      observer?.disconnect();
      for (const e of entries) e.u.destroy();
      root.remove();
    },
    plots: entries.map((e) => e.u),
    root,
  };
}
