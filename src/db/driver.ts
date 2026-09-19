import { DatabaseSync, type StatementSync } from 'node:sqlite';

/**
 * Opens the SQLite database using the runtime's built-in `node:sqlite`.
 *
 * The server ships two ways: as a Node process, and as a single
 * `bun build --compile` executable that the installer drops next to the CLI so
 * `crewly up` works on a machine with no Node, no Docker, and no toolchain.
 * A compiled binary cannot embed a native addon, which rules out
 * `better-sqlite3` — but `node:sqlite` is built into both Node and Bun, so one
 * driver and one test suite cover every way the server ships.
 *
 * `node:sqlite` already matches `better-sqlite3` on everything the call sites
 * depend on: `@name` parameters bind from bare-keyed objects, a missing row
 * comes back as `undefined` rather than `null`, booleans are rejected instead
 * of silently coerced, and `run()` returns `{ changes, lastInsertRowid }`.
 * Only three conveniences are missing, and this module adds them.
 */

export interface Statement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  pluck(): Statement;
}

export interface Database {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  /** Runs `fn` inside a transaction, returning a callable like better-sqlite3's. */
  transaction<T extends (...args: never[]) => unknown>(fn: T): T;
  /**
   * `pragma('journal_mode = WAL')` to set, `pragma('journal_mode')` to read.
   * `{ simple: true }` returns just the first column of the first row.
   */
  pragma(source: string, options?: { simple?: boolean }): unknown;
  close(): void;
}

/** `pluck()` returns only the first column, which `node:sqlite` has no helper for. */
function pluckOf(statement: StatementSync): Statement {
  const first = (row: unknown): unknown => {
    if (row === undefined || row === null) return undefined;
    const values = Object.values(row as Record<string, unknown>);
    return values.length > 0 ? values[0] : undefined;
  };
  const plucked: Statement = {
    run: (...params) => statement.run(...(params as never[])),
    get: (...params) => first(statement.get(...(params as never[]))),
    all: (...params) => statement.all(...(params as never[])).map(first),
    pluck: () => plucked,
  };
  return plucked;
}

function adaptStatement(statement: StatementSync): Statement {
  return {
    run: (...params) => statement.run(...(params as never[])),
    get: (...params) => statement.get(...(params as never[])),
    all: (...params) => statement.all(...(params as never[])),
    pluck: () => pluckOf(statement),
  };
}

function adaptDatabase(db: DatabaseSync): Database {
  return {
    prepare: (sql: string) => adaptStatement(db.prepare(sql)),
    exec: (sql: string) => db.exec(sql),
    // better-sqlite3 hands back a callable that wraps the work in a
    // transaction; node:sqlite leaves the BEGIN/COMMIT to the caller. Nested
    // calls reuse the open transaction so an inner helper cannot commit early.
    transaction: <T extends (...args: never[]) => unknown>(fn: T): T =>
      ((...args: never[]) => {
        if (db.isTransaction) return fn(...args);
        db.exec('BEGIN');
        try {
          const result = fn(...args);
          db.exec('COMMIT');
          return result;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      }) as T,
    pragma: (source: string, options?: { simple?: boolean }) => {
      const rows = db.prepare(`PRAGMA ${source}`).all() as Record<string, unknown>[];
      if (!options?.simple) return rows;
      const [first] = rows;
      return first === undefined ? undefined : Object.values(first)[0];
    },
    close: () => db.close(),
  };
}

export function openSqlite(file: string): Database {
  return adaptDatabase(new DatabaseSync(file));
}
