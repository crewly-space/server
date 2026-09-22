import { spawn } from 'node:child_process';
import { once } from 'node:events';

/** The protocol revision Crewly speaks; servers answer with the one they will use. */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpCallResult {
  text: string;
  isError: boolean;
}

/** A failure a person can act on: `code` is stable, `message` says what to do. */
export class McpError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export type McpTransportConfig =
  | { transport: 'http'; url: string; headers: Record<string, string> }
  | { transport: 'stdio'; command: string; args: string[]; env: Record<string, string> };

export interface McpClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Local processes run with the server's privileges, so they are off unless the operator allows them. */
  allowStdio?: boolean;
  clientVersion?: string;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number | string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

interface Connection {
  request(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  notify(method: string, params?: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
}

function rpcResult(response: JsonRpcResponse, method: string): Record<string, unknown> {
  if (response.error) throw new McpError('mcp_error', `The MCP server refused ${method}: ${response.error.message}`);
  return response.result ?? {};
}

/** Reads the JSON-RPC answer to `id` out of a streamable-HTTP body, which may be JSON or an SSE stream. */
async function readHttpAnswer(response: Response, id: number): Promise<JsonRpcResponse> {
  const type = response.headers.get('content-type') ?? '';
  const body = await response.text();
  if (type.includes('text/event-stream')) {
    for (const event of body.split(/\r?\n\r?\n/)) {
      const data = event.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
      if (!data) continue;
      try {
        const message = JSON.parse(data) as JsonRpcResponse;
        if (message.id === id) return message;
      } catch {
        // Not a JSON-RPC message; keep reading.
      }
    }
    throw new McpError('not_mcp', 'The server streamed events but never answered the request');
  }
  try {
    const parsed = JSON.parse(body) as JsonRpcResponse | JsonRpcResponse[];
    const message = Array.isArray(parsed) ? parsed.find((entry) => entry.id === id) : parsed;
    if (message && message.jsonrpc === '2.0') return message;
  } catch {
    // Fall through.
  }
  throw new McpError('not_mcp', 'That URL did not answer like an MCP server');
}

function httpFailure(status: number, url: string): McpError {
  if (status === 401 || status === 403) {
    return new McpError('unauthorized', `The MCP server refused the credentials (${status}). Check the Authorization header or the secret it uses.`);
  }
  if (status === 404) return new McpError('not_found', `No MCP endpoint at ${url} (404). Check the path, for example /mcp.`);
  if (status === 405) return new McpError('not_mcp', `${url} does not accept MCP requests (405). Check the path.`);
  return new McpError('server_error', `The MCP server answered ${status}.`);
}

function connectHttp(config: Extract<McpTransportConfig, { transport: 'http' }>, options: McpClientOptions): Connection {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? 15_000;
  let sessionId: string | undefined;
  let protocolVersion: string | undefined;
  let nextId = 1;

  const post = async (payload: Record<string, unknown>): Promise<Response> => {
    let response: Response;
    try {
      response = await fetchImpl(config.url, {
        method: 'POST',
        headers: {
          ...config.headers,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
          ...(protocolVersion ? { 'mcp-protocol-version': protocolVersion } : {}),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const reason = error as Error & { cause?: { code?: string } };
      if (reason.name === 'TimeoutError') {
        throw new McpError('timeout', `The MCP server did not answer within ${Math.round(timeoutMs / 1000)} seconds.`);
      }
      const host = (() => {
        try {
          return new URL(config.url).host;
        } catch {
          return config.url;
        }
      })();
      throw new McpError('unreachable', `Could not connect to ${host}${reason.cause?.code ? ` (${reason.cause.code})` : ''}.`);
    }
    if (!response.ok && response.status !== 202) throw httpFailure(response.status, config.url);
    sessionId = response.headers.get('mcp-session-id') ?? sessionId;
    return response;
  };

  return {
    async request(method, params) {
      const id = nextId++;
      const response = await post({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
      const result = rpcResult(await readHttpAnswer(response, id), method);
      if (method === 'initialize' && typeof result.protocolVersion === 'string') protocolVersion = result.protocolVersion;
      return result;
    },
    async notify(method, params) {
      await post({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });
    },
    async close() {
      if (!sessionId) return;
      // Ending the session is a courtesy; a server that does not support it is fine.
      await fetchImpl(config.url, { method: 'DELETE', headers: { ...config.headers, 'mcp-session-id': sessionId } }).catch(() => undefined);
    },
  };
}

/** What a stdio server inherits from the Crewly process: enough to run, and nothing Crewly holds. */
const INHERITED_ENV = ['PATH', 'HOME', 'LANG', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'USERPROFILE'];

async function connectStdio(config: Extract<McpTransportConfig, { transport: 'stdio' }>, options: McpClientOptions): Promise<Connection> {
  if (!options.allowStdio) {
    throw new McpError(
      'stdio_disabled',
      'Local (stdio) MCP servers are disabled on this server. An operator can allow them with CREWLY_MCP_STDIO=1.',
    );
  }
  const timeoutMs = options.timeoutMs ?? 15_000;
  const env: Record<string, string> = {};
  for (const name of INHERITED_ENV) if (process.env[name]) env[name] = process.env[name]!;
  const child = spawn(config.command, config.args, { env: { ...env, ...config.env }, stdio: ['pipe', 'pipe', 'pipe'] });

  const spawnFailure = new Promise<never>((_resolve, reject) => {
    child.once('error', (error: NodeJS.ErrnoException) => {
      reject(error.code === 'ENOENT'
        ? new McpError('command_not_found', `Command not found: ${config.command}. Install it on the server or use its full path.`)
        : new McpError('spawn_failed', `Could not start ${config.command}: ${error.message}`));
    });
  });
  spawnFailure.catch(() => undefined);

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-2000);
  });

  const waiting = new Map<number, (message: JsonRpcResponse) => void>();
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line) as JsonRpcResponse;
        if (typeof message.id === 'number') waiting.get(message.id)?.(message);
      } catch {
        // Servers sometimes log to stdout; anything that is not JSON-RPC is ignored.
      }
    }
  });
  const exited = once(child, 'exit').then(([code]) => {
    throw new McpError('exited', `${config.command} exited (${code ?? 'signal'}) before answering.${stderr ? ` It said: ${stderr.trim().split('\n').slice(-3).join(' ')}` : ''}`);
  });
  exited.catch(() => undefined);

  let nextId = 1;
  const send = (payload: Record<string, unknown>) => {
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  };

  return {
    async request(method, params) {
      const id = nextId++;
      const answer = new Promise<JsonRpcResponse>((resolve) => waiting.set(id, resolve));
      send({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new McpError('timeout', `${config.command} did not answer ${method} within ${Math.round(timeoutMs / 1000)} seconds.`)), timeoutMs);
      });
      try {
        return rpcResult(await Promise.race([answer, spawnFailure, exited, timeout]), method);
      } finally {
        clearTimeout(timer);
        waiting.delete(id);
      }
    },
    async notify(method, params) {
      send({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });
    },
    async close() {
      child.stdin.end();
      if (child.exitCode === null) child.kill();
    },
  };
}

