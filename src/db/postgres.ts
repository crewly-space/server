import { createRequire } from 'node:module';
import type { Database, Statement } from './driver.js';

/**
 * Opens a PostgreSQL database behind the same synchronous `Database` the
 * SQLite driver provides.
 *
 * Everything above the driver was written against a synchronous database, and
 * a hosted server (one Superserver provisions) is the only place PostgreSQL is
 * used: its database runs on the same host, so a round trip is a fraction of
 * a millisecond. The client therefore runs in a worker thread and each call
 * blocks on it -- the same trade SQLite already makes, where every query also
 * holds the event loop -- instead of rewriting four hundred call sites.
 *
 * One connection, like SQLite: a transaction is every statement between its
 * BEGIN and COMMIT on that connection, and nothing else can interleave because
 * the caller is blocked for the whole of each one.
 *
 * The SQL the server writes is SQLite's. What differs is translated here, once
 * per statement text: `?` and `@name` placeholders, `INSERT OR IGNORE`,
 * `IS ?`, `COLLATE NOCASE`, and camelCase aliases, which PostgreSQL would fold to
 * lower case.
 */

const INT8 = 20;
const NUMERIC = 1700;

/** How long one statement may take before the caller gives up on the worker. */
const STATEMENT_TIMEOUT_MS = 60_000;

interface Translated {
  text: string;
  names: string[] | null;
  aliases: Map<string, string> | null;
}

interface Reply {
  rows?: Record<string, unknown>[];
  rowCount?: number;
  error?: { message: string; code?: string; constraint?: string; detail?: string };
}

const translations = new Map<string, Translated>();

/** Replaces `?` and `@name` outside quoted text and comments. */
function placeholders(sql: string): { text: string; names: string[] | null } {
  let text = '';
  let positional = 0;
  const names: string[] = [];
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i]!;
    if (char === "'" || char === '"') {
      const close = sql.indexOf(char, i + 1);
      const end = close === -1 ? sql.length : close + 1;
      text += sql.slice(i, end);
      i = end - 1;
    } else if (char === '-' && sql[i + 1] === '-') {
      const close = sql.indexOf('\n', i);
      const end = close === -1 ? sql.length : close;
      text += sql.slice(i, end);
      i = end - 1;
    } else if (char === '?') {
      text += `$${++positional}`;
    } else if (char === '@' && /[A-Za-z_]/.test(sql[i + 1] ?? '')) {
      const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(i + 1))![0];
      let index = names.indexOf(name);
      if (index === -1) index = names.push(name) - 1;
      text += `$${index + 1}`;
      i += name.length;
    } else {
      text += char;
    }
  }
  if (positional > 0 && names.length > 0) throw new Error('A statement cannot mix ? and @name placeholders');
  return { text, names: names.length > 0 ? names : null };
}

export function translateForPostgres(sql: string): Translated {
  const cached = translations.get(sql);
  if (cached) return cached;
  const placed = placeholders(sql);
  const { names } = placed;
  let { text } = placed;

  // SQLite's INSERT OR IGNORE skips a row that conflicts with any unique key.
  if (/^\s*INSERT\s+OR\s+IGNORE\s+INTO\b/i.test(text)) {
    text = text.replace(/INSERT\s+OR\s+IGNORE\s+INTO/i, 'INSERT INTO').replace(/\s*;?\s*$/, '');
    const returning = /\sRETURNING\s[\s\S]*$/i.exec(text);
    text = returning
      ? `${text.slice(0, returning.index)} ON CONFLICT DO NOTHING${returning[0]}`
      : `${text} ON CONFLICT DO NOTHING`;
  }

  // SQLite's `x IS ?` is equality that treats two NULLs as equal.
  text = text.replace(/\bIS\s+NOT\s+(\$\d+)/gi, 'IS DISTINCT FROM $1');
  text = text.replace(/\bIS\s+(\$\d+)/gi, 'IS NOT DISTINCT FROM $1');

  // `a = ? COLLATE NOCASE` compares case-insensitively; so does ordering by
  // `name COLLATE NOCASE`. PostgreSQL has no such collation by default.
  text = text.replace(/([\w.]+)\s*=\s*(\$\d+)\s+COLLATE\s+NOCASE/gi, 'lower($1) = lower($2)');
  text = text.replace(/([\w.]+)\s+COLLATE\s+NOCASE/gi, 'lower($1)');

  const aliases = new Map<string, string>();
  for (const [, alias] of text.matchAll(/\bAS\s+([A-Za-z_][A-Za-z0-9_]*)/gi)) {
    if (alias !== alias!.toLowerCase()) aliases.set(alias!.toLowerCase(), alias!);
  }
  const result = { text, names, aliases: aliases.size > 0 ? aliases : null };
  translations.set(sql, result);
  return result;
}

