// Dev page driver: a Sim playing fig13 feeds the Three.js scene; light/dark toggle button.
import { DEFAULT_PARAMS } from '../src/core/params';
import { Sim } from '../src/core/sim';
import { DEFAULT_DARK_PALETTE, DEFAULT_LIGHT_PALETTE, WebGLUnavailableError, createScene } from '../src/view/scene';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const wrap = document.getElementById('wrap') as HTMLElement;
const info = document.getElementById('info') as HTMLElement;
const err = document.getElementById('err') as HTMLElement;
const themeBtn = document.getElementById('theme') as HTMLButtonElement;
const reducedBtn = document.getElementById('reduced') as HTMLButtonElement;

const query = new URLSearchParams(location.search);
let dark = query.get('theme') === 'dark';
let reduced = query.get('reduced') === '1';

let handle;
try {
  handle = createScene(canvas, {
    palette: dark ? DEFAULT_DARK_PALETTE : DEFAULT_LIGHT_PALETTE,
    reducedMotion: reduced,
  });
} catch (e) {
  if (e instanceof WebGLUnavailableError) {
    err.textContent = 'WebGL2 is unavailable: the element would show its static fallback here.';
  } else {
    throw e;
  }
}

if (handle) {
  const h = handle;
  const applyTheme = (): void => {
    document.body.classList.toggle('dark', dark);
    h.setTheme(dark ? DEFAULT_DARK_PALETTE : DEFAULT_LIGHT_PALETTE);
    themeBtn.textContent = dark ? 'Light theme' : 'Dark theme';
  };
  const applyReduced = (): void => {
    h.setReducedMotion(reduced);
    reducedBtn.textContent = `Reduced motion: ${reduced ? 'on' : 'off'}`;
    reducedBtn.setAttribute('aria-pressed', String(reduced));
  };
  themeBtn.addEventListener('click', () => {
    dark = !dark;
    applyTheme();
  });
  reducedBtn.addEventListener('click', () => {
    reduced = !reduced;
    applyReduced();
  });
  applyTheme();
  applyReduced();

  const resize = (): void => h.resize(wrap.clientWidth, wrap.clientHeight);
  new ResizeObserver(resize).observe(wrap);
  resize();

  const sim = new Sim(DEFAULT_PARAMS.params, DEFAULT_PARAMS.params.sim.seed);
  sim.enqueue({ type: 'loadPreset', id: 'fig13' });
  const speed = Number(query.get('speed') ?? '1');
  // Optional fast-forward to a given sim time (used for screenshots): ?skip=20
  const skip = Number(query.get('skip') ?? '0');
  let tel = sim.stepControl();
  for (let i = 0; i < skip * 100; i++) tel = sim.stepControl();

  let last = performance.now();
  let acc = 0;
  const frame = (now: number): void => {
    acc += Math.min(0.1, (now - last) / 1000) * speed;
    last = now;
    while (acc >= 0.01) {
      tel = sim.stepControl();
      acc -= 0.01;
    }
    h.update(tel);
    info.textContent = `t = ${tel.t.toFixed(1)} s, theta = ${tel.theta.toFixed(3)} rad`;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
