// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// jsdom has no canvas, Path2D or matchMedia (uPlot needs all three); WebGL2 is absent too, which
// exercises the "no WebGL2" path of the element.
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

import { SloshSim } from '../../src/element/slosh-sim';

let el: SloshSim;
const mount = (attrs: Record<string, string> = {}): SloshSim => {
  const e = document.createElement('slosh-sim');
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  document.body.appendChild(e);
  el = e;
  return e;
};
const fsButton = (e: SloshSim): HTMLButtonElement =>
  e.shadowRoot!.querySelector('.sc-player button[aria-label$="ull screen"]') as HTMLButtonElement;

beforeEach(() => {
  document.documentElement.removeAttribute('data-theme');
});
afterEach(() => {
  el?.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('<slosh-sim>', () => {
  it('is defined and has an open shadow root with its own styles', () => {
    const e = mount();
    expect(customElements.get('slosh-sim')).toBe(SloshSim);
    expect(e.shadowRoot).not.toBeNull();
    expect(e.shadowRoot!.mode).toBe('open');
    expect(e.shadowRoot!.querySelector('style')).not.toBeNull();
    // nothing leaks into the light DOM
    expect(e.querySelector('style')).toBeNull();
  });

  it('reflects the preset and theme attributes (defaults: story, auto)', async () => {
    const e = mount();
    expect(e.preset).toBe('story');
    expect(e.theme).toBe('auto');
    e.setAttribute('preset', 'fig14');
    e.theme = 'dark';
    expect(e.getAttribute('theme')).toBe('dark');
    await Promise.resolve(); // MutationObserver callbacks are microtasks
    expect(e.preset).toBe('fig14');
    expect(e.debugState().preset).toBe('fig14');
    expect(e.debugState().theme).toBe('dark');
    e.preset = 'free';
    expect(e.getAttribute('preset')).toBe('free');
    e.setAttribute('preset', 'nonsense');
    expect(e.preset).toBe('story');
  });

  it('follows the site theme and the theme attribute without a reload', () => {
    const e = mount();
    expect(e.debugState().theme).toBe('light');
    document.documentElement.setAttribute('data-theme', 'dark');
    return Promise.resolve().then(() => {
      expect(e.debugState().theme).toBe('dark');
      expect(e.shadowRoot!.querySelector('.frame')!.getAttribute('data-theme')).toBe('dark');
    });
  });

  it('hides the Full screen button when fullscreen-button="false"', () => {
    const shown = mount();
    expect(fsButton(shown).hidden).toBe(false);
    shown.remove();
    const hidden = mount({ 'fullscreen-button': 'false' });
    expect(fsButton(hidden).hidden).toBe(true);
    hidden.setAttribute('fullscreen-button', 'true');
    expect(fsButton(hidden).hidden).toBe(false);
  });

  it('shows the slotted fallback and keeps controls and charts when WebGL2 is unavailable', () => {
    const e = mount();
    expect(e.shadowRoot!.querySelector('.fallback')!.hasAttribute('hidden')).toBe(false);
    expect(e.shadowRoot!.querySelector('slot[name="fallback"]')).not.toBeNull();
    expect(e.shadowRoot!.querySelectorAll('figure[data-chart]').length).toBe(6);
    expect(e.shadowRoot!.querySelectorAll('.sc-controls button, .sc-player button').length).toBeGreaterThan(5);
    expect(e.debugState().sceneClearColor).toBeNull();
  });

  it('dispatches slosh-fullscreen (bubbles, composed) and shows/hides the Exit control', async () => {
    const e = mount();
    const seen: CustomEvent[] = [];
    document.body.addEventListener('slosh-fullscreen', (ev) => seen.push(ev as CustomEvent));
    const exit = e.shadowRoot!.querySelector('.exit') as HTMLButtonElement;
    expect(exit.hidden).toBe(true);
    await e.enterFullscreen(); // jsdom has no Fullscreen API: the overlay fallback is used
    expect(seen).toHaveLength(1);
    expect(seen[0]!.bubbles).toBe(true);
    expect(seen[0]!.composed).toBe(true);
    expect(seen[0]!.detail).toEqual({ active: true, mode: 'overlay' });
    expect(e.hasAttribute('fullscreen-overlay')).toBe(true);
    expect(exit.hidden).toBe(false);
    expect(e.shadowRoot!.activeElement).toBe(exit);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(seen).toHaveLength(2);
    expect(seen[1]!.detail).toEqual({ active: false, mode: null });
    expect(exit.hidden).toBe(true);
    expect(e.debugState().fullscreen).toBe(false);
  });

  it('dispatches slosh-detect (bubbles, composed) when the detector trips', () => {
    let clock = 0;
    const queue: Array<(t: number) => void> = [];
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => queue.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => undefined);

    const e = mount({ preset: 'fig13', autoplay: '' });
    const seen: CustomEvent[] = [];
    document.body.addEventListener('slosh-detect', (ev) => seen.push(ev as CustomEvent));
    for (let i = 0; i < 600 && seen.length === 0; i++) {
      clock += 100;
      const cbs = queue.splice(0);
      for (const cb of cbs) cb(clock);
    }
    expect(seen.length).toBeGreaterThan(0);
    const ev = seen[0]!;
    expect(ev.bubbles).toBe(true);
    expect(ev.composed).toBe(true);
    expect(['pitch', 'roll']).toContain((ev.detail as { axis: string }).axis);
    expect((ev.detail as { t: number }).t).toBeGreaterThan(0);
    expect(e.shadowRoot!.querySelector('.sc-info')!.textContent).toContain('Slosh anomaly detected');
    vi.unstubAllGlobals();
  }, 60000);

  it('debugState() exposes the chart markers and regime bands', () => {
    let clock = 0;
    const queue: Array<(t: number) => void> = [];
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => queue.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => undefined);

    const e = mount({ preset: 'fig13', autoplay: '' });
    expect(e.debugState().markers).toEqual([]);
    for (let i = 0; i < 600 && !e.debugState().markers.some((m) => m.kind === 'trip'); i++) {
      clock += 100;
      const cbs = queue.splice(0);
      for (const cb of cbs) cb(clock);
    }
    const d = e.debugState();
    expect(d.markers.some((m) => m.kind === 'trip' && m.label.startsWith('Detector tripped'))).toBe(true);
    expect(d.bands.length).toBeGreaterThan(0);
    expect(d.bands[d.bands.length - 1]!.regime).toBe('gainShift');
    vi.unstubAllGlobals();
  }, 60000);

  it('a mount without a preset attribute starts in story mode (initial state, nothing scheduled)', () => {
    const e = mount();
    const d = e.debugState();
    expect(e.hasAttribute('preset')).toBe(false);
    expect(d.preset).toBe('story');
    expect(d.regime).toBe('nominal');
    expect(d.paused).toBe(true);
    expect(d.caption).toMatch(/^Nominal: the PD controller damps the slosh\./);
    const root = e.shadowRoot!;
    const groups = [...root.querySelectorAll('.sc-controls > [role=group], .sc-controls > details')].map(
      (g) => g.getAttribute('aria-label') ?? g.className,
    );
    expect(groups).toEqual(['sc-exp']); // below the view: only Fine-tune; the regime bar is inside the view
    expect(root.querySelector('.view > [aria-label="Regime"]')).not.toBeNull();
    const fine = root.querySelector<HTMLDetailsElement>('details.sc-exp')!;
    expect(fine.open).toBe(false);
    expect(fine.querySelector('summary')!.textContent).toBe('Fine-tune (advanced)');
    expect(fine.querySelector('input[type=range]')).not.toBeNull();
    expect(fine.querySelector('details.sc-about')).not.toBeNull(); // parameter panel is inside Fine-tune
    expect(root.querySelectorAll('details.sc-about')).toHaveLength(1);
    // the rendered component has no Fig / §V.B / Kick / Reset buttons of its own
    const names = [...root.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? b.textContent ?? '');
    expect(names.filter((n) => /Kick|Reset|V\.B|Play the story/.test(n))).toEqual([]);
    expect(names.filter((n) => /Fig \d/.test(n))).toEqual(['Nominal \u00b7 Fig 12', 'Gain shift \u00b7 Fig 13', 'AAC engaged \u00b7 Fig 14']);
    expect(names).toContain('Replay the paper');
    expect(names).toContain('Restart');
    const pressed = [...root.querySelectorAll('button[data-regime]')].map((b) => b.getAttribute('aria-pressed'));
    expect(pressed).toEqual(['true', 'false', 'false']);
    expect(root.querySelector('.sc-info-caption')!.textContent).toBe(d.caption);
    expect(root.querySelector('.sc-summary')!.textContent).toContain('Nominal: the PD controller damps the slosh.');
  });

  it('regime buttons and Play/Restart drive the running flight, and emit slosh-regime / slosh-marker', () => {
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
    const regimes: string[] = [];
    const marks: Array<{ t: number; kind: string; label: string }> = [];
    document.body.addEventListener('slosh-regime', (ev) => regimes.push((ev as CustomEvent).detail.regime));
    document.body.addEventListener('slosh-marker', (ev) => marks.push((ev as CustomEvent).detail));
    const btn = (r: string): HTMLButtonElement => e.shadowRoot!.querySelector(`button[data-regime=${r}]`)!;

    frames(10); // autoplay = Replay the paper (gain shift is scheduled at 8 s)
    expect(e.debugState().simTime).toBeGreaterThan(0.9);
    btn('gainShift').click(); // cancels the scheduled steps; no reset
    frames(20);
    expect(e.debugState().simTime).toBeGreaterThan(2.5);
    expect(e.debugState().regime).toBe('gainShift');
    expect(btn('gainShift').getAttribute('aria-pressed')).toBe('true');
    expect(btn('nominal').getAttribute('aria-pressed')).toBe('false');
    expect(regimes).toContain('gainShift');
    expect(marks.some((m) => m.label.includes('Gain shift'))).toBe(true);
    // the story's own gain shift (8 s) / engage (22 s) were cancelled: still monitor after 25 s
    frames(250);
    expect(e.debugState().regime).toBe('gainShift');
    e.setRegime('engaged');
    frames(2);
    expect(e.debugState().regime).toBe('engaged');
    expect(regimes).toContain('engaged');
    const tBefore = e.debugState().simTime;
    e.playStory(); // resets to the story's initial state
    frames(1);
    expect(e.debugState().simTime).toBeLessThan(tBefore);
    expect(e.debugState().regime).toBe('nominal');
    expect(e.debugState().preset).toBe('story');
    vi.unstubAllGlobals();
  }, 60000);

  it('a Gain shift tap on a quiet pendulum also applies the disturbance; on a swinging one it does not', () => {
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
    const marks: string[] = [];
    document.body.addEventListener('slosh-marker', (ev) => marks.push((ev as CustomEvent).detail.label));
    const tap = (e: SloshSim): void => e.shadowRoot!.querySelector<HTMLButtonElement>('button[data-regime=gainShift]')!.click();
    // a swinging pendulum (story start: θ = 0.2 rad): no disturbance
    const swinging = mount({ autoplay: '' });
    frames(5);
    tap(swinging);
    frames(5);
    expect(marks.filter((m) => m.startsWith('Gain shift'))).not.toHaveLength(0);
    expect(marks).not.toContain('Disturbance');
    swinging.remove();
    // a quiet pendulum (free preset: hanging at rest): the tap also applies the disturbance
    const quiet = mount({ preset: 'free', autoplay: '' });
    frames(5);
    tap(quiet);
    frames(5);
    expect(marks).toContain('Disturbance');
    expect(marks).not.toContain('Kick');
    vi.unstubAllGlobals();
  }, 60000);

  it('narration caption is announced in the accessible summary', () => {
    const e = mount();
    e.setRegime('gainShift');
    const d = e.debugState();
    expect(e.shadowRoot!.querySelector('.sc-summary')!.textContent).toContain(d.caption);
  });

  it('does not autoplay without the attribute, and play()/pause() toggle the run state', () => {
    const e = mount({ preset: 'fig12' });
    expect(e.debugState().paused).toBe(true);
    e.play();
    expect(e.debugState().paused).toBe(false);
    e.pause();
    expect(e.debugState().paused).toBe(true);
  });

  it('ignores autoplay under prefers-reduced-motion', () => {
    vi.stubGlobal('matchMedia', () => ({
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      matches: true,
    }));
    const e = mount({ autoplay: '' });
    expect(e.debugState().paused).toBe(true);
    expect(e.debugState().trailVisible).toBe(false);
    vi.unstubAllGlobals();
  });

  it('loads presets (including free) and resets without throwing', () => {
    const e = mount();
    for (const id of ['fig13', 'fig14', 'vb', 'free', 'fig12'] as const) e.loadPreset(id);
    expect(e.debugState().preset).toBe('fig12');
    e.reset();
    expect(() => e.loadPreset('nope' as never)).toThrow();
  });

  it('resolves the layout: compact when forced, column by default', () => {
    expect(mount().debugState().layout).toBe('column');
    el.remove();
    expect(mount({ layout: 'compact' }).debugState().layout).toBe('compact');
    const folds = el.shadowRoot!.querySelectorAll('details.sc-fold');
    expect(folds.length).toBe(3);
    expect([...folds].every((d) => !(d as HTMLDetailsElement).open)).toBe(true);
    el.setAttribute('layout', 'full');
    expect(el.debugState().layout).toBe('column');
    expect([...folds].every((d) => (d as HTMLDetailsElement).open)).toBe(true);
  });

  it('tears down on disconnect and can be reconnected', () => {
    const e = mount();
    e.remove();
    expect(e.shadowRoot!.innerHTML).toBe('');
    document.body.appendChild(e);
    expect(e.shadowRoot!.querySelectorAll('figure[data-chart]').length).toBe(6);
  });

  describe('video-player controls inside the 3D view', () => {
    const view = (e: SloshSim): HTMLElement => e.shadowRoot!.querySelector('.view') as HTMLElement;
    const overlay = (e: SloshSim): HTMLElement => e.shadowRoot!.querySelector('.sc-play-overlay') as HTMLElement;
    const tapScene = (e: SloshSim, moveX = 0): void => {
      const scene = e.shadowRoot!.querySelector('.scene') as HTMLElement;
      const ev = (type: string, x: number): void => {
        const m = new MouseEvent(type, { clientX: x, clientY: 5, bubbles: true, button: 0 });
        Object.assign(m, { pointerId: 1, pointerType: 'touch' });
        scene.dispatchEvent(m);
      };
      ev('pointerdown', 5);
      ev('pointerup', 5 + moveX);
    };

    it('the regime buttons, Replay the paper, Restart, play/pause, speed and full screen are descendants of the view frame', () => {
      const e = mount();
      const v = view(e);
      const label = (l: string): HTMLElement | null =>
        [...e.shadowRoot!.querySelectorAll('button')].find((b) => b.getAttribute('aria-label')?.startsWith(l)) ?? null;
      for (const l of ['Nominal', 'Gain shift', 'AAC engaged', 'Replay the paper', 'Restart', 'Play', 'Speed', 'Full screen']) {
        const b = label(l);
        expect(b, l).not.toBeNull();
        expect(v.contains(b), l).toBe(true);
      }
      // the player bar sits above the info banner, both in the view
      const dock = v.querySelector('.sc-dock')!;
      expect([...dock.children].map((c) => c.className.split(' ')[0])).toEqual(['sc-player', 'sc-info']);
      // charts and Fine-tune stay below the view
      expect(v.contains(e.shadowRoot!.querySelector('.charts'))).toBe(false);
      expect(v.contains(e.shadowRoot!.querySelector('details.sc-exp'))).toBe(false);
    });

    it('mounts paused with the overlay shown; tapping the overlay resumes and hides it', () => {
      const e = mount();
      expect(overlay(e).hidden).toBe(false);
      (overlay(e).querySelector('button') as HTMLButtonElement).click();
      expect(e.debugState().paused).toBe(false);
      expect(overlay(e).hidden).toBe(true);
    });

    it('a tap on the view toggles play/pause and shows/hides the overlay; a drag does not', () => {
      const e = mount();
      tapScene(e);
      expect(e.debugState().paused).toBe(false);
      expect(overlay(e).hidden).toBe(true);
      tapScene(e, 30); // drag
      expect(e.debugState().paused).toBe(false);
      tapScene(e);
      expect(e.debugState().paused).toBe(true);
      expect(overlay(e).hidden).toBe(false);
    });

    it('play() and pause() on the element drive the overlay', () => {
      const e = mount();
      e.play();
      expect(overlay(e).hidden).toBe(true);
      e.pause();
      expect(overlay(e).hidden).toBe(false);
    });

    it('under reduced motion it mounts paused with the overlay shown, even with autoplay', () => {
      vi.stubGlobal('matchMedia', () => ({
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        matches: true,
      }));
      const e = mount({ autoplay: '' });
      expect(e.debugState().paused).toBe(true);
      expect(overlay(e).hidden).toBe(false);
      vi.unstubAllGlobals();
    });

    it('off-screen auto-pause does not show the overlay, and scrolling back resumes', () => {
      let cb: ((entries: Array<{ isIntersecting: boolean }>) => void) | null = null;
      vi.stubGlobal(
        'IntersectionObserver',
        class {
          constructor(c: typeof cb) {
            cb = c;
          }
          observe(): void {}
          disconnect(): void {}
        },
      );
      const e = mount({ autoplay: '' });
      expect(overlay(e).hidden).toBe(true);
      cb!([{ isIntersecting: false }]);
      expect(e.debugState().paused).toBe(true); // paused by the observer...
      expect(overlay(e).hidden).toBe(true); // ...but not shown as a user pause
      expect(e.shadowRoot!.querySelector('.sc-player button')!.getAttribute('aria-label')).toBe('Pause');
      cb!([{ isIntersecting: true }]);
      expect(e.debugState().paused).toBe(false);
      expect(overlay(e).hidden).toBe(true);
      vi.unstubAllGlobals();
    });
  });
});
