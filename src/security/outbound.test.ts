import { describe, expect, it, vi } from 'vitest';
import { pinnedLookupFor } from './outbound.js';

describe('pinned outbound DNS lookup', () => {
  it('returns an address array when Node requests all addresses', () => {
    const callback = vi.fn();
    const lookup = pinnedLookupFor({ address: '104.18.12.10', family: 4 });

    lookup('openrouter.ai', { all: true }, callback);

    expect(callback).toHaveBeenCalledWith(null, [{ address: '104.18.12.10', family: 4 }]);
  });

  it('retains the legacy address and family callback shape', () => {
    const callback = vi.fn();
    const lookup = pinnedLookupFor({ address: '2606:4700::6812:c0a', family: 6 });

    lookup('openrouter.ai', { family: 0 }, callback);

    expect(callback).toHaveBeenCalledWith(null, '2606:4700::6812:c0a', 6);
  });
});
