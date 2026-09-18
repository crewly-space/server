import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password.js';

describe('password hashing', () => {
  it('verifies the correct password', () => {
    const stored = hashPassword('correct horse battery staple');
    expect(verifyPassword('correct horse battery staple', stored)).toBe(true);
  });

  it('rejects an incorrect password', () => {
    const stored = hashPassword('correct horse battery staple');
    expect(verifyPassword('wrong password', stored)).toBe(false);
  });

  it('salts each hash differently for the same password', () => {
    const a = hashPassword('same password');
    const b = hashPassword('same password');
    expect(a).not.toEqual(b);
  });
});
