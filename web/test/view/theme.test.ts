// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DARK_PALETTE,
  LIGHT_PALETTE,
  SITE_THEME_ATTRIBUTE,
  ThemeController,
  type MediaQueryListLike,
  type Palette,
} from '../../src/view/theme';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function fakeMedia(initial: boolean) {
  const listeners = new Set<() => void>();
  const mql: MediaQueryListLike = {
    matches: initial,
    addEventListener: (_t, l) => void listeners.add(l),
    removeEventListener: (_t, l) => void listeners.delete(l),
  };
  return {
    mql,
    set(v: boolean) {
      mql.matches = v;
      listeners.forEach((l) => l());
    },
    count: () => listeners.size,
  };
}

let host: HTMLElement;
let container: HTMLElement;
beforeEach(() => {
  document.documentElement.removeAttribute(SITE_THEME_ATTRIBUTE);
  host = document.createElement('div');
  container = document.createElement('div');
  host.appendChild(container);
  document.body.appendChild(host);
});
afterEach(() => host.remove());

describe('ThemeController', () => {
  it('uses the site attribute name data-theme', () => {
    expect(SITE_THEME_ATTRIBUTE).toBe('data-theme');
  });

  it('theme="dark" overrides <html data-theme="light">', async () => {
    document.documentElement.setAttribute('data-theme', 'light');
    host.setAttribute('theme', 'dark');
    const onChange = vi.fn();
    const mm = fakeMedia(false);
    const tc = new ThemeController(host, { onChange, container, matchMedia: () => mm.mql });
    expect(tc.current()).toBe('dark');
    expect(container.getAttribute('data-theme')).toBe('dark');
    document.documentElement.setAttribute('data-theme', 'light');
    document.documentElement.setAttribute('data-theme', 'dark');
    document.documentElement.setAttribute('data-theme', 'light');
    await tick();
    expect(tc.current()).toBe('dark');
    expect(onChange).not.toHaveBeenCalled();
    tc.dispose();
  });

  it('theme="auto": html data-theme light -> dark calls onChange once with the dark palette', async () => {
    document.documentElement.setAttribute('data-theme', 'light');
    host.setAttribute('theme', 'auto');
    const onChange = vi.fn<(p: Palette) => void>();
    const mm = fakeMedia(false);
    const tc = new ThemeController(host, { onChange, container, matchMedia: () => mm.mql });
    expect(tc.current()).toBe('light');
    expect(tc.palette()).toBe(LIGHT_PALETTE);
    expect(container.getAttribute('data-theme')).toBe('light');
    document.documentElement.setAttribute('data-theme', 'dark');
    await tick();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(DARK_PALETTE);
    expect(container.getAttribute('data-theme')).toBe('dark');
    tc.dispose();
  });

  it('without data-theme, prefers-color-scheme drives the theme', () => {
    const onChange = vi.fn<(p: Palette) => void>();
    const mm = fakeMedia(false);
    const tc = new ThemeController(host, { onChange, container, matchMedia: () => mm.mql });
    expect(tc.current()).toBe('light');
    mm.set(true);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(DARK_PALETTE);
    mm.set(false);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith(LIGHT_PALETTE);
    tc.dispose();
  });

  it('ignores a data-theme that is not light/dark and falls back to the media query', async () => {
    document.documentElement.setAttribute('data-theme', 'system');
    const mm = fakeMedia(true);
    const tc = new ThemeController(host, { onChange: () => {}, container, matchMedia: () => mm.mql });
    expect(tc.current()).toBe('dark');
    document.documentElement.setAttribute('data-theme', 'light');
    await tick();
    expect(tc.current()).toBe('light');
    tc.dispose();
  });

  it('reacts to changes of the component theme attribute', async () => {
    document.documentElement.setAttribute('data-theme', 'light');
    const onChange = vi.fn<(p: Palette) => void>();
    const mm = fakeMedia(false);
    const tc = new ThemeController(host, { onChange, container, matchMedia: () => mm.mql });
    host.setAttribute('theme', 'dark');
    await tick();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(DARK_PALETTE);
    tc.dispose();
  });

  it('dispose stops observing and listening', async () => {
    const onChange = vi.fn();
    const mm = fakeMedia(false);
    const tc = new ThemeController(host, { onChange, container, matchMedia: () => mm.mql });
    expect(mm.count()).toBe(1);
    tc.dispose();
    expect(mm.count()).toBe(0);
    document.documentElement.setAttribute('data-theme', 'dark');
    mm.set(true);
    await tick();
    expect(onChange).not.toHaveBeenCalled();
  });
});
