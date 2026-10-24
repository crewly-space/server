import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, statSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installLocalApp } from './app-bundle.mjs';
test('installs only complete matching bundles and preserves the old app after a bad build', () => {
  const root = mkdtempSync(join(tmpdir(), 'crewly-bundle-'));
  const source = join(root, 'dist'), target = join(root, 'web');
  mkdirSync(source); mkdirSync(target); writeFileSync(join(target, 'index.html'), 'old working app');
  const html = '<div id="root">new app</div>';
  writeFileSync(join(source, 'index.html'), html);
  const metadata = { version: '0.2.0', assets: { 'index.html': createHash('sha256').update(html).digest('hex') } };
  writeFileSync(join(source, 'crewly-app.json'), JSON.stringify(metadata));
  try {
    assert.throws(() => installLocalApp(source, target, '0.1.0'), /does not match/);
    assert.equal(readFileSync(join(target, 'index.html'), 'utf8'), 'old working app');
    writeFileSync(join(source, 'index.html'), 'truncated');
    assert.throws(() => installLocalApp(source, target, '0.2.0'), /checksum mismatch/);
    assert.equal(readFileSync(join(target, 'index.html'), 'utf8'), 'old working app');
    writeFileSync(join(source, 'index.html'), html); installLocalApp(source, target, '0.2.0');
    assert.equal(readFileSync(join(target, 'index.html'), 'utf8'), html);
    assert.equal(statSync(target).mode & 0o777, 0o755);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
