import type { Database } from '../db/driver.js';
import type { CloudHandoffConfig } from './cloud-handoff.js';

export type AuthMode = 'local' | 'crewly' | 'both';
export interface AuthSettings { mode: AuthMode; crewlyEnabled: boolean; }
interface Row { mode: AuthMode; crewly_enabled: number; handoff_public_key: string | null; }

function row(db: Database): Row { return db.prepare('SELECT mode, crewly_enabled, handoff_public_key FROM auth_settings WHERE id = 1').get() as Row; }
export function getAuthSettings(db: Database): AuthSettings { const value = row(db); return { mode: value.mode, crewlyEnabled: Boolean(value.crewly_enabled) }; }
export function dynamicHandoffConfig(db: Database): CloudHandoffConfig | undefined {
  const settings = row(db); if (!settings.crewly_enabled || !settings.handoff_public_key) return undefined;
  const connection = db.prepare("SELECT instance_id, status, scopes FROM crewly_connection WHERE id = 1").get() as { instance_id: string | null; status: string; scopes: string } | undefined;
  if (!connection?.instance_id || connection.status !== 'connected' || !(JSON.parse(connection.scopes) as string[]).includes('identity')) return undefined;
  return { publicKey: settings.handoff_public_key, deploymentId: connection.instance_id };
}
export function saveAuthSettings(db: Database, input: { mode: AuthMode; publicKey: string | null; updatedBy: string }): AuthSettings {
  const enabled = input.mode === 'crewly' || input.mode === 'both';
  db.prepare('UPDATE auth_settings SET mode = ?, crewly_enabled = ?, handoff_public_key = ?, updated_by = ?, updated_at = ? WHERE id = 1')
    .run(input.mode, enabled ? 1 : 0, enabled ? input.publicKey : null, input.updatedBy, new Date().toISOString());
  return getAuthSettings(db);
}
