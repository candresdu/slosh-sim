// Takes blog/images/slosh-fallback.png: a 1280x720 screenshot of <slosh-sim> at the Fig 13 preset, t of about 20 s.
// The image is the static fallback shown when WebGL is unavailable and is generated from this project's own
// simulation (no R-1 figure, no testbed photo).
//
//   cd web && npm run build && node --experimental-strip-types e2e/scripts/fallback-shot.ts [outfile]
//
// It starts `vite preview` on a free port itself unless BASE_URL is set (then that server is used).
// Needs Node >= 22.6 for --experimental-strip-types. This script is not part of the Playwright test suite.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const webDir = resolve(here, '../..');
const outFile = resolve(process.argv[2] ?? resolve(webDir, '../blog/images/slosh-fallback.png'));
const PORT = 4179;
const TARGET_T = 20;

async function waitForServer(url: string, timeoutMs = 30_000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`server at ${url} did not start`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

let server: ChildProcess | null = null;
let base = process.env.BASE_URL ?? '';
if (!base) {
  base = `http://127.0.0.1:${PORT}`;
  server = spawn('npx', ['vite', 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
    cwd: webDir,
    stdio: 'ignore',
    detached: true, // own process group, so that the whole npx tree can be stopped
  });
}

const browser = await chromium.launch({
  // software WebGL so that the shot also works on machines without a GPU
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
try {
  await waitForServer(`${base}/index.html`);
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/favicon.ico', (r) => r.fulfill({ status: 204 }));
  await page.goto(`${base}/index.html?testSpeed=4`); // sim runs 4x faster than wall time
  await page.waitForFunction(() => {
    const el = document.querySelector('slosh-sim') as (HTMLElement & { debugState?: () => unknown }) | null;
    return el !== null && typeof el.debugState === 'function' && el.shadowRoot?.querySelector('.frame') != null;
  });

  type El = HTMLElement & {
    preset: string;
    play(): void;
    pause(): void;
    enterFullscreen(): void;
    debugState(): { simTime: number; sceneClearColor: string | null; preset: string; fullscreen: boolean };
  };
  const state = () => page.evaluate(() => (document.querySelector('slosh-sim') as El).debugState());

  await page.evaluate(() => {
    const el = document.querySelector('slosh-sim') as El;
    el.preset = 'fig13';
    el.enterFullscreen(); // fills the 1280x720 viewport with the wide layout
    el.play();
  });
  if ((await state()).sceneClearColor === null) throw new Error('no WebGL scene: cannot take the fallback shot');

  for (;;) {
    const s = await state();
    if (s.simTime >= TARGET_T) break;
    await page.waitForTimeout(50);
  }
  await page.evaluate(() => (document.querySelector('slosh-sim') as El).pause());
  await page.waitForTimeout(400); // let the last frame and chart redraw finish
  const s = await state();
  console.log(`preset ${s.preset}, t = ${s.simTime.toFixed(2)} s, fullscreen ${String(s.fullscreen)}`);
  if (s.preset !== 'fig13') throw new Error(`unexpected preset ${s.preset}`);

  mkdirSync(dirname(outFile), { recursive: true });
  await page.screenshot({ path: outFile });
  if (errors.length > 0) throw new Error(`page errors: ${errors.join('; ')}`);
  console.log(`wrote ${outFile}`);
} finally {
  await browser.close();
  if (server?.pid) process.kill(-server.pid);
}
