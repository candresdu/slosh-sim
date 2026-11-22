// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type uPlot from 'uplot';
import type { SimCommand, Telemetry } from '../../src/core/sim';
import { TelemetryRing, type Band, type Marker } from '../../src/runtime/telemetry-ring';
import { CHART_SPECS, MIN_REDRAW_INTERVAL_MS, createCharts, detectionMarkers, regimeMarkers, type ChartsHandle } from '../../src/view/charts';
import { DARK_PALETTE, LIGHT_PALETTE } from '../../src/view/theme';

// ---- canvas / browser API stubs (jsdom has no canvas; uPlot reads matchMedia at import time) -----
interface Call {
  name: string;
  args: unknown[];
}
const recorders = vi.hoisted(() => {
  const rec = new WeakMap<HTMLCanvasElement, Array<{ name: string; args: unknown[] }>>();
  function makeCtx(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
    const calls: Array<{ name: string; args: unknown[] }> = [];
    rec.set(canvas, calls);
    const props: Record<string, unknown> = {};
    return new Proxy({} as Record<string, unknown>, {
      get(_t, name: string) {
        if (name === 'canvas') return canvas;
        if (name === 'measureText') return () => ({ width: 10 });
        if (name in props) return props[name];
        return (...args: unknown[]) => {
          calls.push({ name, args });
        };
      },
      set(_t, name: string, v) {
        props[name] = v;
        calls.push({ name: `set:${name}`, args: [v] });
        return true;
      },
    }) as unknown as CanvasRenderingContext2D;
  }
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
    return makeCtx(this);
  } as unknown as HTMLCanvasElement['getContext'];
  class FakePath2D {
    moveTo(): void {}
    lineTo(): void {}
    rect(): void {}
    closePath(): void {}
    arc(): void {}
    addPath(): void {}
    bezierCurveTo(): void {}
  }
  (globalThis as Record<string, unknown>).Path2D = FakePath2D;
  (globalThis as Record<string, unknown>).matchMedia = () => ({
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    matches: false,
  });
  return rec;
});

// ---- helpers ------------------------------------------------------------------------------------
function sample(t: number, over: Partial<Telemetry> = {}): Telemetry {
  return {
    t,
    theta: 0.2 + 0.01 * Math.sin(t),
    phi: 0,
    massRel: [0.1 * Math.sin(t), 0.05 * Math.cos(t), 1],
    quadPos: [0, 0, -1],
    roll: 0.01,
    pitch: -0.02,
    yaw: 0,
    kT: [1 - 0.001 * t, 1],
    kTApplied: [1, 1],
    ySD: [0.01, 0.02],
    detect: [false, false],
    gainShift: 1,
    aacMode: 'off',
    motorCmd: [0.5, 0.5, 0.5, 0.5],
    motorOmega: [500, 500, 500, 500],
    ...over,
  };
}

function fill(ring: TelemetryRing, n: number, over: (i: number) => Partial<Telemetry> = () => ({})): void {
  for (let i = 0; i < n; i++) ring.push(sample((i + 1) * 0.01, over(i)));
}

let handle: ChartsHandle | null = null;
let host: HTMLElement | null = null;
function make(ring: TelemetryRing, opts: Parameters<typeof createCharts>[2] = {}): ChartsHandle {
  host = document.createElement('div');
  document.body.appendChild(host);
  handle = createCharts(host, ring, { observeResize: false, ...opts });
  return handle;
}
afterEach(() => {
  handle?.dispose();
  handle = null;
  host?.remove();
  host = null;
});

const seriesStroke = (u: uPlot, i: number): string => (u.series[i]!.stroke as (u: uPlot, i: number) => string)(u, i);
const seriesDash = (u: uPlot, i: number): string => JSON.stringify(u.series[i]!.dash ?? []);

