import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface SetupClaim {
  token?: string;
  file: string;
  consume(): void;
}

/**
 * Creates the one-time secret required to claim a fresh server. The CLI reads
 * this file locally, while manual installs can copy it from the data directory.
 */
export function prepareSetupClaim(dataDir: string, initialized: boolean, configuredToken?: string): SetupClaim {
  const file = path.join(dataDir, 'claim-token');
  if (initialized) {
    fs.rmSync(file, { force: true });
    return { file, consume() {} };
  }

  if (configuredToken) {
    if (configuredToken.length < 20 || configuredToken.length > 512) throw new Error('CREWLY_SETUP_TOKEN must contain 20 to 512 characters');
    return { token: configuredToken, file, consume() { fs.rmSync(file, { force: true }); } };
  }
  let token: string;
  try {
    token = fs.readFileSync(file, 'utf8').trim();
    if (token.length < 20) throw new Error(`${file} is invalid; remove it and restart Crewly`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    token = randomBytes(24).toString('base64url');
    try {
      fs.writeFileSync(file, `${token}\n`, { flag: 'wx', mode: 0o600 });
    } catch (writeError) {
      if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError;
      token = fs.readFileSync(file, 'utf8').trim();
    }
  }

  return {
    token,
    file,
    consume() { fs.rmSync(file, { force: true }); },
  };
}
