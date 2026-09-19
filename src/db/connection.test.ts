import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from './connection.js';

describe('openDatabase', () => {
  let dataDir: string;

  afterEach(() => {
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('creates the data directory and an crewly.db file in WAL mode', () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewly-db-'));
    const nestedDir = path.join(dataDir, 'nested');
    const db = openDatabase(nestedDir);
    expect(fs.existsSync(path.join(nestedDir, 'crewly.db'))).toBe(true);
    expect(fs.readFileSync(path.join(nestedDir, 'secrets.key'))).toHaveLength(32);
    const mode = db.pragma('journal_mode', { simple: true });
    expect(mode).toBe('wal');
    db.close();
  });

});
