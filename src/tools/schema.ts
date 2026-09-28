/**
 * What a tool must look like before a model is offered it. An MCP server's
 * schema and description go to a model provider verbatim, so they are
 * checked like any other untrusted input: bounded, self-contained, and an
 * object the model can fill in.
 */

const MAX_SCHEMA_BYTES = 32_000;
const MAX_DEPTH = 12;
const MAX_DESCRIPTION = 1024;

export interface SchemaCheck {
  schema: Record<string, unknown>;
  issues: string[];
}

function depthOf(value: unknown, depth = 0): number {
  if (depth > MAX_DEPTH) return depth;
  if (Array.isArray(value)) return Math.max(depth, ...value.map((entry) => depthOf(entry, depth + 1)));
  if (value && typeof value === 'object') return Math.max(depth, ...Object.values(value).map((entry) => depthOf(entry, depth + 1)));
  return depth;
}

function hasRemoteRef(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasRemoteRef);
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([key, entry]) => (key === '$ref' && typeof entry === 'string' && !entry.startsWith('#')) || hasRemoteRef(entry));
  }
  return false;
}

export function checkInputSchema(input: unknown): SchemaCheck {
  const issues: string[] = [];
  if (input === undefined || input === null) return { schema: { type: 'object', properties: {} }, issues };
  if (typeof input !== 'object' || Array.isArray(input)) return { schema: { type: 'object' }, issues: ['schema is not an object'] };
  const schema = input as Record<string, unknown>;
  const type = schema.type;
  if (type !== undefined && type !== 'object') issues.push(`top-level type is ${JSON.stringify(type)}, not "object"`);
  if (schema.properties !== undefined && (typeof schema.properties !== 'object' || Array.isArray(schema.properties))) issues.push('properties is not an object');
  let size = 0;
  try { size = JSON.stringify(schema).length; } catch { issues.push('schema is not serializable'); }
  if (size > MAX_SCHEMA_BYTES) issues.push(`schema is ${size} bytes; the limit is ${MAX_SCHEMA_BYTES}`);
  if (depthOf(schema) > MAX_DEPTH) issues.push(`schema nests deeper than ${MAX_DEPTH} levels`);
  if (hasRemoteRef(schema)) issues.push('schema refers to an external $ref');
  return { schema: type === undefined ? { ...schema, type: 'object' } : schema, issues };
}

/** A description as a model will read it: bounded, and without control characters. */
export function cleanDescription(text: string | undefined): string {
  // eslint-disable-next-line no-control-regex
  return (text ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, MAX_DESCRIPTION);
}

/** Checks a model's arguments against the top level of the schema before anything is sent anywhere. */
export function checkArguments(schema: Record<string, unknown>, args: unknown): string | null {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'arguments must be an object';
  const values = args as Record<string, unknown>;
  const required = Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === 'string') : [];
  const missing = required.filter((key) => values[key] === undefined);
  if (missing.length) return `missing required argument${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`;
  const properties = (schema.properties && typeof schema.properties === 'object') ? schema.properties as Record<string, { type?: unknown }> : {};
  if (schema.additionalProperties === false) {
    const unknown = Object.keys(values).filter((key) => !(key in properties));
    if (unknown.length) return `unknown argument${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`;
  }
  for (const [key, value] of Object.entries(values)) {
    const expected = properties[key]?.type;
    if (typeof expected !== 'string' || value === null || value === undefined) continue;
    const actual = Array.isArray(value) ? 'array' : typeof value;
    const ok = expected === actual || (expected === 'integer' && Number.isInteger(value)) || (expected === 'number' && actual === 'number');
    if (!ok) return `${key} should be ${expected}, not ${actual}`;
  }
  return null;
}

const SECRET_KEY = /(pass(word)?|passwd|secret|token|api[_-]?key|authorization|credential|private[_-]?key|cookie|signature|access[_-]?key)/i;
const SECRET_VALUE = [
  /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{10,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(postgres(ql)?|mysql|mongodb(\+srv)?|redis):\/\/[^:\s/]+:[^@\s]+@/gi,
];
export const REDACTED = '[redacted]';

/**
 * Arguments as the audit log keeps them: secret-looking keys and values are
 * replaced, long strings are cut. Also given the literal values of any
 * secrets resolved for the call, so those never survive either.
 */
export function redactArguments(value: unknown, knownSecrets: string[] = [], depth = 0): unknown {
  if (depth > 8) return '[…]';
  if (typeof value === 'string') {
    let text = value;
    for (const secret of knownSecrets) if (secret.length >= 6) text = text.split(secret).join(REDACTED);
    for (const pattern of SECRET_VALUE) text = text.replace(pattern, REDACTED);
    return text.length > 500 ? `${text.slice(0, 500)}… (${text.length} chars)` : text;
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, 50).map((entry) => redactArguments(entry, knownSecrets, depth + 1));
    return value.length > 50 ? [...items, `… ${value.length - 50} more`] : items;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 100).map(([key, entry]) =>
      [key, SECRET_KEY.test(key) && entry !== null && entry !== '' ? REDACTED : redactArguments(entry, knownSecrets, depth + 1)]));
  }
  return value;
}
