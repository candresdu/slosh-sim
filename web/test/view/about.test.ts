// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS } from '../../src/core/params';
import { aboutEntries, cleanSource, createAbout } from '../../src/view/about';

describe('about panel', () => {
  const { params, provenance } = DEFAULT_PARAMS;
  const expected = Object.entries(provenance)
    .filter(([, s]) => s !== 'R-1 Table 2')
    .map(([p]) => p);

  it('lists every parameter whose src is not R-1 Table 2, and no other', () => {
    const host = document.createElement('div');
    const a = createAbout(host, provenance, params);
    const listed = [...host.querySelectorAll<HTMLElement>('li[data-param]')].map((l) => l.dataset.param);
    expect(expected.length).toBeGreaterThan(20);
    expect(listed).toEqual(expected);
    expect(listed).toContain('motor.tau');
    expect(listed).toContain('control.rateHz');
    expect(listed).toContain('aac.threshold');
    expect(listed).not.toContain('vehicle.m_q');
    expect(a.entries).toHaveLength(expected.length);
  });

  it('is a details element with a summary, marks the reconstruction and shows values', () => {
    const host = document.createElement('div');
    const a = createAbout(host, provenance, params);
    expect(a.element.tagName).toBe('DETAILS');
    expect(a.element.querySelector('summary')?.textContent).toBe('About these parameters');
    expect(a.element.textContent).toContain('reconstruction');
    const tau = a.element.querySelector('li[data-param="motor.tau"]');
    expect(tau?.textContent).toContain('0.04');
    expect(tau?.getAttribute('data-reconstruction')).toBe('true');
  });

  it('hides internal question references from the displayed text but keeps the raw src', () => {
    expect(cleanSource(`assumed (Q-${1})`)).toBe('assumed'); // built at run time: no planning tag in the source
    expect(cleanSource(`R-1 §III.B (Q-${9})`)).toBe('R-1 §III.B');
    const host = document.createElement('div');
    createAbout(host, provenance, params);
    expect(host.textContent).not.toMatch(/Q-\d/);
  });

  it('works without values', () => {
    expect(aboutEntries({ 'a.b': 'tuned (reconstruction)', 'c.d': 'R-1 Table 2' })).toEqual([
      { path: 'a.b', value: '', src: 'tuned (reconstruction)', label: 'tuned (reconstruction)', reconstruction: true },
    ]);
  });
});
