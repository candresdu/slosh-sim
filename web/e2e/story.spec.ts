import { expect, test, type Page } from '@playwright/test';
import { bannerState, call, debug, detects, hasMarker, INDEX, open, recordDetects, runnerSend, simTime, thetaEnvelope, waitSimTime } from './helpers';

// Story mode through the in-view regime bar: tap texts, banner wording, markers and Replay the paper.
// `?testSpeed=4` runs the sim 4x faster than wall time.
const FAST = `${INDEX}?testSpeed=4`;

const TITLES = {
  nominal: 'Nominal · Fig 12',
  gainShift: 'Gain shift · Fig 13',
  engaged: 'AAC engaged · Fig 14',
} as const;

async function startStory(page: Page): Promise<void> {
  await open(page, FAST);
  await call(page, 'loadPreset', 'story');
  await call(page, 'play');
  await waitSimTime(page, 1);
}

test.describe('regime buttons', () => {
  test('a tap on a paused widget starts the flight from where it is; only Restart leaves it paused', async ({ page }) => {
    await open(page, FAST);
    const el = page.locator('slosh-sim');
    expect((await debug(page)).paused).toBe(true);
    await el.getByRole('button', { name: TITLES.gainShift, exact: true }).click();
    await expect.poll(async () => (await debug(page)).paused).toBe(false);
    await waitSimTime(page, 2); // the flight carries on from the initial swing, it is not reset
    await call(page, 'pause');
    const t = await simTime(page);
    await el.getByRole('button', { name: TITLES.engaged, exact: true }).click();
    await expect.poll(async () => (await debug(page)).paused).toBe(false);
    expect(await simTime(page)).toBeGreaterThanOrEqual(t);
    await call(page, 'pause');
    await el.getByRole('button', { name: 'Restart', exact: true }).click();
    expect((await debug(page)).paused).toBe(true);
  });

  test('each tap shows its phase, figure reference and wording, and never resets the flight', async ({ page }) => {
    await startStory(page);
    const el = page.locator('slosh-sim');

    // Gain shift: the reader is told that the instability is caused on purpose
    const t0 = await simTime(page);
    await el.getByRole('button', { name: TITLES.gainShift, exact: true }).click();
    await expect.poll(async () => (await bannerState(page)).title).toBe(TITLES.gainShift);
    let b = await bannerState(page);
    expect(b.visible).toBe(true);
    expect(b.body).toMatch(/on purpose/);
    expect(b.body).toMatch(/×2\.3/);
    expect(b.body).toMatch(/unstable/);
    expect(b.body).toMatch(/fuel slosh/);
    expect(b.body).toMatch(/Fig 13/);
    await expect(el.getByRole('button', { name: TITLES.gainShift, exact: true })).toHaveAttribute('aria-pressed', 'true');
    expect(await simTime(page)).toBeGreaterThanOrEqual(t0); // no reset: the clock carries on

    // AAC engaged
    await el.getByRole('button', { name: TITLES.engaged, exact: true }).click();
    await expect.poll(async () => (await bannerState(page)).title).toBe(TITLES.engaged);
    b = await bannerState(page);
    expect(b.body).toMatch(/Fig 14/);
    expect(b.body).toMatch(/K_T/);
    expect(await simTime(page)).toBeGreaterThanOrEqual(t0);

    // Nominal
    await el.getByRole('button', { name: TITLES.nominal, exact: true }).click();
    await expect.poll(async () => (await bannerState(page)).title).toBe(TITLES.nominal);
    b = await bannerState(page);
    expect(b.body).toMatch(/Fig 12/);
    expect(await simTime(page)).toBeGreaterThanOrEqual(t0);
    await expect.poll(async () => (await debug(page)).regime).toBe('nominal');
  });

  test('Gain shift on a still pendulum also applies the standard disturbance, marked "Disturbance"', async ({ page }) => {
    await startStory(page);
    const el = page.locator('slosh-sim');
    // quiet the pendulum through the runner (a zero kick) instead of waiting ~30 s for the Fig 12 decay
    await runnerSend(page, [{ type: 'clearSchedule' }, { type: 'kick', theta: 0, phiDot: 0 }]);
    const tq = await simTime(page);
    await waitSimTime(page, tq + 2.6); // the 2 s envelope the tap looks at must not contain the old swing any more
    expect(await thetaEnvelope(page, 2)).toBeLessThan(0.05);
    const t0 = await simTime(page);
    const disturbances = async (): Promise<number[]> =>
      (await debug(page)).markers.filter((m) => m.label === 'Disturbance').map((m) => m.t);
    expect((await disturbances()).filter((t) => t > t0)).toEqual([]); // the quieting kick above is older

    await el.getByRole('button', { name: TITLES.gainShift, exact: true }).click();
    const t1 = await simTime(page);
    await expect.poll(async () => (await disturbances()).filter((t) => t >= t0 - 0.05).length).toBe(1);
    expect(await hasMarker(page, 'Gain shift \u2192 2.3')).toBe(true);
    expect(await hasMarker(page, 'AAC monitoring')).toBe(true);
    const mark = { t: (await disturbances()).pop()! };
    expect(mark.t).toBeGreaterThanOrEqual(t0 - 0.05);
    expect(mark.t).toBeLessThanOrEqual(t1 + 0.05); // applied in the tick of the tap
    // the disturbance is real: theta is back up near 0.2 rad within the same tick
    await expect.poll(() => thetaEnvelope(page, 1)).toBeGreaterThan(0.1);
    expect(await simTime(page)).toBeGreaterThanOrEqual(t0); // still the same flight
  });

  test('Gain shift while the pendulum is still swinging adds no disturbance', async ({ page }) => {
    await startStory(page); // theta starts at 0.2 rad
    const el = page.locator('slosh-sim');
    expect(await thetaEnvelope(page)).toBeGreaterThan(0.05);
    await el.getByRole('button', { name: TITLES.gainShift, exact: true }).click();
    await expect.poll(() => hasMarker(page, 'AAC monitoring')).toBe(true);
    expect(await hasMarker(page, 'Disturbance')).toBe(false);
  });
});

