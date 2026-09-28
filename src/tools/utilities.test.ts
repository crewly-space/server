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
});
