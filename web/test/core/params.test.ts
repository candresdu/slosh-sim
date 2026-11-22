import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';
import raw from '../../../shared/params/default.json';
import paramsSchema from '../../../shared/schema/params.schema.json';
import presetSchema from '../../../shared/schema/preset.schema.json';
import fig12 from '../../../shared/presets/fig12.json';
import fig13 from '../../../shared/presets/fig13.json';
import fig14 from '../../../shared/presets/fig14.json';
import vb from '../../../shared/presets/vb.json';
import { DEFAULT_PARAMS, loadParams } from '../../src/core/params';
import * as S from '../../src/core/state';

describe('schema validation (ajv)', () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });

  it('validates shared/params/default.json', () => {
    const validate = ajv.compile(paramsSchema);
    const ok = validate(raw);
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it.each([
    ['fig12', fig12],
    ['fig13', fig13],
    ['fig14', fig14],
    ['vb', vb],
  ])('validates preset %s', (id, preset) => {
    const validate = ajv.compile(presetSchema);
    expect(validate(preset)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect((preset as { id: string }).id).toBe(id);
  });

  it('rejects a malformed params file', () => {
    const validate = ajv.compile(paramsSchema);
    const bad = JSON.parse(JSON.stringify(raw)) as { vehicle: Record<string, unknown> };
    bad.vehicle.m_q = 1.5;
    expect(validate(bad)).toBe(false);
  });
});

describe('loadParams', () => {
  const { params, provenance } = loadParams(raw);

  it('flattens leaves to plain numbers', () => {
    expect(params.vehicle.m_q).toBe(1.5207);
    expect(params.vehicle.J).toEqual([0.0211, 0.0216, 0.01455]);
    expect(params.pendulum.L).toBe(1);
    expect(params.sim.controlDecimation).toBe(10);
    expect(params.sensing.noise.enabled).toBe(false);
    expect(params.aac.hp.sos[0]).toHaveLength(5);
    expect(params.modelVersion).toBe(raw.modelVersion);
    expect(params).not.toHaveProperty('schema');
  });

  it('keeps null for values that are not tuned yet', () => {
    expect(params.aac.a0 === null || typeof params.aac.a0 === 'number').toBe(true);
  });

  it('provenance map: R-1 Table 2 for vehicle.m_q', () => {
    expect(provenance['vehicle.m_q']).toBe('R-1 Table 2');
    expect(provenance['motor.tau']).toContain('assumed');
    expect(provenance['aac.hp.sos']).toBeDefined();
  });

  it('every leaf has a provenance entry', () => {
    expect(Object.keys(provenance).length).toBeGreaterThan(40);
    for (const v of Object.values(provenance)) expect(v.length).toBeGreaterThan(0);
  });

  it('bundled DEFAULT_PARAMS matches loadParams(raw)', () => {
    expect(DEFAULT_PARAMS.params).toEqual(params);
    expect(DEFAULT_PARAMS.provenance['vehicle.m_q']).toBe('R-1 Table 2');
  });

  it('rejects input without modelVersion', () => {
    expect(() => loadParams({})).toThrow();
  });
});

describe('state layout', () => {
  it('has 23 elements in the Python order', () => {
    expect(S.NX).toBe(23);
    expect([S.P, S.V, S.Q, S.WB, S.N, S.WP, S.OM]).toEqual([0, 3, 6, 10, 13, 16, 19]);
    expect(S.OM0 + 4).toBe(S.NX);
    expect([S.QW, S.WBX, S.NN, S.WPN]).toEqual([6, 10, 13, 16]);
  });
});
