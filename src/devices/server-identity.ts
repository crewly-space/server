import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface AgentdServerIdentity {
  publicKey: string;
  sign(payload: Uint8Array): string;
}

export function agentdServerSignaturePayload(nonce: string): Buffer {
  return Buffer.from(`crewly-agentd-server\n${nonce}`, 'utf8');
}

function identity(privateKey: KeyObject, publicKey: KeyObject): AgentdServerIdentity {
  const rawPublic = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  return {
    publicKey: rawPublic.toString('base64url'),
    sign: (payload) => sign(null, Buffer.from(payload), privateKey).toString('base64url'),
  };
}

export function createAgentdServerIdentity(): AgentdServerIdentity {
  const pair = generateKeyPairSync('ed25519');
  return identity(pair.privateKey, pair.publicKey);
}

function fromDisk(raw: string): AgentdServerIdentity {
  const disk = JSON.parse(raw) as { privateKey?: string };
  if (!disk.privateKey) throw new Error('missing private key');
  const privateKey = createPrivateKey({ key: Buffer.from(disk.privateKey, 'base64'), format: 'der', type: 'pkcs8' });
  return identity(privateKey, createPublicKey(privateKey));
}

/** A stable server key is pinned by devices during pairing. */
export async function loadOrCreateAgentdServerIdentity(dataDir: string): Promise<AgentdServerIdentity> {
  const file = path.join(dataDir, 'agentd-server-key.json');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  try {
    return fromDisk(await readFile(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`read agentd server key: ${(error as Error).message}`);
  }
  const pair = generateKeyPairSync('ed25519');
  const encoded = pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
  try {
    await writeFile(file, `${JSON.stringify({ privateKey: encoded })}\n`, { mode: 0o600, flag: 'wx' });
    return identity(pair.privateKey, pair.publicKey);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return fromDisk(await readFile(file, 'utf8'));
  }
}
