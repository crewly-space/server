import { describe, expect, it } from 'vitest';
import { can } from './model.js';

describe('can', () => {
  it('allows any role to create an agent', () => {
    expect(can('member', 'agent:create')).toBe(true);
    expect(can('admin', 'agent:create')).toBe(true);
    expect(can('owner', 'agent:create')).toBe(true);
  });

  it('requires at least admin to manage group members', () => {
    expect(can('member', 'group:manage_members')).toBe(false);
    expect(can('admin', 'group:manage_members')).toBe(true);
    expect(can('owner', 'group:manage_members')).toBe(true);
  });
});