// uPlot commits scales and draws in a microtask
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// ---- tests --------------------------------------------------------------------------------------
describe('createCharts: construction', () => {
  it('creates 6 charts with series counts [1, 2, 2, 4, 3, 4]', () => {
    const h = make(new TelemetryRing());
    expect(h.plots).toHaveLength(6);
    expect(h.plots.map((u) => u.series.length - 1)).toEqual([1, 2, 2, 4, 3, 4]);
    expect(CHART_SPECS.map((s) => s.series.length)).toEqual([1, 2, 2, 4, 3, 4]);
  });

  it('gives each chart an aria-label and a figcaption', () => {
    const h = make(new TelemetryRing());
    const figs = h.root.querySelectorAll('figure');
    expect(figs).toHaveLength(6);
    figs.forEach((f) => {
      expect(f.getAttribute('aria-label')).toBeTruthy();
      expect(f.querySelector('figcaption')?.textContent?.length).toBeGreaterThan(3);
      expect(f.querySelector('[role="img"]')?.getAttribute('aria-label')).toBeTruthy();
    });
  });

  it('uses a secondary degree axis on the theta chart and a shared 30 s x window', async () => {
    const ring = new TelemetryRing();
    fill(ring, 3000);
    fill(ring, 500); // wraps: t restarts -> ring cleared, then refilled
    const h = make(ring);
    h.redraw(true);
    await flush();
    const theta = h.plots[0]!;
    expect(theta.axes).toHaveLength(3);
    expect(theta.scales.deg).toBeDefined();
    for (const u of h.plots) {
      expect(u.scales.x!.max! - u.scales.x!.min!).toBeCloseTo(30, 9);
    }
  });

  it('rolls the window: shows the last 30 s once the sim time passes 30 s', async () => {
    const ring = new TelemetryRing();
    for (let i = 1; i <= 4500; i++) ring.push(sample(i * 0.01));
    const h = make(ring);
    h.redraw(true);
    await flush();
    const x = h.plots[2]!.scales.x!;
    expect(x.max).toBeCloseTo(45, 9);
    expect(x.min).toBeCloseTo(15, 9);
  });

  it('plots the ring data (roll and pitch in degrees, mass N and E)', () => {
    const ring = new TelemetryRing();
    fill(ring, 100);
    const h = make(ring);
    h.redraw(true);
    expect(h.plots[0]!.data[0]).toHaveLength(100);
    expect(h.plots[2]!.data[1]![99]).toBeCloseTo((-0.02 * 180) / Math.PI, 9); // pitch
    expect(h.plots[2]!.data[2]![99]).toBeCloseTo((0.01 * 180) / Math.PI, 9); // roll
    expect(h.plots[1]!.data[1]![99]).toBeCloseTo(0.1 * Math.sin(1.0), 9);
    expect(h.plots[1]!.data[2]![99]).toBeCloseTo(0.05 * Math.cos(1.0), 9);
  });
});

