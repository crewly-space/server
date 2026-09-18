import type { Database } from '../db/driver.js';

export interface DeviceRecord {
  id: string;
  owner_user_id: string;
  name: string;
  public_key: string;
  platform: string | null;
  capabilities: string;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PairingRecord {
  id: string;
  poll_token_hash: string;
  user_code: string;
  device_id: string;
  device_name: string;
  public_key: string;
  platform: string | null;
  expires_at: string;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
}

export function getDevice(db: Database, id: string): DeviceRecord | undefined {
  return db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as DeviceRecord | undefined;
}

export function listDevicesForUser(db: Database, userId: string): DeviceRecord[] {
  return db.prepare('SELECT * FROM devices WHERE owner_user_id = ? ORDER BY created_at ASC').all(userId) as DeviceRecord[];
}

export function touchDevice(db: Database, id: string, capabilities?: Record<string, unknown>): void {
  const now = new Date().toISOString();
  if (capabilities) {
    db.prepare('UPDATE devices SET capabilities = ?, last_seen_at = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(capabilities), now, now, id);
  } else {
    db.prepare('UPDATE devices SET last_seen_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
  }
}

export function getPairingByCode(db: Database, code: string): PairingRecord | undefined {
  return db.prepare('SELECT * FROM device_pairings WHERE user_code = ?').get(code) as PairingRecord | undefined;
}

export function getPairing(db: Database, id: string): PairingRecord | undefined {
  return db.prepare('SELECT * FROM device_pairings WHERE id = ?').get(id) as PairingRecord | undefined;
}
