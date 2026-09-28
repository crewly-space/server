import { describe, expect, it } from 'vitest';
import { calculate, utilityToolset } from './utilities.js';

describe('built-in utility tools', () => {
  it('calculates with precedence, parentheses, powers and unary signs', () => {
    expect(calculate('2 + 3 * 4')).toBe(14);
    expect(calculate('(2 + 3) * 4')).toBe(20);
    expect(calculate('2 ^ 3 ^ 2')).toBe(512);
    expect(calculate('-2 * (4.5 - 1.5)')).toBe(-6);
  });

  it('rejects unsafe or invalid expressions', () => {
    expect(() => calculate('process.exit()')).toThrow('number_expected');
    expect(() => calculate('1 / 0')).toThrow('division_by_zero');
  });

  it('returns exact time and hashes without external access', async () => {
    const tools = (await utilityToolset(() => new Date('2026-09-28T08:00:00.000Z'))({} as never, {} as never))!;
    const time = await tools.execute({ id: '1', name: 'current_time', input: { timeZone: 'Europe/Warsaw' } });
    expect(time.content).toContain('2026-09-28T08:00:00.000Z');
    const hash = await tools.execute({ id: '2', name: 'hash_text', input: { text: 'crewly', algorithm: 'sha256' } });
    expect(JSON.parse(hash.content).digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('encodes text, formats JSON, counts text and performs date math', async () => {
    const tools = (await utilityToolset()({} as never, {} as never))!;
    const encoded = await tools.execute({ id: '1', name: 'base64_text', input: { value: 'Crewly 🐾', operation: 'encode' } });
    const decoded = await tools.execute({ id: '2', name: 'base64_text', input: { value: JSON.parse(encoded.content).result, operation: 'decode' } });
    expect(JSON.parse(decoded.content).result).toBe('Crewly 🐾');
    const formatted = await tools.execute({ id: '3', name: 'format_json', input: { json: '{"ready":true}' } });
    expect(JSON.parse(formatted.content).result).toContain('\n');
    const stats = await tools.execute({ id: '4', name: 'text_stats', input: { text: 'two words\n🐾' } });
    expect(JSON.parse(stats.content)).toMatchObject({ words: 3, lines: 2, characters: 11 });
    const date = await tools.execute({ id: '5', name: 'date_math', input: { timestamp: '2026-09-28T10:00:00Z', amount: 2, unit: 'hours' } });
    expect(JSON.parse(date.content).result).toBe('2026-09-28T12:00:00.000Z');
  });

  it('rejects malformed Base64 and timestamps', async () => {
    const tools = (await utilityToolset()({} as never, {} as never))!;
    expect((await tools.execute({ id: '1', name: 'base64_text', input: { value: 'not base64', operation: 'decode' } })).isError).toBe(true);
    expect((await tools.execute({ id: '2', name: 'date_math', input: { timestamp: 'tomorrow-ish', amount: 1, unit: 'days' } })).isError).toBe(true);
  });
});
