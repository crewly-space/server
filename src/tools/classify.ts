import { getProviderProfile } from './providers.js';
import { stricterRisk, type ToolRisk } from './types.js';

/**
 * Classifies a tool by what it can do, whatever supplied it. The order is:
 * the provider profile's own rules, then what an MCP server says about the
 * tool (annotations), then the verb in its name. When nothing is certain the
 * answer is `write`: an unknown tool is never assumed to be harmless.
 */

/** MCP tool annotations (2025-03-26+). Hints only: a server may be wrong or lying, so they can only make a tool look riskier -- except readOnlyHint, which is trusted only from trusted servers. */
export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  title?: string;
}

export function snakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

const READ_VERBS = new Set(['get', 'list', 'search', 'find', 'read', 'fetch', 'describe', 'show', 'view', 'lookup', 'inspect',
  'retrieve', 'count', 'check', 'explain', 'analyze', 'analyse', 'summarize', 'download', 'browse', 'query', 'resolve_library',
  'whoami', 'me', 'ping', 'stat', 'diff', 'compare', 'preview', 'validate', 'estimate', 'lint', 'status', 'info']);
const WRITE_VERBS = new Set(['create', 'update', 'add', 'set', 'edit', 'write', 'comment', 'upload', 'move', 'rename', 'assign', 'unassign',
  'label', 'open', 'close', 'reopen', 'resolve', 'patch', 'put', 'insert', 'commit', 'push', 'tag', 'link', 'star', 'fork', 'copy',
  'duplicate', 'archive', 'restore', 'enable', 'disable', 'mark', 'save', 'draft', 'modify', 'replace', 'upsert', 'append', 'import',
  'request', 'submit_review', 'acknowledge', 'snooze', 'mute', 'pin', 'unpin', 'react', 'schedule', 'finalize', 'cancel', 'start', 'stop', 'pause']);
const DELETE_VERBS = new Set(['delete', 'remove', 'destroy', 'drop', 'purge', 'truncate', 'erase', 'wipe', 'revoke', 'unlink', 'clear']);
const EXECUTE_VERBS = new Set(['run', 'execute', 'exec', 'eval', 'evaluate', 'invoke', 'trigger', 'dispatch', 'shell', 'call', 'rerun', 'spawn']);
const DEPLOY_VERBS = new Set(['deploy', 'promote', 'rollback', 'release', 'publish', 'redeploy', 'scale', 'rollout', 'merge', 'apply']);
const MESSAGE_VERBS = new Set(['send', 'reply', 'notify', 'email', 'sms', 'tweet', 'broadcast', 'forward', 'respond', 'invite']);
const FINANCIAL_WORDS = /(^|_)(refund|payout|transfer|charge|capture|withdraw|payment_intent|pay|purchase|checkout|wire|disburse)(_|$)/;
const ADMIN_WORDS = /(^|_)(permission|permissions|role|roles|member|members|collaborator|collaborators|admin|billing|secret|secrets|api_key|api_keys|token|tokens|sso|webhook|webhooks|setting|settings|policy|policies|owner|owners|access)(_|$)/;
const CRITICAL_RESOURCES = /(^|_)(repository|repo|project|organization|org|account|workspace|database|zone|bucket|cluster|domain|team|tenant)s?$/;

/** A few action words carry a resource-independent permission. */
const ACTION_NAMES: Record<string, string> = { add: 'create', insert: 'create', upsert: 'write', put: 'write', patch: 'update', edit: 'update',
  modify: 'update', set: 'update', remove: 'delete', destroy: 'delete', erase: 'delete', exec: 'execute', run: 'execute', invoke: 'execute',
  trigger: 'execute', send: 'send', reply: 'send', respond: 'send', post: 'create', comment: 'create' };

function singular(word: string): string {
  if (/ies$/.test(word)) return `${word.slice(0, -3)}y`;
  if (/(ss|us|is)$/.test(word)) return word;
  if (/(ch|sh|x)es$/.test(word)) return word.slice(0, -2);
  if (/s$/.test(word) && word.length > 3) return word.slice(0, -1);
  return word;
}

