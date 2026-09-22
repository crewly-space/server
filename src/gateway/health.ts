import { AGENTD_BACKED_PROVIDER_KINDS, type ProviderKind } from '../protocol/index.js';
import type { Database } from '../db/driver.js';
import type { DeviceConnectionHub } from '../devices/hub.js';
import { listDevicesForUser } from '../devices/repository.js';
import type { ProviderConfigRecord } from '../providers/repository.js';
import { listRecentProviderCalls } from './meter.js';
import type { ProviderRateLimitState, RateLimitBoard } from './rate-limits.js';

export type ProviderHealthStatus = 'healthy' | 'degraded' | 'down' | 'rate_limited' | 'unknown';

export interface ProviderHealth {
  providerId: string;
  kind: ProviderKind;
  status: ProviderHealthStatus;
  /** Why, in words a person can act on. Absent when healthy. */
  reason?: string;
  window: { since: string; calls: number; errors: number; averageLatencyMs: number | null };
  lastSuccessAt: string | null;
  lastError: { code: string; at: string } | null;
  rateLimit: ProviderRateLimitState | null;
  /** Device-backed providers only: whether any paired device can serve it right now. */
  deviceConnected?: boolean;
}

const WINDOW_MS = 60 * 60 * 1000;
/** This many failures in a row, with nothing since, is down rather than flaky. */
const DOWN_AFTER_CONSECUTIVE_ERRORS = 3;

function isDeviceBacked(kind: ProviderKind): boolean {
  return (AGENTD_BACKED_PROVIDER_KINDS as readonly ProviderKind[]).includes(kind);
}

/** True when any connected device belonging to someone on this server advertises the kind. */
export function deviceServesKind(
  db: Database,
  hub: DeviceConnectionHub | undefined,
  kind: ProviderKind,
  ownerUserId?: string,
): boolean {
  if (!hub) return false;
  const owners = ownerUserId
    ? [ownerUserId]
    : (db.prepare('SELECT DISTINCT owner_user_id AS id FROM devices').all() as { id: string }[]).map((row) => row.id);
  return owners.some((owner) =>
    listDevicesForUser(db, owner).some((device) => {
      if (!hub.isConnected(device.id)) return false;
      try {
        const capabilities = JSON.parse(device.capabilities) as { providers?: Array<{ kind?: string }> };
        return capabilities.providers?.some((provider) => provider.kind === kind) ?? false;
      } catch {
        return false;
      }
    }),
  );
}

/**
 * How a provider has been doing, judged from what actually happened to calls
 * made through the gateway in the last hour -- not from whether its settings
 * look complete.
 */
export function providerHealth(
  db: Database,
  config: ProviderConfigRecord,
  options: { rateLimits?: RateLimitBoard; deviceHub?: DeviceConnectionHub; now?: number } = {},
): ProviderHealth {
  const now = options.now ?? Date.now();
  const since = new Date(now - WINDOW_MS).toISOString();
  const calls = listRecentProviderCalls(db, config.id, since);
  const errors = calls.filter((call) => call.status === 'error');
  const lastSuccess = calls.find((call) => call.status === 'ok');
  const lastError = errors[0];
  const rateLimit = options.rateLimits?.get(config.id) ?? null;

  let consecutiveErrors = 0;
  for (const call of calls) {
    if (call.status === 'ok') break;
    consecutiveErrors += 1;
  }

  const base: ProviderHealth = {
    providerId: config.id,
    kind: config.kind,
    status: 'unknown',
    window: {
      since,
      calls: calls.length,
      errors: errors.length,
      averageLatencyMs: lastSuccess
        ? Math.round(
            calls.filter((c) => c.status === 'ok').reduce((sum, c) => sum + c.latencyMs, 0)
              / calls.filter((c) => c.status === 'ok').length,
          )
        : null,
    },
    lastSuccessAt: lastSuccess?.createdAt ?? null,
    lastError: lastError ? { code: lastError.errorCode ?? 'provider_error', at: lastError.createdAt } : null,
    rateLimit,
  };

  if (isDeviceBacked(config.kind)) {
    const connected = deviceServesKind(db, options.deviceHub, config.kind);
    base.deviceConnected = connected;
    if (!connected) {
      return {
        ...base,
        status: 'down',
        reason: config.kind === 'claude-subscription'
          ? 'No paired device with Claude signed in is connected'
          : `No paired device offering ${config.kind} is connected`,
      };
    }
  } else if (!config.apiKey) {
    return { ...base, status: 'down', reason: 'The provider has no API key' };
  }

  if (rateLimit?.limitedUntil) {
    return { ...base, status: 'rate_limited', reason: `Rate limited until ${rateLimit.limitedUntil}` };
  }
  if (lastError?.errorCode === 'provider_auth_failed' && consecutiveErrors > 0) {
    return { ...base, status: 'down', reason: 'The provider rejected its API key' };
  }
  if (consecutiveErrors >= DOWN_AFTER_CONSECUTIVE_ERRORS) {
    return { ...base, status: 'down', reason: `The last ${consecutiveErrors} calls failed (${lastError!.errorCode})` };
  }
  if (calls.length === 0) return base;
  if (errors.length / calls.length > 0.2) {
    return { ...base, status: 'degraded', reason: `${errors.length} of ${calls.length} calls failed in the last hour` };
  }
  return { ...base, status: 'healthy' };
}
