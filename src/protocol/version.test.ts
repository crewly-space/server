import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from './version.js';

describe('PROTOCOL_VERSION', () => {
  it('is a semver string', () => {
    expect(PROTOCOL_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
