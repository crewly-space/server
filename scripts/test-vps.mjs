// Destructive only to a fresh, isolated test deployment; refuses existing data.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
if (process.env.CREWLY_TEST_VPS !== '1') throw new Error('This Docker integration test requires CREWLY_TEST_VPS=1');
for (const [type, name] of [['volume', 'crewly-vps_data']]) {
  if (spawnSync('docker', [type, 'inspect', name], { stdio: 'ignore' }).status === 0) throw new Error(`Refusing existing ${name}`);
}
const root = mkdtempSync(join(tmpdir(), 'crewly-vps-test-'));
cpSync(resolve('deploy/vps/compose.yaml'), join(root, 'compose.yaml'));
cpSync(resolve('deploy/vps/crewly-vps'), join(root, 'crewly-vps'));
const run = (...args) => execFileSync('bash', [join(root, 'crewly-vps'), ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, CREWLY_WAIT_TIMEOUT: '12' } });
const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
let token;
async function api(path, body) {
  const response = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, { method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', connection: 'close', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body && JSON.stringify(body) });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json();
}
try {
  run('init', 'https://crewly.example.test', 'crewly-release-check', String(port));
  const env = readFileSync(join(root, '.env'), 'utf8');
  assert.throws(() => run('init', 'https://crewly.example.test', 'crewly-release-check', String(port)));
  assert.equal(readFileSync(join(root, '.env'), 'utf8'), env);
  run('up');
  const claimToken = run('setup-code').trim();
  token = (await api('/auth/setup', { email: 'owner@example.test', displayName: 'Owner', password: 'vps-test-password', claimToken })).token;
  const room = (await api('/channels')).channels[0].id;
  const messages = `/conversations/${room}/messages`;
  await api(messages, { body: 'Before the backup' });
  run('backup'); const backup = readFileSync(join(root, '.last-backup'), 'utf8').trim();
  await api(messages, { body: 'After the backup' });
  run('restore', backup);
  assert.deepEqual((await api(messages)).map(message => message.body), ['Before the backup']);
  assert.equal(run('setup-code').trim(), claimToken);
  const image = 'crewly-vps-broken-check';
  writeFileSync(join(root, 'Dockerfile'), 'FROM crewly-release-check\nHEALTHCHECK --interval=1s --timeout=1s --retries=1 CMD exit 1\n');
  execFileSync('docker', ['build', '-t', image, root], { stdio: 'ignore' });
  assert.throws(() => run('update', image));
  run('doctor');
  // A failed update must not leave the broken image as the rollback target.
  run('rollback');
  assert.deepEqual((await api(messages)).map(message => message.body), ['Before the backup']);
  console.log('PASS: VPS init preserves keys; backup restores messages, sessions and setup secret; unhealthy update restores the previous image and data');
} finally {
  spawnSync('docker', ['compose', '--project-name', 'crewly-vps', '--env-file', join(root, '.env'), '-f', join(root, 'compose.yaml'), 'down', '--volumes'], { stdio: 'ignore' });
  rmSync(root, { recursive: true, force: true });
}
