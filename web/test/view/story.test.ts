// @vitest-environment jsdom
// Story mode: command lists, regime switching on a running Sim (via the Runner), narration.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadParams } from '../../src/core/params';
import { PRESETS } from '../../src/core/presets';
import { Sim, type SimCommand, type Telemetry } from '../../src/core/sim';
import { Runner, TelemetryRing } from '../../src/runtime';
import { createSummary } from '../../src/view/summary';
import {
  STORY_GAIN_SHIFT,
  STORY_RAMP_S,
  StoryNarrator,
  narrate,
  playStoryCommands,
  regimeCommands,
  restartStoryCommands,
  ringThetaEnvelope,
  storyCommands,
  type NarrationInput,
} from '../../src/view/story';
import { makeTel } from '../runtime/helpers';

const ROOT = resolve(__dirname, '../../..');
const { params } = loadParams(JSON.parse(readFileSync(resolve(ROOT, 'shared/params/default.json'), 'utf8')));
const golden = JSON.parse(readFileSync(resolve(ROOT, 'golden/story.json'), 'utf8')) as {
  columns: Record<string, number[]>;
};
const col = (k: string): number[] => golden.columns[k] as number[];

class Rig {
  readonly sim = new Sim(params, params.sim.seed);
  readonly ring = new TelemetryRing();
  readonly runner = new Runner(
    { stepControl: () => this.sim.stepControl(), enqueue: (c) => this.sim.enqueue(c), commandLog: () => this.sim.commandLog() },
    this.ring,
  );
  last!: Telemetry;
  tick(n = 1): Telemetry {
    for (let i = 0; i < n; i++) {
      this.last = this.sim.stepControl();
      this.runner.ingest(this.last);
    }
    return this.last;
  }
}

const types = (cmds: readonly SimCommand[]): string[] => cmds.map((c) => c.type);

describe('command lists', () => {
  it('Nominal, Gain shift and AAC engaged send exactly the specified commands', () => {
    expect(regimeCommands('nominal')).toEqual([
      { type: 'clearSchedule' },
      { type: 'rampGainShift', to: 1, durationS: 1.5 },
      { type: 'setAacMode', mode: 'off' },
    ]);
    expect(regimeCommands('gainShift')).toEqual([
      { type: 'clearSchedule' },
      { type: 'rampGainShift', to: 2.3, durationS: 1.5 },
      { type: 'setAacMode', mode: 'monitor' },
    ]);
    expect(regimeCommands('engaged')).toEqual([{ type: 'clearSchedule' }, { type: 'setAacMode', mode: 'engaged' }]);
  });

  it('a Gain shift tap adds the standard kick only when the θ envelope is below 0.05 rad', () => {
    const kick = { type: 'kick', theta: 0.2, phiDot: 0.6 };
    expect(regimeCommands('gainShift', 0.049)).toEqual([...regimeCommands('gainShift'), kick]);
    expect(regimeCommands('gainShift', 0.05)).toEqual(regimeCommands('gainShift'));
    expect(regimeCommands('gainShift', 0.3)).not.toContainEqual(kick);
    // the kick is in the same list, and no other regime ever kicks
    expect(storyCommands({ kind: 'regime', regime: 'gainShift' }, 0)).toContainEqual(kick);
    expect(types(regimeCommands('nominal', 0))).not.toContain('kick');
    expect(types(regimeCommands('engaged', 0))).not.toContain('kick');
  });

  it('a quiet Gain shift tap yields a Disturbance marker in the ring', () => {
    const rig = new Rig();
    rig.runner.send({ type: 'loadPreset', id: 'fig12' });
    rig.runner.send({ type: 'clearSchedule' });
    rig.runner.send({ type: 'kick', theta: 0.01, phiDot: 0 }); // a quiet pendulum
    rig.tick(600);
    const env = ringThetaEnvelope(rig.ring);
    expect(env).toBeLessThan(0.05);
    rig.runner.send(regimeCommands('gainShift', env));
    rig.tick(5);
    const labels = rig.ring.markers().map((m) => m.label);
    expect(labels).toContain('Disturbance');
    expect(labels).not.toContain('Kick');
  });

  it('the regime buttons never send reset or loadPreset', () => {
    for (const r of ['nominal', 'gainShift', 'engaged'] as const) {
      const t = types(regimeCommands(r));
      expect(t).not.toContain('reset');
      expect(t).not.toContain('loadPreset');
      expect(t[0]).toBe('clearSchedule');
    }
  });

  it('Replay the paper sends loadPreset story; Restart sends loadPreset story then clearSchedule', () => {
    expect(playStoryCommands()).toEqual([{ type: 'loadPreset', id: 'story' }]);
    expect(restartStoryCommands()).toEqual([{ type: 'loadPreset', id: 'story' }, { type: 'clearSchedule' }]);
    expect(storyCommands({ kind: 'play' })).toEqual(playStoryCommands());
    expect(storyCommands({ kind: 'restart' })).toEqual(restartStoryCommands());
    expect(storyCommands({ kind: 'regime', regime: 'engaged' })).toEqual(regimeCommands('engaged'));
  });

  it('the 1.5 s ramp and the 2.3 gain shift are the story preset values', () => {
    const ramp = PRESETS.story.events.find((e) => e.type === 'rampGainShift');
    expect(ramp?.durationS).toBe(STORY_RAMP_S);
    expect(ramp?.to).toBe(STORY_GAIN_SHIFT);
    expect(STORY_RAMP_S).toBeGreaterThanOrEqual(1);
    expect(STORY_RAMP_S).toBeLessThanOrEqual(2);
  });

  it('Runner.send applies a list in order at one tick boundary', () => {
    const rig = new Rig();
    rig.runner.send(restartStoryCommands());
    rig.tick();
    const log = rig.sim.commandLog();
    expect(log.map((e) => e[1].type)).toEqual(['loadPreset', 'clearSchedule']);
    expect(log[0]![0]).toBe(log[1]![0]);
  });
});

