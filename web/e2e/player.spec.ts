import { expect, test, type Locator, type Page } from '@playwright/test';
import { debug, hasScene, INDEX, open } from './helpers';

// The video-style player: centred play overlay while paused, tap on the view toggles, a drag orbits without toggling.

/** A point inside the scene box away from the regime bar (top), the player bar / banner (bottom) and the centre disc. */
async function emptySpot(scene: Locator): Promise<{ x: number; y: number }> {
  const b = (await scene.boundingBox())!;
  return { x: b.x + b.width * 0.8, y: b.y + b.height * 0.45 };
}

async function sceneShot(page: Page): Promise<Buffer> {
  return page.locator('slosh-sim .scene canvas').screenshot();
}

test('paused: a play icon covers the centre of the view and the player bar offers Play', async ({ page }) => {
  await open(page, INDEX);
  const el = page.locator('slosh-sim');
  const scene = el.locator('.scene');
  expect((await debug(page)).paused).toBe(true);

  const disc = el.getByRole('button', { name: 'Play', exact: true }).first();
  await expect(disc).toBeVisible();
  await expect(el.locator('.sc-play-overlay')).toBeVisible();
  const sb = (await scene.boundingBox())!;
  const db = (await disc.boundingBox())!;
  expect(Math.abs(db.x + db.width / 2 - (sb.x + sb.width / 2))).toBeLessThan(2);
  expect(Math.abs(db.y + db.height / 2 - (sb.y + sb.height / 2))).toBeLessThan(2);
  // the scrim covers the whole view, so the paused state is obvious
  const ob = (await el.locator('.sc-play-overlay').boundingBox())!;
  expect(ob.width).toBeGreaterThanOrEqual(sb.width - 1);
  expect(ob.height).toBeGreaterThanOrEqual(sb.height - 1);
  await expect(el.locator('.sc-player').getByRole('button', { name: 'Play', exact: true })).toBeVisible();
});

test('the play button resumes and the overlay goes; Pause brings it back', async ({ page }) => {
  await open(page, INDEX);
  const el = page.locator('slosh-sim');
  await el.locator('.sc-play-disc').click();
  expect((await debug(page)).paused).toBe(false);
  await expect(el.locator('.sc-play-overlay')).toBeHidden();
  await expect(el.locator('.sc-player').getByRole('button', { name: 'Pause', exact: true })).toBeVisible();

  await el.locator('.sc-player').getByRole('button', { name: 'Pause', exact: true }).click();
  expect((await debug(page)).paused).toBe(true);
  await expect(el.locator('.sc-play-overlay')).toBeVisible();
});

test('pausing by tapping the view shows the overlay; tapping the view again resumes', async ({ page }) => {
  await open(page, INDEX);
  const el = page.locator('slosh-sim');
  const scene = el.locator('.scene');
  await el.locator('.sc-play-disc').click(); // playing
  await expect(el.locator('.sc-play-overlay')).toBeHidden();

  const p = await emptySpot(scene);
  await page.mouse.click(p.x, p.y); // a tap on the view pauses
  expect((await debug(page)).paused).toBe(true);
  await expect(el.locator('.sc-play-overlay')).toBeVisible();

  await page.mouse.click(p.x, p.y); // the scrim lets the tap through: it resumes
  expect((await debug(page)).paused).toBe(false);
  await expect(el.locator('.sc-play-overlay')).toBeHidden();
});

test('a tap on the big play icon resumes exactly once', async ({ page }) => {
  await open(page, INDEX);
  const el = page.locator('slosh-sim');
  await el.locator('.sc-play-disc').click();
  expect((await debug(page)).paused).toBe(false); // not toggled twice (disc click + view tap)
  await expect(el.locator('.sc-play-overlay')).toBeHidden();
});

for (const startPlaying of [false, true]) {
  test(`a drag orbits the camera without toggling play/pause (${startPlaying ? 'playing' : 'paused'})`, async ({ page }) => {
    await open(page, INDEX);
    const el = page.locator('slosh-sim');
    const scene = el.locator('.scene');
    if (startPlaying) await el.locator('.sc-play-disc').click();
    const before = (await debug(page)).paused;
    expect(before).toBe(!startPlaying);

    const shotBefore = !startPlaying && (await hasScene(page)) ? await sceneShot(page) : null;
    const p = await emptySpot(scene);
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) await page.mouse.move(p.x - i * 8, p.y + i * 2);
    await page.mouse.up();

    expect((await debug(page)).paused).toBe(before); // unchanged: the drag is not a tap
    expect(await el.locator('.sc-play-overlay').isVisible()).toBe(before);

    if (shotBefore !== null) {
      // paused, so only the camera can change the picture
      await expect.poll(async () => !(await sceneShot(page)).equals(shotBefore), { timeout: 5000 }).toBe(true);
    }
  });
}

test('a slow press (over 300 ms) without moving is not a tap', async ({ page }) => {
  await open(page, INDEX);
  const el = page.locator('slosh-sim');
  const p = await emptySpot(el.locator('.scene'));
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.waitForTimeout(450);
  await page.mouse.up();
  expect((await debug(page)).paused).toBe(true);
});