function isVerb(word: string): boolean {
  return READ_VERBS.has(word) || WRITE_VERBS.has(word) || DELETE_VERBS.has(word) || EXECUTE_VERBS.has(word)
    || DEPLOY_VERBS.has(word) || MESSAGE_VERBS.has(word) || word === 'post';
}

function verbOf(tokens: string[]): { verb: string; rest: string[] } {
  // "create_issue": verb first. "pull_request_read", "issue_write": verb last, as consolidated tools name them.
  if (tokens.length && isVerb(tokens[0]!)) return { verb: tokens[0]!, rest: tokens.slice(1) };
  if (tokens.length > 1 && isVerb(tokens.at(-1)!)) return { verb: tokens.at(-1)!, rest: tokens.slice(0, -1) };
  const index = tokens.findIndex(isVerb);
  if (index === -1) return { verb: tokens[0] ?? '', rest: tokens.slice(1) };
  return { verb: tokens[index]!, rest: tokens.slice(index + 1) };
}

export interface Classification {
  risk: ToolRisk;
  permission: string;
  /** Which step decided, for explaining it to a person. */
  basis: 'provider_rule' | 'annotation' | 'name' | 'unknown';
}

export function classifyTool(input: {
  name: string;
  description?: string;
  provider?: string | null;
  annotations?: ToolAnnotations;
  /** Whether the server's own read-only claim can be believed. */
  trustAnnotations?: boolean;
}): Classification {
  const name = snakeCase(input.name);
  const profile = getProviderProfile(input.provider);
  // Tools often lead with their product's name ("notion_search", "github_create_issue"); that is not the resource.
  const productTokens = [...(input.provider ? snakeCase(input.provider).split('_') : []), ...(profile ? snakeCase(profile.name).split('_') : [])];
  const allTokens = name.split('_').filter(Boolean);
  let skip = 0;
  while (skip < allTokens.length - 1 && productTokens.includes(allTokens[skip]!)) skip += 1;
  const tokens = allTokens.slice(skip);
  const { verb, rest } = verbOf(tokens);
  const resourceWords = rest.filter((word) => !['a', 'an', 'the', 'to', 'for', 'by', 'from', 'in', 'on', 'of', 'with', 'or', 'and', 'all', 'my', 'new'].includes(word));
  const named = resourceWords.join('_') || tokens.filter((word) => word !== verb).join('_');
  // A bare verb ("notion_search") acts on what the provider is for.
  const areaResource = named ? undefined : profile?.areas[0];
  const rawResource = named || areaResource || name;
  const aliased = profile?.resourceAliases?.[rawResource] ?? profile?.resourceAliases?.[singular(rawResource)]
    ?? profile?.resourceAliases?.[resourceWords[0] ?? ''];
  const resource = aliased ?? areaResource ?? singular(resourceWords.length ? resourceWords.map(singular).join('_') : rawResource);

  const byName = (): { risk: ToolRisk; action: string; certain: boolean } => {
    if (FINANCIAL_WORDS.test(name) && !READ_VERBS.has(verb)) return { risk: 'financial', action: ACTION_NAMES[verb] ?? (verb || 'write'), certain: true };
    if (READ_VERBS.has(verb)) return { risk: 'read', action: 'read', certain: true };
    if (DELETE_VERBS.has(verb)) {
      return { risk: CRITICAL_RESOURCES.test(rawResource) ? 'dangerous' : 'delete', action: 'delete', certain: true };
    }
    if (DEPLOY_VERBS.has(verb)) return { risk: 'deploy', action: verb === 'merge' ? 'merge' : 'deploy', certain: true };
    if (EXECUTE_VERBS.has(verb)) return { risk: 'execute', action: 'execute', certain: true };
    if (MESSAGE_VERBS.has(verb) || (verb === 'post' && /message|email|chat|tweet|status/.test(rawResource))) {
      return { risk: 'external_message', action: 'send', certain: true };
    }
    if (WRITE_VERBS.has(verb) || verb === 'post') {
      if (ADMIN_WORDS.test(rawResource)) return { risk: 'admin', action: 'admin', certain: true };
      return { risk: 'write', action: ACTION_NAMES[verb] ?? verb, certain: true };
    }
    return { risk: 'write', action: 'write', certain: false };
  };

  const rule = profile?.rules?.find((candidate) => candidate.match.test(name));
  if (rule && (rule.risk || rule.permission)) {
    const fallback = byName();
    const risk = rule.risk ?? fallback.risk;
    return { risk, permission: rule.permission ?? `${resource}:${fallback.action}`, basis: 'provider_rule' };
  }

  const guessed = byName();
  let risk = guessed.risk;
  let basis: Classification['basis'] = guessed.certain ? 'name' : 'unknown';
  const annotations = input.annotations;
  if (annotations) {
    if (annotations.destructiveHint === true && annotations.readOnlyHint !== true) {
      risk = stricterRisk(risk, 'delete');
      basis = 'annotation';
    } else if (annotations.readOnlyHint === true && input.trustAnnotations && riskRank(risk) <= riskRank('write')) {
      risk = 'read';
      basis = 'annotation';
    }
  }
  const action = risk === 'read' ? 'read' : guessed.action;
  return { risk, permission: `${resource}:${action}`, basis };
}

