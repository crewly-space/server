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

  it('reads OPENCREW_PORT and OPENCREW_DATA_DIR when set', () => {
    const config = loadConfig({ OPENCREW_PORT: '5050', OPENCREW_DATA_DIR: '/tmp/opencrew-data' }, []);
    expect(config.port).toBe(5050);
    expect(config.dataDir).toBe(path.resolve('/tmp/opencrew-data'));
  });

  it('lets command-line flags override environment values', () => {
    const config = loadConfig(
      { OPENCREW_PORT: '5050', OPENCREW_HOST: '0.0.0.0' },
      ['--port', '6060', '--host=127.0.0.2', '--trust-proxy'],
    );
    expect(config.port).toBe(6060);
    expect(config.host).toBe('127.0.0.2');
    expect(config.trustProxy).toBe(true);
  });

  it('loads .env from the selected data directory without overriding process env', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencrew-config-'));
    fs.writeFileSync(path.join(dataDir, '.env'), 'OPENCREW_PORT=9090\nOPENCREW_TRUST_PROXY=yes\n');
    const config = loadConfig({ OPENCREW_DATA_DIR: dataDir, OPENCREW_PORT: '7070' }, []);
    expect(config.port).toBe(7070);
    expect(config.trustProxy).toBe(true);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('rejects unknown options', () => {
    expect(() => loadConfig({}, ['--wat'])).toThrow(/unknown option/);
  });
});
