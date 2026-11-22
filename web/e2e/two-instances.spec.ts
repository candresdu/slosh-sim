import { expect, test } from '@playwright/test';
import { debug, open, TWO, waitSimTime } from './helpers';

test('two instances run independently; one scrolled out of view pauses', async ({ page }) => {
  // tall viewport so that both are on screen at the start
  await page.setViewportSize({ width: 1000, height: 3200 });
  await open(page, TWO);
  await waitSimTime(page, 0.5, '#a');
  await waitSimTime(page, 0.5, '#b');
  expect((await debug(page, '#a')).preset).toBe('fig12');
  expect((await debug(page, '#b')).preset).toBe('fig13');

  // room to scroll, then bring #b to the top of the viewport so #a is fully above it
  await page.evaluate(() => {
    const spacer = document.createElement('div');
    spacer.style.height = '6000px';
    document.querySelector('main')!.appendChild(spacer);
    window.scrollTo(0, document.querySelector('#b')!.getBoundingClientRect().top + window.scrollY); // ignores scroll-margin
  });
  await expect.poll(async () => (await debug(page, '#a')).paused).toBe(true);
  expect((await debug(page, '#b')).paused).toBe(false);

  const a1 = (await debug(page, '#a')).simTime;
  const b1 = (await debug(page, '#b')).simTime;
  await page.waitForTimeout(1500);
  expect((await debug(page, '#a')).simTime).toBe(a1);
  // the visible one keeps running (poll: software WebGL in a tall viewport can lag behind wall time)
  await expect.poll(async () => (await debug(page, '#b')).simTime, { timeout: 20_000 }).toBeGreaterThan(b1 + 0.5);
  expect((await debug(page, '#a')).simTime).toBe(a1);

  // back in view: #a resumes (and does not jump forward by the time it was hidden)
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect.poll(async () => (await debug(page, '#a')).paused).toBe(false);
  await waitSimTime(page, a1 + 0.5, '#a');
  expect((await debug(page, '#a')).simTime).toBeLessThan(a1 + 3);
});
