import { expect, test } from '@playwright/test';
import type { Locator } from '@playwright/test';
import { ALFOLIO, debug, open } from './helpers';

interface Box { x: number; y: number; width: number; height: number }

/** Every box lies inside `frame` (1 px tolerance). */
async function expectInside(frame: Box, items: Array<[string, Locator]>): Promise<void> {
  for (const [name, loc] of items) {
    await expect(loc, name).toBeVisible();
    const b = (await loc.boundingBox())!;
    expect(b.x, `${name} left`).toBeGreaterThanOrEqual(frame.x - 1);
    expect(b.y, `${name} top`).toBeGreaterThanOrEqual(frame.y - 1);
    expect(b.x + b.width, `${name} right`).toBeLessThanOrEqual(frame.x + frame.width + 1);
    expect(b.y + b.height, `${name} bottom`).toBeLessThanOrEqual(frame.y + frame.height + 1);
  }
}

/** Tap Gain shift so the info banner is shown (the tap also starts the flight, so the play overlay is gone), then list
 *  the primary controls and the banner. */
async function primaryControls(el: Locator): Promise<Array<[string, Locator]>> {
  await el.getByRole('button', { name: 'Gain shift \u00b7 Fig 13', exact: true }).click();
  await expect(el.locator('.sc-info')).toBeVisible();
  const items: Array<[string, Locator]> = [];
  for (const n of ['Nominal \u00b7 Fig 12', 'Gain shift \u00b7 Fig 13', 'AAC engaged \u00b7 Fig 14', 'Replay the paper', 'Restart']) {
    items.push([n, el.getByRole('button', { name: n, exact: true })]);
  }
  items.push(['Play/Pause (player bar)', el.locator('.sc-player button[data-player="play"]')]);
  items.push(['Speed', el.locator('.sc-player button[aria-label^="Speed"]')]);
  items.push(['Full screen', el.locator('.sc-player button[aria-label="Full screen"]')]);
  items.push(['Info banner', el.locator('.sc-info')]);
  items.push(['Banner title', el.locator('.sc-info-title')]);
  return items;
}

test('730 px post column: full-width 3D view and a 3-chart strip (θ, K_T, y_SD) inside the widget frame', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 900 });
  await open(page, ALFOLIO);
  const el = page.locator('slosh-sim');
  await expect.poll(async () => (await debug(page)).layout).toBe('column');

  const host = await el.boundingBox();
  const scene = await el.locator('.scene').boundingBox();
  expect(host!.width).toBeLessThanOrEqual(730);
  expect(host!.width).toBeGreaterThan(600);
  expect(scene!.width).toBeGreaterThanOrEqual(host!.width - 3); // inside the widget's 1 px border

  const cols = await el.locator('.slosh-charts').evaluate((n) => getComputedStyle(n).gridTemplateColumns.split(' ').length);
  expect(cols).toBe(3);
  // the three key charts sit in one row; the other three are only shown in full screen
  const boxes = [];
  for (const id of ['theta', 'kT', 'ySD']) {
    await expect(el.locator(`figure[data-chart="${id}"]`)).toBeVisible();
    boxes.push((await el.locator(`figure[data-chart="${id}"]`).boundingBox())!);
  }
  for (const id of ['mass', 'attitude', 'motors']) await expect(el.locator(`figure[data-chart="${id}"]`)).toBeHidden();
  expect(Math.abs(boxes[0]!.y - boxes[2]!.y)).toBeLessThan(2);
  expect(boxes[1]!.x).toBeGreaterThan(boxes[0]!.x + boxes[0]!.width - 2);
  // the charts are inside the widget's frame
  await expectInside((await el.locator('.frame').boundingBox())!, [['charts', el.locator('.slosh-charts')]]);
  await expect(el.locator('.sc-more')).toBeVisible();
  // no horizontal scrolling of the page
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('730 px column: the controls and the info banner are inside the 3D view frame', async ({ page }) => {
  await page.setViewportSize({ width: 730, height: 900 });
  await open(page, ALFOLIO);
  const el = page.locator('slosh-sim');
  await expect.poll(async () => (await debug(page)).layout).toBe('column');
  const items = await primaryControls(el);
  const frame = (await el.locator('.view').boundingBox())!;
  await expectInside(frame, items);
  // the dock overlays the lower part of the scene: the banner ends at the scene's bottom edge
  const scene = (await el.locator('.scene').boundingBox())!;
  const banner = (await el.locator('.sc-info').boundingBox())!;
  expect(banner.y + banner.height).toBeLessThanOrEqual(scene.y + scene.height + 1);
  expect(banner.y).toBeGreaterThanOrEqual(scene.y);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect((await el.boundingBox())!.width).toBeLessThanOrEqual(730);
});

test('360 px viewport: compact layout with θ, K_T and y_SD shown and the rest left for full screen', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await open(page, ALFOLIO);
  const el = page.locator('slosh-sim');
  await expect.poll(async () => (await debug(page)).layout).toBe('compact');

  for (const id of ['theta', 'kT', 'ySD']) {
    await expect(el.locator(`figure[data-chart="${id}"]`)).toBeVisible();
    // these are not inside a <details>
    expect(await el.locator(`figure[data-chart="${id}"]`).evaluate((n) => n.closest('details') === null)).toBe(true);
  }
  for (const id of ['mass', 'attitude', 'motors']) {
    const fig = el.locator(`figure[data-chart="${id}"]`);
    await expect(fig).toBeHidden();
    const details = el.locator(`details.sc-fold:has(figure[data-chart="${id}"])`);
    await expect(details).toHaveCount(1);
    await expect(details).toBeHidden(); // folded charts are offered in full screen only
  }

  const vp = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(vp).toBeLessThanOrEqual(360);
  expect((await el.boundingBox())!.width).toBeLessThanOrEqual(360);
});

test('360 px viewport: the controls and the info banner are inside the 3D view frame, the banner right under the view', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await open(page, ALFOLIO);
  const el = page.locator('slosh-sim');
  await expect.poll(async () => (await debug(page)).layout).toBe('compact');
  const items = await primaryControls(el);
  const frame = (await el.locator('.view').boundingBox())!;
  await expectInside(frame, items);

  // compact layout: the dock (player bar, then the banner) sits directly under the scene
  const scene = (await el.locator('.scene').boundingBox())!;
  const bar = (await el.locator('.sc-player').boundingBox())!;
  const banner = (await el.locator('.sc-info').boundingBox())!;
  expect(bar.y).toBeGreaterThanOrEqual(scene.y + scene.height - 1);
  expect(Math.abs(bar.y - (scene.y + scene.height))).toBeLessThan(2);
  expect(Math.abs(banner.y - (bar.y + bar.height))).toBeLessThan(2); // directly under the player bar, nothing between
  // the regime bar sits above the scene inside the same frame; the fine-tune panel is below the whole frame
  const regime = (await el.locator('.sc-regime').boundingBox())!;
  expect(regime.y + regime.height).toBeLessThanOrEqual(scene.y + 1);
  const fine = (await el.locator('details.sc-exp > summary').boundingBox())!;
  expect(fine.y).toBeGreaterThanOrEqual(frame.y + frame.height - 1);

  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  expect((await el.boundingBox())!.width).toBeLessThanOrEqual(360);
});
