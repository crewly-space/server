import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';

export function verifyAppBundle(directory, expectedVersion) {
  const metadata = JSON.parse(readFileSync(resolve(directory, 'crewly-app.json'), 'utf8'));
  if (expectedVersion !== 'latest' && metadata.version !== expectedVersion) throw new Error(`App version ${metadata.version} does not match required ${expectedVersion}`);
  if (!metadata.assets || !Object.hasOwn(metadata.assets, 'index.html')) throw new Error('App manifest does not include index.html');
  for (const [file, digest] of Object.entries(metadata.assets)) {
    const absolute = resolve(directory, file);
    if (isAbsolute(file) || !absolute.startsWith(resolve(directory) + sep)) throw new Error('Invalid app asset path');
    const actual = createHash('sha256').update(readFileSync(absolute)).digest('hex');
    if (actual !== digest) throw new Error(`App asset checksum mismatch: ${file}`);
  }
  return metadata;
}

export function installLocalApp(source, target, version) {
  // Verify before touching a working UI; stage next to the destination so the
  // final rename stays on the same filesystem.
  verifyAppBundle(source, version);
  mkdirSync(dirname(target), { recursive: true });
  const stage = mkdtempSync(resolve(dirname(target), '.crewly-web-'));
  const previous = `${stage}-previous`;
  try {
    cpSync(source, stage, { recursive: true });
    if (existsSync(resolve(target, '.gitkeep'))) cpSync(resolve(target, '.gitkeep'), resolve(stage, '.gitkeep'));
    verifyAppBundle(stage, version);
    // Public assets prepared by a build container must remain readable to the
    // host Docker client and the non-root runtime. Secrets never live here.
    chmodSync(stage, 0o755);
    if (existsSync(target)) renameSync(target, previous);
    try { renameSync(stage, target); } catch (error) { if (existsSync(previous)) renameSync(previous, target); throw error; }
  } finally { rmSync(stage, { recursive: true, force: true }); rmSync(previous, { recursive: true, force: true }); }
}
