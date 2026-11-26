import type { Pool } from 'pg';

import type { AuthenticatedCapabilities } from '../capabilities/types.js';
import { INSTALLATION_MODULES, type InstallationModuleKey } from './registry.js';

/**
 * Builds the legacy env capability map passed into `takeOverInstallationModules`
 * for every registry module that carries a `legacyEnvKey`.
 */
export function legacyModuleValues(
  capabilities: AuthenticatedCapabilities | undefined,
): Partial<Record<InstallationModuleKey, boolean>> {
  const values: Partial<Record<InstallationModuleKey, boolean>> = {};
  for (const module of INSTALLATION_MODULES) {
    const legacyEnvKey: string | null = module.legacyEnvKey;
    if (legacyEnvKey !== null) {
      values[module.key] = capabilities?.[module.capability] ?? false;
    }
  }
  return values;
}

/**
 * One-time takeover / initialization of `installation_module_state` (MOD-002 / R0).
 * Runs in the API process only, after schema verification and before the server
 * listens. Any thrown error must stop startup.
 *
 * `INSERT ... ON CONFLICT DO NOTHING RETURNING` decides the winner: only the
 * process whose insert returned a row writes the system audit event, in the same
 * transaction. A concurrent loser blocks on the unique key until the winner
 * commits and then does nothing.
 *
 * Fail closed:
 * - If `installation_module_state` contains any key outside the registry,
 *   startup stops and requires controlled recovery.
 * - When a row is missing for a registry module that already has a prior
 *   `MODULE_STATE_TAKEN_OVER` or `MODULE_STATE_INITIALIZED` event, the
 *   transaction rolls back and throws; env is never silently re-derived.
 */
export async function takeOverInstallationModules(
  pool: Pool,
  legacy: Partial<Record<InstallationModuleKey, boolean>>,
  now: () => Date = () => new Date(),
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const registryKeys = INSTALLATION_MODULES.map((module) => module.key);
    const unknownKeys = await client.query<{ module_key: string }>(
      `SELECT module_key FROM installation_module_state
        WHERE NOT (module_key = ANY($1::text[]))
        ORDER BY module_key`,
      [registryKeys],
    );
    if (unknownKeys.rows.length > 0) {
      const keys = unknownKeys.rows.map((row) => row.module_key).join(', ');
      throw new Error(
        `Installation module state contains keys outside the registry: ${keys}; controlled recovery required`,
      );
    }

    for (const module of INSTALLATION_MODULES) {
      const legacyEnvKey: string | null = module.legacyEnvKey;
      let enabled: boolean;
      let source: 'ENV_TAKEOVER' | 'FRESH_INSTALL';
      let eventType: 'MODULE_STATE_TAKEN_OVER' | 'MODULE_STATE_INITIALIZED';

      if (legacyEnvKey !== null) {
        const value = legacy[module.key];
        if (value === undefined) {
          throw new Error(
            `Missing legacy value for installation module ${module.key} (${legacyEnvKey})`,
          );
        }
        enabled = value;
        source = 'ENV_TAKEOVER';
        eventType = 'MODULE_STATE_TAKEN_OVER';
      } else {
        enabled = false;
        source = 'FRESH_INSTALL';
        eventType = 'MODULE_STATE_INITIALIZED';
      }

      const timestamp = now();
      const inserted = await client.query(
        `INSERT INTO installation_module_state (module_key, enabled, source, updated_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (module_key) DO NOTHING
         RETURNING module_key`,
        [module.key, enabled, source, timestamp],
      );
      if (inserted.rowCount === 0) continue;

      const priorTakeover = await client.query(
        `SELECT 1 FROM operator_audit_events
          WHERE event_type IN ('MODULE_STATE_TAKEN_OVER', 'MODULE_STATE_INITIALIZED')
            AND module_key = $1
          LIMIT 1`,
        [module.key],
      );
      if (priorTakeover.rowCount !== 0) {
        throw new Error(
          `Installation module state row for ${module.key} is missing although a takeover event exists; controlled recovery required`,
        );
      }
      await client.query(
        `INSERT INTO operator_audit_events
           (actor_kind, event_type, module_key, new_value, occurred_at)
         VALUES ('SYSTEM', $1, $2, $3::jsonb, $4)`,
        [eventType, module.key, JSON.stringify({ enabled, source }), timestamp],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
