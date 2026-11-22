// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SimCommand, Telemetry } from '../../src/core/sim';
import { createControls, type ControlsHandle, type ControlsHost } from '../../src/view/controls';
import { LIGHT_PALETTE } from '../../src/view/theme';

let box: HTMLElement;
let sent: SimCommand[];
let host: ControlsHost;
let c: ControlsHandle;

function tel(p: Partial<Telemetry> = {}): Telemetry {
  return {
    t: 0.01,
    theta: 0.2,
    phi: 0,
    massRel: [0, 0, 1],
    quadPos: [0, 0, 0],
    roll: 0,
    pitch: 0,
    yaw: 0,
    kT: [1, 1],
    kTApplied: [1, 1],
    ySD: [0, 0],
    detect: [false, false],
    gainShift: 1,
    aacMode: 'off',
    motorCmd: [0, 0, 0, 0],
    motorOmega: [0, 0, 0, 0],
    ...p,
  };
}
const q = <T extends Element>(sel: string): T => {
  const e = box.querySelector<T>(sel);
  if (e === null) throw new Error(`missing ${sel}`);
  return e;
};
const slider = (): HTMLInputElement => q<HTMLInputElement>('input[type=range]');
const radio = (m: string): HTMLInputElement => q<HTMLInputElement>(`input[type=radio][value=${m}]`);
const btn = (text: string): HTMLButtonElement => {
  const b = [...box.querySelectorAll('button')].find((x) => x.textContent?.startsWith(text));
  if (b === undefined) throw new Error(`no button ${text}`);
  return b;
};

beforeEach(() => {
  box = document.createElement('div');
  document.body.appendChild(box);
  sent = [];
  vi.clearAllMocks();
  host = { send: (cmd) => void sent.push(...(Array.isArray(cmd) ? (cmd as SimCommand[]) : [cmd as SimCommand])) };
  c = createControls(box, { host });
});
afterEach(() => box.remove());

describe('gain shift slider', () => {
  it('is a range 0.5-3.0 step 0.05 with an output and a label', () => {
    const s = slider();
    expect([s.min, s.max, s.step]).toEqual(['0.5', '3', '0.05']);
    expect(s.getAttribute('aria-label')).toBe('Gain shift');
    expect(box.querySelector('output')?.textContent).toBe('1.00');
  });

  it('dispatches exactly one setGainShift with the slider value', () => {
    const s = slider();
    s.value = '2.3';
    s.dispatchEvent(new Event('input', { bubbles: true }));
    expect(sent).toEqual([{ type: 'setGainShift', value: 2.3 }]);
    expect(box.querySelector('output')?.textContent).toBe('2.30');
  });

  it('does not snap back to a stale telemetry sample, then follows the sim', () => {
    const s = slider();
    s.value = '2.3';
    s.dispatchEvent(new Event('input'));
    c.sync(tel({ t: 0.02, gainShift: 1 }));
    expect(s.value).toBe('2.3');
    c.sync(tel({ t: 0.03, gainShift: 2.3 }));
    c.sync(tel({ t: 0.04, gainShift: 2.5 }));
    expect(s.value).toBe('2.5');
  });
});

describe('AAC mode', () => {
  it('is a radio group in a fieldset with a legend', () => {
    const fs = q<HTMLFieldSetElement>('fieldset');
    expect(fs.querySelector('legend')?.textContent).toBe('AAC mode');
    expect([...fs.querySelectorAll('input[type=radio]')].map((r) => (r as HTMLInputElement).value)).toEqual([
      'off',
      'monitor',
      'engaged',
    ]);
    expect(radio('off').checked).toBe(true);
  });

  it('dispatches setAacMode on change', () => {
    radio('engaged').click();
    expect(sent).toEqual([{ type: 'setAacMode', mode: 'engaged' }]);
  });
});

describe('accessibility and theme', () => {
  it('every interactive element has an accessible name', () => {
    const els = box.querySelectorAll<HTMLElement>('button, input, select, textarea');
    expect(els.length).toBe(1 + 3 + 5); // slider, 3 radios, 3 regime + Replay + Restart
    for (const e of els) {
      const aria = e.getAttribute('aria-label');
      const id = e.getAttribute('id');
      const label = (id !== null && box.querySelector(`label[for="${id}"]`)?.textContent) || e.closest('label')?.textContent;
      const name = (aria ?? label ?? '').trim();
      expect(name, e.outerHTML).not.toBe('');
    }
  });

  it('radio names are unique per instance', () => {
    const box2 = document.createElement('div');
    document.body.appendChild(box2);
    createControls(box2, { host });
    const n1 = radio('off').name;
    const n2 = box2.querySelector<HTMLInputElement>('input[type=radio]')?.name;
    expect(n2).not.toBe(n1);
    box2.remove();
  });

  it('colours come from custom properties (no literal colours in element styles)', () => {
    c.setPalette(LIGHT_PALETTE.css);
    expect(c.element.style.getPropertyValue('--sc-accent')).toBe(LIGHT_PALETTE.css.accent);
    expect(c.element.style.getPropertyValue('--sc-focus')).toBe(LIGHT_PALETTE.css.focus);
  });
});

