export const PROTOCOL_VERSION = '0.1.0';

/** Capabilities describe additive wire features; a client may ignore ones it does not know. */
export const PROTOCOL_CAPABILITIES = [
  'agentd.heartbeat.v1',
  'agentd.capabilities.v1',
] as const;
export type ProtocolCapability = typeof PROTOCOL_CAPABILITIES[number];

export type ProtocolNegotiation = {
  compatible: boolean;
  reason: 'current' | 'legacy-client' | 'invalid-client-version' | 'major-version-mismatch';
  protocolVersion: string;
};

export function negotiateProtocol(clientVersion?: string): ProtocolNegotiation {
  if (!clientVersion) return { compatible: true, reason: 'legacy-client', protocolVersion: PROTOCOL_VERSION };
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(clientVersion);
  if (!match) return { compatible: false, reason: 'invalid-client-version', protocolVersion: PROTOCOL_VERSION };
  const compatible = Number(match[1]) === Number(PROTOCOL_VERSION.split('.')[0]);
  return {
    compatible,
    reason: compatible ? 'current' : 'major-version-mismatch',
    protocolVersion: PROTOCOL_VERSION,
  };
}

/** Capabilities are opt-in so legacy clients are never sent newer operations. */
export function negotiateCapabilities(clientCapabilities?: Record<string, unknown>): ProtocolCapability[] {
  return PROTOCOL_CAPABILITIES.filter((capability) => clientCapabilities?.[capability] === true);
}

export function supportsCapability(capabilities: readonly string[] | undefined, capability: string): boolean {
  return capabilities?.includes(capability) ?? false;
}
