import { expect, test, type Page } from '@playwright/test';
import { ALFOLIO, debug, open } from './helpers';

const hostBg = (page: Page): Promise<string> =>
  page.evaluate(() => getComputedStyle(document.querySelector('slosh-sim')!.shadowRoot!.querySelector('.frame')!).backgroundColor);
const setHtmlTheme = (page: Page, v: string): Promise<void> =>
  page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), v);

test('al-folio data-theme switches the component without a reload', async ({ page }) => {
  await open(page, ALFOLIO);
  await page.evaluate(() => ((window as unknown as { __alive: boolean }).__alive = true)); // survives only without a reload
  const light = await debug(page);
  const lightBg = await hostBg(page);
  expect(light.theme).toBe('light');
  expect(lightBg).toBe('rgb(255, 255, 255)'); // the page's --global-bg-color

  await setHtmlTheme(page, 'dark');
  await expect.poll(() => debug(page).then((d) => d.theme)).toBe('dark');
  await expect.poll(() => hostBg(page)).toBe('rgb(28, 28, 29)');
  const dark = await debug(page);
  if (light.sceneClearColor !== null) {
    expect(dark.sceneClearColor).not.toBeNull();
    expect(dark.sceneClearColor).not.toBe(light.sceneClearColor);
  }

  await setHtmlTheme(page, 'light');
  await expect.poll(() => debug(page).then((d) => d.theme)).toBe('light');
  await expect.poll(() => hostBg(page)).toBe(lightBg);
  expect((await debug(page)).sceneClearColor).toBe(light.sceneClearColor);
  expect(await page.evaluate(() => (window as unknown as { __alive?: boolean }).__alive)).toBe(true);
});

test('the page toggle button flips the component too', async ({ page }) => {
  await open(page, ALFOLIO);
  await page.getByRole('button', { name: 'Toggle theme' }).click();
  await expect.poll(() => debug(page).then((d) => d.theme)).toBe('dark');
  await page.getByRole('button', { name: 'Toggle theme' }).click();
  await expect.poll(() => debug(page).then((d) => d.theme)).toBe('light');
});

test('theme="light" on the element ignores the html attribute', async ({ page }) => {
  await open(page, ALFOLIO);
  await page.evaluate(() => document.querySelector('slosh-sim')!.setAttribute('theme', 'light'));
  await expect.poll(() => debug(page).then((d) => d.theme)).toBe('light');
  const before = await debug(page);
  const bgBefore = await hostBg(page);
  await setHtmlTheme(page, 'dark');
  await page.waitForTimeout(500);
  const after = await debug(page);
  expect(after.theme).toBe('light');
  expect(after.sceneClearColor).toBe(before.sceneClearColor);
  expect(await hostBg(page)).toBe(bgBefore);
  expect(bgBefore).not.toBe('rgb(28, 28, 29)');
});

test('theme="dark" on the element stays dark under a light page', async ({ page }) => {
  await open(page, ALFOLIO);
  await page.evaluate(() => document.querySelector('slosh-sim')!.setAttribute('theme', 'dark'));
  await expect.poll(() => debug(page).then((d) => d.theme)).toBe('dark');
  await setHtmlTheme(page, 'light');
  await page.waitForTimeout(300);
  expect((await debug(page)).theme).toBe('dark');
});
