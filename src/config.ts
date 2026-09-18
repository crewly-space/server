import fs from 'node:fs';
import path from 'node:path';

export interface AppConfig {
  port: number;
  dataDir: string;
  host: string;
  webDir?: string;
  logLevel: string;
  trustProxy: boolean;
}

const ARG_TO_ENV: Record<string, string> = {
  '--port': 'OPENCREW_PORT',
  '--data-dir': 'OPENCREW_DATA_DIR',
  '--host': 'OPENCREW_HOST',
  '--web-dir': 'OPENCREW_WEB_DIR',
  '--log-level': 'OPENCREW_LOG_LEVEL',
  '--trust-proxy': 'OPENCREW_TRUST_PROXY',
};

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  args: string[] = process.argv.slice(2),
): AppConfig {
  const cli = parseArgs(args);
  const initial = { ...env, ...cli };
  const dataDir = path.resolve(initial.OPENCREW_DATA_DIR ?? path.resolve(process.cwd(), 'data'));
  const fileEnv = readEnvFile(path.join(dataDir, '.env'));
  // Flags win over process environment, which wins over the data directory's .env.
  const resolved = { ...fileEnv, ...env, ...cli };
  const port = resolved.OPENCREW_PORT ? Number(resolved.OPENCREW_PORT) : 8787;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`port must be an integer between 1 and 65535, got ${resolved.OPENCREW_PORT}`);
  }
  const logLevel = resolved.OPENCREW_LOG_LEVEL ?? 'info';
  if (!['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'].includes(logLevel)) {
    throw new Error(`OPENCREW_LOG_LEVEL is invalid: ${logLevel}`);
  }
  return {
    port,
    dataDir,
    host: resolved.OPENCREW_HOST ?? '127.0.0.1',
    webDir: resolved.OPENCREW_WEB_DIR ? path.resolve(resolved.OPENCREW_WEB_DIR) : undefined,
    logLevel,
    trustProxy: parseBoolean(resolved.OPENCREW_TRUST_PROXY),
  };
}

function parseArgs(args: string[]): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index]!;
    const equals = raw.indexOf('=');
    const name = equals === -1 ? raw : raw.slice(0, equals);
    const envName = ARG_TO_ENV[name];
    if (!envName) throw new Error(`unknown option "${name}"; run opencrew-server --help`);
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
