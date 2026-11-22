import { expect, test } from '@playwright/test';
import { debug, hasScene, open, TWO } from './helpers';

test('reduced motion: no autoplay and no trail', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page, TWO);
  const t0 = (await debug(page, '#a')).simTime;
  await page.waitForTimeout(2000);
  const d = await debug(page, '#a');
  expect(d.simTime).toBe(t0); // sim time stays where the first frame left it
  expect(d.simTime).toBeLessThan(0.05);
  expect(d.paused).toBe(true);
  expect(d.trailVisible).toBe(false);
  // the charts still work: pressing Play advances the sim
  await page.locator('#a').getByRole('button', { name: 'Play', exact: true }).first().click();
  await expect.poll(async () => (await debug(page, '#a')).simTime).toBeGreaterThan(0.5);
  expect((await debug(page, '#a')).trailVisible).toBe(false);
  await expect(page.locator('#a figure[data-chart="theta"] canvas').first()).toBeVisible();
});

test('without reduced motion the autoplay attribute starts the sim', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await open(page, TWO);
  await expect.poll(async () => (await debug(page, '#a')).simTime).toBeGreaterThan(0.5);
  if (await hasScene(page, '#a')) {
    await expect.poll(async () => (await debug(page, '#a')).trailVisible).toBe(true);
  }
});
