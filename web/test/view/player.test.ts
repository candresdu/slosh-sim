// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TAP_MAX_MOVE_PX, TAP_MAX_MS, TapDetector, createPlayer, type PlayerHandle } from '../../src/view/player';

describe('TapDetector', () => {
  it('a short, still press is a tap', () => {
    const d = new TapDetector();
    d.down(1, 100, 100, 0);
    expect(d.up(1, 102, 101, 120)).toBe(true);
  });
  it('moving 8 px or more is a drag, even if the pointer comes back', () => {
    const d = new TapDetector();
    d.down(1, 100, 100, 0);
    d.move(1, 100 + TAP_MAX_MOVE_PX, 100);
    expect(d.up(1, 100, 100, 100)).toBe(false);
  });
  it('a press of 300 ms or more is not a tap', () => {
    const d = new TapDetector();
    d.down(1, 0, 0, 0);
    expect(d.up(1, 0, 0, TAP_MAX_MS)).toBe(false);
  });
  it('a second pointer cancels the gesture', () => {
    const d = new TapDetector();
    d.down(1, 0, 0, 0);
    d.down(2, 50, 50, 10);
    expect(d.up(1, 0, 0, 20)).toBe(false);
    expect(d.up(2, 50, 50, 30)).toBe(false);
  });
  it('an up without a down is not a tap', () => {
    expect(new TapDetector().up(1, 0, 0, 0)).toBe(false);
  });
});

let view: HTMLElement;
let surface: HTMLElement;
let dock: HTMLElement;
let p: PlayerHandle;
let t = 0;
const pause = vi.fn<() => void>();
const resume = vi.fn<() => void>();
const setSpeed = vi.fn<(s: 1 | 0.5) => void>();
const onFs = vi.fn<() => void>();

const ptr = (type: string, x: number, y: number, target: Element = surface, extra: Record<string, unknown> = {}): void => {
  const e = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, button: 0 });
  Object.assign(e, { pointerId: 1, pointerType: 'touch', ...extra });
  target.dispatchEvent(e);
};
const tapAt = (x = 10, y = 10, target: Element = surface): void => {
  ptr('pointerdown', x, y, target);
  t += 100;
  ptr('pointerup', x, y, target);
};
const btn = (label: string): HTMLButtonElement => {
  const b = [...view.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === label);
  if (b === undefined) throw new Error(`no button ${label}`);
  return b;
};

beforeEach(() => {
  vi.clearAllMocks();
  t = 0;
  view = document.createElement('div');
  surface = document.createElement('div');
  surface.tabIndex = 0;
  dock = document.createElement('div');
  view.append(surface, dock);
  document.body.appendChild(view);
  p = createPlayer({ host: { pause, resume, setSpeed }, view, dock, surface, onFullscreenToggle: onFs, now: () => t });
});
afterEach(() => view.remove());

describe('player overlay and play/pause', () => {
  it('starts paused with the overlay shown, the overlay is a Play button, and the bar button says Play', () => {
    expect(p.isPaused()).toBe(true);
    expect(p.scrim.hidden).toBe(false);
    expect(p.overlay.tagName).toBe('BUTTON');
    expect(p.overlay.getAttribute('aria-label')).toBe('Play');
    expect(p.bar.querySelector('button')!.getAttribute('aria-pressed')).toBe('true');
  });

  it('tapping the overlay resumes and hides it; the bar button toggles Pause/Play with aria-pressed', () => {
    p.overlay.click();
    expect(resume).toHaveBeenCalledTimes(1);
    expect(p.scrim.hidden).toBe(true);
    const b = p.bar.querySelector('button')!;
    expect(b.getAttribute('aria-label')).toBe('Pause');
    expect(b.getAttribute('aria-pressed')).toBe('false');
    b.click();
    expect(pause).toHaveBeenCalledTimes(1);
    expect(p.scrim.hidden).toBe(false);
    expect(b.getAttribute('aria-label')).toBe('Play');
    expect(b.getAttribute('aria-pressed')).toBe('true');
  });

  it('tapping the view toggles: pause shows the overlay, a second tap resumes and hides it', () => {
    p.setPaused(false);
    tapAt();
    expect(pause).toHaveBeenCalledTimes(1);
    expect(p.scrim.hidden).toBe(false);
    tapAt();
    expect(resume).toHaveBeenCalledTimes(1);
    expect(p.scrim.hidden).toBe(true);
  });

  it('a drag of more than 8 px on the view does not change the paused state', () => {
    ptr('pointerdown', 10, 10);
    ptr('pointermove', 40, 10);
    t += 100;
    ptr('pointerup', 40, 10);
    expect(p.isPaused()).toBe(true);
    expect(resume).not.toHaveBeenCalled();
    p.setPaused(false);
    ptr('pointerdown', 10, 10);
    ptr('pointermove', 10, 30);
    ptr('pointerup', 10, 30);
    expect(p.isPaused()).toBe(false);
    expect(pause).not.toHaveBeenCalled();
  });

  it('a long press (300 ms or more) does not toggle', () => {
    ptr('pointerdown', 10, 10);
    t += 400;
    ptr('pointerup', 10, 10);
    expect(p.isPaused()).toBe(true);
  });

  it('a tap on a button inside the view does not also toggle', () => {
    const inner = document.createElement('button');
    surface.appendChild(inner);
    tapAt(10, 10, inner);
    expect(p.isPaused()).toBe(true);
    expect(resume).not.toHaveBeenCalled();
  });

  it('Space and K toggle when the view itself has focus; other targets and keys do not', () => {
    const key = (k: string, target: Element = surface): void => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    };
    key(' ');
    expect(p.isPaused()).toBe(false);
    key('k');
    expect(p.isPaused()).toBe(true);
    key('x');
    expect(p.isPaused()).toBe(true);
    const inner = document.createElement('button');
    surface.appendChild(inner);
    key(' ', inner);
    expect(p.isPaused()).toBe(true);
  });

  it('setPaused does not call the host (the owner already knows)', () => {
    p.setPaused(false);
    p.setPaused(true);
    expect(pause).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });
});

describe('player bar', () => {
  it('Speed toggles between 1× and 0.5×', () => {
    const b = [...p.bar.querySelectorAll('button')].find((x) => x.textContent?.startsWith('Speed'))!;
    b.click();
    expect(setSpeed).toHaveBeenLastCalledWith(0.5);
    expect(b.textContent).toBe('Speed 0.5×');
    expect(b.getAttribute('aria-pressed')).toBe('true');
    b.click();
    expect(setSpeed).toHaveBeenLastCalledWith(1);
    expect(b.textContent).toBe('Speed 1×');
    p.setSpeed(0.5);
    expect(b.textContent).toBe('Speed 0.5×');
  });

  it('Full screen calls onFullscreenToggle and reflects the active state; it can be hidden', () => {
    const b = btn('Full screen');
    b.click();
    expect(onFs).toHaveBeenCalledTimes(1);
    p.setFullscreenActive(true);
    expect(b.getAttribute('aria-pressed')).toBe('true');
    expect(b.textContent).toBe('Exit full screen');
    p.setFullscreenActive(false);
    expect(b.textContent).toBe('Full screen');
    p.setFullscreenVisible(false);
    expect(b.hidden).toBe(true);
  });

  it('the bar goes into the dock and dispose removes everything', () => {
    expect(dock.contains(p.bar)).toBe(true);
    expect(surface.contains(p.scrim)).toBe(true);
    p.dispose();
    expect(p.bar.isConnected).toBe(false);
    expect(p.scrim.isConnected).toBe(false);
    tapAt();
    expect(resume).not.toHaveBeenCalled();
  });
});
