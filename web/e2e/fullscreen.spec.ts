import { expect, test } from '@playwright/test';
import { ALFOLIO, debug, focusedInShadow, open } from './helpers';


test('native full screen in Chromium: the host is the fullscreen element', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'native full screen is asserted on Chromium; the other engines use the same code path');
  await open(page, ALFOLIO);
  await page.getByRole('button', { name: 'Full screen' }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === document.querySelector('slosh-sim'))).toBe(true);
  await expect.poll(async () => (await debug(page)).fullscreenMode).toBe('native');
  await expect(page.locator('slosh-sim').locator('.exit')).toBeVisible();

  // Escape exits
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  await expect.poll(async () => (await debug(page)).fullscreen).toBe(false);
  expect((await focusedInShadow(page))?.label).toBe('Full screen');

  // the Exit control exits
  await page.getByRole('button', { name: 'Full screen' }).click();
  await expect.poll(async () => (await debug(page)).fullscreenMode).toBe('native');
  await page.locator('slosh-sim').locator('.exit').click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  await expect.poll(async () => (await debug(page)).fullscreen).toBe(false);
  expect((await focusedInShadow(page))?.label).toBe('Full screen');
});

test.describe('overlay fallback (no Element.requestFullscreen, like iPhone Safari)', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(Element.prototype, 'requestFullscreen', { value: undefined, configurable: true, writable: true });
      Object.defineProperty(Element.prototype, 'webkitRequestFullscreen', { value: undefined, configurable: true, writable: true });
    });
    await open(page, ALFOLIO);
    await page.evaluate(() => window.scrollTo(0, 300)); // enter from a scrolled page, as a reader would
  });

  test('the overlay covers the viewport and sits above the navbar', async ({ page }) => {
    await page.getByRole('button', { name: 'Full screen' }).click();
    await expect.poll(async () => (await debug(page)).fullscreenMode).toBe('overlay');
    expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();

    const box = await page.locator('slosh-sim').boundingBox();
    const vp = page.viewportSize()!;
    expect(box!.x).toBeLessThanOrEqual(0);
    expect(box!.y).toBeLessThanOrEqual(0);
    expect(box!.width).toBeGreaterThanOrEqual(vp.width);
    expect(box!.height).toBeGreaterThanOrEqual(vp.height);

    const topmost = await page.evaluate(() => {
      const nav = document.querySelector('nav.navbar')!.getBoundingClientRect();
      const hit = document.elementFromPoint(nav.left + nav.width / 2, nav.top + nav.height / 2);
      return hit === document.querySelector('slosh-sim');
    });
    expect(topmost).toBe(true);
    // the navbar itself is not what is on top
    const navCovered = await page.evaluate(() => {
      const nav = document.querySelector('nav.navbar')!;
      const r = nav.getBoundingClientRect();
      return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) !== nav;
    });
    expect(navCovered).toBe(true);
  });

  test('Escape exits and focus returns to the Full screen button', async ({ page }) => {
    await page.getByRole('button', { name: 'Full screen' }).click();
    await expect.poll(async () => (await debug(page)).fullscreenMode).toBe('overlay');
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await debug(page)).fullscreen).toBe(false);
    await expect(page.locator('slosh-sim')).not.toHaveAttribute('fullscreen-overlay', /.*/);
    expect((await focusedInShadow(page))?.label).toBe('Full screen');
  });

  test('the Exit control exits and focus returns to the Full screen button', async ({ page }) => {
    await page.getByRole('button', { name: 'Full screen' }).click();
    const exit = page.locator('slosh-sim').locator('.exit');
    await expect(exit).toBeVisible();
    await expect(exit).toBeFocused();
    await exit.click();
    await expect.poll(async () => (await debug(page)).fullscreen).toBe(false);
    await expect(exit).toBeHidden();
    expect((await focusedInShadow(page))?.label).toBe('Full screen');
  });

  test('the Exit control works from the keyboard', async ({ page }) => {
    await page.getByRole('button', { name: 'Full screen' }).click();
    await expect(page.locator('slosh-sim').locator('.exit')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await debug(page)).fullscreen).toBe(false);
    expect((await focusedInShadow(page))?.label).toBe('Full screen');
  });
});

