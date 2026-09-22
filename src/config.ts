import fs from 'node:fs';
import path from 'node:path';

export interface AppConfig {
  port: number;
  dataDir: string;
  host: string;
  webDir?: string;
  logLevel: string;
  trustProxy: boolean;
  /**
   * Set together by a Crewly Cloud provisioner, and absent on a self-hosted
   * server, which signs people in locally and knows nothing about a Cloud.
   */
  cloudHandoff?: { publicKey: string; deploymentId: string };
  /** Browser origins allowed to call this server's API, such as the hosted app. */
  trustedAppOrigins: string[];
  /** How deep agents may delegate to each other: 1 to 4, from CREWLY_MAX_DELEGATION_DEPTH. */
  maxDelegationDepth?: number;
  /** A platform-managed encryption key for stored secrets (CREWLY_SECRETS_KEY); absent when self-hosted. */
  managedSecretsKey?: string;
}

const ARG_TO_ENV: Record<string, string> = {
  '--port': 'CREWLY_PORT',
  '--data-dir': 'CREWLY_DATA_DIR',
  '--host': 'CREWLY_HOST',
  '--web-dir': 'CREWLY_WEB_DIR',
  '--log-level': 'CREWLY_LOG_LEVEL',
  '--trust-proxy': 'CREWLY_TRUST_PROXY',
};

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  args: string[] = process.argv.slice(2),
): AppConfig {
  const cli = parseArgs(args);
  const initial = { ...env, ...cli };
  const dataDir = path.resolve(initial.CREWLY_DATA_DIR ?? path.resolve(process.cwd(), 'data'));
  const fileEnv = readEnvFile(path.join(dataDir, '.env'));
  // Flags win over process environment, which wins over the data directory's .env.
  const resolved = { ...fileEnv, ...env, ...cli };
  const port = resolved.CREWLY_PORT ? Number(resolved.CREWLY_PORT) : 8787;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`port must be an integer between 1 and 65535, got ${resolved.CREWLY_PORT}`);
  }
  const handoffPublicKey = resolved.CREWLY_CLOUD_HANDOFF_PUBLIC_KEY?.trim();
  const deploymentId = resolved.CREWLY_DEPLOYMENT_ID?.trim();
  if (Boolean(handoffPublicKey) !== Boolean(deploymentId)) {
    throw new Error('CREWLY_CLOUD_HANDOFF_PUBLIC_KEY and CREWLY_DEPLOYMENT_ID must be set together');
  }
  const trustedAppOrigins = (resolved.CREWLY_TRUSTED_APP_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map((origin) => {
      try {
        return new URL(origin).origin;
      } catch {
        throw new Error(`CREWLY_TRUSTED_APP_ORIGINS contains an invalid origin: ${origin}`);
      }
    });
  const maxDelegationDepth = resolved.CREWLY_MAX_DELEGATION_DEPTH ? Number(resolved.CREWLY_MAX_DELEGATION_DEPTH) : undefined;
  if (maxDelegationDepth !== undefined && (!Number.isInteger(maxDelegationDepth) || maxDelegationDepth < 1 || maxDelegationDepth > 4)) {
    throw new Error(`CREWLY_MAX_DELEGATION_DEPTH must be an integer from 1 to 4, got ${resolved.CREWLY_MAX_DELEGATION_DEPTH}`);
  }
  const logLevel = resolved.CREWLY_LOG_LEVEL ?? 'info';
  if (!['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'].includes(logLevel)) {
    throw new Error(`CREWLY_LOG_LEVEL is invalid: ${logLevel}`);
  }
  return {
    port,
    dataDir,
    host: resolved.CREWLY_HOST ?? '127.0.0.1',
    webDir: resolved.CREWLY_WEB_DIR ? path.resolve(resolved.CREWLY_WEB_DIR) : undefined,
    logLevel,
    trustProxy: parseBoolean(resolved.CREWLY_TRUST_PROXY),
    cloudHandoff: handoffPublicKey && deploymentId
      ? { publicKey: handoffPublicKey, deploymentId }
      : undefined,
    trustedAppOrigins,
    ...(maxDelegationDepth !== undefined ? { maxDelegationDepth } : {}),
    ...(resolved.CREWLY_SECRETS_KEY?.trim() ? { managedSecretsKey: resolved.CREWLY_SECRETS_KEY.trim() } : {}),
  };
}

function parseArgs(args: string[]): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index]!;
    const equals = raw.indexOf('=');
    const name = equals === -1 ? raw : raw.slice(0, equals);
    const envName = ARG_TO_ENV[name];
    if (!envName) throw new Error(`unknown option "${name}"; run crewly-server --help`);
    if (name === '--trust-proxy' && equals === -1 && (args[index + 1]?.startsWith('--') ?? true)) {
      result[envName] = 'true';
      continue;
    }
    const value = equals === -1 ? args[++index] : raw.slice(equals + 1);
    if (!value) throw new Error(`${name} requires a value`);
    result[envName] = value;
  }
  return result;
}

function readEnvFile(file: string): NodeJS.ProcessEnv {
  if (!fs.existsSync(file)) return {};
  const result: NodeJS.ProcessEnv = {};
  for (const sourceLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function parseBoolean(value: string | undefined): boolean {
  if (!value) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}
