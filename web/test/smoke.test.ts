import { describe, expect, it } from 'vitest';
import { CORE_VERSION } from '../src/core/index';

describe('smoke', () => {
  it('exposes the core version', () => {
    expect(CORE_VERSION).toBe('0.1.0');
  });
});
