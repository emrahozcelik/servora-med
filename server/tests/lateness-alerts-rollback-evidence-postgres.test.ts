import { describe, expect, it } from 'vitest';

import { ALWAYS_OPEN_NOTIFICATION_WINDOW } from '../src/modules/notifications/quiet-hours.js';
import { readDbBaseline } from './support/db-clock-baseline.js';
import {
  MINUTE_MS,
  atLocal,
  buildLatenessAlertWorker,
  databaseUrl,
  insertJob,
  insertOrg,
  insertUser,
  nextOpenDateKey,
  readRollbackEvidence,
  withSchema,
} from './support/ovr6-harness.js';

/**
 * OVR-6 §9.2 / §10 R1 — the rollback-evidence query.
 *
 * A `current` repoint to the previous release is allowed only when the
 * read-only query proves zero rows of the three new notification kinds, the
 * three new activity events and `job_card_lateness_alert_deliveries`. The flag
 * having been off is not evidence; the rows are.
 */

const TZ = 'Europe/Istanbul';

describe.skipIf(!databaseUrl)('OVR-6 rollback evidence', () => {
  it('R1 returns zero on a fresh 069 and non-zero after one alert', async () => {
    await withSchema('ovr6_r1', async (pool) => {
      const baseline = await readDbBaseline(pool);
      const day = nextOpenDateKey(baseline, TZ);
      const organizationId = await insertOrg(pool, 'OVR-6 R1 Klinik');
      const managerId = await insertUser(pool, { organizationId, role: 'MANAGER' });
      const staffId = await insertUser(pool, { organizationId, role: 'STAFF' });
      const scheduledAt = atLocal(day, 14, 0);
      const job = await insertJob(pool, {
        organizationId, type: 'GENERAL_TASK', status: 'ACCEPTED',
        assignedTo: staffId, createdBy: managerId, title: 'Geri alma kanıtı',
        scheduledAt, scheduledEndsAt: atLocal(day, 15, 0), baseNow: baseline,
      });

      // An unrelated activity is not rollback evidence.
      await pool.query(
        `INSERT INTO job_card_activity_logs (organization_id, job_card_id, event_type)
         VALUES ($1, $2, 'JOB_CREATED')`,
        [organizationId, job.id],
      );
      expect(await readRollbackEvidence(pool)).toEqual({
        notificationCount: 0,
        activityCount: 0,
        deliveryCount: 0,
      });

      const scan = { at: new Date(scheduledAt.getTime() + 15 * MINUTE_MS) };
      const worker = buildLatenessAlertWorker(pool, {
        now: () => scan.at,
        notificationWindow: ALWAYS_OPEN_NOTIFICATION_WINDOW,
        timing: { startReminderDelayMs: 15 * MINUTE_MS },
      });
      await worker.runIteration();

      const evidence = await readRollbackEvidence(pool);
      expect(evidence.deliveryCount).toBe(1);
      expect(evidence.activityCount).toBe(1);
      expect(evidence.notificationCount).toBe(1);

      // The query is read-only: running it again changes nothing.
      expect(await readRollbackEvidence(pool)).toEqual(evidence);
      const deliveries = await pool.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM job_card_lateness_alert_deliveries`,
      );
      expect(deliveries.rows[0]!.count).toBe(1);
    });
  });
});
