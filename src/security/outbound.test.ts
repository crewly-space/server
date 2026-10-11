import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchPublicHttps, isPrivateOrReservedAddress, parsePublicHttpsUrl, pinnedLookupFor, resolvePublicHttpsUrl } from './outbound.js';

afterEach(() => vi.unstubAllEnvs());

describe('outbound address validation', () => {
  it.each([
    '::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:0001',
    '::ffff:169.254.169.254', '::ffff:a9fe:a9fe', '::ffff:a00:1',
    '0:0:0:0:0:0:0:1',
  ])('blocks private IPv6 address %s in every transport', async (address) => {
    vi.stubEnv('CREWLY_ALLOW_PRIVATE_NETWORK', '');
    const url = `https://[${address}]/`;
    const transport = vi.fn();
    expect(isPrivateOrReservedAddress(address)).toBe(true);
    expect(() => parsePublicHttpsUrl(url)).toThrow('outbound_private_network_blocked');
    await expect(fetchPublicHttps(url, {}, transport)).rejects.toThrow('outbound_private_network_blocked');
    expect(transport).not.toHaveBeenCalled();
  });

  it('blocks a hostname resolving to a hex IPv4-mapped private address', async () => {
    vi.stubEnv('CREWLY_ALLOW_PRIVATE_NETWORK', '');
    await expect(resolvePublicHttpsUrl('https://server.example', async () => [
      { address: '::ffff:7f00:1', family: 6 },
    ])).rejects.toThrow('outbound_private_network_blocked');
  });

  it('accepts public mapped IPv4 addresses and the explicit private-network opt-in', () => {
    vi.stubEnv('CREWLY_ALLOW_PRIVATE_NETWORK', '');
    expect(isPrivateOrReservedAddress('::ffff:8.8.8.8')).toBe(false);
    expect(parsePublicHttpsUrl('https://[::ffff:808:808]/').protocol).toBe('https:');
    vi.stubEnv('CREWLY_ALLOW_PRIVATE_NETWORK', 'true');
    expect(parsePublicHttpsUrl('http://[::ffff:7f00:1]/').protocol).toBe('http:');
  });
});

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
