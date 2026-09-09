import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import {
  hasValidPlannedInterval,
  isPlannedIntervalJobType,
} from '../src/modules/job-cards/job-card-duration.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCardType } from '../src/modules/job-cards/types.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrations = [
  '001_auth_foundation.sql',
  '002_delivery_tracer.sql',
  '003_people.sql',
  '004_crm_contacts.sql',
  '005_product_catalog.sql',
  '006_jobcard_workspace.sql',
  '007_sales_meeting.sql',
  '008_meeting_approval_withdrawal.sql',
  '009_job_acceptance_and_scheduling.sql',
  '010_entity_delete_audit.sql',
  '011_create_realtime_events.sql',
  '012_create_in_app_notifications.sql',
  '013_create_job_action_locations.sql',
  '014_create_web_push.sql',
  '015_job_card_engagement_kind.sql',
  '016_google_reverse_geocoding.sql',
  '017_calendar.sql',
  '018_messaging.sql',
  '019_job_card_operational_note_context.sql',
  '020_job_card_transition_note_contexts.sql',
  '021_job_card_note_added_notification_kind.sql',
  '022_job_card_follow_up_links.sql',
  '024_job_card_notes_invoice_number.sql',
  '027_follow_up_proposals.sql',
  '028_notification_center_dismissal.sql',
  '029_messaging_conversation_archive.sql',
  '030_backup_domain_foundation.sql',
  '031_backup_engine_failure_taxonomy_and_dump_version.sql',
  '032_backup_r2_failure_taxonomy.sql',
  '033_backup_worker_runtime.sql',
  '034_demo_data_foundation.sql',
  '035_demo_data_purge_foundation.sql',
  '036_job_card_invalidated.sql',
  '042_unsuccessful_visit_reason.sql',
  '043_job_card_schedule_and_assignment_history.sql',
  '044_job_card_accountability_facts.sql',
] as const;

async function applyMigrations(pool: Pool) {
  for (const migration of migrations) {
    const path = fileURLToPath(
      new URL(`../src/db/migrations/${migration}`, import.meta.url),
    );
    await pool.query(await readFile(path, 'utf8'));
  }
}

async function withMigratedDatabase(run: (pool: Pool) => Promise<void>) {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `r3_interval_start_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool | null = null;

  try {
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema},public`,
    });
    await applyMigrations(pool);
    await run(pool);
  } finally {
    await pool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  }
}

const NOW_ISO = '2026-09-09T12:00:00.000Z';

type Schedule = { at: string | null; endsAt: string | null };

async function createOrganization(pool: Pool) {
  return (await pool.query<{ id: string }>(
    `INSERT INTO organizations (name) VALUES ('R3 interval start') RETURNING id`,
  )).rows[0]!.id;
}

async function createUser(pool: Pool, organizationId: string, role: string) {
  return (await pool.query<{ id: string }>(
    `INSERT INTO users (organization_id, name, email, password_hash, role)
     VALUES ($1, 'R3 User', $2, 'unused-test-hash', $3)
     RETURNING id`,
    [organizationId, `${randomUUID()}@test.local`, role],
  )).rows[0]!.id;
}

async function createAcceptedJob(
  pool: Pool,
  organizationId: string,
  actorUserId: string,
  type: JobCardType,
  schedule: Schedule,
) {
  const engagementKind = type === 'SALES_MEETING' ? 'SALES_MEETING' : null;
  const jobCardId = (await pool.query<{ id: string }>(
    `INSERT INTO job_cards
       (organization_id, type, status, title, assigned_to, created_by,
        accepted_at, accepted_by, scheduled_at, scheduled_ends_at, engagement_kind)
     VALUES ($1, $2, 'ACCEPTED', 'R3 interval job', $3, $3,
             '2026-09-09T09:00:00.000Z', $3, $4, $5, $6)
     RETURNING id`,
    [organizationId, type, actorUserId, schedule.at, schedule.endsAt, engagementKind],
  )).rows[0]!.id;
  await pool.query(
    `INSERT INTO job_card_schedule_revisions
       (organization_id, job_card_id, revision_no, organization_timezone, source, created_by)
     VALUES ($1, $2, 1, 'Europe/Istanbul', 'CREATE', $3)`,
    [organizationId, jobCardId, actorUserId],
  );
  return jobCardId;
}

