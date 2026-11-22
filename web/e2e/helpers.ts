import { expect, type Page } from '@playwright/test';

export const ALFOLIO = '/e2e/pages/alfolio.html';
export const INDEX = '/index.html';
export const TWO = '/e2e/pages/two.html';

export interface SimDebug {
  simTime: number;
  theme: 'light' | 'dark';
  sceneClearColor: string | null;
  fullscreen: boolean;
  fullscreenMode: 'native' | 'overlay' | null;
  layout: 'compact' | 'column' | 'wide';
  trailVisible: boolean;
  preset: string;
  paused: boolean;
  markers: Array<{ t: number; kind: string; label: string }>;
  regime: 'nominal' | 'gainShift' | 'engaged' | null;
  caption: string;
}

/** Collect console errors and uncaught exceptions. Call before `goto`. */
export function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

/** The demo pages have no favicon; answer it so it cannot show up as a console error. */
export async function stubFavicon(page: Page): Promise<void> {
  await page.route('**/favicon.ico', (r) => r.fulfill({ status: 204 }));
}

export async function open(page: Page, url: string): Promise<void> {
  await stubFavicon(page);
  await page.goto(url);
  await page.waitForFunction(() => {
    const el = document.querySelector('slosh-sim') as (HTMLElement & { debugState?: () => unknown }) | null;
    return el !== null && typeof el.debugState === 'function' && el.shadowRoot?.querySelector('.frame') != null;
  });
}

export function debug(page: Page, selector = 'slosh-sim'): Promise<SimDebug> {
  return page.evaluate(
    (sel) => (document.querySelector(sel) as unknown as { debugState(): SimDebug }).debugState(),
    selector,
  );
}

export async function simTime(page: Page, selector = 'slosh-sim'): Promise<number> {
  return (await debug(page, selector)).simTime;
}

/** Wait until the sim clock has reached `t` seconds. */
export async function waitSimTime(page: Page, t: number, selector = 'slosh-sim', timeoutMs = 100_000): Promise<void> {
  await expect.poll(() => simTime(page, selector), { timeout: timeoutMs, intervals: [100, 250, 500] }).toBeGreaterThanOrEqual(t);
}

/** Call a method on the (first) element. */
export function call(page: Page, method: string, ...args: unknown[]): Promise<void> {
  return page.evaluate(
    ([m, a]) => {
      const el = document.querySelector('slosh-sim') as unknown as Record<string, (...x: unknown[]) => unknown>;
      el[m as string]!(...(a as unknown[]));
    },
    [method, args] as const,
  );
}

/** Record `slosh-detect` events on window.__detects as {axis, t}. */
export function recordDetects(page: Page): Promise<void> {
  return page.evaluate(() => {
    const w = window as unknown as { __detects: Array<{ axis: string; t: number }> };
    w.__detects = [];
    document.querySelector('slosh-sim')!.addEventListener('slosh-detect', (e) => {
      w.__detects.push((e as CustomEvent<{ axis: string; t: number }>).detail);
    });
  });
}

export function detects(page: Page): Promise<Array<{ axis: string; t: number }>> {
  return page.evaluate(() => (window as unknown as { __detects: Array<{ axis: string; t: number }> }).__detects);
}

/** True when the component managed to create a WebGL2 scene (software GL may be missing in some browsers). */
export async function hasScene(page: Page, selector = 'slosh-sim'): Promise<boolean> {
  return (await debug(page, selector)).sceneClearColor !== null;
}

/** Description of the focused element inside the first <slosh-sim>'s shadow root. */
export function focusedInShadow(page: Page): Promise<{ tag: string; label: string; outlineWidth: number; type: string } | null> {
  return page.evaluate(() => {
    const el = document.querySelector('slosh-sim');
    const a = el?.shadowRoot?.activeElement as HTMLElement | null | undefined;
    if (!a) return null;
    const label =
      a.getAttribute('aria-label') ?? (a as HTMLInputElement).labels?.[0]?.textContent?.trim() ?? a.textContent?.trim() ?? '';
    return {
      tag: a.tagName.toLowerCase(),
      label,
      type: (a as HTMLInputElement).type ?? '',
      outlineWidth: parseFloat(getComputedStyle(a).outlineWidth),
    };
  });
}

/**
 * Send commands to the sim through the element's runner (the same path the controls use; there is no disturbance button,
 * so tests that need the standard kick use this). `rt` is the component's private runtime, reachable at run time only.
 */
export function runnerSend(page: Page, cmds: unknown, selector = 'slosh-sim'): Promise<void> {
  return page.evaluate(
    ([sel, c]) => {
      const el = document.querySelector(sel as string) as unknown as { rt: { runner: { send(c: unknown): void } } };
      el.rt.runner.send(c);
    },
    [selector, cmds] as const,
  );
}

/** The text of the info banner (title, body, caption lines) and whether it is visible. */
export async function bannerState(page: Page): Promise<{ visible: boolean; title: string; body: string; caption: string }> {
  return page.evaluate(() => {
    const root = document.querySelector('slosh-sim')!.shadowRoot!;
    const b = root.querySelector('.sc-info') as HTMLElement;
    const t = (c: string): string => root.querySelector(c)?.textContent ?? '';
    return { visible: !b.hidden, title: t('.sc-info-title'), body: t('.sc-info-body'), caption: t('.sc-info-caption') };
  });
}

/** Largest |theta| over the last `windowS` seconds of the telemetry ring [rad] (0 when empty). */
export function thetaEnvelope(page: Page, windowS = 2): Promise<number> {
  return page.evaluate((w) => {
    const el = document.querySelector('slosh-sim') as unknown as {
      rt: { ring: { view(k: string): ArrayLike<number> } };
    };
    const t = el.rt.ring.view('t');
    const th = el.rt.ring.view('theta');
    const n = t.length;
    if (n === 0) return 0;
    const t1 = t[n - 1] as number;
    let m = 0;
    for (let i = n - 1; i >= 0 && (t[i] as number) >= t1 - w; i--) m = Math.max(m, Math.abs(th[i] as number));
    return m;
  }, windowS);
}

export function hasMarker(page: Page, label: string): Promise<boolean> {
  return debug(page).then((d) => d.markers.some((m) => m.label === label));
}

/** Accessible names of all visible buttons in the first <slosh-sim> (aria-label, else text). */
export function buttonNames(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const root = document.querySelector('slosh-sim')!.shadowRoot!;
    return Array.from(root.querySelectorAll('button'))
      .filter((b) => !b.hidden && b.offsetParent !== null)
      .map((b) => b.getAttribute('aria-label') ?? b.textContent?.trim() ?? '');
  });
}

/** The buttons the widget offers; anything else (a separate figure button, a disturbance button, a Reset button) is a regression. */
export const EXPECTED_BUTTONS = [
  'Nominal \u00b7 Fig 12',
  'Gain shift \u00b7 Fig 13',
  'AAC engaged \u00b7 Fig 14',
  'Replay the paper',
  'Restart',
  'Play', // the overlay
  'Play', // the player bar
  'Speed 1\u00d7, press for half speed',
  'Full screen',
] as const;