describe('story on a running Sim', () => {
  it('Replay the paper matches golden/story.json from t = 0 after any history', () => {
    const rig = new Rig();
    rig.runner.send({ type: 'loadPreset', id: 'fig14' });
    rig.tick(437);
    rig.runner.send({ type: 'kick' });
    rig.tick(61);
    rig.runner.send(playStoryCommands());
    let worst = 0;
    for (let k = 1; k <= 1500; k++) {
      const t = rig.tick();
      expect(t.t).toBeCloseTo(k * 0.01, 9);
      worst = Math.max(
        worst,
        Math.abs(t.theta - col('theta')[k]!),
        Math.abs(t.roll - col('roll')[k]!),
        Math.abs(t.pitch - col('pitch')[k]!),
        Math.abs(t.kT[0] - col('kT_pitch')[k]!),
        Math.abs(t.ySD[0] - col('ySD_pitch')[k]!),
        Math.abs(t.motorCmd[0] - col('m1')[k]!),
      );
    }
    expect(worst).toBeLessThan(1e-9);
  });

  it('Restart leaves nothing scheduled: the story events never fire', () => {
    const rig = new Rig();
    rig.runner.send(playStoryCommands());
    rig.tick(300);
    rig.runner.send(restartStoryCommands());
    let t = rig.tick();
    expect(t.t).toBeCloseTo(0.01, 9);
    expect(t.theta).toBeCloseTo(col('theta')[1]!, 9); // the story's initial state
    t = rig.tick(2600); // beyond the shift (8 s) and the engage (22 s)
    expect(t.gainShift).toBe(1);
    expect(t.aacMode).toBe('off');
    expect(rig.sim.commandLog().filter((e) => e[1].type === 'setAacMode')).toHaveLength(0);
  });

  it('a Gain shift tap during Replay the paper cancels the remaining events without resetting', () => {
    const play = new Rig();
    play.runner.send(playStoryCommands());
    const tap = new Rig();
    tap.runner.send(playStoryCommands());
    play.tick(300);
    tap.tick(300);
    tap.runner.send(regimeCommands('gainShift'));
    // the next tick after the tap: state continuous (no jump back to the initial state)
    const before = tap.last.theta;
    const next = tap.tick();
    expect(Math.abs(next.theta - before)).toBeLessThan(0.05);
    expect(next.t).toBeCloseTo(3.01, 9);
    expect(next.aacMode).toBe('monitor');
    // the story's engage at 22 s must not fire; the gain shift ends exactly at 2.3
    const end = tap.tick(2100);
    expect(end.t).toBeGreaterThan(24);
    expect(end.aacMode).toBe('monitor');
    expect(end.gainShift).toBe(2.3);
    // the untouched story does engage
    expect(play.tick(2100).aacMode).toBe('engaged');
    const log = tap.sim.commandLog().map((e) => e[1].type);
    expect(log.filter((x) => x === 'loadPreset')).toHaveLength(1);
    expect(log).not.toContain('reset');
  });

  it('AAC engaged gives kTApplied = kT on the next tick (a step, no ramp)', () => {
    const rig = new Rig();
    rig.runner.send(playStoryCommands());
    const t = rig.tick(1500); // 15 s: gain shift tripped and K_T computed in Monitor
    expect(t.aacMode).toBe('monitor');
    expect(Math.min(t.kT[0], t.kT[1])).toBeLessThan(0.99);
    expect(t.kTApplied).toEqual([1, 1]);
    rig.runner.send(regimeCommands('engaged'));
    const n = rig.tick();
    expect(n.aacMode).toBe('engaged');
    expect(n.kTApplied[0]).toBe(n.kT[0]);
    expect(n.kTApplied[1]).toBe(n.kT[1]);
    expect(rig.sim.commandLog().some((e) => e[1].type === 'reset')).toBe(false);
  });

  it('the pressed regime follows the telemetry rule (ring bands)', () => {
    const rig = new Rig();
    rig.runner.send(playStoryCommands());
    rig.tick(900);
    const bands = rig.ring.bands();
    expect(bands.map((b) => b.regime)).toEqual(['nominal', 'gainShift']);
  });
});

