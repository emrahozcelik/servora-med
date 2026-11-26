import type { Pool } from 'pg';

import { INSTALLATION_MODULES } from './registry.js';

/**
 * One-time takeover of the legacy `*_ENABLED` env values into
 * `installation_module_state` (contract §5). Runs in the API process only,
 * after schema verification and before the server listens. Any thrown error
 * must stop startup.
 *
 * `INSERT ... ON CONFLICT DO NOTHING RETURNING` decides the winner: only the
 * process whose insert returned a row writes the `MODULE_STATE_TAKEN_OVER`
 * audit event, in the same transaction. A concurrent loser blocks on the
 * unique key until the winner commits and then does nothing.
 *
 * Fail closed: when the row is missing but a takeover event already exists
 * (damaged or partial restore), the transaction is rolled back and this throws;
 * the env value is never silently re-derived.
 */
export async function takeOverInstallationModules(
  pool: Pool,
  legacy: { overviewDashboard: boolean },
  now: () => Date = () => new Date(),
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const module of INSTALLATION_MODULES) {
      const enabled = legacy[module.capability];
      const timestamp = now();
      const inserted = await client.query(
        `INSERT INTO installation_module_state (module_key, enabled, source, updated_at)
         VALUES ($1, $2, 'ENV_TAKEOVER', $3)
         ON CONFLICT (module_key) DO NOTHING
         RETURNING module_key`,
        [module.key, enabled, timestamp],
      );
      if (inserted.rowCount === 0) continue;

      const priorTakeover = await client.query(
        `SELECT 1 FROM operator_audit_events
          WHERE event_type = 'MODULE_STATE_TAKEN_OVER' AND module_key = $1
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
         VALUES ('SYSTEM', 'MODULE_STATE_TAKEN_OVER', $1, $2::jsonb, $3)`,
        [module.key, JSON.stringify({ enabled, source: 'ENV_TAKEOVER' }), timestamp],
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
