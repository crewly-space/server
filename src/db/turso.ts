import { createRequire } from 'node:module';
import { waitForWorkerReply } from './worker-reply.js';
import type { Database, Statement } from './driver.js';

// Keep the existing synchronous repository contract while the official client
// owns one interactive transaction (and its Hrana stream) in a worker.
const SOURCE = `
const { workerData } = require('node:worker_threads');
const { createClient } = require(workerData.clientPath);
const { port, flag, url, authToken } = workerData;
const client = createClient({ url, authToken, intMode: 'number' });
let transaction;
function reply(value) { port.postMessage(value); Atomics.store(flag, 0, 1); Atomics.notify(flag, 0); }
port.on('message', async (request) => {
 try {
  let result;
  if (request.action === 'close') { transaction?.close(); client.close(); }
  else if (request.action === 'begin') transaction = await client.transaction('write');
  else if (request.action === 'commit') { try { await transaction.commit(); } finally { transaction.close(); transaction = undefined; } }
  else if (request.action === 'rollback') { try { if(transaction) await transaction.rollback(); } finally { transaction?.close(); transaction = undefined; } }
  else if (request.action === 'exec') await (transaction || client).executeMultiple(request.sql);
  else result = await (transaction || client).execute({ sql: request.sql, args: request.args });
  reply(result ? { rows: result.rows.map(row => Object.fromEntries(result.columns.map(name => [name, row[name]]))), changes: result.rowsAffected, lastInsertRowid: result.lastInsertRowid } : {});
 } catch(error) { reply({ error: { message: String(error.message || error), code: error.code } }); }
});
`;
interface Reply { rows?: Record<string, unknown>[]; changes?: number; lastInsertRowid?: bigint; error?: { message: string; code?: string } }
export function openTurso(url: string, authToken: string): Database {
  const require = createRequire(import.meta.url);
  const { Worker, MessageChannel, receiveMessageOnPort } = require('node:worker_threads') as typeof import('node:worker_threads');
  const flag = new Int32Array(new SharedArrayBuffer(4));
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(SOURCE, { eval: true, workerData: { clientPath: require.resolve('@libsql/client'), port: port2, flag, url, authToken }, transferList: [port2] });
  worker.unref(); port1.unref();
  let closed = false, inTransaction = false;
  function call(request: Record<string, unknown>): Reply {
    if (closed) throw new Error('The database connection is closed');
    Atomics.store(flag, 0, 0); port1.postMessage(request);
    try { waitForWorkerReply(flag, 65000); } catch (error) { closed = true; port1.close(); void worker.terminate(); throw error; }
    const result = receiveMessageOnPort(port1)?.message as Reply | undefined;
    if (!result) throw new Error('Turso worker returned no answer');
    if (result.error) throw Object.assign(new Error(result.error.message), { code: result.error.code });
    return result;
  }
  function statement(sql: string, pluck = false): Statement {
    function query(params: unknown[]) {
      const first = params[0];
      const named = params.length === 1 && first !== null && typeof first === 'object' && !Array.isArray(first) && !ArrayBuffer.isView(first) && !(first instanceof ArrayBuffer);
      const values = named ? Object.values(first as Record<string, unknown>) : params;
      if (values.some(value => typeof value === 'boolean')) throw new TypeError('Cannot bind a boolean; use 1 or 0');
      return call({ action: 'query', sql, args: named ? first : params });
    }
    const shape = (row: Record<string, unknown> | undefined) => {
      if (!row) return undefined;
      const normalized = Object.fromEntries(Object.entries(row).map(([name, value]) => [name, value instanceof ArrayBuffer ? Buffer.from(value) : value]));
      return pluck ? Object.values(normalized)[0] : normalized;
    };
    return { run: (...params) => { const result = query(params); return { changes: result.changes ?? 0, lastInsertRowid: result.lastInsertRowid ?? 0 }; },
      get: (...params) => shape(query(params).rows?.[0]), all: (...params) => (query(params).rows ?? []).map(shape), pluck: () => statement(sql, true) };
  }
  const close = () => { if (closed) return; try { call({ action: 'close' }); } finally { closed = true; port1.close(); void worker.terminate(); } };
  try { statement('SELECT 1').get(); } catch (error) { close(); throw new Error('Could not open libSQL. Check the database URL, token, network and database permissions.', { cause: error }); }
  return { dialect: 'sqlite', prepare: sql => statement(sql), exec: sql => { call({ action: 'exec', sql }); },
    transaction: <T extends (...args: never[]) => unknown>(fn: T): T => ((...args: never[]) => {
      if (inTransaction) return fn(...args);
      call({ action: 'begin' }); inTransaction = true;
      try { const result = fn(...args); call({ action: 'commit' }); return result; }
      catch (error) { try { call({ action: 'rollback' }); } catch { /* preserve original error */ } throw error; }
      finally { inTransaction = false; }
    }) as T,
    pragma: (source, options) => { const rows = statement(`PRAGMA ${source}`).all() as Record<string, unknown>[]; return options?.simple ? rows[0] && Object.values(rows[0])[0] : rows; }, close };
}