describe('story mode group', () => {
  it('is the regime bar, with three aria-pressed regime buttons that cite their figure, Replay the paper and Restart', () => {
    expect(box.querySelector('.sc-controls')!.firstElementChild!.getAttribute('aria-label')).toBe('Regime');
    const regimes = [...box.querySelectorAll<HTMLButtonElement>('button[data-regime]')];
    expect(regimes.map((b) => b.textContent)).toEqual(['Nominal \u00b7 Fig 12', 'Gain shift \u00b7 Fig 13', 'AAC engaged \u00b7 Fig 14']);
    expect(regimes.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Nominal \u00b7 Fig 12',
      'Gain shift \u00b7 Fig 13',
      'AAC engaged \u00b7 Fig 14',
    ]);
    for (const b of regimes) expect(b.hasAttribute('aria-pressed')).toBe(true);
    expect(btn('Replay the paper')).toBeTruthy();
    expect(btn('Restart')).toBeTruthy();
  });

  it('has no figure, Kick or Reset buttons of its own, and no Play the story button', () => {
    const names = [...box.querySelectorAll('button')].map((b) => `${b.textContent} | ${b.getAttribute('aria-label')}`);
    expect(names.filter((n) => /Kick|Reset|Play the story|V\.B|Replay a paper figure/.test(n))).toEqual([]);
    // every button that mentions a figure is one of the three regime buttons
    const figs = [...box.querySelectorAll('button')].filter((b) => /Fig \d|§/.test(`${b.textContent}${b.getAttribute('aria-label')}`));
    expect(figs.map((b) => b.dataset.regime)).toEqual(['nominal', 'gainShift', 'engaged']);
    expect(box.querySelector('[data-preset]')).toBeNull();
    expect(box.textContent).not.toContain('Replay a paper figure');
  });

  it('sends the story command lists, and the regime buttons never reset', () => {
    btn('Gain shift').click();
    expect(sent.map((c) => c.type)).toEqual(['clearSchedule', 'rampGainShift', 'setAacMode']);
    sent.length = 0;
    btn('Nominal').click();
    btn('AAC engaged').click();
    expect(sent.map((c) => c.type)).toEqual(['clearSchedule', 'rampGainShift', 'setAacMode', 'clearSchedule', 'setAacMode']);
    sent.length = 0;
    btn('Replay the paper').click();
    expect(sent).toEqual([{ type: 'loadPreset', id: 'story' }]);
    sent.length = 0;
    btn('Restart').click();
    expect(sent).toEqual([{ type: 'loadPreset', id: 'story' }, { type: 'clearSchedule' }]);
  });

  it('Gain shift with a θ envelope below 0.05 rad also sends the kick; at or above it sends none', () => {
    let env = 0.049;
    const box2 = document.createElement('div');
    document.body.appendChild(box2);
    const out: SimCommand[] = [];
    createControls(box2, {
      host: { send: (cmd) => void out.push(...(Array.isArray(cmd) ? (cmd as SimCommand[]) : [cmd as SimCommand])) },
      thetaEnvelope: () => env,
    });
    const gs = (): HTMLButtonElement => box2.querySelector<HTMLButtonElement>('button[data-regime=gainShift]')!;
    gs().click();
    expect(out.map((x) => x.type)).toEqual(['clearSchedule', 'rampGainShift', 'setAacMode', 'kick']);
    expect(out[3]).toEqual({ type: 'kick', theta: 0.2, phiDot: 0.6 });
    out.length = 0;
    env = 0.05;
    gs().click();
    expect(out.map((x) => x.type)).toEqual(['clearSchedule', 'rampGainShift', 'setAacMode']);
    out.length = 0;
    box2.querySelector<HTMLButtonElement>('button[data-regime=nominal]')!.click(); // no kick for other regimes
    env = 0;
    box2.querySelector<HTMLButtonElement>('button[data-regime=engaged]')!.click();
    expect(out.map((x) => x.type)).not.toContain('kick');
    box2.remove();
  });

  it('the pressed regime follows the telemetry and the caption is shown', () => {
    const pressed = (): string[] =>
      [...box.querySelectorAll<HTMLButtonElement>('button[data-regime]')]
        .filter((b) => b.getAttribute('aria-pressed') === 'true')
        .map((b) => b.dataset.regime as string);
    c.sync(tel({ t: 0.02 }));
    expect(pressed()).toEqual(['nominal']);
    c.sync(tel({ t: 0.03, gainShift: 2.3, aacMode: 'monitor' }));
    expect(pressed()).toEqual(['gainShift']);
    c.sync(tel({ t: 0.04, gainShift: 2.3, aacMode: 'engaged' }));
    expect(pressed()).toEqual(['engaged']);
  });

  it('Fine-tune (advanced) is a <details> closed by default that holds the slider and the AAC radios', () => {
    const d = q<HTMLDetailsElement>('details.sc-exp');
    expect(d.open).toBe(false);
    expect(q('details.sc-exp > summary').textContent).toBe('Fine-tune (advanced)');
    expect(d.contains(slider())).toBe(true);
    for (const m of ['off', 'monitor', 'engaged']) expect(d.contains(radio(m))).toBe(true);
    // the regime bar stays outside it
    expect(d.contains(btn('Restart'))).toBe(false);
  });
});

describe('regime bar placement', () => {
  it('goes into regimeContainer when given, with the figure visible in each regime label', () => {
    const view = document.createElement('div');
    document.body.appendChild(view);
    const box2 = document.createElement('div');
    document.body.appendChild(box2);
    const c2 = createControls(box2, { host, regimeContainer: view });
    expect(view.contains(c2.regimeBar)).toBe(true);
    expect(box2.contains(c2.regimeBar)).toBe(false);
    expect(box2.querySelector('button[data-regime]')).toBeNull();
    const labels = [...view.querySelectorAll('button[data-regime]')].map((b) => b.textContent);
    expect(labels).toEqual(['Nominal · Fig 12', 'Gain shift · Fig 13', 'AAC engaged · Fig 14']);
    for (const b of view.querySelectorAll('button[data-regime]')) expect(b.querySelector('.sc-fig')).not.toBeNull();
    c2.dispose();
    expect(view.querySelector('button')).toBeNull();
    view.remove();
    box2.remove();
  });
});
