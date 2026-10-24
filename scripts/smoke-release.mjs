// Run the binary from an unpacked release, with a fresh disk and its bundled UI.
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
const directory = resolve(process.argv[2] || 'dist-binary/crewly_linux_amd64');
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const binary = resolve(directory, process.platform === 'win32' ? 'crewly-server.exe' : 'crewly-server');
if (execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim() !== `crewly-server ${version}`) throw new Error('Binary version does not match package.json');
execFileSync(binary, ['--help'], { stdio: 'ignore' });
const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const data = mkdtempSync(join(tmpdir(), 'crewly-install-'));
const child = spawn(binary, ['--host', '127.0.0.1', '--port', String(port), '--data-dir', data, '--web-dir', resolve(directory, 'web'), '--log-level', 'silent'], { stdio: ['ignore', 'pipe', 'pipe'] });
let logs = ''; child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-5000); });
try {
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Binary exited: ${logs}`);
    try { if ((await fetch(`${base}/readyz`)).ok) { ready = true; break; } } catch { /* booting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error(`Binary did not become ready: ${logs}`);
  const html = await fetch(base).then(response => response.text());
  if (!html.includes('id="root"')) throw new Error('Packaged app is missing');
  const metadata = await fetch(`${base}/crewly-app.json`).then(response => response.json());
  if (metadata.version !== version) throw new Error('Bundled app/server version mismatch');
  const status = await fetch(`${base}/api/v1/auth/status`).then(response => response.json());
  if (status.initialized || !status.claimRequired) throw new Error('Fresh installation is not protected by its setup claim');
  console.log(`PASS: unpacked Crewly ${version}, native startup, bundled app, readiness and protected first setup`);
} finally {
  if (child.exitCode === null) await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 2000).unref(); });
  rmSync(data, { recursive: true, force: true });
}
