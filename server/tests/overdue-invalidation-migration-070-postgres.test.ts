/**
 * OVR-2 migration 070 rehearsal on existing data (PostgreSQL).
 *
 * External-review ask: prove that `070_overdue_incident_invalidation_closure`
 * upgrades a database that already carries OVR-2/OVR-5 incident history —
 *
 * - open rows,
 * - recovered rows,
 * - rows ended by an authorized deadline extension (`DEADLINE_EXTENDED` with
 *   its appended schedule revision, exactly as 066 requires),
 * - and a historical `INVALIDATED` JobCard whose incident is still open (the
 *   owner rejects evidence-less backfill, so it must stay open),
 *
 * without executing any DML. Every seeded row is compared before/after
 * (including `xmin`, which only changes on UPDATE/DELETE), every constraint is
 * checked for existence and validation, the new `CARD_INVALIDATED` shape is
 * enforced next to the unchanged `DEADLINE_EXTENDED` shape, and a second
 * runner pass is a no-op.
 *
 * The upgrade path mirrors the established pattern in
 * `sale-integer-migration-postgres.test.ts`: copy `001..069` into a temporary
 * directory, migrate with it, seed the historical rows, then run the real
 * repository directory so exactly 070 is applied.
 */
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDirectory = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
const MIGRATION_069 = '069_lateness_alerts_and_quiet_hours';
const MIGRATION_070 = '070_overdue_incident_invalidation_closure';
const TIMEZONE = 'Europe/Istanbul';

async function at069(run: (pool: Pool, store: PostgresMigrationStore) => Promise<void>): Promise<void> {
  const admin = new Pool({ connectionString: databaseUrl });
  const schema = `ovr2_070_${randomUUID().replaceAll('-', '')}`.toLowerCase();
  const previous = await mkdtemp(path.join(tmpdir(), 'ovr2-070-head069-'));
  let pool: Pool | null = null;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema},public`,
    });
    for (const filename of (await readdir(migrationsDirectory)).filter(
      (name) => /^\d{3}_.+\.sql$/.test(name) && Number(name.slice(0, 3)) <= 69,
    )) {
      await copyFile(
        path.join(migrationsDirectory, filename),
        path.join(previous, filename),
      );
    }
    const store = new PostgresMigrationStore(pool);
    const applied = await runMigrations({ migrationsDirectory: previous, store });
    expect(applied.appliedVersions.at(-1)).toBe(MIGRATION_069);
    expect(applied.appliedVersions).toHaveLength(69);
    await run(pool, store);
  } finally {
    await pool?.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
    await rm(previous, { recursive: true, force: true });
  }
}

async function insertOrganization(pool: Pool, name: string): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO organizations (name, timezone) VALUES ($1, $2) RETURNING id`,
    [name, TIMEZONE],
  )).rows[0]!.id;
}

