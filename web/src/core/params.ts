// Typed mirror of shared/params/default.json plus the loader that flattens the
// {v, src} leaves into plain numbers and records provenance for the UI.
import raw from '../../../shared/params/default.json';

export type Vec3 = [number, number, number];

export interface Gains {
  Kp: number;
  Kd: number;
}

export interface FilterParams {
  fc: number;
  order: number;
  /** Second-order sections [b0, b1, b2, a1, a2] (a0 = 1), computed by Python. */
  sos: number[][];
}

export interface SimParams {
  modelVersion: string;
  vehicle: {
    m_q: number;
    J: Vec3;
    arm: number;
    k_f: number;
    k_tau: number;
    pivotOffset: Vec3;
  };
  pendulum: { m_p: number; L: number; k_damp: number };
  motor: { tau: number; omegaMin: number; omegaMax: number };
  control: {
    rateHz: number;
    attMax: number;
    inner: Gains;
    outer: Gains;
    alt: Gains;
    yaw: Gains;
  };
  aac: {
    /** null until tuned. */
    a0: number | null;
    b_e: number;
    /** null until tuned. */
    b_s: number | null;
    kMin: number;
    kMax: number;
    hp: FilterParams;
    lp: FilterParams;
    /** null until tuned. */
    threshold: number | null;
    clearRatio: number;
    clearHoldS: number;
    engageRampS: number;
    refLeadS: number;
    refLagS: number;
  };
  sensing: {
    latencyMs: number;
    noise: { enabled: boolean; pos: number; att: number; rate: number };
  };
  sim: { dt: number; controlDecimation: number; seed: number; g: number };
}

export interface LoadedParams {
  params: SimParams;
  /** Dotted parameter path (e.g. "vehicle.m_q") -> provenance string (e.g. "R-1 Table 2"). */
  provenance: Record<string, string>;
}

type Json = unknown;

function isRecord(x: Json): x is Record<string, Json> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function isLeaf(x: Json): x is { v: Json; src: string } {
  if (!isRecord(x)) return false;
  const keys = Object.keys(x);
  return keys.length === 2 && 'v' in x && 'src' in x && typeof x.src === 'string';
}

function flatten(node: Json, path: string, prov: Record<string, string>): Json {
  if (isLeaf(node)) {
    prov[path] = node.src;
    return node.v;
  }
  if (!isRecord(node)) throw new Error(`params: expected object at "${path}"`);
  const out: Record<string, Json> = {};
  for (const [k, child] of Object.entries(node)) {
    if (path === '' && (k === 'schema' || k === 'modelVersion')) continue;
    out[k] = flatten(child, path === '' ? k : `${path}.${k}`, prov);
  }
  return out;
}

/**
 * Flatten a parsed default.json (or a compatible document) into plain parameters and a
 * provenance map. Structural validation is the job of the JSON schema (see the tests);
 * this function only checks the shape it needs to flatten.
 */
export function loadParams(json: unknown = raw): LoadedParams {
  if (!isRecord(json) || typeof json.modelVersion !== 'string') {
    throw new Error('params: missing modelVersion');
  }
  const provenance: Record<string, string> = {};
  const flat = flatten(json, '', provenance) as Record<string, Json>;
  const params = { modelVersion: json.modelVersion, ...flat } as unknown as SimParams;
  return { params, provenance };
}

/** The parameters bundled at build time. */
export const DEFAULT_PARAMS: LoadedParams = loadParams(raw);