function bind(names: string[] | null, params: unknown[]): unknown[] {
  const values = names
    ? names.map((name) => {
        const source = params[0];
        if (!source || typeof source !== 'object') throw new Error(`Missing named parameter @${name}`);
        return (source as Record<string, unknown>)[name];
      })
    : params;
  return values.map((value) => {
    if (value === undefined) return null;
    // node:sqlite refuses booleans rather than guessing; so does this driver.
    if (typeof value === 'boolean') throw new TypeError('Cannot bind a boolean; use 1 or 0');
    return value;
  });
}

/**
 * The worker: one pg client, reconnected when the connection is lost. It is
 * plain CommonJS so that it runs from any build, and it loads `pg` from the
 * path the parent resolved, so the parent's node_modules is the one used.
 */
const WORKER_SOURCE = `
const { workerData } = require('node:worker_threads');
const pg = require(workerData.pgPath);
const { port, flag, url, statementTimeoutMs } = workerData;
pg.types.setTypeParser(${INT8}, (value) => Number(value));
pg.types.setTypeParser(${NUMERIC}, (value) => Number(value));
let client = null;
let connecting = null;
function isConnectionError(error) {
  const code = String(error && error.code || '');
  const message = String(error && error.message || error);
  return code.startsWith('08') || ['57P01', '57P02', '57P03'].includes(code)
    || /connection (?:terminated|closed)|connection error|not queryable|server closed the connection/i.test(message);
}
function discard(connection) {
  if (client === connection) client = null;
  connecting = null;
  try { connection.end().catch(() => {}); } catch {}
}
function connect() {
  if (connecting) return connecting;
  const next = new pg.Client({ connectionString: url, statement_timeout: statementTimeoutMs });
  const lost = () => { if (connecting === attempt) { client = null; connecting = null; } };
  next.on('error', lost);
  next.on('end', lost);
  const attempt = next.connect()
    // A search_path naming a schema that does not exist yet (a test's, or one
    // chosen deliberately on a shared server) gets it created.
    .then(() => next.query("DO $$ BEGIN IF current_schema() IS NULL THEN EXECUTE format('CREATE SCHEMA IF NOT EXISTS %I', trim(split_part(current_setting('search_path'), ',', 1))); END IF; END $$"))
    .then(() => { client = next; return next; }, (error) => { lost(); throw error; });
  connecting = attempt;
  return attempt;
}
function reply(message) {
  port.postMessage(message);
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
}
port.on('message', async (request) => {
  if (request.close) {
    try { if (client) await client.end(); } catch {}
    reply({});
    return;
  }
  let connection = null;
  try {
    connection = client ?? await connect();
    if (request.savepoint) await connection.query('SAVEPOINT crewly_statement');
    let result;
    try {
      result = request.values
        ? await connection.query({ text: request.text, values: request.values })
        : await connection.query(request.text);
    } catch (error) {
      if (request.savepoint && !isConnectionError(error)) await connection.query('ROLLBACK TO SAVEPOINT crewly_statement');
      throw error;
    }
    if (request.savepoint) await connection.query('RELEASE SAVEPOINT crewly_statement');
    const last = Array.isArray(result) ? result[result.length - 1] : result;
    reply({ rows: last ? last.rows : [], rowCount: last && last.rowCount != null ? last.rowCount : 0 });
  } catch (error) {
    // pg can reject the query before its asynchronous error/end event fires.
    // Clear the dead client before replying so an immediate next statement
    // reconnects instead of racing that event and failing a second time.
    if (connection && isConnectionError(error)) discard(connection);
    reply({ error: { message: String(error && error.message || error), code: error && error.code, constraint: error && error.constraint, detail: error && error.detail } });
  }
});
`;

