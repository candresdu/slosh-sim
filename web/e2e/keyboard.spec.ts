import { expect, test, type Page } from '@playwright/test';
import { debug, focusedInShadow, INDEX, open } from './helpers';

// Order of the controls in the DOM: the regime bar (regimes, Replay, Restart), the 3D view, its play overlay,
// the player bar (play/pause, speed, full screen), then the Fine-tune summary. The slider and AAC radios are inside the closed <details>, so they are not tab stops.
const TAB_ORDER = [
  'Nominal \u00b7 Fig 12',
  'Gain shift \u00b7 Fig 13',
  'AAC engaged \u00b7 Fig 14',
  'Replay the paper',
  'Restart',
  '3D view. Space or K plays and pauses. Drag to orbit.',
  'Play', // the play overlay: the demo starts paused
  'Play', // the player bar
  'Speed 1×, press for half speed',
  'Full screen',
  'Fine-tune (advanced)',
] as const;

async function tabTo(page: Page, label: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab');
    const f = await focusedInShadow(page);
    if (f?.label === label) return;
  }
  throw new Error(`Tab never reached "${label}"`);
}

test('Tab reaches every control in order, each with a visible focus ring', async ({ page }) => {
  await open(page, INDEX);
  await page.locator('#theme').focus(); // the page's own button just before the component
  const seen: string[] = [];
  for (let i = 0; i < TAB_ORDER.length; i++) {
    await page.keyboard.press('Tab');
    const f = await focusedInShadow(page);
    expect(f, `tab stop ${i + 1}`).not.toBeNull();
    seen.push(f!.label);
    expect(f!.outlineWidth, `outline of "${f!.label}"`).toBeGreaterThanOrEqual(2);
  }
  expect(seen).toEqual([...TAB_ORDER]);
});

test('Space and Enter activate the buttons', async ({ page }) => {
  await open(page, INDEX);
  const el = page.locator('slosh-sim');
  await tabTo(page, 'Play'); // the play overlay
  await page.keyboard.press('Tab'); // the player bar's button
  await page.keyboard.press('Space');
  await expect(el.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  expect((await debug(page)).paused).toBe(false);
  await page.keyboard.press('Enter');
  await expect(el.getByRole('button', { name: 'Play', exact: true }).first()).toBeVisible();
  expect((await debug(page)).paused).toBe(true);

  // a regime button: Enter switches the running flight (Gain shift = AAC Monitor)
  await el.getByText('Fine-tune (advanced)').click();
  await page.locator('#theme').focus();
  await tabTo(page, 'Gain shift \u00b7 Fig 13');
  await page.keyboard.press('Enter');
  await expect(el.getByRole('radio', { name: 'Monitor' })).toBeChecked();

  // Speed toggle with Space
  await tabTo(page, 'Speed 1×, press for half speed');
  await page.keyboard.press('Space');
  await expect(el.getByRole('button', { name: /Speed 0.5×/ })).toHaveAttribute('aria-pressed', 'true');
});

test('arrow keys move the slider and the AAC radios', async ({ page }) => {
  await open(page, INDEX);
  const el = page.locator('slosh-sim');
  await el.getByText('Fine-tune (advanced)').click();
  const slider = el.getByRole('slider', { name: 'Gain shift' });
  await slider.focus();
  await expect(slider).toHaveValue('1');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(slider).toHaveValue('1.1');
  await page.keyboard.press('ArrowLeft');
  await expect(slider).toHaveValue('1.05');
  await page.keyboard.press('End');
  await expect(slider).toHaveValue('3');

  const off = el.getByRole('radio', { name: 'Off' });
  await off.focus();
  await page.keyboard.press('ArrowRight');
  await expect(el.getByRole('radio', { name: 'Monitor' })).toBeChecked();
  await expect(el.getByRole('radio', { name: 'Monitor' })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(el.getByRole('radio', { name: 'Engaged' })).toBeChecked();
  await page.keyboard.press('ArrowLeft');
  await expect(el.getByRole('radio', { name: 'Monitor' })).toBeChecked();
});

test('Space and K toggle play while the 3D view has focus (and Enter on the overlay plays)', async ({ page }) => {
  await open(page, INDEX);
  const el = page.locator('slosh-sim');
  const scene = el.locator('.scene');
  await scene.focus();
  expect((await debug(page)).paused).toBe(true);
  await page.keyboard.press('Space');
  expect((await debug(page)).paused).toBe(false);
  await expect(el.locator('.sc-play-overlay')).toBeHidden();
  await page.keyboard.press('k');
  expect((await debug(page)).paused).toBe(true);
  await expect(el.locator('.sc-play-overlay')).toBeVisible();
  await page.keyboard.press('K');
  expect((await debug(page)).paused).toBe(false);
  await page.keyboard.press('Space');
  expect((await debug(page)).paused).toBe(true);

  // the scene keeps focus (a toggle does not move it) and Space on another control does not toggle through the view
  await expect(scene).toBeFocused();
  await tabTo(page, 'Speed 1×, press for half speed');
  await page.keyboard.press('Space');
  expect((await debug(page)).paused).toBe(true);

  // the play overlay's disc is a real button: Enter on it resumes
  await page.locator('#theme').focus();
  await tabTo(page, 'Play');
  await page.keyboard.press('Enter');
  expect((await debug(page)).paused).toBe(false);
  await expect(el.locator('.sc-play-overlay')).toBeHidden();
});