describe('createCharts: throttling', () => {
  it('calls setData at most 30 times per simulated second at 60 fps', () => {
    const ring = new TelemetryRing();
    let clock = 0;
    const h = make(ring, { now: () => clock });
    const spies = h.plots.map((u) => {
      const orig = u.setData.bind(u);
      const spy = vi.fn(orig);
      u.setData = spy as unknown as typeof u.setData;
      return spy;
    });
    const frame = 1000 / 60;
    for (let i = 0; i < 60; i++) {
      clock = i * frame;
      // the sim pushes 1 or 2 ticks per frame (100 Hz)
      ring.push(sample(ring.length === 0 ? 0.01 : (ring.latest()!.t + 0.01)));
      h.redraw();
    }
    for (const s of spies) {
      expect(s.mock.calls.length).toBeLessThanOrEqual(30);
      expect(s.mock.calls.length).toBeGreaterThanOrEqual(28);
    }
  });

  it('stays at or below 30 Hz on a 144 Hz display and with jittery frame times', () => {
    const ring = new TelemetryRing();
    let clock = 0;
    const h = make(ring, { now: () => clock });
    const spy = vi.fn(h.plots[0]!.setData.bind(h.plots[0]!));
    h.plots[0]!.setData = spy as unknown as uPlot['setData'];
    let seed = 7;
    const rnd = (): number => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    let tSim = 0;
    while (clock < 10000) {
      clock += 1000 / 144 + (rnd() - 0.5) * 2;
      tSim += 0.01;
      ring.push(sample(tSim));
      h.redraw();
    }
    expect(spy.mock.calls.length).toBeLessThanOrEqual(10 * 30 + 1);
    expect(MIN_REDRAW_INTERVAL_MS).toBeCloseTo(33.333, 2);
  });

  it('does not redraw when the ring has not changed (paused), but force does', () => {
    const ring = new TelemetryRing();
    fill(ring, 10);
    let clock = 0;
    const h = make(ring, { now: () => clock });
    const spy = vi.fn(h.plots[0]!.setData.bind(h.plots[0]!));
    h.plots[0]!.setData = spy as unknown as uPlot['setData'];
    h.redraw();
    clock += 100;
    h.redraw();
    clock += 100;
    h.redraw();
    expect(spy).toHaveBeenCalledTimes(1);
    h.redraw(true);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('detectionMarkers', () => {
  it('draws a vertical line at each trip time and a highlight after the first trip (hook level)', () => {
    const calls: Call[] = [];
    const ctx = new Proxy({} as Record<string, unknown>, {
      get: (_t, name: string) => (...args: unknown[]) => void calls.push({ name, args }),
      set: () => true,
    });
    const u = {
      ctx,
      bbox: { left: 10, top: 5, width: 300, height: 100 },
      valToPos: (v: number) => 10 + v * 10,
    } as unknown as uPlot;
    const plugin = detectionMarkers({
      trips: () => [
        { t: 4, axis: 0 },
        { t: 12, axis: 1 },
      ],
      palette: () => LIGHT_PALETTE.chart,
    });
    (plugin.hooks.draw as (u: uPlot) => void)(u);
    const moves = calls.filter((c) => c.name === 'moveTo').map((c) => c.args[0]);
    expect(moves).toEqual([50, 130]);
    const fillRect = calls.find((c) => c.name === 'fillRect')!;
    expect(fillRect.args).toEqual([50, 5, 260, 100]); // from first trip to the right edge
  });

  it('draws nothing without detections and skips trips outside the plot area', () => {
    const calls: Call[] = [];
    const ctx = new Proxy({} as Record<string, unknown>, {
      get: (_t, name: string) => (...args: unknown[]) => void calls.push({ name, args }),
      set: () => true,
    });
    const u = { ctx, bbox: { left: 0, top: 0, width: 100, height: 50 }, valToPos: (v: number) => v } as unknown as uPlot;
    let trips = [] as Array<{ t: number; axis: 0 | 1 }>;
    const plugin = detectionMarkers({ trips: () => trips, palette: () => LIGHT_PALETTE.chart });
    (plugin.hooks.draw as (u: uPlot) => void)(u);
    expect(calls).toHaveLength(0);
    trips = [{ t: 500, axis: 0 }];
    (plugin.hooks.draw as (u: uPlot) => void)(u);
    expect(calls.filter((c) => c.name === 'moveTo')).toHaveLength(0);
  });

  it('draws at the times returned by ring.detections() on every chart', async () => {
    const ring = new TelemetryRing();
    fill(ring, 400, (i) => ({ detect: [i >= 150, i >= 250], aacMode: 'monitor' }));
    const trips = ring.detections().map((d) => d.t);
    expect(trips).toHaveLength(2);
    expect(trips[0]).toBeCloseTo(1.51, 9);
    expect(trips[1]).toBeCloseTo(2.51, 9);
    const h = make(ring);
    h.redraw(true);
    await flush();
    for (const u of h.plots) {
      const rec = recorders.get(u.ctx.canvas)!;
      rec.length = 0;
      u.redraw(); // runs the draw hooks again, recording only this pass
      await flush();
      const xs = rec.filter((c) => c.name === 'moveTo').map((c) => c.args[0] as number);
      for (const d of ring.detections()) {
        const expected = u.valToPos(d.t, 'x', true);
        expect(xs.some((x) => Math.abs(x - expected) < 1e-9)).toBe(true);
      }
      expect(rec.some((c) => c.name === 'fillRect')).toBe(true);
    }
  });
});

describe('palettes: colour and dash', () => {
  for (const pal of [LIGHT_PALETTE, DARK_PALETTE]) {
    it(`every series pair on a chart differs in colour and dash pattern (${pal.name})`, () => {
      const ring = new TelemetryRing();
      fill(ring, 20);
      const h = make(ring, { palette: pal });
      h.plots.forEach((u, ci) => {
        const n = u.series.length;
        for (let a = 1; a < n; a++) {
          for (let b = a + 1; b < n; b++) {
            expect(seriesStroke(u, a), `chart ${ci} series ${a} vs ${b} colour`).not.toBe(seriesStroke(u, b));
            expect(seriesDash(u, a), `chart ${ci} series ${a} vs ${b} dash`).not.toBe(seriesDash(u, b));
          }
        }
      });
    });
  }

  it('dark palette: Okabe-Ito black becomes light grey, and axes are lighter than in light', () => {
    expect(LIGHT_PALETTE.chart.primary).toBe('#000000');
    expect(DARK_PALETTE.chart.primary).not.toBe('#000000');
    const lum = (hex: string): number => {
      const v = hex.replace('#', '');
      return [0, 2, 4].reduce((s, i) => s + parseInt(v.slice(i, i + 2), 16), 0);
    };
    expect(lum(DARK_PALETTE.chart.primary)).toBeGreaterThan(500);
    expect(lum(DARK_PALETTE.chart.axis)).toBeGreaterThan(lum(LIGHT_PALETTE.chart.axis));
  });
});

describe('setTheme', () => {
  it('changes series strokes without creating new instances and keeps the ring data plotted', () => {
    const ring = new TelemetryRing();
    fill(ring, 200);
    const h = make(ring, { palette: LIGHT_PALETTE });
    h.redraw(true);
    const before = [...h.plots];
    const lightStrokes = h.plots.map((u) => u.series.slice(1).map((_s, i) => seriesStroke(u, i + 1)));
    const axisLight = (h.plots[0]!.axes[0]!.stroke as () => string)();
    const gridLight = ((h.plots[0]!.axes[0]!.grid as { stroke: () => string }).stroke)();

    h.setTheme(DARK_PALETTE);

    expect(h.plots).toHaveLength(6);
    h.plots.forEach((u, i) => expect(u).toBe(before[i]));
    expect(h.root.querySelectorAll('canvas').length).toBe(6);
    h.plots.forEach((u, ci) => {
      // the first series of every chart changes colour
      expect(seriesStroke(u, 1)).not.toBe(lightStrokes[ci]![0]);
      expect(seriesStroke(u, 1)).toBe(
        ci === 0 ? DARK_PALETTE.chart.primary : ci === 5 ? DARK_PALETTE.chart.motors[0] : DARK_PALETTE.chart.pitch,
      );
      // ring data is still plotted
      expect(u.data[0]).toHaveLength(200);
      expect(u.data[1]).toHaveLength(200);
    });
    expect((h.plots[0]!.axes[0]!.stroke as () => string)()).toBe(DARK_PALETTE.chart.axis);
    expect((h.plots[0]!.axes[0]!.stroke as () => string)()).not.toBe(axisLight);
    expect(((h.plots[0]!.axes[0]!.grid as { stroke: () => string }).stroke)()).not.toBe(gridLight);
    expect(h.root.style.getPropertyValue('--sc-fg')).toBe(DARK_PALETTE.css.fg);

    // and back
    h.setTheme(LIGHT_PALETTE);
    expect(seriesStroke(h.plots[3]!, 1)).toBe(LIGHT_PALETTE.chart.pitch);
    h.plots.forEach((u, i) => expect(u).toBe(before[i]));
  });

  it('keeps the legend key swatches in sync with the palette', () => {
    const h = make(new TelemetryRing(), { palette: LIGHT_PALETTE });
    const first = (): string => h.root.querySelector('figure[data-chart="theta"] line')!.getAttribute('stroke')!;
    expect(first()).toBe(LIGHT_PALETTE.chart.primary);
    h.setTheme(DARK_PALETTE);
    expect(first()).toBe(DARK_PALETTE.chart.primary);
  });
});

describe('K_T applied lines and threshold', () => {
  it('shows the applied (dashed) K_T lines only in monitor mode', () => {
    const ring = new TelemetryRing();
    fill(ring, 50, () => ({ aacMode: 'monitor' }));
    const h = make(ring);
    h.redraw(true);
    const kt = h.plots[3]!;
    expect(kt.series.map((s) => s.show)).toEqual([true, true, true, true, true]);
    fill(ring, 1, () => ({ aacMode: 'engaged' }));
    ring.push(sample(100, { aacMode: 'engaged' }));
    h.redraw(true);
    expect(kt.series.slice(3).map((s) => s.show)).toEqual([false, false]);
    expect(kt.series.slice(1, 3).map((s) => s.show)).toEqual([true, true]);
  });

  it('setThreshold updates the horizontal threshold line', async () => {
    const ring = new TelemetryRing();
    fill(ring, 30);
    const h = make(ring, { threshold: 0.5 });
    h.redraw(true);
    const ysd = h.plots[4]!;
    expect(Array.from(ysd.data[3]!.slice(0, 3))).toEqual([0.5, 0.5, 0.5]);
    h.setThreshold(2);
    await flush();
    expect(ysd.data[3]![29]).toBe(2);
    expect(ysd.scales.y!.max!).toBeGreaterThanOrEqual(3);
  });
});

describe('dispose', () => {
  it('removes the charts from the container', () => {
    const h = make(new TelemetryRing());
    const parent = h.root.parentElement!;
    h.dispose();
    expect(parent.querySelector('.slosh-charts')).toBeNull();
    expect(() => h.redraw(true)).not.toThrow();
  });
});

// ---- regime bands, transition lines, trip markers -------------------------------------------------
function recCtx(): { ctx: CanvasRenderingContext2D; calls: Call[] } {
  const calls: Call[] = [];
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (_t, name: string) => {
      if (name === 'measureText') return (txt: string) => ({ width: txt.length * 5 });
      return (...args: unknown[]) => void calls.push({ name, args });
    },
    set: (_t, name: string, v) => {
      calls.push({ name: `set:${name}`, args: [v] });
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}
const fakePlot = (ctx: CanvasRenderingContext2D): uPlot =>
  ({ ctx, bbox: { left: 10, top: 5, width: 300, height: 100 }, valToPos: (v: number) => 10 + v * 10 }) as unknown as uPlot;

describe('regimeMarkers (hook level)', () => {
  const bands: Band[] = [
    { t0: 0, t1: 5, regime: 'nominal' },
    { t0: 5, t1: 12, regime: 'gainShift' },
    { t0: 12, t1: 40, regime: 'engaged' }, // runs past the right edge: clipped
  ];
  const marks: Marker[] = [
    { t: 5, kind: 'gainShift', label: 'Gain shift \u2192 2.3' },
    { t: 9, kind: 'trip', label: 'Detector tripped (pitch)', axis: 0 },
    { t: 12, kind: 'aacMode', label: 'AAC engaged' },
    { t: 500, kind: 'kick', label: 'Disturbance' }, // outside the plot
  ];
  const make1 = (labels: boolean, pal = LIGHT_PALETTE) =>
    regimeMarkers({ bands: () => bands, markers: () => marks, palette: () => pal.chart, showLabels: () => labels });

  it('draws each band as a low-alpha fill in its palette colour, clipped to the plot area', () => {
    const { ctx, calls } = recCtx();
    (make1(false).hooks.drawClear as (u: uPlot) => void)(fakePlot(ctx));
    const rects = calls.filter((c) => c.name === 'fillRect').map((c) => c.args);
    expect(rects.filter((r) => r[3] === 100)).toEqual([
      [10, 5, 50, 100],
      [60, 5, 70, 100],
      [130, 5, 180, 100], // right edge at 310
    ]);
    const fills = calls.filter((c) => c.name === 'set:fillStyle').map((c) => c.args[0]);
    const b = LIGHT_PALETTE.chart.bands;
    expect(fills).toEqual([b.nominal.fill, b.nominal.stroke, b.gainShift.fill, b.gainShift.stroke, b.engaged.fill, b.engaged.stroke]);
  });

  it('draws solid transition lines for non-trip markers only, labels only when asked', () => {
    for (const labels of [false, true]) {
      const { ctx, calls } = recCtx();
      (make1(labels).hooks.draw as (u: uPlot) => void)(fakePlot(ctx));
      expect(calls.filter((c) => c.name === 'moveTo').map((c) => c.args[0])).toEqual([60, 130]);
      expect(calls.filter((c) => c.name === 'setLineDash').every((c) => (c.args[0] as number[]).length === 0)).toBe(true);
      const texts = calls.filter((c) => c.name === 'fillText').map((c) => c.args[0]);
      expect(texts).toEqual(labels ? ['Gain shift \u2192 2.3', 'AAC engaged'] : []);
    }
  });

  it('draws nothing without bands or markers', () => {
    const { ctx, calls } = recCtx();
    const p = regimeMarkers({ bands: () => [], markers: () => [], palette: () => LIGHT_PALETTE.chart, showLabels: () => true });
    (p.hooks.drawClear as (u: uPlot) => void)(fakePlot(ctx));
    (p.hooks.draw as (u: uPlot) => void)(fakePlot(ctx));
    expect(calls).toHaveLength(0);
  });

  it('reads colours from the palette at draw time', () => {
    let pal = LIGHT_PALETTE;
    const p = regimeMarkers({ bands: () => bands, markers: () => marks, palette: () => pal.chart, showLabels: () => false });
    const style = (): unknown => {
      const { ctx, calls } = recCtx();
      (p.hooks.drawClear as (u: uPlot) => void)(fakePlot(ctx));
      return calls.find((c) => c.name === 'set:fillStyle')!.args[0];
    };
    expect(style()).toBe(LIGHT_PALETTE.chart.bands.nominal.fill);
    pal = DARK_PALETTE;
    expect(style()).toBe(DARK_PALETTE.chart.bands.nominal.fill);
  });

  it('trip markers are dashed, in the trip colour and carry a ▲; transition lines are solid', () => {
    const { ctx, calls } = recCtx();
    const p = detectionMarkers({ trips: () => [{ t: 9, axis: 1 }], palette: () => LIGHT_PALETTE.chart });
    (p.hooks.draw as (u: uPlot) => void)(fakePlot(ctx));
    expect(calls.find((c) => c.name === 'setLineDash')!.args[0]).not.toEqual([]);
    expect(calls.filter((c) => c.name === 'set:strokeStyle').map((c) => c.args[0])).toEqual([LIGHT_PALETTE.chart.trip]);
    expect(calls.find((c) => c.name === 'fillText')!.args[0]).toBe('\u25B2');
    expect(LIGHT_PALETTE.chart.trip).not.toBe(LIGHT_PALETTE.chart.transition);
    expect(DARK_PALETTE.chart.trip).not.toBe(DARK_PALETTE.chart.transition);
  });
});

describe('charts: bands, markers and trips on all 6 charts', () => {
  const log = (c: SimCommand): [number, SimCommand] => [0, c];
  function story(): TelemetryRing {
    const ring = new TelemetryRing();
    for (let i = 1; i <= 600; i++) {
      const over: Partial<Telemetry> =
        i < 200 ? {} : i < 400 ? { gainShift: 2.3, aacMode: 'monitor', detect: [i >= 300, false] } : { gainShift: 2.3, aacMode: 'engaged', detect: [true, false] };
      const cmds =
        i === 200 ? [log({ type: 'rampGainShift', to: 2.3, durationS: 1.5 }), log({ type: 'setAacMode', mode: 'monitor' })] : i === 400 ? [log({ type: 'setAacMode', mode: 'engaged' })] : [];
      ring.push(sample(i * 0.01, over), cmds);
    }
    return ring;
  }

  it('draws bands, transition lines and trip markers on every chart; labels as the label flags say', async () => {
    const ring = story();
    const h = make(ring);
    h.redraw(true);
    await flush();
    let labelled = 0;
    for (const u of h.plots) {
      const rec = recorders.get(u.ctx.canvas)!;
      rec.length = 0;
      u.redraw();
      await flush();
      const fills = rec.filter((c) => c.name === 'set:fillStyle').map((c) => c.args[0]);
      for (const r of ['nominal', 'gainShift', 'engaged'] as const) {
        expect(fills).toContain(LIGHT_PALETTE.chart.bands[r].fill);
      }
      const dashed = rec.filter((c) => c.name === 'setLineDash').map((c) => (c.args[0] as number[]).length);
      expect(dashed).toContain(0); // transition lines
      expect(dashed.some((n) => n > 0)).toBe(true); // trip line
      expect(rec.some((c) => c.name === 'fillText' && c.args[0] === '\u25B2')).toBe(true);
      if (rec.some((c) => c.name === 'fillText' && c.args[0] === 'AAC engaged')) labelled++;
    }
    expect(labelled).toBeGreaterThan(0); // jsdom has no layout: every chart counts as a column top
  });

  it('band and trip colours switch with setTheme() without recreating the charts', async () => {
    const ring = story();
    const h = make(ring, { palette: LIGHT_PALETTE });
    h.redraw(true);
    await flush();
    const before = [...h.plots];
    const canvases = [...h.root.querySelectorAll('canvas')];
    const pass = async (u: uPlot): Promise<Call[]> => {
      const rec = recorders.get(u.ctx.canvas)!;
      rec.length = 0;
      u.redraw();
      await flush();
      return [...rec];
    };
    const light = await pass(h.plots[0]!);
    expect(light.filter((c) => c.name === 'set:fillStyle').map((c) => c.args[0])).toContain(LIGHT_PALETTE.chart.bands.gainShift.fill);
    expect(light.filter((c) => c.name === 'set:strokeStyle').map((c) => c.args[0])).toContain(LIGHT_PALETTE.chart.trip);

    h.setTheme(DARK_PALETTE);
    await flush();
    const dark = await pass(h.plots[0]!);
    const df = dark.filter((c) => c.name === 'set:fillStyle').map((c) => c.args[0]);
    const ds = dark.filter((c) => c.name === 'set:strokeStyle').map((c) => c.args[0]);
    for (const r of ['nominal', 'gainShift', 'engaged'] as const) {
      expect(df).toContain(DARK_PALETTE.chart.bands[r].fill);
      expect(df).not.toContain(LIGHT_PALETTE.chart.bands[r].fill);
    }
    expect(ds).toContain(DARK_PALETTE.chart.trip);
    expect(ds).not.toContain(LIGHT_PALETTE.chart.trip);

    // same instances, same canvases, data still there
    h.plots.forEach((u, i) => expect(u).toBe(before[i]));
    expect([...h.root.querySelectorAll('canvas')]).toEqual(canvases);
    expect(h.plots[0]!.data[0]).toHaveLength(600);

    // legend swatches follow too
    const sw = h.root.querySelectorAll<HTMLElement>('.sc-regimes .sc-swatch');
    expect(sw).toHaveLength(3);
    expect(sw[1]!.style.borderTopColor).toBeTruthy();
    h.setTheme(LIGHT_PALETTE);
    h.plots.forEach((u, i) => expect(u).toBe(before[i]));
  });

  it('shows the band names in the legend', () => {
    const h = make(new TelemetryRing());
    const text = h.root.querySelector('.sc-regimes')!.textContent!;
    expect(text).toContain('Nominal');
    expect(text).toContain('Gain shift');
    expect(text).toContain('AAC engaged');
    expect(text).toContain('detector trip');
  });
});

describe('band and trip palette colours: colour-vision-deficiency check', () => {
  // Machado et al. 2009 simulation matrices (severity 1.0), applied to linear RGB
  const SIM = {
    protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
    deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
    tritanopia: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]],
  } as const;
  const lin = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const parse = (css: string): [number, number, number, number] => {
    const m = /^rgba?\(([^)]+)\)$/.exec(css);
    if (m) {
      const p = m[1]!.split(',').map(Number);
      return [p[0]! / 255, p[1]! / 255, p[2]! / 255, p[3] ?? 1];
    }
    const v = css.replace('#', '');
    return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255).concat(1) as [number, number, number, number];
  };
  // composite over the background, then simulate, then CIE-like distance in linear RGB (scaled)
  const seen = (css: string, bg: string, m: readonly (readonly number[])[] | null): number[] => {
    const [r, g, b, a] = parse(css);
    const [br, bgc, bb] = parse(bg);
    const rgb = [r * a + br * (1 - a), g * a + bgc * (1 - a), b * a + bb * (1 - a)].map(lin);
    return m === null ? rgb : m.map((row) => row[0]! * rgb[0]! + row[1]! * rgb[1]! + row[2]! * rgb[2]!);
  };
  const dist = (a: number[], b: number[]): number => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

  for (const pal of [LIGHT_PALETTE, DARK_PALETTE]) {
    for (const [name, m] of [['normal', null], ...Object.entries(SIM)] as Array<[string, (typeof SIM)[keyof typeof SIM] | null]>) {
      it(`band strips (stroke) are pairwise distinguishable: ${pal.name}, ${name}`, () => {
        const b = pal.chart.bands;
        const bg = pal.css.surface;
        const cols = [b.nominal.stroke, b.gainShift.stroke, b.engaged.stroke].map((c) => seen(c, bg, m));
        for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) expect(dist(cols[i]!, cols[j]!)).toBeGreaterThan(0.03);
      });
      it(`band fills are pairwise distinguishable over the background: ${pal.name}, ${name}`, () => {
        const b = pal.chart.bands;
        const bg = pal.css.surface;
        const cols = [b.nominal.fill, b.gainShift.fill, b.engaged.fill].map((c) => seen(c, bg, m));
        for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) expect(dist(cols[i]!, cols[j]!)).toBeGreaterThan(0.003);
      });
    }
  }
});