export function openPostgres(url: string): Database {
  const require = createRequire(import.meta.url);
  let pgPath: string;
  try {
    pgPath = require.resolve('pg');
  } catch {
    throw new Error('PostgreSQL needs the pg package, which this build of the server does not include');
  }
  // Loaded here rather than imported so the single-binary build, which never
  // uses PostgreSQL, does not depend on worker threads.
  const { MessageChannel, Worker, receiveMessageOnPort } = require('node:worker_threads') as typeof import('node:worker_threads');

  const flag = new Int32Array(new SharedArrayBuffer(4));
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: { pgPath, port: port2, flag, url, statementTimeoutMs: STATEMENT_TIMEOUT_MS },
    transferList: [port2],
  });
  worker.unref();
  port1.unref();
  let closed = false;
  let transactionDepth = 0;

  const call = (request: { text: string; values?: unknown[]; savepoint?: boolean } | { close: true }): Reply => {
    if (closed) throw new Error('The database connection is closed');
    Atomics.store(flag, 0, 0);
    port1.postMessage(request);
    if (Atomics.wait(flag, 0, 0, STATEMENT_TIMEOUT_MS + 5_000) === 'timed-out') {
      throw new Error('PostgreSQL did not answer in time');
    }
    const received = receiveMessageOnPort(port1);
    if (!received) throw new Error('PostgreSQL worker returned no answer');
    return received.message as Reply;
  };

  const fail = (error: NonNullable<Reply['error']>): never => {
    throw Object.assign(new Error(error.message), {
      code: error.code,
      constraint: error.constraint,
      detail: error.detail,
    });
  };

  const query = (sql: string, params: unknown[]): { rows: Record<string, unknown>[]; rowCount: number } => {
    const { text, names, aliases } = translateForPostgres(sql);
    // On SQLite a failed statement fails alone; on PostgreSQL it would abort
    // the whole transaction, so code that catches a conflict and carries on
    // would find every later statement refused. A savepoint keeps SQLite's rule.
    const savepoint = transactionDepth > 0 && !/^\s*SELECT\b/i.test(text);
    const reply = call({ text, values: bind(names, params), savepoint });
    if (reply.error) fail(reply.error);
    // Every table carries a rowid, as SQLite's do; like SQLite, `SELECT *`
    // does not return it.
    const rows = (reply.rows ?? []).map((row) => {
      delete row.rowid;
      return aliases
        ? Object.fromEntries(Object.entries(row).map(([key, value]) => [aliases.get(key) ?? key, value]))
        : row;
    });
    return { rows, rowCount: reply.rowCount ?? 0 };
  };

  const exec = (sql: string): void => {
    const reply = call({ text: sql });
    if (reply.error) fail(reply.error);
  };

  const statement = (sql: string, pluck: boolean): Statement => {
    const shape = (row: Record<string, unknown> | undefined): unknown => {
      if (!pluck || row === undefined) return row;
      const values = Object.values(row);
      return values.length > 0 ? values[0] : undefined;
    };
    return {
      // No rowid to report: an insert that needs its key asks with RETURNING.
      run: (...params) => ({ changes: query(sql, params).rowCount, lastInsertRowid: 0 }),
      get: (...params) => shape(query(sql, params).rows[0]),
      all: (...params) => query(sql, params).rows.map(shape),
      pluck: () => statement(sql, true),
    };
  };

  return {
    dialect: 'postgres',
    prepare: (sql: string) => statement(sql, false),
    exec,
    transaction: <T extends (...args: never[]) => unknown>(fn: T): T =>
      ((...args: never[]) => {
        // Nested calls join the open transaction, as they do on SQLite.
        if (transactionDepth > 0) return fn(...args);
        exec('BEGIN');
        transactionDepth++;
        try {
          const result = fn(...args);
          transactionDepth--;
          exec('COMMIT');
          return result;
        } catch (error) {
          transactionDepth--;
          exec('ROLLBACK');
          throw error;
        }
      }) as T,
    // SQLite tuning has no PostgreSQL meaning. Reads answer as SQLite would
    // on a healthy database so shared code needs no branch for them.
    pragma: (source: string, options?: { simple?: boolean }) => {
      if (/^foreign_keys\s*$/i.test(source)) return options?.simple ? 1 : [{ foreign_keys: 1 }];
      if (/^foreign_key_check\b/i.test(source)) return [];
      return options?.simple ? undefined : [];
    },
    close: () => {
      if (closed) return;
      try {
        call({ close: true });
      } finally {
        closed = true;
        port1.close();
        void worker.terminate();
      }
    },
  };
}
