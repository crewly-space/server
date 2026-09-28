import { createHash, randomUUID } from 'node:crypto';
import type { ToolsetProvider } from '../providers/respond.js';

class ExpressionParser {
  private index = 0;
  constructor(private readonly source: string) {}

  parse(): number {
    const value = this.expression();
    this.space();
    if (this.index !== this.source.length || !Number.isFinite(value)) throw new Error('invalid_expression');
    return value;
  }

  private space() { while (/\s/.test(this.source[this.index] ?? '')) this.index += 1; }
  private take(value: string): boolean {
    this.space();
    if (!this.source.startsWith(value, this.index)) return false;
    this.index += value.length; return true;
  }
  private expression(): number {
    let value = this.term();
    for (;;) { if (this.take('+')) value += this.term(); else if (this.take('-')) value -= this.term(); else return value; }
  }
  private term(): number {
    let value = this.power();
    for (;;) {
      if (this.take('*')) value *= this.power();
      else if (this.take('/')) { const right = this.power(); if (right === 0) throw new Error('division_by_zero'); value /= right; }
      else if (this.take('%')) { const right = this.power(); if (right === 0) throw new Error('division_by_zero'); value %= right; }
      else return value;
    }
  }
  private power(): number {
    const left = this.unary();
    return this.take('^') ? left ** this.power() : left;
  }
  private unary(): number {
    if (this.take('+')) return this.unary();
    if (this.take('-')) return -this.unary();
    return this.primary();
  }
  private primary(): number {
    if (this.take('(')) { const value = this.expression(); if (!this.take(')')) throw new Error('missing_closing_parenthesis'); return value; }
    this.space();
    const match = /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i.exec(this.source.slice(this.index));
    if (!match) throw new Error('number_expected');
    this.index += match[0].length; return Number(match[0]);
  }
}

export function calculate(expression: string): number {
  if (!expression.trim() || expression.length > 200) throw new Error('invalid_expression');
  return new ExpressionParser(expression).parse();
}

