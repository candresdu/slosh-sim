import { expect, test } from '@playwright/test';
import { ALFOLIO, buttonNames, call, debug, detects, open, recordDetects, runnerSend, simTime, thetaEnvelope, waitSimTime } from './helpers';

// `?testSpeed=4` is the test-only hook that runs the sim 4x faster than wall time.
const FAST = `${ALFOLIO}?testSpeed=4`;

test('fig13 preset (loaded by the preset attribute) runs with AAC Monitor and slosh-detect fires within 60 s of sim time', async ({ page }) => {
  await open(page, FAST);
  const el = page.locator('slosh-sim');
  // the mock post sets preset="fig13"; there is no figure button to press
  await expect(el).toHaveAttribute('preset', 'fig13');
  expect((await debug(page)).preset).toBe('fig13');
  expect((await buttonNames(page)).filter((n) => /^Fig \d+$/.test(n))).toEqual([]);
  await el.getByText('Fine-tune (advanced)').click();
  // K_T is computed but not applied: the radio shows Monitor, so the motion equals Off and the detector can trip
  await expect(el.getByRole('radio', { name: 'Monitor' })).toBeChecked();
  await expect(el.getByRole('radio', { name: 'Off' })).not.toBeChecked();
  await expect(el.getByRole('slider', { name: 'Gain shift' })).toHaveValue('2.3');

  await recordDetects(page);
  await call(page, 'play');
  await expect.poll(async () => (await detects(page)).length, { timeout: 100_000 }).toBeGreaterThan(0);

  const first = (await detects(page))[0]!;
  expect(first.t).toBeGreaterThan(0);
  expect(first.t).toBeLessThanOrEqual(60);
  expect(['pitch', 'roll']).toContain(first.axis);
  // the banner announces it
  await expect(el.getByRole('status').filter({ hasText: 'Slosh anomaly detected' })).toBeVisible();
});

test('gain shift 2.3 with AAC Off: no slosh-detect in 30 s of sim time after a kick through the runner', async ({ page }) => {
  await open(page, FAST);
  const el = page.locator('slosh-sim');
  // no disturbance button: the standard kick (theta 0.2 rad, phi-dot 0.6 rad/s) goes in through the runner
  await runnerSend(page, [
    { type: 'reset' },
    { type: 'setGainShift', value: 2.3 },
    { type: 'setAacMode', mode: 'off' },
    { type: 'kick' },
  ]);
  await recordDetects(page);
  await call(page, 'play');
  await el.getByText('Fine-tune (advanced)').click();
  await expect(el.getByRole('slider', { name: 'Gain shift' })).toHaveValue('2.3');
  await expect(el.getByRole('radio', { name: 'Off' })).toBeChecked();

  const t0 = await simTime(page);
  await waitSimTime(page, t0 + 30);
  // the controls still show the unstable setting, and the AAC stayed Off
  await expect(el.getByRole('slider', { name: 'Gain shift' })).toHaveValue('2.3');
  await expect(el.getByRole('radio', { name: 'Off' })).toBeChecked();
  expect(await detects(page)).toEqual([]);
  await expect(el.getByRole('status').filter({ hasText: 'Slosh anomaly detected' })).toHaveCount(0);
  // the slosh did grow (the AAC off does not stop it), so the missing trip is not just a quiet pendulum
  expect(await thetaEnvelope(page, 5)).toBeGreaterThan(0.2);
  expect((await debug(page)).markers.some((m) => m.kind === 'trip')).toBe(false);
});
