#!/usr/bin/env node
// Install the coordinated, already-built app. A build never compiles app/main.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { installLocalApp } from './app-bundle.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(root, 'web');
const sibling = resolve(root, '../app/dist');
const pinned = JSON.parse(readFileSync(resolve(root, 'release.json'), 'utf8')).appVersion;
const requested = process.argv[2] || process.env.APP_VERSION;
const version = (requested || pinned).replace(/^v/, '');
if (!/^(latest|\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)$/.test(version)) throw new Error('Invalid app version');
if (!requested && !process.env.CREWLY_APP_TARBALL && existsSync(resolve(sibling, 'index.html'))) {
  installLocalApp(sibling, target, version);
  console.log(`fetch-app: verified sibling app ${version} → web/`);
} else {
  const url = process.env.CREWLY_APP_TARBALL || `https://github.com/crewly-space/app/releases/${version === 'latest' ? 'latest/download' : `download/v${version}`}/crewly-app-dist.tar.gz`;
  const directory = mkdtempSync(join(tmpdir(), 'crewly-app-'));
  try {
    const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`App ${version} download failed (${response.status}). Publish the coordinated app release first, or build the pinned sibling app. Existing web/ was preserved.`);
    const tarball = resolve(directory, 'app.tar.gz');
    writeFileSync(tarball, Buffer.from(await response.arrayBuffer()));
    const listing = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' });
    if (listing.split('\n').some(file => file.startsWith('/') || file.split('/').includes('..'))) throw new Error('Unsafe app archive path');
    const unpacked = resolve(directory, 'unpacked'); mkdirSync(unpacked);
    execFileSync('tar', ['--no-same-owner', '-xzf', tarball, '-C', unpacked, '--strip-components=1']);
    installLocalApp(unpacked, target, version);
    console.log(`fetch-app: verified app ${version} → web/`);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
