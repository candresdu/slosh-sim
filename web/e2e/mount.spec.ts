import { expect, test } from '@playwright/test';
import { buttonNames, call, collectErrors, EXPECTED_BUTTONS, debug, INDEX, open, waitSimTime } from './helpers';

test('index.html mounts <slosh-sim> with its controls and charts', async ({ page }) => {
  const errors = collectErrors(page);
  await open(page, INDEX);
  const el = page.locator('slosh-sim');
  await expect(el).toBeVisible();
  for (const name of ['Nominal \u00b7 Fig 12', 'Gain shift \u00b7 Fig 13', 'AAC engaged \u00b7 Fig 14', 'Replay the paper', 'Restart']) {
    await expect(el.getByRole('button', { name, exact: true })).toBeVisible();
  }
  // exactly the in-view regime and player buttons: no separate figure buttons, no extra action buttons
  expect(await buttonNames(page)).toEqual([...EXPECTED_BUTTONS]);
  await el.getByText('Fine-tune (advanced)').click(); // closed by default
  await expect(el.getByRole('slider', { name: 'Gain shift' })).toBeVisible();
  await expect(el.locator('figure[data-chart]')).toHaveCount(6);
  expect((await debug(page)).preset).toBe('fig12');
  expect(errors).toEqual([]);
});

for (const preset of ['fig12', 'fig13', 'fig14', 'vb'] as const) {
  test(`preset ${preset} runs 5 s without console errors`, async ({ page }) => {
    const errors = collectErrors(page);
    await open(page, '/index.html?testSpeed=4');
    await call(page, 'loadPreset', preset);
    expect((await debug(page)).preset).toBe(preset);
    await call(page, 'play');
    await waitSimTime(page, 5);
    expect((await debug(page)).paused).toBe(false);
    expect(errors).toEqual([]);
  });
}