function riskRank(risk: ToolRisk): number {
  return ['read', 'write', 'external_message', 'delete', 'execute', 'deploy', 'financial', 'admin', 'dangerous'].indexOf(risk);
}

/**
 * SQL a database tool is about to run, classified for this one call. Only a
 * single read-only statement counts as a read; anything the parser cannot be
 * sure of is treated as a write, and statements that destroy data or schema
 * -- including DELETE or UPDATE without a WHERE -- are destructive.
 */
export function classifySql(sql: string): 'read' | 'write' | 'destructive' {
  const text = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .trim()
    .replace(/;\s*$/, '');
  if (!text) return 'read';
  const statements = text.split(';').map((part) => part.trim()).filter(Boolean);
  let worst: 'read' | 'write' | 'destructive' = 'read';
  for (const statement of statements) {
    const upper = statement.toUpperCase();
    const keyword = /^\s*(\w+)/.exec(upper)?.[1] ?? '';
    let level: 'read' | 'write' | 'destructive';
    if (/\b(DROP|TRUNCATE|ALTER|GRANT|REVOKE|RENAME)\b/.test(upper)) level = 'destructive';
    else if (/^(DELETE|UPDATE)$/.test(keyword) || /\b(DELETE\s+FROM|UPDATE\s+\S+\s+SET)\b/.test(upper)) {
      // A filter that cannot fail to match everything is no filter.
      const where = /\bWHERE\b([\s\S]*)$/.exec(upper)?.[1]?.trim() ?? '';
      level = !where || /^(1\s*=\s*1|TRUE|'[^']*'\s*=\s*'[^']*')\b/.test(where) ? 'destructive' : 'write';
    } else if (/^(SELECT|SHOW|EXPLAIN|DESCRIBE|DESC|PRAGMA|VALUES|TABLE)$/.test(keyword)
      || (keyword === 'WITH' && !/\b(INSERT|UPDATE|DELETE|MERGE)\b/.test(upper))) {
      level = /\bINTO\b/.test(upper) && keyword === 'SELECT' ? 'write' : 'read';
    } else level = 'write';
    if (level === 'destructive') return 'destructive';
    if (level === 'write') worst = 'write';
  }
  return worst;
}

const SQL_KEYS = ['sql', 'query', 'statement', 'statements'];

/**
 * The risk of one particular call, which can differ from the tool's: running
 * a SELECT through an "execute_sql" tool is a read, a DROP TABLE is dangerous.
 */
export function callRisk(tool: { risk: ToolRisk; permission: string }, input: Record<string, unknown>): { risk: ToolRisk; permission: string } {
  // Only tools that run SQL: a docs search on a database provider also takes a "query".
  const isDatabase = /^(query|data|schema|destructive):/.test(tool.permission);
  if (!isDatabase) return tool;
  const sql = SQL_KEYS.map((key) => input[key]).flat().filter((value): value is string => typeof value === 'string').join(';\n');
  if (!sql) return tool;
  const kind = classifySql(sql);
  if (kind === 'destructive') return { risk: 'dangerous', permission: 'destructive:execute' };
  if (kind === 'write') return { risk: stricterRisk(tool.risk === 'read' ? 'write' : tool.risk, 'write'), permission: 'data:write' };
  return { risk: 'read', permission: 'data:read' };
}
