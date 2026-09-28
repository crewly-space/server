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
        return { content: `There is no built-in utility called ${call.name}.`, isError: true };
      } catch (error) {
        return { content: `Utility failed: ${error instanceof Error ? error.message : String(error)}`, isError: true };
      }
    },
  });
}
