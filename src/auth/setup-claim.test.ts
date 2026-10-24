import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareSetupClaim } from './setup-claim.js';

describe('setup claim', () => {
  let dataDir: string;
  afterEach(() => {
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('persists one token across restarts and removes it when consumed', () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewly-claim-'));
    const first = prepareSetupClaim(dataDir, false);
    const second = prepareSetupClaim(dataDir, false);
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(second.token).toBe(first.token);
    expect(fs.readFileSync(first.file, 'utf8').trim()).toBe(first.token);
    first.consume();
    expect(fs.existsSync(first.file)).toBe(false);
  });

  it('removes a stale token after initialization', () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewly-claim-'));
    const pending = prepareSetupClaim(dataDir, false);
    expect(fs.existsSync(pending.file)).toBe(true);
    expect(prepareSetupClaim(dataDir, true).token).toBeUndefined();
    expect(fs.existsSync(pending.file)).toBe(false);
  });
});

it('uses a dashboard-provided claim secret only until the first owner exists', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'crewly-hosted-claim-'));
  try {
    const token = 'dashboard-provided-setup-secret';
    const claim = prepareSetupClaim(directory, false, token);
    expect(claim.token).toBe(token);
    expect(fs.existsSync(claim.file)).toBe(false);
    claim.consume();
    expect(prepareSetupClaim(directory, true, token).token).toBeUndefined();
    expect(() => prepareSetupClaim(directory, false, 'short')).toThrow(/20 to 512/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
