import { describe, expect, it } from 'vitest';
import fixture from '../../../golden/fixtures/controller.json';
import { Controller, type Meas, type Ref } from '../../src/core/controller';
import { loadParams } from '../../src/core/params';
import { expectClose, expectScalar } from './helpers';

describe('controller fixtures', () => {
  it('has 3 cases of 300 ticks', () => {
    expect(fixture.cases.length).toBe(3);
    expect(fixture.ticks).toBe(300);
  });

  for (const cs of fixture.cases) {
    it(`matches case ${cs.name} (rel 1e-12)`, () => {
      const { params } = loadParams(fixture.params);
      params.sensing.latencyMs = cs.latencyMs;
      params.sensing.noise.enabled = cs.noiseEnabled;
      const ctrl = new Controller(params, cs.seed);
      const inp = cs.inputs;
      const out = cs.outputs;
      for (let i = 0; i < fixture.ticks; i++) {
        const meas: Meas = { pos: inp.pos[i] as number[], vel: inp.vel[i] as number[], q: inp.q[i] as number[], wB: inp.wB[i] as number[] };
        const ref: Ref = { pos: inp.refPos[i] as number[], yaw: inp.refYaw[i] as number };
        const o = ctrl.step(meas, ref, inp.gs[i] as number, inp.kT[i] as [number, number]);
        const at = `${cs.name} tick ${i}`;
        expectClose(o.u, out.u[i] as number[], `${at} u`);
        expectScalar(o.pitchC, out.pitchC[i] as number, `${at} pitchC`);
        expectScalar(o.rollC, out.rollC[i] as number, `${at} rollC`);
        expectScalar(o.f, out.f[i] as number, `${at} f`);
        expectClose(o.tau, out.tau[i] as number[], `${at} tau`);
        expectClose(o.omegaCmd, out.omegaCmd[i] as number[], `${at} omegaCmd`);
        expectClose(o.sensed.pos, out.sensedPos[i] as number[], `${at} sensedPos`);
        expectClose(o.sensed.vel, out.sensedVel[i] as number[], `${at} sensedVel`);
        expectScalar(o.sensed.roll, out.sensedRoll[i] as number, `${at} sensedRoll`);
        expectScalar(o.sensed.pitch, out.sensedPitch[i] as number, `${at} sensedPitch`);
        expectScalar(o.sensed.yaw, out.sensedYaw[i] as number, `${at} sensedYaw`);
        expectClose(o.sensed.rates, out.sensedRates[i] as number[], `${at} sensedRates`);
      }
    });
  }

  it('latency FIFO delays by round(latency/tick) ticks', () => {
    const { params } = loadParams(fixture.params);
    params.sensing.latencyMs = 30;
    params.sensing.noise.enabled = false;
    const ctrl = new Controller(params, 1);
    expect(ctrl.delayTicks).toBe(3);
    const ref: Ref = { pos: [0, 0, 0], yaw: 0 };
    const sensedN: number[] = [];
    for (let i = 0; i < 6; i++) {
      const meas: Meas = { pos: [i, 0, 0], vel: [0, 0, 0], q: [1, 0, 0, 0], wB: [0, 0, 0] };
      sensedN.push(ctrl.step(meas, ref, 1).sensed.pos[0]);
    }
    expect(sensedN).toEqual([0, 0, 0, 0, 1, 2]);
  });

  it('reset re-seeds the noise stream', () => {
    const { params } = loadParams(fixture.params);
    params.sensing.noise.enabled = true;
    const ctrl = new Controller(params, 5);
    const meas: Meas = { pos: [0, 0, 0], vel: [0, 0, 0], q: [1, 0, 0, 0], wB: [0, 0, 0] };
    const ref: Ref = { pos: [0, 0, 0], yaw: 0 };
    const a = ctrl.step(meas, ref, 1).sensed.pos[0];
    ctrl.reset(5);
    const b = ctrl.step(meas, ref, 1).sensed.pos[0];
    expect(b).toBe(a);
    expect(a).not.toBe(0);
  });
});
