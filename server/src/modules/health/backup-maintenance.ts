import type { Pool } from 'pg';

/**
 * One primary-PostgreSQL read per prospective BR5 positive-health decision.
 * Missing migration, missing row, malformed response or query failure denies
 * admission. No local cache or fail-open fallback across API instances.
 *
 * Revision zero is the seeded PAUSED state; a genuine operator RESUME must
 * advance the CAS revision to at least one.
 */
export async function maintenanceAllowsPositiveBackupHealth(pool: Pool): Promise<boolean> {
  try {
    const result = await pool.query<{ paused: unknown; revision: unknown }>(
      `SELECT paused, revision
         FROM backup_health_maintenance_state
        WHERE singleton -- br5_maintenance_admission`,
    );
    if (result.rows.length !== 1) return false;
    const row = result.rows[0]!;
    const revision = typeof row.revision === 'string'
      ? row.revision
      : typeof row.revision === 'number' && Number.isSafeInteger(row.revision)
        ? String(row.revision)
        : null;
    return row.paused === false
      && revision !== null
      && /^[1-9][0-9]*$/.test(revision);
  } catch {
    return false;
  }
}
