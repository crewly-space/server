import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('defaults to a loopback-only server on port 8787', () => {
    const config = loadConfig({}, []);
    expect(config.port).toBe(8787);
    expect(config.host).toBe('127.0.0.1');
    expect(config.dataDir).toMatch(/data$/);
  });

  it('reads CREWLY_PORT and CREWLY_DATA_DIR when set', () => {
    const config = loadConfig({ CREWLY_PORT: '5050', CREWLY_DATA_DIR: '/tmp/crewly-data' }, []);
    expect(config.port).toBe(5050);
    expect(config.dataDir).toBe(path.resolve('/tmp/crewly-data'));
  });

  it('lets command-line flags override environment values', () => {
    const config = loadConfig(
      { CREWLY_PORT: '5050', CREWLY_HOST: '0.0.0.0' },
      ['--port', '6060', '--host=127.0.0.2', '--trust-proxy'],
    );
    expect(config.port).toBe(6060);
    expect(config.host).toBe('127.0.0.2');
    expect(config.trustProxy).toEqual(['127.0.0.1', '::1']);
  });

  it('loads .env from the selected data directory without overriding process env', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewly-config-'));
    fs.writeFileSync(path.join(dataDir, '.env'), 'CREWLY_PORT=9090\nCREWLY_TRUST_PROXY=yes\n');
    const config = loadConfig({ CREWLY_DATA_DIR: dataDir, CREWLY_PORT: '7070' }, []);
    expect(config.port).toBe(7070);
    expect(config.trustProxy).toEqual(['127.0.0.1', '::1']);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('trusts forwarding headers only from the proxies it is given', () => {
    expect(loadConfig({}, []).trustProxy).toBe(false);
    expect(loadConfig({ CREWLY_TRUST_PROXY: '172.17.0.1, 10.0.0.0/8' }, []).trustProxy).toEqual(['172.17.0.1', '10.0.0.0/8']);
    expect(() => loadConfig({ CREWLY_TRUST_PROXY: 'everyone' }, [])).toThrow(/CREWLY_TRUST_PROXY/);
  });

  it('rejects unknown options', () => {
    expect(() => loadConfig({}, ['--wat'])).toThrow(/unknown option/);
  });

  it('reads how deep agents may delegate, and refuses a depth the run table cannot hold', () => {
    expect(loadConfig({ CREWLY_MAX_DELEGATION_DEPTH: '2' }, []).maxDelegationDepth).toBe(2);
    expect(loadConfig({}, []).maxDelegationDepth).toBeUndefined();
    expect(() => loadConfig({ CREWLY_MAX_DELEGATION_DEPTH: '9' }, [])).toThrow(/1 to 4/);
  });

  it('reads an outbound mail provider from CREWLY_MAIL_*, and refuses half of one', () => {
    expect(loadConfig({}, []).mail).toBeUndefined();
    expect(loadConfig({ CREWLY_MAIL_PROVIDER: 'resend', CREWLY_MAIL_API_KEY: 're_x', CREWLY_MAIL_FROM: 'Crewly <a@example.com>' }, []).mail)
      .toEqual({ provider: 'resend', apiKey: 're_x', fromAddress: 'Crewly <a@example.com>' });
    expect(() => loadConfig({ CREWLY_MAIL_PROVIDER: 'resend', CREWLY_MAIL_API_KEY: 're_x' }, [])).toThrow(/CREWLY_MAIL_FROM/);
    expect(() => loadConfig({ CREWLY_MAIL_PROVIDER: 'smtp', CREWLY_MAIL_API_KEY: 'x', CREWLY_MAIL_FROM: 'a@example.com' }, [])).toThrow(/resend or postmark/);
  });
});