function plainService(pool: Pool) {
  return new JobCardService(
    new PostgresJobCardRepository(pool),
    () => new Date(NOW_ISO),
  );
}

function geoService(
  pool: Pool,
  onReverse?: () => Promise<void>,
  counter?: { calls: number },
) {
  return new JobCardService(
    new PostgresJobCardRepository(pool),
    () => new Date(NOW_ISO),
    undefined,
    {
      enabled: true,
      reverseGeocoder: {
        reverse: async () => {
          if (counter) counter.calls += 1;
          if (onReverse) await onReverse();
          return {
            neighborhood: 'Kızılay', district: 'Çankaya', city: 'Ankara',
            approximateLabel: 'Kızılay, Çankaya / Ankara',
          };
        },
      },
    },
  );
}

function startRequest(clientActionId: string, expectedVersion = 1) {
  return { clientActionId, expectedVersion };
}

function geoStartRequest(clientActionId: string, expectedVersion = 1) {
  return {
    clientActionId,
    expectedVersion,
    locationCapture: {
      outcome: 'captured' as const,
      latitude: 39.92077,
      longitude: 32.85411,
      accuracyMeters: 24,
      capturedAt: '2026-09-09T11:59:58.000Z',
    },
  };
}

async function sideEffectCounts(
  pool: Pool,
  organizationId: string,
  jobCardId: string,
  actorUserId: string,
  clientActionId: string,
) {
  const row = (await pool.query<{
    status: string;
    version: number;
    activityCount: number;
    locationCount: number;
    realtimeCount: number;
    actionCount: number;
    revisionCount: number;
  }>(
    `SELECT j.status, j.version,
       (SELECT COUNT(*)::int FROM job_card_activity_logs a
         WHERE a.organization_id = j.organization_id AND a.job_card_id = j.id) AS "activityCount",
       (SELECT COUNT(*)::int FROM job_action_locations l
         WHERE l.organization_id = j.organization_id AND l.job_card_id = j.id) AS "locationCount",
       (SELECT COUNT(*)::int FROM realtime_events r
         WHERE r.organization_id = j.organization_id AND r.entity_id = j.id) AS "realtimeCount",
       (SELECT COUNT(*)::int FROM processed_actions p
         WHERE p.organization_id = j.organization_id AND p.user_id = $3
           AND p.client_action_id = $2) AS "actionCount",
       (SELECT COUNT(*)::int FROM job_card_schedule_revisions s
         WHERE s.organization_id = j.organization_id AND s.job_card_id = j.id
           AND s.revision_no > 1) AS "revisionCount"
     FROM job_cards j WHERE j.organization_id = $1 AND j.id = $4`,
    [organizationId, clientActionId, actorUserId, jobCardId],
  )).rows[0]!;
  return row;
}

describe('hasValidPlannedInterval', () => {
  it('requires a positive finite interval only for scheduled job types', () => {
    expect(isPlannedIntervalJobType('SALES_MEETING')).toBe(true);
    expect(isPlannedIntervalJobType('PRODUCT_DELIVERY')).toBe(true);
    expect(isPlannedIntervalJobType('GENERAL_TASK')).toBe(false);
    // Valid intervals (canonical and noncanonical legacy alike).
    expect(hasValidPlannedInterval('SALES_MEETING', '2026-09-09T09:00:00.000Z', '2026-09-09T10:00:00.000Z')).toBe(true);
    expect(hasValidPlannedInterval('SALES_MEETING', '2026-09-09T09:00:00.000Z', '2026-09-09T09:45:00.000Z')).toBe(true);
    expect(hasValidPlannedInterval('PRODUCT_DELIVERY', '2026-09-09T13:00:00.000Z', '2026-09-09T14:00:00.000Z')).toBe(true);
    // Missing bounds.
    expect(hasValidPlannedInterval('SALES_MEETING', '2026-09-09T09:00:00.000Z', null)).toBe(false);
    expect(hasValidPlannedInterval('PRODUCT_DELIVERY', null, null)).toBe(false);
    // Degenerate bounds (normally blocked by the DB CHECK as well).
    expect(hasValidPlannedInterval('SALES_MEETING', '2026-09-09T09:00:00.000Z', '2026-09-09T09:00:00.000Z')).toBe(false);
    expect(hasValidPlannedInterval('PRODUCT_DELIVERY', '2026-09-09T10:00:00.000Z', '2026-09-09T09:00:00.000Z')).toBe(false);
    expect(hasValidPlannedInterval('SALES_MEETING', 'not-a-date', '2026-09-09T10:00:00.000Z')).toBe(false);
    // GENERAL_TASK stays open-ended.
    expect(hasValidPlannedInterval('GENERAL_TASK', null, null)).toBe(true);
    expect(hasValidPlannedInterval('GENERAL_TASK', '2026-09-09T09:00:00.000Z', null)).toBe(true);
  });
});

