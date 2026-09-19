import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import {
  createProviderConfig,
  deleteProviderConfig,
  getProviderConfig,
  listProviderConfigs,
  updateProviderConfig,
} from './repository.js';

describe('provider config repository', () => {
  let dataDir: string;

  afterEach(() => {
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function freshDb() {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewly-providers-'));
    const db = openDatabase(dataDir);
    runMigrations(db);
    return db;
  }

  it('creates a provider config with a caller-supplied id and reads it back', () => {
    const db = freshDb();
    const config = createProviderConfig(db, { id: 'anthropic-default', kind: 'anthropic', apiKey: 'sk-test' });
    expect(config.id).toBe('anthropic-default');
    expect(config.apiKey).toBe('sk-test');
    expect(getProviderConfig(db, 'anthropic-default')?.kind).toBe('anthropic');
    db.close();
  });

  it('encrypts API keys at rest and decrypts them after reopening the database', () => {
    let db = freshDb();
    createProviderConfig(db, { id: 'anthropic-default', kind: 'anthropic', apiKey: 'sk-plain-secret' });
    const raw = db.prepare('SELECT api_key FROM provider_configs WHERE id = ?').get('anthropic-default') as { api_key: string };
    expect(raw.api_key).not.toContain('sk-plain-secret');
    expect(raw.api_key).toMatch(/^enc:v1:/);
    expect(fs.readFileSync(path.join(dataDir, 'secrets.key'))).toHaveLength(32);
    db.close();

    db = openDatabase(dataDir);
    expect(getProviderConfig(db, 'anthropic-default')?.apiKey).toBe('sk-plain-secret');
    db.close();
  });

  it('migrates a legacy plaintext key when migrations run', () => {
    const db = freshDb();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO provider_configs (id, kind, api_key, base_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run('legacy', 'anthropic', 'sk-legacy-plaintext', null, now, now);
    runMigrations(db);
    const raw = db.prepare('SELECT api_key FROM provider_configs WHERE id = ?').get('legacy') as { api_key: string };
    expect(raw.api_key).toMatch(/^enc:v1:/);
    expect(raw.api_key).not.toContain('sk-legacy-plaintext');
    expect(getProviderConfig(db, 'legacy')?.apiKey).toBe('sk-legacy-plaintext');
    db.close();
  });

  it('allows an agentd-backed provider with no stored api key', () => {
    const db = freshDb();
    const config = createProviderConfig(db, { id: 'my-claude-subscription', kind: 'claude-subscription' });
    expect(config.apiKey).toBeNull();
    db.close();
  });

  it('lists all configured providers', () => {
    const db = freshDb();
    createProviderConfig(db, { id: 'anthropic-default', kind: 'anthropic', apiKey: 'sk-test' });
    createProviderConfig(db, { id: 'openai-default', kind: 'openai', apiKey: 'sk-openai' });
    expect(listProviderConfigs(db)).toHaveLength(2);
    db.close();
  });

  it('rejects a duplicate id', () => {
    const db = freshDb();
    createProviderConfig(db, { id: 'anthropic-default', kind: 'anthropic', apiKey: 'sk-test' });
    expect(() => createProviderConfig(db, { id: 'anthropic-default', kind: 'openai', apiKey: 'sk-other' })).toThrow();
    db.close();
  });

  it('rotates a key, updates the base URL, and deletes the provider', () => {
    const db = freshDb();
    createProviderConfig(db, { id: 'compat', kind: 'openai-compatible', apiKey: 'sk-old', baseUrl: 'https://old.example/v1' });
    const updated = updateProviderConfig(db, 'compat', { apiKey: 'sk-new', baseUrl: 'https://new.example/v1' });
    expect(updated?.apiKey).toBe('sk-new');
    expect(updated?.baseUrl).toBe('https://new.example/v1');
    const raw = db.prepare('SELECT api_key FROM provider_configs WHERE id = ?').get('compat') as { api_key: string };
    expect(raw.api_key).not.toContain('sk-new');
    expect(deleteProviderConfig(db, 'compat')).toBe(true);
    expect(getProviderConfig(db, 'compat')).toBeUndefined();
    expect(deleteProviderConfig(db, 'compat')).toBe(false);
    db.close();
  });
});
