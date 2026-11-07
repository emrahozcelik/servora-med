import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { maintenanceAllowsPositiveBackupHealth } from '../src/modules/health/backup-maintenance.js';
import { evaluateBr5PositiveHealthAdmission } from '../src/modules/backup/freshness-policy.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDirectory = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

describe.skipIf(!databaseUrl)('BR5 installation-wide maintenance admission PG17', () => {
  const schema = `br5maint_${randomUUID().replaceAll('-', '')}`;
  const admin = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
  let apiA: Pool;
  let apiB: Pool;

  beforeAll(async () => {
    if (!admin) return;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const options = { connectionString: databaseUrl, options: `-c search_path=${schema},public` };
    apiA = new Pool(options);
    apiB = new Pool(options);
    await runMigrations({ migrationsDirectory, store: new PostgresMigrationStore(apiA) });
  });

  afterAll(async () => {
    await apiA?.end();
    await apiB?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  const transition = async (
    pool: Pool, revision: number, paused: boolean, ticket: string, reason: string,
  ): Promise<string> => {
    const result = await pool.query<{ revision: string }>(
      `SELECT backup_health_maintenance_transition(
        $1::bigint, $2::boolean, $3::text, $4::text, $5::text
      ) AS revision`,
      [revision, paused, 'BR5_TEST_OPERATOR', ticket, reason],
    );
    return result.rows[0]!.revision;
  };

  it('starts in PAUSED state with a matching immutable initial audit record', async () => {
    const state = await apiA.query<{ paused: boolean; revision: string; reason_code: string }>(
      `SELECT paused, revision, reason_code FROM backup_health_maintenance_state WHERE singleton`,
    );
    expect(state.rows).toEqual([{ paused: true, revision: '0', reason_code: 'INITIAL_HOLD' }]);
    const event = await apiB.query<{ revision: string; paused: boolean; reason_code: string }>(
      `SELECT revision, paused, reason_code FROM backup_health_maintenance_events ORDER BY revision`,
    );
    expect(event.rows).toEqual([{ revision: '0', paused: true, reason_code: 'INITIAL_HOLD' }]);
    expect(await maintenanceAllowsPositiveBackupHealth(apiA)).toBe(false);
    expect(await maintenanceAllowsPositiveBackupHealth(apiB)).toBe(false);
  });

  it('uses a single DB CAS revision across two API instances and writes audit history', async () => {
    const attempts = await Promise.allSettled([
      transition(apiA, 0, false, 'OWNER-APPROVED-TEST-A', 'POST_MAINTENANCE_CHECK'),
      transition(apiB, 0, false, 'OWNER-APPROVED-TEST-B', 'POST_MAINTENANCE_CHECK'),
    ]);
    expect(attempts.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((x) => x.status === 'rejected')).toHaveLength(1);

    expect(await maintenanceAllowsPositiveBackupHealth(apiA)).toBe(true);
    expect(await maintenanceAllowsPositiveBackupHealth(apiB)).toBe(true);
    // Resuming maintenance is NOT a positive health security qualification.
    expect(evaluateBr5PositiveHealthAdmission()).toBe('BLOCKED');

    await expect(transition(
      apiB, 0, true, 'STALE', 'EMERGENCY_HOLD',
    )).rejects.toThrow();
    await expect(transition(
      apiA, 1, false, 'SAME-STATE', 'POST_MAINTENANCE_CHECK',
    )).rejects.toThrow();
    await expect(transition(
      apiA, 1, true, 'BAD-REASON', 'POST_MAINTENANCE_CHECK',
    )).rejects.toThrow();

    expect(await transition(
      apiB, 1, true, 'OWNER-APPROVED-TEST-C', 'SCHEDULED_MAINTENANCE',
    )).toBe('2');
    expect(await maintenanceAllowsPositiveBackupHealth(apiA)).toBe(false);
    expect(await maintenanceAllowsPositiveBackupHealth(apiB)).toBe(false);

    const events = await apiB.query<{
      revision: string; paused: boolean; reason_code: string; ticket_ref: string;
    }>(`SELECT revision, paused, reason_code, ticket_ref
          FROM backup_health_maintenance_events ORDER BY revision`);
    expect(events.rows).toHaveLength(3);
    expect(events.rows.map((x) => [x.revision, x.paused])).toEqual([
      ['0', true], ['1', false], ['2', true],
    ]);
    expect(events.rows[2]).toMatchObject({
      reason_code: 'SCHEDULED_MAINTENANCE',
      ticket_ref: 'OWNER-APPROVED-TEST-C',
    });

    await expect(apiA.query(
      `UPDATE backup_health_maintenance_events SET paused = false WHERE revision = 1`,
    )).rejects.toThrow();
    await expect(apiA.query(
      `DELETE FROM backup_health_maintenance_events WHERE revision = 2`,
    )).rejects.toThrow();
    await expect(apiA.query(
      `DELETE FROM backup_health_maintenance_state WHERE singleton`,
    )).rejects.toThrow();

    // A direct authorized owner UPDATE with a missing revision increment must
    // also fail rather than bypass the transition ledger.
    await expect(apiA.query(
      `UPDATE backup_health_maintenance_state SET paused = FALSE WHERE singleton`,
    )).rejects.toThrow();
    const final = await apiA.query<{ paused: boolean; revision: string }>(
      `SELECT paused, revision FROM backup_health_maintenance_state WHERE singleton`,
    );
    expect(final.rows).toEqual([{ paused: true, revision: '2' }]);
  });
});
