// A minimal MCP server over stdio, for tests: echo, and read the TOKEN it was started with.
import readline from 'node:readline';

const tools = [
  { name: 'echo', description: 'Echo text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'whoami', description: 'Say which TOKEN and HOME_SECRET it can see', inputSchema: { type: 'object' } },
];

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  let result;
  if (message.method === 'initialize') {
    result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '1' } };
  } else if (message.method === 'tools/list') {
    result = { tools };
  } else if (message.method === 'tools/call' && message.params.name === 'echo') {
    result = { content: [{ type: 'text', text: message.params.arguments.text }] };
  } else if (message.method === 'tools/call' && message.params.name === 'whoami') {
    result = { content: [{ type: 'text', text: `${process.env.TOKEN ?? '(no token)'} ${process.env.HOME_SECRET ?? '(no home secret)'}` }] };
  } else {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unknown method' } })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
});