async function withSession<T>(config: McpTransportConfig, options: McpClientOptions, work: (connection: Connection) => Promise<T>): Promise<T> {
  const connection = config.transport === 'http' ? connectHttp(config, options) : await connectStdio(config, options);
  try {
    await connection.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'crewly', version: options.clientVersion ?? '0.0.0' },
    });
    await connection.notify('notifications/initialized');
    return await work(connection);
  } finally {
    await connection.close();
  }
}

/** Connects, lists every tool the server offers (following pagination), and disconnects. */
export async function discoverMcpTools(config: McpTransportConfig, options: McpClientOptions = {}): Promise<McpToolInfo[]> {
  return withSession(config, options, async (connection) => {
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const result = await connection.request('tools/list', cursor ? { cursor } : undefined);
      for (const tool of (result.tools as Array<Record<string, unknown>> | undefined) ?? []) {
        if (typeof tool.name !== 'string') continue;
        tools.push({
          name: tool.name,
          description: typeof tool.description === 'string' ? tool.description : '',
          inputSchema: (tool.inputSchema as Record<string, unknown> | undefined) ?? { type: 'object' },
        });
      }
      cursor = typeof result.nextCursor === 'string' ? result.nextCursor : undefined;
      if (!cursor) break;
    }
    return tools;
  });
}

/** Calls one tool and flattens its content to the text a model reads. */
export async function callMcpTool(
  config: McpTransportConfig,
  name: string,
  args: Record<string, unknown>,
  options: McpClientOptions = {},
): Promise<McpCallResult> {
  return withSession(config, options, async (connection) => {
    const result = await connection.request('tools/call', { name, arguments: args });
    const content = (result.content as Array<Record<string, unknown>> | undefined) ?? [];
    const text = content
      .map((block) => {
        if (block.type === 'text' && typeof block.text === 'string') return block.text;
        if (block.type === 'resource' && block.resource && typeof (block.resource as { text?: unknown }).text === 'string') {
          return (block.resource as { text: string }).text;
        }
        return `[${String(block.type ?? 'content')} omitted]`;
      })
      .join('\n');
    const structured = result.structuredContent ? JSON.stringify(result.structuredContent) : '';
    return { text: text || structured, isError: result.isError === true };
  });
}
