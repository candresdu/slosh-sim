import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { ALFOLIO, INDEX, bannerState, open, stubFavicon, waitSimTime } from './helpers';

async function scan(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']).analyze();
  return results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.impact}: ${v.id} (${v.nodes.map((n) => n.target.join(' ')).join('; ')})`);
}

for (const [name, url] of [
  ['index.html', INDEX],
  ['alfolio.html', ALFOLIO],
] as const) {
  test(`axe: ${name} has no serious or critical violations`, async ({ page }) => {
    await stubFavicon(page);
    await open(page, `${url}?testSpeed=4`);
    await page.evaluate(() => (document.querySelector('slosh-sim') as unknown as { play(): void }).play());
    await waitSimTime(page, 4); // some chart data and a detection banner on fig13
    expect(await scan(page)).toEqual([]);
  });
}

test('axe: alfolio.html in the dark theme', async ({ page }) => {
  await open(page, `${ALFOLIO}?theme=dark&testSpeed=4`);
  await page.evaluate(() => (document.querySelector('slosh-sim') as unknown as { play(): void }).play());
  await waitSimTime(page, 4);
  expect(await scan(page)).toEqual([]);
});

// The two new overlays of the video-style widget: the play overlay (paused) and the info banner.
for (const theme of ['light', 'dark'] as const) {
  for (const [name, url] of [
    ['index.html', INDEX],
    ['alfolio.html', ALFOLIO],
  ] as const) {
    test(`axe: ${name} (${theme}) with the play overlay shown`, async ({ page }) => {
      await open(page, `${url}?theme=${theme}&testSpeed=4`);
      if (name === 'index.html') await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
      const el = page.locator('slosh-sim');
      await expect(el.locator('.sc-play-overlay')).toBeVisible();
      await expect(el.locator('.sc-play-disc')).toBeVisible();
      expect(await scan(page)).toEqual([]);
    });

    test(`axe: ${name} (${theme}) with the info banner shown`, async ({ page }) => {
      await open(page, `${url}?theme=${theme}&testSpeed=4`);
      if (name === 'index.html') await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
      const el = page.locator('slosh-sim');
      await el.getByRole('button', { name: 'Gain shift \u00b7 Fig 13', exact: true }).click();
      await expect(el.locator('.sc-info')).toBeVisible();
      await page.evaluate(() => (document.querySelector('slosh-sim') as unknown as { play(): void }).play());
      await waitSimTime(page, 3);
      expect((await bannerState(page)).title).toBe('Gain shift \u00b7 Fig 13');
      expect(await scan(page)).toEqual([]);
      // and once the detector has tripped the banner also carries the trip message
      await expect(el.locator('.sc-info-caption')).toContainText('Slosh anomaly detected', { timeout: 100_000 });
      expect(await scan(page)).toEqual([]);
    });
  }
}
