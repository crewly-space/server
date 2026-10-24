#!/usr/bin/env node
// Build the separately owned app at its pinned commit before a source deploy.
// This is a preparation step; the server Dockerfile never compiles app source.
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { installLocalApp } from './app-bundle.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { appRef, appVersion } = JSON.parse(readFileSync(resolve(root, 'release.json'), 'utf8'));
if (!/^[a-f0-9]{40}$/.test(appRef)) throw new Error('release.json must pin a full app commit SHA');
const temporary = mkdtempSync(join(tmpdir(), 'crewly-source-'));
const app = join(temporary, 'app');
const run = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: 'inherit' });
try {
  run('git', ['clone', '--no-checkout', 'https://github.com/crewly-space/app.git', app]);
  run('git', ['checkout', '--detach', appRef], app);
  symlinkSync(root, join(temporary, 'server'), process.platform === 'win32' ? 'junction' : 'dir');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  run(npm, ['ci'], app);
  run(npm, ['run', 'vendor:check'], app);
  run(npm, ['run', 'build'], app);
  installLocalApp(join(app, 'dist'), resolve(root, 'web'), appVersion);
  console.log(`Prepared app ${appVersion} from ${appRef}. Build the Docker image next.`);
} finally { rmSync(temporary, { recursive: true, force: true }); }