const base: NarrationInput = {
  regime: 'nominal',
  tSinceEntry: 3,
  thetaEnv: 0.2,
  thetaTrend: 'decaying',
  kTApplied: 1,
  aacMode: 'off',
};

describe('narrate()', () => {
  it('nominal', () => {
    expect(narrate(base)).toBe('Nominal: the PD controller damps the slosh.');
  });
  it('gain shift, before a trip', () => {
    const s = narrate({ ...base, regime: 'gainShift', aacMode: 'monitor', thetaTrend: 'growing' });
    expect(s).toBe('The slosh oscillation is now growing; the detector is watching.');
  });
  it('gain shift, after a trip', () => {
    const s = narrate({ ...base, regime: 'gainShift', aacMode: 'monitor', thetaTrend: 'growing', tripSinceEntry: 2.2 });
    expect(s).toBe('Detector tripped 2.2 s after the shift. K_T is computed but not applied.');
  });
  it('engaged', () => {
    const s = narrate({ ...base, regime: 'engaged', aacMode: 'engaged', kTApplied: 0.4, thetaTrend: 'decaying' });
    expect(s).toBe('K_T lowered, oscillation decays.');
    expect(narrate({ ...base, regime: 'engaged', aacMode: 'engaged', kTApplied: 0.4, thetaTrend: 'growing' })).toContain(
      'K_T lowered to 0.40',
    );
    expect(narrate({ ...base, regime: 'engaged', aacMode: 'engaged', kTApplied: 1 })).toContain('AAC engaged');
  });
  it('never mentions Kick, whatever the θ envelope', () => {
    for (const regime of ['nominal', 'gainShift', 'engaged'] as const) {
      for (const thetaEnv of [0, 0.049, 0.05, 0.3]) {
        for (const aacMode of ['off', 'monitor', 'engaged'] as const) {
          for (const tripSinceEntry of [undefined, 2.2]) {
            for (const kTApplied of [0.4, 1]) {
              const s = narrate({ ...base, regime, thetaEnv, aacMode, tripSinceEntry, kTApplied });
              expect(s).not.toMatch(/kick/i);
            }
          }
        }
      }
    }
  });
});

describe('StoryNarrator and the summary', () => {
  function ringWith(samples: Array<Partial<Telemetry>>): TelemetryRing {
    const ring = new TelemetryRing();
    samples.forEach((s, i) => ring.push(makeTel(0.01 * (i + 1), s)));
    return ring;
  }

  it('evaluates at most every 0.5 s of sim time and reports only changes', () => {
    const ring = new TelemetryRing();
    const nar = new StoryNarrator();
    const got: string[] = [];
    for (let i = 1; i <= 300; i++) {
      ring.push(makeTel(0.01 * i, { theta: 0.2 }));
      const c = nar.update(ring);
      if (c !== null) got.push(c);
    }
    expect(got).toEqual(['Nominal: the PD controller damps the slosh.']);
    // regime changes to gain shift: a new caption appears at the next evaluation, once
    for (let i = 301; i <= 400; i++) {
      ring.push(makeTel(0.01 * i, { theta: 0.2, gainShift: 2.3, aacMode: 'monitor' }));
      const c = nar.update(ring);
      if (c !== null) got.push(c);
    }
    expect(got).toHaveLength(2);
    expect(got[1]).toContain('detector is watching');
    // throttled: a second call within 0.5 s of the last evaluation returns null even with new data
    ring.push(makeTel(4.01, { theta: 0.2, gainShift: 2.3, aacMode: 'monitor' }));
    expect(nar.update(ring)).toBeNull();
  });

  it('reports the trip delay from the regime entry, with no Kick hint for a quiet θ', () => {
    const ring = new TelemetryRing();
    const nar = new StoryNarrator();
    let last: string | null = null;
    for (let i = 1; i <= 500; i++) {
      const t = 0.01 * i;
      const shifted = t > 1;
      ring.push(
        makeTel(t, {
          theta: 0.02,
          gainShift: shifted ? 2.3 : 1,
          aacMode: shifted ? 'monitor' : 'off',
          detect: [shifted && t >= 3.2, false],
        }),
      );
      last = nar.update(ring) ?? last;
    }
    expect(last).toMatch(/^Detector tripped 2\.2 s after the shift\. K_T is computed but not applied\./);
    expect(last).not.toMatch(/kick/i);
  });

  it('pushes a caption to the summary only when it changes', () => {
    const box = document.createElement('div');
    const sum = createSummary(box);
    const ring = ringWith([{}, {}, {}]);
    sum.update(ring);
    expect(sum.setCaption('Nominal: the PD controller damps the slosh.')).toBe(true);
    const text = sum.element.textContent;
    expect(text).toContain('Nominal: the PD controller damps the slosh.');
    expect(sum.setCaption('Nominal: the PD controller damps the slosh.')).toBe(false);
    expect(sum.element.textContent).toBe(text);
    expect(sum.setCaption('K_T lowered, oscillation decays.')).toBe(true);
    expect(sum.element.textContent).toContain('K_T lowered, oscillation decays.');
    expect(sum.element.textContent).not.toContain('Nominal:');
  });
});
