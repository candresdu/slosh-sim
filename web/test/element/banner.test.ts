// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (_t, name: string) => (name === 'measureText' ? () => ({ width: 10 }) : () => undefined),
    set: () => true,
  });
  HTMLCanvasElement.prototype.getContext = (() => ctx) as unknown as HTMLCanvasElement['getContext'];
  class FakePath2D {
    moveTo(): void {}
    lineTo(): void {}
    rect(): void {}
    closePath(): void {}
    arc(): void {}
    addPath(): void {}
    bezierCurveTo(): void {}
  }
  (globalThis as Record<string, unknown>).Path2D = FakePath2D;
  (globalThis as Record<string, unknown>).matchMedia = () => ({
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    matches: false,
  });
});

import '../../src/element/slosh-sim';
import type { SloshSim } from '../../src/element/slosh-sim';

let el: SloshSim;
const mount = (attrs: Record<string, string> = {}): SloshSim => {
  const e = document.createElement('slosh-sim');
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  document.body.appendChild(e);
  el = e;
  return e;
};
const banner = (e: SloshSim): HTMLElement => e.shadowRoot!.querySelector('.sc-info') as HTMLElement;
const title = (e: SloshSim): string => banner(e).querySelector('.sc-info-title')!.textContent!;
const press = (e: SloshSim, label: string): void =>
  [...e.shadowRoot!.querySelectorAll<HTMLButtonElement>('.sc-controls button')].find((b) => b.getAttribute('aria-label') === label)!.click();

afterEach(() => {
  el?.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('info banner in <slosh-sim>', () => {
  it('is hidden at the start and is a descendant of the 3D view frame in both layouts', () => {
    for (const layout of ['full', 'compact']) {
      const e = mount({ layout });
      const view = e.shadowRoot!.querySelector('.view')!;
      expect(view.contains(e.shadowRoot!.querySelector('.scene'))).toBe(true);
      expect(view.contains(banner(e))).toBe(true);
      expect(banner(e).hidden).toBe(true);
      expect(e.shadowRoot!.querySelectorAll('.sc-banner, .sc-story-caption')).toHaveLength(0);
      e.remove();
    }
  });

  it('shows the matching title for each regime button and for Replay the paper', () => {
    const e = mount();
    const expected: Array<[string, string]> = [
      ['Nominal · Fig 12', 'Fig 12'],
      ['Gain shift · Fig 13', 'Fig 13'],
      ['AAC engaged · Fig 14', 'Fig 14'],
      ['Replay the paper', 'Figs 12–14'],
    ];
    for (const [label, fig] of expected) {
      banner(e).hidden = true;
      press(e, label);
      expect(banner(e).hidden, label).toBe(false);
      expect(title(e), label).toContain(fig);
    }
    expect(title(e)).toContain('§V.B');
  });

  it('the Gain shift banner says the gains are raised on purpose', () => {
    const e = mount();
    press(e, 'Gain shift · Fig 13');
    expect(banner(e).textContent).toMatch(/on purpose/);
    expect(banner(e).textContent).toMatch(/unstable/);
  });

  it('dismiss hides it; the next regime tap shows it again', () => {
    const e = mount();
    press(e, 'Gain shift · Fig 13');
    banner(e).querySelector<HTMLButtonElement>('.sc-info-close')!.click();
    expect(banner(e).hidden).toBe(true);
    press(e, 'AAC engaged · Fig 14');
    expect(banner(e).hidden).toBe(false);
    expect(title(e)).toContain('Fig 14');
  });

  it('Restart hides it', () => {
    const e = mount();
    press(e, 'Nominal · Fig 12');
    press(e, 'Restart');
    expect(banner(e).hidden).toBe(true);
  });

  it('during Replay the paper each scheduled phase change updates the title, and a trip shows axis and time', () => {
    let clock = 0;
    const queue: Array<(t: number) => void> = [];
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => queue.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    const frames = (n: number): void => {
      for (let i = 0; i < n; i++) {
        clock += 100;
        for (const cb of queue.splice(0)) cb(clock);
      }
    };
    const e = mount({ autoplay: '' });
    expect(title(e)).toBe(''); // autoplay itself does not show it until the first phase change
    press(e, 'Replay the paper');
    expect(title(e)).toContain('Replay the paper');
    frames(50); // 5 s: still Nominal
    expect(title(e)).toContain('Replay the paper');
    frames(50); // gain shift at 8 s
    expect(title(e)).toContain('Gain shift · Fig 13');
    expect(banner(e).hidden).toBe(false);
    let guard = 0;
    while (!/Slosh anomaly detected/.test(banner(e).textContent ?? '') && guard++ < 300) frames(1);
    expect(banner(e).querySelector('.sc-info-caption')!.textContent).toMatch(/Slosh anomaly detected on the (pitch|roll) axis at t = \d+\.\d s/);
    expect(title(e)).toContain('Fig 13');
    // dismiss, then the engage at 22 s shows it again with the new title
    banner(e).querySelector<HTMLButtonElement>('.sc-info-close')!.click();
    expect(banner(e).hidden).toBe(true);
    guard = 0;
    while (banner(e).hidden && guard++ < 400) frames(1);
    expect(title(e)).toContain('AAC engaged · Fig 14');
    // the accessible summary still announces caption changes
    expect(e.shadowRoot!.querySelector('.sc-summary')!.textContent).toContain(e.debugState().caption);
  }, 60000);
});
