import type { ProviderKind } from '../protocol/index.js';
import type { Database } from '../db/driver.js';
import { decryptDatabaseSecret, encryptDatabaseSecret } from '../db/secrets.js';

export interface ProviderConfigRecord {
  id: string;
  kind: ProviderKind;
  apiKey: string | null;
  baseUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ProviderConfigRow {
  id: string;
  kind: ProviderKind;
  api_key: string | null;
  base_url: string | null;
  created_at: string;
  updated_at: string;
}

function rowToProviderConfig(db: Database, row: ProviderConfigRow): ProviderConfigRecord {
  return {
    id: row.id,
    kind: row.kind,
    apiKey: row.api_key === null ? null : decryptDatabaseSecret(db, row.api_key),
    baseUrl: row.base_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createProviderConfig(
  db: Database,
  input: { id: string; kind: ProviderKind; apiKey?: string | null; baseUrl?: string | null }
): ProviderConfigRecord {
  const now = new Date().toISOString();
  const row: ProviderConfigRow = {
    id: input.id,
    kind: input.kind,
    api_key: input.apiKey ? encryptDatabaseSecret(db, input.apiKey) : null,
    base_url: input.baseUrl ?? null,
    created_at: now,
    updated_at: now,
  };
  db.prepare(
    `INSERT INTO provider_configs (id, kind, api_key, base_url, created_at, updated_at)
     VALUES (@id, @kind, @api_key, @base_url, @created_at, @updated_at)`
  ).run(row);
  return rowToProviderConfig(db, row);
}

export function getProviderConfig(db: Database, id: string): ProviderConfigRecord | undefined {
  const row = db.prepare('SELECT * FROM provider_configs WHERE id = ?').get(id) as ProviderConfigRow | undefined;
  return row ? rowToProviderConfig(db, row) : undefined;
}

export function listProviderConfigs(db: Database): ProviderConfigRecord[] {
  const rows = db.prepare('SELECT * FROM provider_configs ORDER BY created_at ASC').all() as ProviderConfigRow[];
  return rows.map((row) => rowToProviderConfig(db, row));
}

export function updateProviderConfig(
  db: Database,
  id: string,
  input: { apiKey?: string; baseUrl?: string | null }
): ProviderConfigRecord | undefined {
  const existing = getProviderConfig(db, id);
  if (!existing) return undefined;
  const apiKey = input.apiKey ?? existing.apiKey;
  const baseUrl = input.baseUrl === undefined ? existing.baseUrl : input.baseUrl;
  const updatedAt = new Date().toISOString();
  db.prepare(
    `UPDATE provider_configs
     SET api_key = ?, base_url = ?, updated_at = ?
     WHERE id = ?`
  ).run(apiKey === null ? null : encryptDatabaseSecret(db, apiKey), baseUrl, updatedAt, id);
  return { ...existing, apiKey, baseUrl, updatedAt };
}

export function deleteProviderConfig(db: Database, id: string): boolean {
  return Number(db.prepare('DELETE FROM provider_configs WHERE id = ?').run(id).changes) > 0;
}
