import { expect, test } from '@playwright/test';
import { collectErrors, debug, open, waitSimTime } from './helpers';

test('without WebGL the fallback image shows and the charts still render', async ({ page }) => {
  // WebGL disabled: every WebGL context request fails, which is what a blocked or missing GPU stack does
  await page.addInitScript(() => {
    const orig = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
      if (/webgl/i.test(type)) return null;
      return (orig as (...a: unknown[]) => unknown).call(this, type, ...rest) as RenderingContext | null;
    } as typeof orig;
  });
  const errors = collectErrors(page);
  await open(page, '/index.html?testSpeed=4');
  const el = page.locator('slosh-sim');
  await expect(el.locator('.fallback')).toBeVisible();
  await expect(page.locator('slosh-sim > img[slot="fallback"]')).toBeVisible();
  await expect(el.locator('.scene canvas')).toBeHidden();
  expect((await debug(page)).sceneClearColor).toBeNull();

  // charts and controls keep working
  await el.getByRole('button', { name: 'Play', exact: true }).first().click();
  await waitSimTime(page, 2);
  for (const id of ['theta', 'kT', 'ySD', 'mass', 'attitude', 'motors']) {
    await expect(el.locator(`figure[data-chart="${id}"] canvas`).first()).toHaveCount(1);
  }
  await expect(el.locator('figure[data-chart="theta"] canvas').first()).toBeVisible();
  expect(errors).toEqual([]);
});
