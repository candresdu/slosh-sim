// Takes the 12 review screenshots of the video-style widget into reports/screenshots/widget/:
//   {phone-360x780, column-730} x {light, dark} x {paused-overlay, gain-shift-banner, aac-engaged-after-trip}
// All images are generated from this project's own simulation (no R-1 figure, no testbed photo).
//
//   cd web && npm run build && node --experimental-strip-types e2e/scripts/widget-shots.ts [outDir]
//
// Starts `vite preview` itself unless BASE_URL is set. Not part of the Playwright suite.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const webDir = resolve(here, '../..');
const outDir = resolve(process.argv[2] ?? resolve(webDir, '../reports/screenshots/widget'));
const PORT = 4181;

const SIZES = [
  { name: 'phone-360x780', width: 360, height: 780 },
  { name: 'column-730', width: 730, height: 900 },
] as const;
const THEMES = ['light', 'dark'] as const;

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

type El = HTMLElement & {
  play(): void;
  pause(): void;
  loadPreset(id: string): void;
  debugState(): { simTime: number; sceneClearColor: string | null; markers: Array<{ kind: string }> };
};

const sim = (page: Page) => page.evaluate(() => (document.querySelector('slosh-sim') as El).debugState());
async function waitUntil(page: Page, what: string, f: () => Promise<boolean>, timeoutMs = 120_000): Promise<void> {
  const t0 = Date.now();
  while (!(await f())) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await page.waitForTimeout(100);
  }
}

let server: ChildProcess | null = null;
let base = process.env.BASE_URL ?? '';
if (!base) {
  base = `http://127.0.0.1:${PORT}`;
  server = spawn('npx', ['vite', 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
    cwd: webDir,
    stdio: 'ignore',
    detached: true,
  });
}

mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
try {
  await waitForServer(`${base}/e2e/pages/alfolio.html`);
  for (const size of SIZES) {
    for (const theme of THEMES) {
      const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 1 });
      const page = await ctx.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.route('**/favicon.ico', (r) => r.fulfill({ status: 204 }));
      const shot = async (state: string): Promise<void> => {
        const el = page.locator('slosh-sim');
        // top of the view just below the 56 px mock navbar
        await el.evaluate((n) => n.scrollIntoView({ block: 'start' }));
        await page.evaluate(() => window.scrollBy(0, -64));
        await page.waitForTimeout(300);
        await page.screenshot({ path: resolve(outDir, `${size.name}-${theme}-${state}.png`) });
      };
      const tap = (name: string) => page.locator('slosh-sim').getByRole('button', { name, exact: true }).click();

      await page.goto(`${base}/e2e/pages/alfolio.html?theme=${theme}&testSpeed=4`);
      await page.waitForFunction(() => {
        const el = document.querySelector('slosh-sim') as (HTMLElement & { debugState?: () => unknown }) | null;
        return el !== null && typeof el.debugState === 'function' && el.shadowRoot?.querySelector('.frame') != null;
      });
      if ((await sim(page)).sceneClearColor === null) throw new Error('no WebGL scene: cannot take the screenshots');

      // 1. paused, with the play overlay: a few seconds of the story, then pause
      await page.evaluate(() => {
        const el = document.querySelector('slosh-sim') as El;
        el.loadPreset('story');
        el.play();
      });
      await waitUntil(page, 'story t >= 4', async () => (await sim(page)).simTime >= 4);
      await page.evaluate(() => (document.querySelector('slosh-sim') as El).pause());
      await shot('paused-overlay');

      // 2. Gain shift banner: the live flight carries on from the paused moment
      await page.evaluate(() => (document.querySelector('slosh-sim') as El).play());
      await tap('Gain shift · Fig 13');
      const t1 = (await sim(page)).simTime;
      await waitUntil(page, 'gain shift growth', async () => (await sim(page)).simTime >= t1 + 4);
      await shot('gain-shift-banner');

      // 3. AAC engaged after the detector trip
      await waitUntil(page, 'detector trip', async () => (await sim(page)).markers.some((m) => m.kind === 'trip'));
      await tap('AAC engaged · Fig 14');
      const t2 = (await sim(page)).simTime;
      await waitUntil(page, 'engaged for 3 s', async () => (await sim(page)).simTime >= t2 + 3);
      await shot('aac-engaged-after-trip');

      if (errors.length > 0) throw new Error(`page errors: ${errors.join('; ')}`);
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  if (server?.pid) {
    try {
      process.kill(-server.pid);
    } catch {
      /* already gone */
    }
  }
}
console.log(`wrote ${outDir}`);
