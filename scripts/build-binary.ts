#!/usr/bin/env bun
/**
 * Cross-compiles the standalone `opencrew-server` executables the installer
 * drops next to the `opencrew` CLI.
 *
 * Without these, `opencrew up` and `opencrew server start` have nothing to
 * launch: the CLI looks for an `opencrew-server` sibling and gives up when it
 * is missing. The CLI itself is built the same way over in the agentd repo, so
 * the two halves of a self-hosted install stay symmetrical — one archive, two
 * self-contained binaries, no Node and no Docker on the user's machine.
 *
 * SQLite comes from the built-in `node:sqlite`, which both Node and Bun provide,
 * rather than a native addon a compiled binary could not embed; see src/db/driver.ts.
 */
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

interface Target {
  /** Bun's --target triple. */
  target: string;
  /** Release asset directory, matching what infra/scripts/package-release.sh expects. */
  asset: string;
  binary: string;
}

const TARGETS: Target[] = [
  { target: 'bun-linux-x64', asset: 'opencrew_linux_amd64', binary: 'opencrew-server' },
  { target: 'bun-linux-arm64', asset: 'opencrew_linux_arm64', binary: 'opencrew-server' },
  { target: 'bun-darwin-x64', asset: 'opencrew_darwin_amd64', binary: 'opencrew-server' },
  { target: 'bun-darwin-arm64', asset: 'opencrew_darwin_arm64', binary: 'opencrew-server' },
  { target: 'bun-windows-x64', asset: 'opencrew_windows_amd64', binary: 'opencrew-server.exe' },
];

const ROOT = join(import.meta.dir, '..');
const OUT_DIR = join(ROOT, 'dist-binary');
const requested = process.argv.slice(2);
const selected = requested.length > 0 ? TARGETS.filter((t) => requested.includes(t.target)) : TARGETS;

if (selected.length === 0) {
  console.error(`No matching target. Known: ${TARGETS.map((t) => t.target).join(', ')}`);
  process.exit(1);
}

// The migrations directory is unreadable from inside a compiled binary, so the
// SQL has to be embedded before the bundle is built.
const embed = Bun.spawn(['node', join(ROOT, 'scripts', 'embed-migrations.mjs')], {
  stdout: 'inherit',
  stderr: 'inherit',
  cwd: ROOT,
});
if ((await embed.exited) !== 0) {
  console.error('failed to embed migrations');
  process.exit(1);
}

await rm(OUT_DIR, { recursive: true, force: true });
await mkdir(OUT_DIR, { recursive: true });

let failed = false;
for (const { target, asset, binary } of selected) {
  const outfile = join(OUT_DIR, asset, binary);
  process.stdout.write(`  building ${target.padEnd(18)} `);
  const child = Bun.spawn(
    [
      'bun',
      'build',
      join(ROOT, 'src', 'index.ts'),
      '--compile',
      `--target=${target}`,
      '--minify',
      `--outfile=${outfile}`,
    ],
    { stdout: 'pipe', stderr: 'pipe', cwd: ROOT },
  );
  if ((await child.exited) !== 0) {
    failed = true;
    console.log('failed');
    console.error((await new Response(child.stderr).text()).trim());
    continue;
  }
  const size = Bun.file(outfile).size;
  console.log(`${(size / 1_048_576).toFixed(1)} MB → dist-binary/${asset}/${binary}`);
}

if (failed) process.exit(1);
console.log(`\nBuilt ${selected.length} target(s) into dist-binary/`);
