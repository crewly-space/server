#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../dist/config.js';
import { openDatabase } from '../dist/db/connection.js';
import { exportDatabase } from '../dist/db/export.js';

const output = process.argv[2];
if (!output || process.argv.length !== 3) {
  console.error('Usage: npm run db:export -- /absolute/path/to/crewly-export.db');
  process.exit(1);
}
const config = loadConfig(process.env, []);
const keyFile = path.join(config.dataDir, 'secrets.key');
if (!config.managedSecretsKey && !fs.existsSync(keyFile)) throw new Error('Use the original CREWLY_DATA_DIR or CREWLY_SECRETS_KEY. Refusing to generate an unrelated key during export.');
const key = config.managedSecretsKey ? Buffer.from(config.managedSecretsKey, 'base64') : fs.readFileSync(keyFile);
if (key.length !== 32) throw new Error('The original encryption key must be 32 bytes');
const db = openDatabase(config.dataDir, { databaseUrl: config.databaseUrl, managedSecretsKey: config.managedSecretsKey, turso: config.turso });
try {
  const counts = exportDatabase(db, path.resolve(output), key);
  console.log(`Exported ${Object.keys(counts).length} tables / ${Object.values(counts).reduce((a, b) => a + b, 0)} rows to ${path.resolve(output)}.`);
  console.log('The source was not modified. Preserve the original encryption key, attachments and agentd-server-key.json when moving hosts.');
} finally { db.close(); }