describe.skipIf(!databaseUrl)('R3 SM/PD START requires a valid scheduled interval', () => {
  it.each([
    ['PD canonical 30m', 'PRODUCT_DELIVERY', { at: '2026-09-09T10:00:00.000Z', endsAt: '2026-09-09T10:30:00.000Z' }],
    ['PD noncanonical 50m', 'PRODUCT_DELIVERY', { at: '2026-09-09T10:00:00.000Z', endsAt: '2026-09-09T10:50:00.000Z' }],
    ['SM canonical 60m', 'SALES_MEETING', { at: '2026-09-09T09:00:00.000Z', endsAt: '2026-09-09T10:00:00.000Z' }],
    ['SM noncanonical 45m', 'SALES_MEETING', { at: '2026-09-09T09:00:00.000Z', endsAt: '2026-09-09T09:45:00.000Z' }],
    ['GT open-ended', 'GENERAL_TASK', { at: null, endsAt: null }],
  ] as const)('START succeeds: %s', async (_label, type, schedule) => {
    await withMigratedDatabase(async (pool) => {
      const organizationId = await createOrganization(pool);
      const actorUserId = await createUser(pool, organizationId, 'STAFF');
      const jobCardId = await createAcceptedJob(pool, organizationId, actorUserId, type, schedule);
      const actor = { id: actorUserId, organizationId, role: 'STAFF' as const };

      await plainService(pool).start(actor, jobCardId, startRequest(randomUUID()));

      const job = (await pool.query<{ status: string; version: number }>(
        `SELECT status, version FROM job_cards WHERE id = $1`, [jobCardId],
      )).rows[0]!;
      expect(job).toMatchObject({ status: 'IN_PROGRESS', version: 2 });
    });
  });

  it.each([
    ['PD missing end', 'PRODUCT_DELIVERY', { at: '2026-09-09T10:00:00.000Z', endsAt: null }],
    ['PD missing both', 'PRODUCT_DELIVERY', { at: null, endsAt: null }],
    ['SM missing end', 'SALES_MEETING', { at: '2026-09-09T09:00:00.000Z', endsAt: null }],
    ['SM missing both', 'SALES_MEETING', { at: null, endsAt: null }],
  ] as const)('START rejects invalid interval: %s', async (_label, type, schedule) => {
    await withMigratedDatabase(async (pool) => {
      const organizationId = await createOrganization(pool);
      const actorUserId = await createUser(pool, organizationId, 'STAFF');
      const jobCardId = await createAcceptedJob(pool, organizationId, actorUserId, type, schedule);
      const actor = { id: actorUserId, organizationId, role: 'STAFF' as const };
      const clientActionId = randomUUID();

      await expect(
        plainService(pool).start(actor, jobCardId, startRequest(clientActionId)),
      ).rejects.toMatchObject({ code: 'SCHEDULED_INTERVAL_REQUIRED', statusCode: 400 });

      expect(await sideEffectCounts(pool, organizationId, jobCardId, actorUserId, clientActionId)).toEqual({
        status: 'ACCEPTED', version: 1,
        activityCount: 0, locationCount: 0, realtimeCount: 0,
        actionCount: 0, revisionCount: 0,
      });
    });
  });

  it('keeps the DB CHECK authoritative for zero-length intervals', async () => {
    await withMigratedDatabase(async (pool) => {
      const organizationId = await createOrganization(pool);
      const actorUserId = await createUser(pool, organizationId, 'STAFF');
      await expect(pool.query(
        `INSERT INTO job_cards
           (organization_id, type, status, title, assigned_to, created_by,
            accepted_at, accepted_by, scheduled_at, scheduled_ends_at)
         VALUES ($1, 'SALES_MEETING', 'ACCEPTED', 'R3 zero-length', $2, $2,
                 '2026-09-09T09:00:00.000Z', $2,
                 '2026-09-09T09:00:00.000Z', '2026-09-09T09:00:00.000Z')`,
        [organizationId, actorUserId],
      )).rejects.toMatchObject({ code: '23514' });
    });
  });

  it('does not disclose schedule state to unauthorized actors', async () => {
    await withMigratedDatabase(async (pool) => {
      const organizationId = await createOrganization(pool);
      const staffUserId = await createUser(pool, organizationId, 'STAFF');
      const adminUserId = await createUser(pool, organizationId, 'ADMIN');
      const managerUserId = await createUser(pool, organizationId, 'MANAGER');
      const otherStaffUserId = await createUser(pool, organizationId, 'STAFF');
      const jobCardId = await createAcceptedJob(
        pool, organizationId, staffUserId, 'SALES_MEETING', { at: null, endsAt: null },
      );

      for (const [role, userId] of [
        ['ADMIN', adminUserId],
        ['MANAGER', managerUserId],
        ['STAFF', otherStaffUserId],
      ] as const) {
        await expect(
          plainService(pool).start(
            { id: userId, organizationId, role }, jobCardId, startRequest(randomUUID()),
          ),
        ).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
      }
    });
  });

  it('preserves START time eligibility for a valid future interval', async () => {
    await withMigratedDatabase(async (pool) => {
      const organizationId = await createOrganization(pool);
      const actorUserId = await createUser(pool, organizationId, 'STAFF');
      const jobCardId = await createAcceptedJob(pool, organizationId, actorUserId, 'SALES_MEETING', {
        at: '2026-09-09T15:00:00.000Z', endsAt: '2026-09-09T16:00:00.000Z',
      });
      const actor = { id: actorUserId, organizationId, role: 'STAFF' as const };

      await expect(
        plainService(pool).start(actor, jobCardId, startRequest(randomUUID())),
      ).rejects.toMatchObject({ code: 'INVALID_TRANSITION', statusCode: 409 });
    });
  });

  it('geo START with a pre-known invalid interval invokes no provider work', async () => {
    await withMigratedDatabase(async (pool) => {
      const organizationId = await createOrganization(pool);
      const actorUserId = await createUser(pool, organizationId, 'STAFF');
      const jobCardId = await createAcceptedJob(pool, organizationId, actorUserId, 'PRODUCT_DELIVERY', {
        at: '2026-09-09T10:00:00.000Z', endsAt: null,
      });
      const actor = { id: actorUserId, organizationId, role: 'STAFF' as const };
      const clientActionId = randomUUID();
      const counter = { calls: 0 };

      await expect(
        geoService(pool, undefined, counter).start(actor, jobCardId, geoStartRequest(clientActionId)),
      ).rejects.toMatchObject({ code: 'SCHEDULED_INTERVAL_REQUIRED', statusCode: 400 });

      expect(counter.calls).toBe(0);
      expect(await sideEffectCounts(pool, organizationId, jobCardId, actorUserId, clientActionId)).toEqual({
        status: 'ACCEPTED', version: 1,
        activityCount: 0, locationCount: 0, realtimeCount: 0,
        actionCount: 0, revisionCount: 0,
      });
    });
  });

  it('geo START with a valid interval preserves existing geolocation behavior', async () => {
    await withMigratedDatabase(async (pool) => {
      const organizationId = await createOrganization(pool);
      const actorUserId = await createUser(pool, organizationId, 'STAFF');
      const jobCardId = await createAcceptedJob(pool, organizationId, actorUserId, 'PRODUCT_DELIVERY', {
        at: '2026-09-09T10:00:00.000Z', endsAt: '2026-09-09T10:30:00.000Z',
      });
      const actor = { id: actorUserId, organizationId, role: 'STAFF' as const };
      const counter = { calls: 0 };

      await geoService(pool, undefined, counter).start(
        actor, jobCardId, geoStartRequest(randomUUID()),
      );

      expect(counter.calls).toBe(1);
      const job = (await pool.query<{ status: string; version: number }>(
        `SELECT status, version FROM job_cards WHERE id = $1`, [jobCardId],
      )).rows[0]!;
      expect(job).toMatchObject({ status: 'IN_PROGRESS', version: 2 });
      const locations = (await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM job_action_locations WHERE job_card_id = $1`, [jobCardId],
      )).rows[0]!;
      expect(Number(locations.count)).toBe(1);
    });
  });

  it('authoritative TX check rejects a schedule corrupted after the precheck', async () => {
    await withMigratedDatabase(async (pool) => {
      const organizationId = await createOrganization(pool);
      const actorUserId = await createUser(pool, organizationId, 'STAFF');
      const jobCardId = await createAcceptedJob(pool, organizationId, actorUserId, 'SALES_MEETING', {
        at: '2026-09-09T09:00:00.000Z', endsAt: '2026-09-09T09:45:00.000Z',
      });
      const actor = { id: actorUserId, organizationId, role: 'STAFF' as const };
      const clientActionId = randomUUID();
      const counter = { calls: 0 };
      // Race fixture: the pre-read sees a valid interval; the provider seam
      // corrupts the authoritative row (without touching expectedVersion)
      // before the locked transaction read.
      const corruptSchedule = async () => {
        await pool.query(`UPDATE job_cards SET scheduled_ends_at = NULL WHERE id = $1`, [jobCardId]);
      };

      await expect(
        geoService(pool, corruptSchedule, counter).start(
          actor, jobCardId, geoStartRequest(clientActionId),
        ),
      ).rejects.toMatchObject({ code: 'SCHEDULED_INTERVAL_REQUIRED', statusCode: 400 });

      // Provider work may already have happened in this artificial race.
      expect(counter.calls).toBe(1);
      expect(await sideEffectCounts(pool, organizationId, jobCardId, actorUserId, clientActionId)).toEqual({
        status: 'ACCEPTED', version: 1,
        activityCount: 0, locationCount: 0, realtimeCount: 0,
        actionCount: 0, revisionCount: 0,
      });
    });
  });

  it('completed exact START replay survives a later schedule change', async () => {
    await withMigratedDatabase(async (pool) => {
      const organizationId = await createOrganization(pool);
      const actorUserId = await createUser(pool, organizationId, 'STAFF');
      const jobCardId = await createAcceptedJob(pool, organizationId, actorUserId, 'PRODUCT_DELIVERY', {
        at: '2026-09-09T10:00:00.000Z', endsAt: '2026-09-09T10:30:00.000Z',
      });
      const actor = { id: actorUserId, organizationId, role: 'STAFF' as const };
      const clientActionId = randomUUID();
      const counter = { calls: 0 };
      const service = geoService(pool, undefined, counter);
      const request = geoStartRequest(clientActionId);

      const first = await service.start(actor, jobCardId, request);
      await pool.query(`UPDATE job_cards SET scheduled_ends_at = NULL WHERE id = $1`, [jobCardId]);

      const replay = await service.start(actor, jobCardId, request);
      // Replay replays the original success receipt against current truth
      // (the corrupted schedule is visible in the read model) without
      // re-executing the transition or re-evaluating R3.
      expect(replay).toMatchObject({ status: 'IN_PROGRESS', version: 2, id: jobCardId });
      expect(first).toMatchObject({ status: 'IN_PROGRESS', version: 2, id: jobCardId });
      expect(counter.calls).toBe(1);
      const job = (await pool.query<{ status: string; version: number }>(
        `SELECT status, version FROM job_cards WHERE id = $1`, [jobCardId],
      )).rows[0]!;
      expect(job).toMatchObject({ status: 'IN_PROGRESS', version: 2 });
    });
  });

  it('same key with a changed START request still conflicts without schedule masking', async () => {
    await withMigratedDatabase(async (pool) => {
      const organizationId = await createOrganization(pool);
      const actorUserId = await createUser(pool, organizationId, 'STAFF');
      const jobCardId = await createAcceptedJob(pool, organizationId, actorUserId, 'SALES_MEETING', {
        at: '2026-09-09T09:00:00.000Z', endsAt: '2026-09-09T10:00:00.000Z',
      });
      const actor = { id: actorUserId, organizationId, role: 'STAFF' as const };
      const clientActionId = randomUUID();
      const service = plainService(pool);

      await service.start(actor, jobCardId, startRequest(clientActionId, 1));
      await pool.query(`UPDATE job_cards SET scheduled_ends_at = NULL WHERE id = $1`, [jobCardId]);

      await expect(
        service.start(actor, jobCardId, startRequest(clientActionId, 2)),
      ).rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED', statusCode: 409 });
    });
  });
});