async function insertUser(
  pool: Pool,
  organizationId: string,
  role: 'ADMIN' | 'MANAGER' | 'STAFF',
  name: string,
): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO users (organization_id, name, email, password_hash, role, is_active)
     VALUES ($1, $2, $3, 'test-hash', $4, TRUE) RETURNING id`,
    [organizationId, name, `${randomUUID()}@test.local`, role],
  )).rows[0]!.id;
}

async function insertJob(
  pool: Pool,
  input: {
    organizationId: string;
    staffId: string;
    title: string;
    invalidatedBy?: string;
  },
): Promise<string> {
  const invalidated = input.invalidatedBy !== undefined;
  return (await pool.query<{ id: string }>(
    `INSERT INTO job_cards
       (organization_id, type, status, title, assigned_to, created_by,
        invalidated_at, invalidated_by, invalidation_reason_code)
     VALUES ($1, 'GENERAL_TASK', $2, $3, $4, $4, $5, $6, $7)
     RETURNING id`,
    [
      input.organizationId,
      invalidated ? 'INVALIDATED' : 'NEW',
      input.title,
      input.staffId,
      invalidated ? new Date('2026-07-01T09:00:00.000Z') : null,
      input.invalidatedBy ?? null,
      invalidated ? 'DUPLICATE' : null,
    ],
  )).rows[0]!.id;
}

async function insertScheduleRevision(
  pool: Pool,
  input: {
    organizationId: string;
    jobCardId: string;
    revisionNo: number;
    createdBy: string;
    scheduledAt: string;
    scheduledEndsAt: string;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO job_card_schedule_revisions
       (organization_id, job_card_id, revision_no, scheduled_at, scheduled_ends_at,
        organization_timezone, source, created_by, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      input.organizationId,
      input.jobCardId,
      input.revisionNo,
      new Date(input.scheduledAt),
      new Date(input.scheduledEndsAt),
      TIMEZONE,
      input.revisionNo === 1 ? 'CREATE' : 'RESCHEDULE',
      input.createdBy,
      new Date('2026-06-30T06:00:00.000Z'),
    ],
  );
}

type IncidentSeed = {
  organizationId: string;
  jobCardId: string;
  scheduleRevisionNo: number;
  episodeNo?: number;
  breachedAt?: string;
  accountableUserId: string;
  recoveredAt?: string;
  recoveryActorUserId?: string;
  ending?: {
    endedAt: string;
    endedByUserId: string;
    endReason: string;
    endNote: string | null;
    endedByScheduleRevisionNo: number | null;
  };
};

async function insertIncident(pool: Pool, seed: IncidentSeed): Promise<string> {
  const breachedAt = new Date(seed.breachedAt ?? '2026-06-30T07:30:00.000Z');
  return (await pool.query<{ id: string }>(
    `INSERT INTO job_card_overdue_incidents
       (organization_id, job_card_id, delay_type, episode_no, schedule_revision_no,
        deadline_at, breached_at, accountable_user_id, accountable_role,
        accountable_source, source, recovered_at, recovery_actor_user_id,
        ended_at, ended_by_user_id, end_reason, end_note, ended_by_schedule_revision_no)
     VALUES ($1, $2, 'LATE_SUBMISSION', $3, $4, $5, $5, $6, 'STAFF',
             'ASSIGNMENT_AT_BREACH', 'TRANSITION', $7, $8, $9, $10, $11, $12, $13)
     RETURNING id`,
    [
      seed.organizationId,
      seed.jobCardId,
      seed.episodeNo ?? 1,
      seed.scheduleRevisionNo,
      breachedAt,
      seed.accountableUserId,
      seed.recoveredAt === undefined ? null : new Date(seed.recoveredAt),
      seed.recoveryActorUserId ?? null,
      seed.ending === undefined ? null : new Date(seed.ending.endedAt),
      seed.ending?.endedByUserId ?? null,
      seed.ending?.endReason ?? null,
      seed.ending?.endNote ?? null,
      seed.ending?.endedByScheduleRevisionNo ?? null,
    ],
  )).rows[0]!.id;
}

/** Set the complete ending shape on one existing row (all five columns). */
async function setEnding(
  pool: Pool,
  incidentId: string,
  ending: {
    endedAt: Date | null;
    endedByUserId: string | null;
    endReason: string | null;
    endNote: string | null;
    endedByScheduleRevisionNo: number | null;
  },
): Promise<void> {
  await pool.query(
    `UPDATE job_card_overdue_incidents
        SET ended_at = $2,
            ended_by_user_id = $3,
            end_reason = $4,
            end_note = $5,
            ended_by_schedule_revision_no = $6
      WHERE id = $1`,
    [
      incidentId,
      ending.endedAt,
      ending.endedByUserId,
      ending.endReason,
      ending.endNote,
      ending.endedByScheduleRevisionNo,
    ],
  );
}

async function snapshot(
  pool: Pool,
  table: 'incidents' | 'jobs' | 'revisions',
) {
  const TABLES = {
    incidents: 'job_card_overdue_incidents',
    jobs: 'job_cards',
    revisions: 'job_card_schedule_revisions',
  } as const;
  return (await pool.query(`SELECT *, xmin::text AS xmin FROM ${TABLES[table]} ORDER BY id`)).rows;
}

async function tableConstraints(pool: Pool) {
  return (await pool.query<{
    conname: string; contype: string; convalidated: boolean; definition: string;
  }>(
    `SELECT c.conname, c.contype, c.convalidated, pg_get_constraintdef(c.oid) AS definition
       FROM pg_constraint c
      WHERE c.conrelid = 'job_card_overdue_incidents'::regclass
      ORDER BY c.conname`,
  )).rows;
}

describe.skipIf(!databaseUrl)('OVR-2 migration 070 on existing incident history', () => {
  it('upgrades 069 data to 070 without DML, keeps every seeded row identical and enforces both ending shapes', async () => {
    await at069(async (pool, store) => {
      const organizationId = await insertOrganization(pool, 'OVR2 070 Rehearsal');
      const adminId = await insertUser(pool, organizationId, 'ADMIN', 'OVR2 Yönetici');
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'OVR2 Müdür');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'OVR2 Personel');

      const openJobId = await insertJob(pool, {
        organizationId, staffId, title: 'Açık gecikme',
      });
      const recoveredJobId = await insertJob(pool, {
        organizationId, staffId, title: 'Kapanmış gecikme',
      });
      const endedJobId = await insertJob(pool, {
        organizationId, staffId, title: 'Uzatılmış gecikme',
      });
      // Historical shape: the card was invalidated before the closure rule
      // existed, so its incident is still open and must never be backfilled.
      const historicalJobId = await insertJob(pool, {
        organizationId, staffId, title: 'Eski geçersiz iş', invalidatedBy: adminId,
      });
      for (const jobCardId of [openJobId, recoveredJobId, endedJobId, historicalJobId]) {
        await insertScheduleRevision(pool, {
          organizationId,
          jobCardId,
          revisionNo: 1,
          createdBy: staffId,
          scheduledAt: '2026-06-30T06:00:00.000Z',
          scheduledEndsAt: '2026-06-30T07:00:00.000Z',
        });
      }
      // 066 requires the appended revision that proved the new boundary.
      await insertScheduleRevision(pool, {
        organizationId,
        jobCardId: endedJobId,
        revisionNo: 2,
        createdBy: managerId,
        scheduledAt: '2026-07-01T06:00:00.000Z',
        scheduledEndsAt: '2026-07-01T07:00:00.000Z',
      });

      const openIncidentId = await insertIncident(pool, {
        organizationId,
        jobCardId: openJobId,
        scheduleRevisionNo: 1,
        accountableUserId: staffId,
      });
      const recoveredIncidentId = await insertIncident(pool, {
        organizationId,
        jobCardId: recoveredJobId,
        scheduleRevisionNo: 1,
        accountableUserId: staffId,
        recoveredAt: '2026-06-30T07:40:00.000Z',
        recoveryActorUserId: staffId,
      });
      const endedIncidentId = await insertIncident(pool, {
        organizationId,
        jobCardId: endedJobId,
        scheduleRevisionNo: 1,
        accountableUserId: staffId,
        ending: {
          endedAt: '2026-06-30T08:00:00.000Z',
          endedByUserId: managerId,
          endReason: 'DEADLINE_EXTENDED',
          endNote: 'Müşteri randevusu ertelendi.',
          endedByScheduleRevisionNo: 2,
        },
      });
      const historicalIncidentId = await insertIncident(pool, {
        organizationId,
        jobCardId: historicalJobId,
        scheduleRevisionNo: 1,
        accountableUserId: staffId,
      });

      const incidentsBefore = await snapshot(pool, 'incidents');
      const jobsBefore = await snapshot(pool, 'jobs');
      const revisionsBefore = await snapshot(pool, 'revisions');
      const migrationsBefore = (await pool.query(
        'SELECT version, applied_at FROM schema_migrations ORDER BY version',
      )).rows;
      expect(incidentsBefore).toHaveLength(4);
      expect(migrationsBefore.at(-1)!.version).toBe(MIGRATION_069);

      // 1) Apply exactly 070 over the existing rows.
      const upgrade = await runMigrations({ migrationsDirectory, store });
      expect(upgrade).toEqual({ appliedVersions: [MIGRATION_070] });

      // 2) No DML: every seeded row is byte-identical, including its xmin,
      //    and the migration ledger only gained 070.
      expect(await snapshot(pool, 'incidents')).toEqual(incidentsBefore);
      expect(await snapshot(pool, 'jobs')).toEqual(jobsBefore);
      expect(await snapshot(pool, 'revisions')).toEqual(revisionsBefore);
      const migrationsAfter = (await pool.query<{ version: string }>(
        'SELECT version FROM schema_migrations ORDER BY version',
      )).rows;
      expect(migrationsAfter).toHaveLength(70);
      expect(migrationsAfter.at(-1)!.version).toBe(MIGRATION_070);
      expect(migrationsAfter.filter((row) => row.version === MIGRATION_070)).toHaveLength(1);

      // 3) The historical invalidated card's incident is still open: the
      //    migration never backfills an administrative closure.
      const historical = (await pool.query<Record<string, unknown>>(
        `SELECT recovered_at, recovery_actor_user_id, ended_at, ended_by_user_id,
                end_reason, end_note, ended_by_schedule_revision_no
           FROM job_card_overdue_incidents WHERE id = $1`,
        [historicalIncidentId],
      )).rows[0]!;
      expect(historical).toEqual({
        recovered_at: null,
        recovery_actor_user_id: null,
        ended_at: null,
        ended_by_user_id: null,
        end_reason: null,
        end_note: null,
        ended_by_schedule_revision_no: null,
      });
      // The seeded states stayed where they were seeded.
      const states = await pool.query<{ id: string; state: string }>(
        `SELECT id,
                CASE WHEN recovered_at IS NOT NULL THEN 'RECOVERED'
                     WHEN end_reason = 'DEADLINE_EXTENDED' THEN 'DEADLINE_EXTENDED'
                     ELSE 'OPEN' END AS state
           FROM job_card_overdue_incidents ORDER BY id`,
      );
      const stateById = new Map(states.rows.map((row) => [row.id, row.state]));
      expect(stateById.get(openIncidentId)).toBe('OPEN');
      expect(stateById.get(recoveredIncidentId)).toBe('RECOVERED');
      expect(stateById.get(endedIncidentId)).toBe('DEADLINE_EXTENDED');

      // 4) Every CHECK on the table exists and is validated; both new
      //    definitions are in place next to the untouched OVR-5 family.
      const constraints = await tableConstraints(pool);
      const byName = new Map(constraints.map((constraint) => [constraint.conname, constraint]));
      expect(constraints.filter((constraint) => constraint.contype === 'c'
        && constraint.convalidated !== true)).toEqual([]);
      expect(byName.get('job_card_overdue_incidents_ending_set_check')).toMatchObject({
        convalidated: true,
        definition: expect.stringContaining('CARD_INVALIDATED'),
      });
      expect(byName.get('job_card_overdue_incidents_ending_set_check')!.definition)
        .toContain('DEADLINE_EXTENDED');
      expect(byName.get('job_card_overdue_incidents_ending_set_check')!.definition)
        .toContain('ended_by_schedule_revision_no');
      expect(byName.get('job_card_overdue_incidents_end_reason_check')).toMatchObject({
        convalidated: true,
        definition: expect.stringContaining('CARD_INVALIDATED'),
      });
      for (const name of [
        'job_card_overdue_incidents_ending_exclusive_check',
        'job_card_overdue_incidents_ending_instant_check',
        'job_card_overdue_incidents_end_note_check',
        'job_card_overdue_incidents_recovery_pair_check',
        'job_card_overdue_incidents_breach_instant_check',
        'job_card_overdue_incidents_ended_by_user_fk',
        'job_card_overdue_incidents_ended_by_revision_fk',
      ]) {
        expect(byName.get(name)?.convalidated).toBe(true);
      }

      // 5) The OVR-5 shape is unchanged and stays strict.
      let episodeNo = 2;
      const freshOpenIncident = () => insertIncident(pool, {
        organizationId,
        jobCardId: openJobId,
        scheduleRevisionNo: 1,
        episodeNo: episodeNo++,
        accountableUserId: staffId,
      });
      const deadlineExtended = {
        endedAt: new Date('2026-06-30T08:00:00.000Z'),
        endedByUserId: managerId,
        endReason: 'DEADLINE_EXTENDED',
        endNote: 'Yeni tarih onaylandı.',
        endedByScheduleRevisionNo: 1,
      };
      const extendedWithoutRevision = await freshOpenIncident();
      await expect(setEnding(pool, extendedWithoutRevision, {
        ...deadlineExtended, endedByScheduleRevisionNo: null,
      })).rejects.toMatchObject({
        code: '23514',
        constraint: 'job_card_overdue_incidents_ending_set_check',
      });
      const extendedWithoutNote = await freshOpenIncident();
      await expect(setEnding(pool, extendedWithoutNote, {
        ...deadlineExtended, endNote: null,
      })).rejects.toMatchObject({
        code: '23514',
        constraint: 'job_card_overdue_incidents_ending_set_check',
      });

      // 6) CARD_INVALIDATED needs the instant, actor and reason, and must not
      //    claim a schedule revision; the accepted shape round-trips.
      const cardInvalidation = {
        endedAt: new Date('2026-07-02T09:00:00.000Z'),
        endedByUserId: adminId,
        endReason: 'CARD_INVALIDATED',
        endNote: null,
        endedByScheduleRevisionNo: null,
      };
      const invalidatedWithRevision = await freshOpenIncident();
      await expect(setEnding(pool, invalidatedWithRevision, {
        ...cardInvalidation, endedByScheduleRevisionNo: 1,
      })).rejects.toMatchObject({
        code: '23514',
        constraint: 'job_card_overdue_incidents_ending_set_check',
      });
      const invalidatedWithoutActor = await freshOpenIncident();
      await expect(setEnding(pool, invalidatedWithoutActor, {
        ...cardInvalidation, endedByUserId: null,
      })).rejects.toMatchObject({
        code: '23514',
        constraint: 'job_card_overdue_incidents_ending_set_check',
      });
      const invalidatedWithoutInstant = await freshOpenIncident();
      await expect(setEnding(pool, invalidatedWithoutInstant, {
        ...cardInvalidation, endedAt: null,
      })).rejects.toMatchObject({
        code: '23514',
        constraint: 'job_card_overdue_incidents_ending_set_check',
      });
      const unknownReason = await freshOpenIncident();
      // An unknown reason violates both the ending shape and the closed
      // vocabulary; PostgreSQL reports one of them, so the code is the proof.
      await expect(setEnding(pool, unknownReason, {
        ...cardInvalidation, endReason: 'OTHER',
      })).rejects.toMatchObject({ code: '23514' });
      const accepted = await freshOpenIncident();
      await setEnding(pool, accepted, cardInvalidation);
      expect((await pool.query<Record<string, unknown>>(
        `SELECT recovered_at, ended_at, ended_by_user_id, end_reason, end_note,
                ended_by_schedule_revision_no
           FROM job_card_overdue_incidents WHERE id = $1`,
        [accepted],
      )).rows[0]).toEqual({
        recovered_at: null,
        ended_at: new Date('2026-07-02T09:00:00.000Z'),
        ended_by_user_id: adminId,
        end_reason: 'CARD_INVALIDATED',
        end_note: null,
        ended_by_schedule_revision_no: null,
      });

      // 7) Recovery and ending stay mutually exclusive: a recovered row can
      //    never gain an administrative closure.
      await expect(setEnding(pool, recoveredIncidentId, cardInvalidation))
        .rejects.toMatchObject({
          code: '23514',
          constraint: 'job_card_overdue_incidents_ending_exclusive_check',
        });

      // 8) Runner idempotency: a second pass applies nothing and the applied
      //    history is unchanged.
      expect(await runMigrations({ migrationsDirectory, store }))
        .toEqual({ appliedVersions: [] });
      expect((await pool.query(
        'SELECT version FROM schema_migrations ORDER BY version',
      )).rows).toEqual(migrationsAfter);
    });
  });
});