test.describe('Replay the paper', () => {
  test('resets to the start, then the banner follows Nominal, Gain shift and AAC engaged', async ({ page }) => {
    await startStory(page);
    const el = page.locator('slosh-sim');
    await waitSimTime(page, 3);

    await el.getByRole('button', { name: 'Replay the paper', exact: true }).click();
    await expect.poll(() => simTime(page)).toBeLessThan(3); // reset to the story's initial state
    let b = await bannerState(page);
    expect(b.visible).toBe(true);
    expect(b.title).toContain('Replay the paper');
    expect(b.title).toMatch(/Figs 12–14/);
    expect(b.title).toContain('§V.B');
    expect(b.body).toMatch(/Fig 12/);
    expect(b.body).toMatch(/Fig 13/);
    expect(b.body).toMatch(/Fig 14/);
    await recordDetects(page);

    // shift at 8 s of the story, AAC engaged at 22 s
    await waitSimTime(page, 9);
    await expect.poll(async () => (await bannerState(page)).title).toBe(TITLES.gainShift);
    b = await bannerState(page);
    expect(b.body).toMatch(/on purpose/);
    expect((await debug(page)).regime).toBe('gainShift');
    await expect.poll(async () => (await detects(page)).length, { timeout: 60_000 }).toBeGreaterThan(0);
    await expect.poll(async () => (await bannerState(page)).caption).toMatch(/Slosh anomaly detected/);

    await waitSimTime(page, 23);
    await expect.poll(async () => (await bannerState(page)).title).toBe(TITLES.engaged);
    expect((await bannerState(page)).body).toMatch(/Fig 14/);
    expect((await debug(page)).regime).toBe('engaged');
    const labels = (await debug(page)).markers.map((m) => m.label);
    expect(labels).toContain('Gain shift \u2192 2.3');
    expect(labels).toContain('AAC engaged');
  });

  test('a regime tap during the replay cancels the remaining steps without a reset', async ({ page }) => {
    await startStory(page);
    const el = page.locator('slosh-sim');
    await el.getByRole('button', { name: 'Replay the paper', exact: true }).click();
    await waitSimTime(page, 3);
    const t0 = await simTime(page);
    await el.getByRole('button', { name: TITLES.nominal, exact: true }).click();
    await expect.poll(async () => (await bannerState(page)).title).toBe(TITLES.nominal);

    await waitSimTime(page, 26); // past the replay's shift (8 s) and engage (22 s)
    expect(await simTime(page)).toBeGreaterThan(t0); // never reset
    const d = await debug(page);
    expect(d.regime).toBe('nominal');
    expect(d.markers.map((m) => m.label)).not.toContain('Gain shift \u2192 2.3');
    expect(d.markers.map((m) => m.label)).not.toContain('AAC engaged');
    expect((await bannerState(page)).title).toBe(TITLES.nominal);
  });

  test('Restart returns to the initial state with nothing scheduled and no banner', async ({ page }) => {
    await startStory(page);
    const el = page.locator('slosh-sim');
    await el.getByRole('button', { name: 'Replay the paper', exact: true }).click();
    await waitSimTime(page, 2);
    await el.getByRole('button', { name: 'Restart', exact: true }).click();
    await expect.poll(() => simTime(page)).toBeLessThan(2);
    await waitSimTime(page, 12); // the replay would have applied the shift at 8 s
    const d = await debug(page);
    expect(d.regime).toBe('nominal');
    expect(d.markers.map((m) => m.label)).not.toContain('Gain shift \u2192 2.3');
    expect((await bannerState(page)).visible).toBe(false);
  });
});
