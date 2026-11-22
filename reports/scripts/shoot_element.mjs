// Screenshots and checks of <slosh-sim> on the mock al-folio page (run against `npx vite preview`).
// Usage: node shoot_element.mjs http://localhost:4173 ../screenshots
const { chromium } = await import('/workspace/.shots-tools/node_modules/playwright/index.mjs');
const [, , base, outDir] = process.argv;
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const bg = (p) => p.evaluate(() => getComputedStyle(document.querySelector('slosh-sim').shadowRoot.querySelector('.frame')).backgroundColor);
const state = (p) => p.evaluate(() => document.querySelector('slosh-sim').debugState());

async function open(width, height) {
  const page = await browser.newPage({ viewport: { width, height } });
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.log('console error:', m.text()); });
  await page.goto(`${base}/e2e/pages/alfolio.html`);
  await page.waitForTimeout(500);
  await page.evaluate(() => document.querySelector('slosh-sim').play());
  return page;
}

// 730 px column: light, then toggle to dark without reloading
let page = await open(800, 1500);
await page.waitForTimeout(9000);
const colW = await page.evaluate(() => document.querySelector('slosh-sim').getBoundingClientRect().width);
const sceneBox = await page.evaluate(() => { const r = document.querySelector('slosh-sim').shadowRoot.querySelector('.scene').getBoundingClientRect(); return [r.width, r.height]; });
const gridCols = await page.evaluate(() => getComputedStyle(document.querySelector('slosh-sim').shadowRoot.querySelector('.slosh-charts')).gridTemplateColumns);
console.log('column width', colW, 'scene', sceneBox, 'chart columns', gridCols);
const light = { bg: await bg(page), st: await state(page) };
await page.screenshot({ path: `${outDir}/element-alfolio-light.png` });
await page.evaluate(() => { window.__marker = 42; });
await page.click('#toggle');
await page.waitForTimeout(1500);
const dark = { bg: await bg(page), st: await state(page) };
const marker = await page.evaluate(() => window.__marker);
await page.screenshot({ path: `${outDir}/element-alfolio-dark.png` });
console.log('light', JSON.stringify(light));
console.log('dark ', JSON.stringify(dark), 'no reload:', marker === 42);
// full screen (wide layout) above the navbar
await page.setViewportSize({ width: 1280, height: 800 });
await page.waitForTimeout(500);
await page.evaluate(() => document.querySelector('slosh-sim').enterFullscreen());
await page.waitForTimeout(1500);
console.log('fullscreen', JSON.stringify(await state(page)));
await page.screenshot({ path: `${outDir}/element-alfolio-fullscreen-dark.png` });
await page.keyboard.press('Escape');
await page.waitForTimeout(500);
console.log('after Escape', JSON.stringify(await state(page)));
await page.close();

// 360 px viewport: compact
page = await open(360, 2400);
await page.waitForTimeout(6000);
const folds = await page.evaluate(() => [...document.querySelector('slosh-sim').shadowRoot.querySelectorAll('details.sc-fold')].map((d) => d.open));
console.log('compact', (await state(page)).layout, 'folds open:', folds, 'scrollWidth', await page.evaluate(() => document.documentElement.scrollWidth));
await page.screenshot({ path: `${outDir}/element-alfolio-360.png`, fullPage: true });
await page.close();
await browser.close();
