// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FULLSCREEN_OVERLAY_CSS,
  FullscreenController,
  OVERLAY_ATTRIBUTE,
  type FullscreenState,
} from '../../src/view/fullscreen';

let host: HTMLElement;
let states: FullscreenState[];
let onChange: (s: FullscreenState) => void;

function setFullscreenEnabled(v: boolean) {
  Object.defineProperty(document, 'fullscreenEnabled', { value: v, configurable: true });
}
function setFullscreenElement(el: Element | null) {
  Object.defineProperty(document, 'fullscreenElement', { value: el, configurable: true });
}
const escape = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  states = [];
  onChange = (s) => states.push({ ...s });
  document.documentElement.style.overflow = '';
  setFullscreenEnabled(false);
  setFullscreenElement(null);
  (host as { requestFullscreen?: unknown }).requestFullscreen = undefined;
  (document as { exitFullscreen?: unknown }).exitFullscreen = undefined;
});
afterEach(() => {
  host.remove();
  document.documentElement.style.overflow = '';
});

describe('FullscreenController overlay fallback', () => {
  it('uses the overlay when requestFullscreen is undefined, and exit restores state', async () => {
    document.documentElement.style.overflow = 'scroll';
    const fc = new FullscreenController(host, { onChange });
    expect(fc.isActive()).toBe(false);
    expect(fc.mode()).toBeNull();
    await fc.enter();
    expect(host.hasAttribute(OVERLAY_ATTRIBUTE)).toBe(true);
    expect(document.documentElement.style.overflow).toBe('hidden');
    expect(fc.mode()).toBe('overlay');
    expect(fc.isActive()).toBe(true);
    await fc.exit();
    expect(host.hasAttribute(OVERLAY_ATTRIBUTE)).toBe(false);
    expect(document.documentElement.style.overflow).toBe('scroll');
    expect(fc.isActive()).toBe(false);
    expect(states).toEqual([
      { active: true, mode: 'overlay' },
      { active: false, mode: null },
    ]);
    fc.dispose();
  });

  it('falls back to the overlay when requestFullscreen rejects', async () => {
    setFullscreenEnabled(true);
    const req = vi.fn().mockRejectedValue(new TypeError('denied'));
    (host as unknown as { requestFullscreen: unknown }).requestFullscreen = req;
    const fc = new FullscreenController(host, { onChange });
    await fc.enter();
    expect(req).toHaveBeenCalledTimes(1);
    expect(fc.mode()).toBe('overlay');
    expect(host.hasAttribute(OVERLAY_ATTRIBUTE)).toBe(true);
    expect(document.documentElement.style.overflow).toBe('hidden');
    await fc.exit();
    expect(host.hasAttribute(OVERLAY_ATTRIBUTE)).toBe(false);
    expect(document.documentElement.style.overflow).toBe('');
    fc.dispose();
  });

  it('falls back when fullscreenEnabled is false even if requestFullscreen exists', async () => {
    const req = vi.fn().mockResolvedValue(undefined);
    (host as unknown as { requestFullscreen: unknown }).requestFullscreen = req;
    const fc = new FullscreenController(host, { onChange });
    await fc.enter();
    expect(req).not.toHaveBeenCalled();
    expect(fc.mode()).toBe('overlay');
    fc.dispose();
  });

  it('Escape exits the overlay', async () => {
    const fc = new FullscreenController(host, { onChange });
    await fc.enter();
    escape();
    expect(fc.isActive()).toBe(false);
    expect(host.hasAttribute(OVERLAY_ATTRIBUTE)).toBe(false);
    expect(states.at(-1)).toEqual({ active: false, mode: null });
    fc.dispose();
  });

  it('toggle enters then exits; Escape when inactive does nothing', async () => {
    const fc = new FullscreenController(host, { onChange });
    escape();
    expect(states).toEqual([]);
    await fc.toggle();
    expect(fc.isActive()).toBe(true);
    await fc.toggle();
    expect(fc.isActive()).toBe(false);
    fc.dispose();
  });

  it('dispose while in overlay restores the page', async () => {
    const fc = new FullscreenController(host, { onChange });
    await fc.enter();
    fc.dispose();
    expect(document.documentElement.style.overflow).toBe('');
    expect(host.hasAttribute(OVERLAY_ATTRIBUTE)).toBe(false);
  });

  it('overlay CSS sits above the Bootstrap navbar (1030)', () => {
    expect(FULLSCREEN_OVERLAY_CSS).toContain(':host([fullscreen-overlay])');
    expect(FULLSCREEN_OVERLAY_CSS).toContain('position: fixed');
    expect(FULLSCREEN_OVERLAY_CSS).toContain('inset: 0');
    expect(FULLSCREEN_OVERLAY_CSS).toContain('z-index: 2000');
    expect(FULLSCREEN_OVERLAY_CSS).toContain('100dvh');
  });
});

describe('FullscreenController native path', () => {
  function installNative() {
    setFullscreenEnabled(true);
    const req = vi.fn(async () => {
      setFullscreenElement(host);
    });
    const exitFs = vi.fn(async () => {
      setFullscreenElement(null);
      document.dispatchEvent(new Event('fullscreenchange'));
    });
    (host as unknown as { requestFullscreen: unknown }).requestFullscreen = req;
    (document as unknown as { exitFullscreen: unknown }).exitFullscreen = exitFs;
    return { req, exitFs };
  }

  it('enter() calls requestFullscreen and reports native', async () => {
    const { req } = installNative();
    const fc = new FullscreenController(host, { onChange });
    await fc.enter();
    expect(req).toHaveBeenCalledTimes(1);
    expect(fc.mode()).toBe('native');
    expect(host.hasAttribute(OVERLAY_ATTRIBUTE)).toBe(false);
    expect(document.documentElement.style.overflow).toBe('');
    expect(states).toEqual([{ active: true, mode: 'native' }]);
    await fc.exit();
    expect(fc.isActive()).toBe(false);
    expect(states).toEqual([
      { active: true, mode: 'native' },
      { active: false, mode: null },
    ]);
    fc.dispose();
  });

  it('Escape exits native mode', async () => {
    const { exitFs } = installNative();
    const fc = new FullscreenController(host, { onChange });
    await fc.enter();
    escape();
    await Promise.resolve();
    await Promise.resolve();
    expect(exitFs).toHaveBeenCalledTimes(1);
    expect(fc.isActive()).toBe(false);
    expect(states.at(-1)).toEqual({ active: false, mode: null });
    fc.dispose();
  });

  it('syncs when the browser leaves full screen by itself (fullscreenchange)', async () => {
    installNative();
    const fc = new FullscreenController(host, { onChange });
    await fc.enter();
    setFullscreenElement(null);
    document.dispatchEvent(new Event('fullscreenchange'));
    expect(fc.isActive()).toBe(false);
    expect(states).toEqual([
      { active: true, mode: 'native' },
      { active: false, mode: null },
    ]);
    fc.dispose();
  });

  it('falls back to webkitRequestFullscreen', async () => {
    Object.defineProperty(document, 'webkitFullscreenEnabled', { value: true, configurable: true });
    const req = vi.fn(async () => {});
    (host as unknown as { webkitRequestFullscreen: unknown }).webkitRequestFullscreen = req;
    const fc = new FullscreenController(host, { onChange });
    await fc.enter();
    expect(req).toHaveBeenCalledTimes(1);
    expect(fc.mode()).toBe('native');
    fc.dispose();
    Object.defineProperty(document, 'webkitFullscreenEnabled', { value: undefined, configurable: true });
  });
});
