// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { BANNER_TEXTS, createBanner, type BannerHandle } from '../../src/view/banner';

let host: HTMLElement;
let b: BannerHandle;
const q = (sel: string): HTMLElement => b.element.querySelector(sel) as HTMLElement;

afterEach(() => {
  b?.dispose();
  host?.remove();
});
const make = (): void => {
  host = document.createElement('div');
  document.body.appendChild(host);
  b = createBanner(host);
};

describe('banner', () => {
  it('is a hidden role=status element inside the view, with title, body and caption lines and a close button', () => {
    make();
    expect(b.element.getAttribute('role')).toBe('status');
    expect(host.contains(b.element)).toBe(true);
    expect(b.isVisible()).toBe(false);
    expect(b.element.querySelector('button')!.getAttribute('aria-label')).toBe('Dismiss the info banner');
  });

  it.each([
    ['nominal', 'Fig 12'],
    ['gainShift', 'Fig 13'],
    ['engaged', 'Fig 14'],
    ['replay', 'Figs 12–14'],
  ] as const)('shows the %s phase with its figure reference', (phase, fig) => {
    make();
    b.showPhase(phase);
    expect(b.isVisible()).toBe(true);
    expect(q('.sc-info-title').textContent).toContain(fig);
    expect(q('.sc-info-body').textContent).toBe(BANNER_TEXTS[phase].body);
  });

  it('cites the §V.B flight test for Replay the paper', () => {
    make();
    b.showPhase('replay');
    expect(q('.sc-info-title').textContent).toContain('§V.B');
  });

  it('the Gain shift text says plainly that the gains are raised on purpose to drive the slosh unstable', () => {
    make();
    b.showPhase('gainShift');
    const t = q('.sc-info-body').textContent!;
    expect(t).toMatch(/on purpose/);
    expect(t).toMatch(/×2\.3/);
    expect(t).toMatch(/outer-loop gains/);
    expect(t).toMatch(/unstable/);
    expect(t).toMatch(/slosh grows/);
    expect(t).toMatch(/only monitoring/);
  });

  it('shows the narration caption on the third line', () => {
    make();
    b.showPhase('engaged');
    b.setCaption('K_T lowered, oscillation decays.');
    expect(q('.sc-info-caption').textContent).toBe('K_T lowered, oscillation decays.');
  });

  it('after a trip the third line is the trip message with axis and time; a new phase clears it', () => {
    make();
    b.showPhase('gainShift');
    b.setCaption('the detector is watching');
    b.showTrip(0, 12.34);
    expect(q('.sc-info-caption').textContent).toBe('Slosh anomaly detected on the pitch axis at t = 12.3 s');
    b.showTrip(1, 14);
    expect(q('.sc-info-caption').textContent).toContain('roll axis at t = 14.0 s');
    b.showTrip(0, 20); // only the first trip per axis counts
    expect(q('.sc-info-caption').textContent).toContain('pitch axis at t = 12.3 s');
    b.setCaption('still growing');
    expect(q('.sc-info-caption').textContent).toContain('Slosh anomaly detected');
    b.showPhase('engaged');
    b.setCaption('K_T lowered');
    expect(q('.sc-info-caption').textContent).toBe('K_T lowered');
  });

  it('a trip shows the banner even when no phase was tapped, but not after a dismissal', () => {
    make();
    b.showTrip(1, 5);
    expect(b.isVisible()).toBe(true);
    expect(q('.sc-info-caption').textContent).toContain('roll axis at t = 5.0 s');
    b.dismiss();
    b.showTrip(0, 6);
    expect(b.isVisible()).toBe(false);
  });

  it('× hides it and the next phase change shows it again', () => {
    make();
    b.showPhase('nominal');
    q('.sc-info-close').click();
    expect(b.isVisible()).toBe(false);
    b.showPhase('gainShift');
    expect(b.isVisible()).toBe(true);
    expect(q('.sc-info-title').textContent).toContain('Fig 13');
  });

  it('reset hides it and forgets the trips', () => {
    make();
    b.showPhase('gainShift');
    b.showTrip(0, 3);
    b.reset();
    expect(b.isVisible()).toBe(false);
    expect(b.phase()).toBeNull();
    b.showPhase('nominal');
    b.setCaption('');
    expect(q('.sc-info-caption').textContent).toBe('');
  });
});
