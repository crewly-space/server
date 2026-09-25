import { describe, expect, it } from 'vitest';
import { negotiateCapabilities, negotiateProtocol, PROTOCOL_VERSION } from './version.js';

describe('PROTOCOL_VERSION', () => {
  it('is a semver string', () => {
    expect(PROTOCOL_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('accepts additive changes, legacy clients, and rejects a major mismatch', () => {
    expect(negotiateProtocol(PROTOCOL_VERSION)).toMatchObject({ compatible: true, reason: 'current' });
    expect(negotiateProtocol('0.9.0')).toMatchObject({ compatible: true });
    expect(negotiateProtocol()).toMatchObject({ compatible: true, reason: 'legacy-client' });
    expect(negotiateProtocol('1.0.0')).toMatchObject({ compatible: false, reason: 'major-version-mismatch' });
    expect(negotiateProtocol('not-a-version')).toMatchObject({ compatible: false, reason: 'invalid-client-version' });
  });

  it('negotiates only capabilities explicitly advertised by the client', () => {
    expect(negotiateCapabilities({
      'agentd.capabilities.v1': true,
      'unknown.future.v1': true,
    })).toEqual(['agentd.capabilities.v1']);
    expect(negotiateCapabilities()).toEqual([]);
  });
});
