// Dev page driver: Sim + Runner feed the telemetry ring; the six live charts follow it.
import { DEFAULT_PARAMS } from '../src/core/params';
import { Sim } from '../src/core/sim';
import type { PresetId } from '../src/core/presets';
import { Runner, TelemetryRing } from '../src/runtime';
import { createCharts } from '../src/view/charts';
import { paletteFor } from '../src/view/theme';

const query = new URLSearchParams(location.search);
let dark = query.get('theme') === 'dark';
const preset = (query.get('preset') ?? 'fig13') as PresetId;
const skip = Number(query.get('skip') ?? '0'); // fast-forward [s] (screenshots)

const ring = new TelemetryRing();
const sim = new Sim(DEFAULT_PARAMS.params, DEFAULT_PARAMS.params.sim.seed);
const runner = new Runner(sim, ring);

const threshold = DEFAULT_PARAMS.params.aac.threshold ?? 1;
const charts = createCharts(document.getElementById('charts') as HTMLElement, ring, {
  palette: paletteFor(dark),
  threshold,
});

const banner = document.getElementById('banner') as HTMLElement;
const info = document.getElementById('info') as HTMLElement;
const themeBtn = document.getElementById('theme') as HTMLButtonElement;

const load = (id: PresetId): void => {
  runner.send({ type: 'loadPreset', id });
  banner.textContent = '';
  banner.classList.remove('tripped');
};
for (const id of ['fig12', 'fig13', 'fig14', 'vb'] as const) {
  document.getElementById(id)?.addEventListener('click', () => load(id));
}

const applyTheme = (): void => {
  document.body.classList.toggle('dark', dark);
  charts.setTheme(paletteFor(dark));
  themeBtn.textContent = dark ? 'Light theme' : 'Dark theme';
};
themeBtn.addEventListener('click', () => {
  dark = !dark;
  applyTheme();
});
applyTheme();

runner.on('detect', (axis, t) => {
  banner.textContent = `Anomaly detected on ${axis === 0 ? 'pitch' : 'roll'} at t = ${t.toFixed(1)} s`;
  banner.classList.add('tripped');
});
runner.on('frame', (tel) => {
  charts.redraw();
  info.textContent = `t = ${tel.t.toFixed(1)} s, theta = ${tel.theta.toFixed(3)} rad`;
});

load(preset);
for (let i = 0; i < skip * 100; i++) ring.push(sim.stepControl());
runner.start();