/** Small deterministic helpers that make models stop guessing at exact values. */
export function utilityToolset(now: () => Date = () => new Date()): ToolsetProvider {
  return () => ({
    definitions: [
      { name: 'calculate', description: 'Calculate an exact arithmetic expression using +, -, *, /, %, ^ and parentheses.', inputSchema: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'], additionalProperties: false } },
      { name: 'current_time', description: 'Get the exact current time in UTC and optionally in an IANA time zone.', inputSchema: { type: 'object', properties: { timeZone: { type: 'string', description: 'For example Europe/Warsaw.' } }, additionalProperties: false } },
      { name: 'generate_uuid', description: 'Generate one or more cryptographically random UUID v4 identifiers.', inputSchema: { type: 'object', properties: { count: { type: 'number', minimum: 1, maximum: 20 } }, additionalProperties: false } },
      { name: 'hash_text', description: 'Hash text with SHA-256 or SHA-512 and return a lowercase hexadecimal digest.', inputSchema: { type: 'object', properties: { text: { type: 'string' }, algorithm: { type: 'string', enum: ['sha256', 'sha512'] } }, required: ['text'], additionalProperties: false } },
      { name: 'base64_text', description: 'Encode UTF-8 text as Base64 or decode Base64 back to UTF-8.', inputSchema: { type: 'object', properties: { value: { type: 'string' }, operation: { type: 'string', enum: ['encode', 'decode'] } }, required: ['value', 'operation'], additionalProperties: false } },
      { name: 'format_json', description: 'Validate JSON and return it pretty-printed or minified without changing its data.', inputSchema: { type: 'object', properties: { json: { type: 'string' }, style: { type: 'string', enum: ['pretty', 'minified'] } }, required: ['json'], additionalProperties: false } },
      { name: 'text_stats', description: 'Count Unicode characters, words, lines and UTF-8 bytes in text.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } },
      { name: 'url_component', description: 'Encode or decode a URL component exactly.', inputSchema: { type: 'object', properties: { value: { type: 'string' }, operation: { type: 'string', enum: ['encode', 'decode'] } }, required: ['value', 'operation'], additionalProperties: false } },
      { name: 'date_math', description: 'Add or subtract an exact number of seconds, minutes, hours or days from an ISO timestamp.', inputSchema: { type: 'object', properties: { timestamp: { type: 'string' }, amount: { type: 'number' }, unit: { type: 'string', enum: ['seconds', 'minutes', 'hours', 'days'] } }, required: ['timestamp', 'amount', 'unit'], additionalProperties: false } },
    ],
    async execute(call) {
      try {
        if (call.name === 'calculate') return { content: JSON.stringify({ expression: String(call.input.expression ?? ''), result: calculate(String(call.input.expression ?? '')) }) };
        if (call.name === 'current_time') {
          const instant = now(); const timeZone = String(call.input.timeZone ?? 'UTC');
          const local = new Intl.DateTimeFormat('en-CA', { timeZone, dateStyle: 'full', timeStyle: 'long', hourCycle: 'h23' }).format(instant);
          return { content: JSON.stringify({ utc: instant.toISOString(), timeZone, local }) };
        }
        if (call.name === 'generate_uuid') {
          const count = Math.min(20, Math.max(1, Math.trunc(Number(call.input.count ?? 1))));
          return { content: JSON.stringify({ uuids: Array.from({ length: count }, () => randomUUID()) }) };
        }
        if (call.name === 'hash_text') {
          const algorithm = call.input.algorithm === 'sha512' ? 'sha512' : 'sha256';
          return { content: JSON.stringify({ algorithm, digest: createHash(algorithm).update(String(call.input.text ?? '')).digest('hex') }) };
        }
        if (call.name === 'base64_text') {
          const value = String(call.input.value ?? ''); const operation = call.input.operation === 'decode' ? 'decode' : 'encode';
          if (value.length > 100_000) throw new Error('input_too_large');
          if (operation === 'decode' && (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value) || Buffer.from(value, 'base64').toString('base64') !== value)) throw new Error('invalid_base64');
          return { content: JSON.stringify({ operation, result: operation === 'encode' ? Buffer.from(value, 'utf8').toString('base64') : Buffer.from(value, 'base64').toString('utf8') }) };
        }
        if (call.name === 'format_json') {
          const value = String(call.input.json ?? ''); if (value.length > 100_000) throw new Error('input_too_large');
          const parsed = JSON.parse(value) as unknown; const style = call.input.style === 'minified' ? 'minified' : 'pretty';
          return { content: JSON.stringify({ style, result: JSON.stringify(parsed, null, style === 'pretty' ? 2 : 0) }) };
        }
        if (call.name === 'text_stats') {
          const value = String(call.input.text ?? ''); if (value.length > 100_000) throw new Error('input_too_large');
          const trimmed = value.trim();
          return { content: JSON.stringify({ characters: Array.from(value).length, words: trimmed ? trimmed.split(/\s+/u).length : 0,
            lines: value ? value.split(/\r\n|\r|\n/).length : 0, bytes: Buffer.byteLength(value, 'utf8') }) };
        }
        if (call.name === 'url_component') {
          const value = String(call.input.value ?? ''); if (value.length > 100_000) throw new Error('input_too_large');
          const operation = call.input.operation === 'decode' ? 'decode' : 'encode';
          return { content: JSON.stringify({ operation, result: operation === 'encode' ? encodeURIComponent(value) : decodeURIComponent(value) }) };
        }
        if (call.name === 'date_math') {
          const timestamp = new Date(String(call.input.timestamp ?? '')); if (!Number.isFinite(timestamp.getTime())) throw new Error('invalid_timestamp');
          const amount = Number(call.input.amount); if (!Number.isFinite(amount)) throw new Error('invalid_amount');
          const multiplier = call.input.unit === 'days' ? 86_400_000 : call.input.unit === 'hours' ? 3_600_000 : call.input.unit === 'minutes' ? 60_000 : 1_000;
          const result = new Date(timestamp.getTime() + amount * multiplier); if (!Number.isFinite(result.getTime())) throw new Error('date_out_of_range');
          return { content: JSON.stringify({ timestamp: timestamp.toISOString(), amount, unit: call.input.unit, result: result.toISOString() }) };
        }
        return { content: `There is no built-in utility called ${call.name}.`, isError: true };
      } catch (error) {
        return { content: `Utility failed: ${error instanceof Error ? error.message : String(error)}`, isError: true };
      }
    },
  });
}
