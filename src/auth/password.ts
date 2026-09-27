import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const KEY_LENGTH = 64;
const N = 1 << 17;
const R = 8;
const P = 1;

async function key(password: string, salt: string, options?: { N: number; r: number; p: number }): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, options ? { ...options, maxmem: 256 * 1024 * 1024 } : {}, (error, value) => {
      if (error) reject(error); else resolve(value);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const hash = await key(password, salt, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt}$${hash.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  let salt: string | undefined;
  let hash: string | undefined;
  let options: { N: number; r: number; p: number } | undefined;
  if (stored.startsWith('scrypt$')) {
    const [, n, r, p, parsedSalt, parsedHash] = stored.split('$');
    salt = parsedSalt;
    hash = parsedHash;
    options = { N: Number(n), r: Number(r), p: Number(p) };
    if (!Number.isInteger(options.N) || options.N < N || options.r !== R || options.p !== P) return false;
  } else {
    [salt, hash] = stored.split(':');
  }
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  if (expected.length !== KEY_LENGTH) return false;
  const candidate = await key(password, salt, options);
  return timingSafeEqual(candidate, expected);
}
