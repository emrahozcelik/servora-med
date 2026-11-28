import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import type { AppError } from '../src/errors/index.js';
import type { SafeUser } from '../src/modules/auth/types.js';
import {
  PostgresOverdueBreachScannerRepository,
  createOverdueBreachScanner,
} from '../src/modules/job-cards/overdue-breach-scanner.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCardActor } from '../src/modules/job-cards/types.js';
import {
  ALWAYS_OPEN_NOTIFICATION_WINDOW,
  DEFAULT_NOTIFICATION_WINDOW,
} from '../src/modules/notifications/quiet-hours.js';
import { PostgresReportsRepository } from '../src/modules/reports/repository.js';
import { ReportsService } from '../src/modules/reports/service.js';
import { readDbBaseline } from './support/db-clock-baseline.js';
import {
  HOUR_MS,
  MINUTE_MS,
  actor,
  addDays,
  atLocal,
  buildJobCardService,
  buildLatenessAlertWorker,
  buildOverdueReminderWorker,
  databaseUrl,
  insertCustomer,
  insertIncident,
  insertJob,
  insertOffer,
  insertOrg,
  insertUser,
  nextOpenDateKey,
  nextSundayDateKey,
  selectActivities,
  selectIncidents,
  selectLatenessDeliveries,
  selectNotifications,
  selectOverdueDeliveries,
  shift,
  withSchema,
} from './support/ovr6-harness.js';
import { passThroughReportReadSnapshot } from './support/report-read-snapshot.js';

/**
 * RESCUE-003/B — Neutral acknowledgement (`ACKNOWLEDGED_ONLY`) and atomic
 * `PATCH` `CORRECTED` closure PostgreSQL acceptance suite.
 *
 * Covers:
 * - Migration 077 fail-closed preconditions, clean 076 -> 077 upgrade, and DB CHECKs
 * - ACKNOWLEDGED_ONLY via `resolveChangeRequest`: permissions, tenant isolation,
 *   note bounds, linkedJobCardId rejection, and zero mutation to job/offers/incidents
 * - Idempotency replay, payload mismatch conflict (409), and concurrent resolution race
 * - Activity projection for `JOB_CHANGE_REQUEST_RESOLVED`
 * - OVR-7 exclusion + legacy grouping continuity + subsequent qualifying closure
 * - OVR-4 & OVR-6 alert worker resumption (undelivered), suppression (delivered),
 *   quiet-hours deferral, and `changeRequestOpenSince` reset
 * - Atomic `PATCH` `CORRECTED` (field edit + closure, rollback, no-op & role rejection)
 * - Started/terminal job guards, JOB-009 follow-up continuity, SALE-002/003 pair guards,
 *   and optional modules disabled
 */

const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
const MIGRATION_076 = '076_assignment_offer_suggested_solution';
const MIGRATION_077 = '077_change_request_acknowledged_only';
const TZ = 'Europe/Istanbul';

async function rejectionOf(action: () => Promise<unknown>): Promise<AppError> {
  try {
    await action();
  } catch (error) {
    return error as AppError;
  }
  throw new Error('Expected promise to reject');
}

function safeUser(id: string, organizationId: string, role: SafeUser['role'], name: string): SafeUser {
  return {
    id,
    organizationId,
    name,
    email: `${id}@rescue003b.test`,
    role,
    mustChangePassword: false,
    isActive: true,
    version: 1,
  };
}

function buildReportsService(pool: Pool, now: () => Date): ReportsService {
  const repository = new PostgresReportsRepository(pool);
  return new ReportsService(
    repository,
    passThroughReportReadSnapshot(repository, null),
    now,
  );
}

async function readChangeRequestRow(pool: Pool, changeRequestId: string) {
  return (await pool.query<{
    id: string;
    state: string;
    resolution: string | null;
    resolved_by: string | null;
    resolved_at: Date | null;
    resolution_note: string | null;
    linked_job_card_id: string | null;
  }>(
    `SELECT id, state, resolution, resolved_by, resolved_at, resolution_note, linked_job_card_id
       FROM job_card_change_requests
      WHERE id = $1`,
    [changeRequestId],
  )).rows[0]!;
}

async function readJobSnapshot(pool: Pool, jobCardId: string) {
  return (await pool.query<{
    status: string;
    version: number;
    title: string;
    description: string | null;
    customer_id: string | null;
    contact_id: string | null;
    assigned_to: string;
    priority: string;
    due_date: string | null;
    scheduled_at: Date | null;
    scheduled_ends_at: Date | null;
    engagement_kind: string | null;
    started_at: Date | null;
  }>(
    `SELECT status, version, title, description, customer_id, contact_id,
            assigned_to, priority, due_date::text AS due_date,
            scheduled_at, scheduled_ends_at, engagement_kind, started_at
       FROM job_cards
      WHERE id = $1`,
    [jobCardId],
  )).rows[0]!;
}

describe.skipIf(!databaseUrl)('RESCUE-003/B neutral acknowledgement and atomic CORRECTED', () => {
  it('migration 077: pre-existing 076 rows survive clean upgrade and DB CHECKs enforce ACKNOWLEDGED_ONLY rules', async () => {
    const adminPool = new Pool({ connectionString: databaseUrl });
    const schema = `rescue003b_mig_${randomUUID().replaceAll('-', '')}`;
    const legacyDirectory = await mkdtemp(path.join(tmpdir(), 'rescue003b-076-'));
    let pool: Pool | null = null;
    try {
      await adminPool.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({
        connectionString: databaseUrl,
        options: `-c search_path=${schema},public`,
      });
      for (const name of await readdir(MIGRATIONS_DIRECTORY)) {
        if (!name.endsWith('.sql') || name >= '077_') continue;
        await copyFile(
          path.join(MIGRATIONS_DIRECTORY, name),
          path.join(legacyDirectory, name),
        );
      }
      const store = new PostgresMigrationStore(pool);
      const before = await runMigrations({ migrationsDirectory: legacyDirectory, store });
      expect(before.appliedVersions.at(-1)).toBe(MIGRATION_076);

      const orgId = await insertOrg(pool, 'Migration 077 Org');
      const managerId = await insertUser(pool, { organizationId: orgId, role: 'MANAGER', name: 'Müdür' });
      const staffId = await insertUser(pool, { organizationId: orgId, role: 'STAFF', name: 'Personel' });
      const baseline = await readDbBaseline(pool);
      const jobA = await insertJob(pool, {
        organizationId: orgId, type: 'GENERAL_TASK', status: 'IN_PROGRESS',
        assignedTo: staffId, createdBy: managerId, baseNow: baseline,
      });
      const jobB = await insertJob(pool, {
        organizationId: orgId, type: 'GENERAL_TASK', status: 'IN_PROGRESS',
        assignedTo: staffId, createdBy: managerId, baseNow: baseline,
      });
      const linkedTarget = await insertJob(pool, {
        organizationId: orgId, type: 'GENERAL_TASK', status: 'NEW',
        assignedTo: staffId, createdBy: managerId, baseNow: baseline,
      });

      const openReqId = (await pool.query<{ id: string }>(
        `INSERT INTO job_card_change_requests
           (organization_id, job_card_id, requested_by, requested_at, job_status_at_request,
            reason_code, reason_text, client_action_id, state)
         VALUES ($1, $2, $3, $4, 'IN_PROGRESS', 'CUSTOMER_POSTPONED', 'Bekleyen talep', $5, 'OPEN')
         RETURNING id`,
        [orgId, jobA.id, staffId, baseline, randomUUID()],
      )).rows[0]!.id;
      const closedReqId = (await pool.query<{ id: string }>(
        `INSERT INTO job_card_change_requests
           (organization_id, job_card_id, requested_by, requested_at, job_status_at_request,
            reason_code, reason_text, client_action_id, state,
            resolution, resolved_by, resolved_at, resolution_note)
         VALUES ($1, $2, $3, $4, 'IN_PROGRESS', 'OTHER', 'Eski reddedilen talep', $5, 'CLOSED',
                 'REJECTED', $6, $4, 'Eski ret notu')
         RETURNING id`,
        [orgId, jobB.id, staffId, baseline, randomUUID(), managerId],
      )).rows[0]!.id;

      const upgrade = await runMigrations({ migrationsDirectory: MIGRATIONS_DIRECTORY, store });
      expect(upgrade.appliedVersions).toEqual([MIGRATION_077]);
      expect(await runMigrations({ migrationsDirectory: MIGRATIONS_DIRECTORY, store })).toEqual({
        appliedVersions: [],
      });

      expect(await readChangeRequestRow(pool, openReqId)).toMatchObject({
        state: 'OPEN', resolution: null, resolution_note: null,
      });
      expect(await readChangeRequestRow(pool, closedReqId)).toMatchObject({
        state: 'CLOSED', resolution: 'REJECTED', resolution_note: 'Eski ret notu',
      });

      // Valid ACKNOWLEDGED_ONLY row
      const validAckId = (await pool.query<{ id: string }>(
        `INSERT INTO job_card_change_requests
           (organization_id, job_card_id, requested_by, requested_at, job_status_at_request,
            reason_code, reason_text, client_action_id, state,
            resolution, resolved_by, resolved_at, resolution_note)
         VALUES ($1, $2, $3, $4, 'IN_PROGRESS', 'OTHER', 'Talep', $5, 'CLOSED',
                 'ACKNOWLEDGED_ONLY', $6, $4, 'Kayıt altına alındı.')
         RETURNING id`,
        [orgId, jobB.id, staffId, baseline, randomUUID(), managerId],
      )).rows[0]!.id;
      expect(validAckId).toBeTruthy();

      // Reject ACKNOWLEDGED_ONLY with NULL note
      await expect(pool.query(
        `INSERT INTO job_card_change_requests
           (organization_id, job_card_id, requested_by, requested_at, job_status_at_request,
            reason_code, reason_text, client_action_id, state,
            resolution, resolved_by, resolved_at, resolution_note)
         VALUES ($1, $2, $3, $4, 'IN_PROGRESS', 'OTHER', 'Talep', $5, 'CLOSED',
                 'ACKNOWLEDGED_ONLY', $6, $4, NULL)`,
        [orgId, jobB.id, staffId, baseline, randomUUID(), managerId],
      )).rejects.toMatchObject({
        code: '23514',
        constraint: 'job_card_change_requests_closure_check',
      });

      // Reject ACKNOWLEDGED_ONLY with blank note
      await expect(pool.query(
        `INSERT INTO job_card_change_requests
           (organization_id, job_card_id, requested_by, requested_at, job_status_at_request,
            reason_code, reason_text, client_action_id, state,
            resolution, resolved_by, resolved_at, resolution_note)
         VALUES ($1, $2, $3, $4, 'IN_PROGRESS', 'OTHER', 'Talep', $5, 'CLOSED',
                 'ACKNOWLEDGED_ONLY', $6, $4, '   ')`,
        [orgId, jobB.id, staffId, baseline, randomUUID(), managerId],
      )).rejects.toMatchObject({
        code: '23514',
        constraint: 'job_card_change_requests_resolution_note_check',
      });

      // Reject ACKNOWLEDGED_ONLY with > 2000 note
      await expect(pool.query(
        `INSERT INTO job_card_change_requests
           (organization_id, job_card_id, requested_by, requested_at, job_status_at_request,
            reason_code, reason_text, client_action_id, state,
            resolution, resolved_by, resolved_at, resolution_note)
         VALUES ($1, $2, $3, $4, 'IN_PROGRESS', 'OTHER', 'Talep', $5, 'CLOSED',
                 'ACKNOWLEDGED_ONLY', $6, $4, $7)`,
        [orgId, jobB.id, staffId, baseline, randomUUID(), managerId, 'x'.repeat(2001)],
      )).rejects.toMatchObject({
        code: '23514',
        constraint: 'job_card_change_requests_resolution_note_check',
      });

      // Reject ACKNOWLEDGED_ONLY with linked_job_card_id
      await expect(pool.query(
        `INSERT INTO job_card_change_requests
           (organization_id, job_card_id, requested_by, requested_at, job_status_at_request,
            reason_code, reason_text, client_action_id, state,
            resolution, resolved_by, resolved_at, resolution_note, linked_job_card_id)
         VALUES ($1, $2, $3, $4, 'IN_PROGRESS', 'OTHER', 'Talep', $5, 'CLOSED',
                 'ACKNOWLEDGED_ONLY', $6, $4, 'Not var.', $7)`,
        [orgId, jobB.id, staffId, baseline, randomUUID(), managerId, linkedTarget.id],
      )).rejects.toMatchObject({
        code: '23514',
        constraint: 'job_card_change_requests_closure_check',
      });

      // Reject REJECTED with NULL note (preserved invariant)
      await expect(pool.query(
        `INSERT INTO job_card_change_requests
           (organization_id, job_card_id, requested_by, requested_at, job_status_at_request,
            reason_code, reason_text, client_action_id, state,
            resolution, resolved_by, resolved_at, resolution_note)
         VALUES ($1, $2, $3, $4, 'IN_PROGRESS', 'OTHER', 'Talep', $5, 'CLOSED',
                 'REJECTED', $6, $4, NULL)`,
        [orgId, jobB.id, staffId, baseline, randomUUID(), managerId],
      )).rejects.toMatchObject({
        code: '23514',
        constraint: 'job_card_change_requests_closure_check',
      });

      // Reject OPEN with ACKNOWLEDGED_ONLY
      await expect(pool.query(
        `INSERT INTO job_card_change_requests
           (organization_id, job_card_id, requested_by, requested_at, job_status_at_request,
            reason_code, reason_text, client_action_id, state, resolution)
         VALUES ($1, $2, $3, $4, 'IN_PROGRESS', 'OTHER', 'Talep', $5, 'OPEN', 'ACKNOWLEDGED_ONLY')`,
        [orgId, linkedTarget.id, staffId, baseline, randomUUID()],
      )).rejects.toMatchObject({
        code: '23514',
        constraint: 'job_card_change_requests_closure_check',
      });
    } finally {
      await pool?.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
      await rm(legacyDirectory, { recursive: true, force: true });
    }
  });

  it('migration 077 guard fails closed and rolls back when 064 constraint drifted', async () => {
    const adminPool = new Pool({ connectionString: databaseUrl });
    const schema = `rescue003b_guard_${randomUUID().replaceAll('-', '')}`;
    const legacyDirectory = await mkdtemp(path.join(tmpdir(), 'rescue003b-guard-'));
    let pool: Pool | null = null;
    try {
      await adminPool.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({
        connectionString: databaseUrl,
        options: `-c search_path=${schema},public`,
      });
      for (const name of await readdir(MIGRATIONS_DIRECTORY)) {
        if (!name.endsWith('.sql') || name >= '077_') continue;
        await copyFile(
          path.join(MIGRATIONS_DIRECTORY, name),
          path.join(legacyDirectory, name),
        );
      }
      const store = new PostgresMigrationStore(pool);
      const before = await runMigrations({ migrationsDirectory: legacyDirectory, store });
      expect(before.appliedVersions.at(-1)).toBe(MIGRATION_076);

      // Hand-tamper closure constraint so it misses the exact 064 definition.
      await pool.query(
        'ALTER TABLE job_card_change_requests DROP CONSTRAINT job_card_change_requests_closure_check',
      );
      await pool.query(
        `ALTER TABLE job_card_change_requests
           ADD CONSTRAINT job_card_change_requests_closure_check
           CHECK (state IN ('OPEN', 'CLOSED'))`,
      );

      const failure = await rejectionOf(() => runMigrations({
        migrationsDirectory: MIGRATIONS_DIRECTORY,
        store,
      }));
      expect(failure.message).toContain('must match the exact 064 definition');

      const applied = (await pool.query<{ version: string }>(
        'SELECT version FROM schema_migrations ORDER BY version ASC',
      )).rows.map((row) => row.version);
      expect(applied.at(-1)).toBe(MIGRATION_076);
      expect(applied).not.toContain(MIGRATION_077);
    } finally {
      await pool?.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
      await rm(legacyDirectory, { recursive: true, force: true });
    }
  });

  it('ACKNOWLEDGED_ONLY enforces role/tenant/note/linkedJobCardId and leaves job, offers, and incidents untouched', async () => {
    await withSchema('rescue003b_ack', async (pool) => {
      const baseline = await readDbBaseline(pool);
      const orgId = await insertOrg(pool, 'RESCUE-003B Ack Org');
      const otherOrgId = await insertOrg(pool, 'Komşu Org');
      const managerId = await insertUser(pool, { organizationId: orgId, role: 'MANAGER', name: 'Müdür' });
      const adminId = await insertUser(pool, { organizationId: orgId, role: 'ADMIN', name: 'Admin' });
      const otherManagerId = await insertUser(pool, { organizationId: otherOrgId, role: 'MANAGER', name: 'Komşu Müdür' });
      const staffId = await insertUser(pool, { organizationId: orgId, role: 'STAFF', name: 'Personel' });

      const scheduledAt = shift(baseline, 2 * HOUR_MS);
      const scheduledEndsAt = shift(baseline, 3 * HOUR_MS);
      const job1 = await insertJob(pool, {
        organizationId: orgId, type: 'SALES_MEETING', status: 'ACCEPTED',
        assignedTo: staffId, createdBy: managerId,
        scheduledAt, scheduledEndsAt, baseNow: baseline,
      });
      const job2 = await insertJob(pool, {
        organizationId: orgId, type: 'GENERAL_TASK', status: 'IN_PROGRESS',
        assignedTo: staffId, createdBy: managerId, baseNow: baseline,
      });
      const offerId = await insertOffer(pool, {
        organizationId: orgId, jobCardId: job1.id, assigneeUserId: staffId,
        openedBy: managerId, openedAt: shift(baseline, -HOUR_MS),
        acceptanceDueAt: shift(baseline, HOUR_MS), state: 'ACCEPTED',
        closedAt: shift(baseline, -30 * MINUTE_MS), closedBy: staffId,
      });
      const incidentId = await insertIncident(pool, {
        organizationId: orgId, jobCardId: job1.id, delayType: 'LATE_START',
        deadlineAt: scheduledEndsAt, breachedAt: scheduledEndsAt,
        accountableUserId: staffId, accountableRole: 'STAFF',
      });

      const clock = { now: shift(baseline, 5 * MINUTE_MS) };
      const { service } = buildJobCardService(pool, clock, { assignmentWindowEnabled: true });
      const staff = actor(staffId, orgId, 'STAFF');
      const manager = actor(managerId, orgId, 'MANAGER');
      const admin = actor(adminId, orgId, 'ADMIN');
      const otherManager = actor(otherManagerId, otherOrgId, 'MANAGER');

      const req1 = await service.createChangeRequest(staff, job1.id, {
        clientActionId: randomUUID(),
        reasonCode: 'CUSTOMER_POSTPONED',
        reasonText: 'Müşteri bilgilendirmesi yapıldı.',
      });
      const req2 = await service.createChangeRequest(staff, job2.id, {
        clientActionId: randomUUID(),
        reasonCode: 'OTHER',
        reasonText: 'İkinci talep notu.',
      });

      // Guards: STAFF 403, cross-tenant 404, missing/blank/>2000 note 400, linkedJobCardId 400
      await expect(service.resolveChangeRequest(staff, job1.id, req1.changeRequestId, {
        clientActionId: randomUUID(), resolution: 'ACKNOWLEDGED_ONLY', note: 'Yetkisiz.',
      })).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });

      await expect(service.resolveChangeRequest(otherManager, job1.id, req1.changeRequestId, {
        clientActionId: randomUUID(), resolution: 'ACKNOWLEDGED_ONLY', note: 'Komşu.',
      })).rejects.toMatchObject({ code: 'JOB_CARD_NOT_FOUND', statusCode: 404 });

      for (const badNote of [undefined, null, '', '   ', 'a'.repeat(2001)]) {
        await expect(service.resolveChangeRequest(manager, job1.id, req1.changeRequestId, {
          clientActionId: randomUUID(),
          resolution: 'ACKNOWLEDGED_ONLY',
          note: badNote,
        })).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
      }

      await expect(service.resolveChangeRequest(manager, job1.id, req1.changeRequestId, {
        clientActionId: randomUUID(),
        resolution: 'ACKNOWLEDGED_ONLY',
        note: 'Bağlı iş verilmemeli.',
        linkedJobCardId: job2.id,
      })).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });

      const jobBefore = await readJobSnapshot(pool, job1.id);
      const incidentsBefore = await selectIncidents(pool, orgId, job1.id);
      const offerBefore = (await pool.query(
        'SELECT * FROM job_card_assignment_offers WHERE id = $1', [offerId],
      )).rows[0];

      // MANAGER succeeds with padded note (trimmed to 1..2000)
      clock.now = shift(baseline, 15 * MINUTE_MS);
      const receipt1 = await service.resolveChangeRequest(manager, job1.id, req1.changeRequestId, {
        clientActionId: randomUUID(),
        resolution: 'ACKNOWLEDGED_ONLY',
        note: '  Not kayıt altına alındı.  ',
      });
      expect(receipt1).toEqual({
        jobCardId: job1.id,
        changeRequestId: req1.changeRequestId,
        resolution: 'ACKNOWLEDGED_ONLY',
        resolvedAt: clock.now.toISOString(),
      });

      expect(await readChangeRequestRow(pool, req1.changeRequestId)).toMatchObject({
        state: 'CLOSED',
        resolution: 'ACKNOWLEDGED_ONLY',
        resolved_by: managerId,
        resolved_at: clock.now,
        resolution_note: 'Not kayıt altına alındı.',
        linked_job_card_id: null,
      });

      // JobCard, offer, and incident remain completely untouched
      expect(await readJobSnapshot(pool, job1.id)).toEqual(jobBefore);
      expect(await selectIncidents(pool, orgId, job1.id)).toEqual(incidentsBefore);
      expect((await pool.query(
        'SELECT * FROM job_card_assignment_offers WHERE id = $1', [offerId],
      )).rows[0]).toEqual(offerBefore);
      expect(incidentsBefore[0]!.id).toBe(incidentId);

      // Activity & notification persisted once
      const activities = await selectActivities(pool, orgId, job1.id);
      expect(activities.map((a) => a.event_type)).toEqual([
        'JOB_CHANGE_REQUESTED',
        'JOB_CHANGE_REQUEST_RESOLVED',
      ]);
      const notifications = (await selectNotifications(pool, orgId, job1.id))
        .filter((n) => n.kind === 'job.change_request_resolved');
      expect(notifications).toHaveLength(1);
      expect(notifications[0]!.recipient_user_id).toBe(staffId);

      // Activity presenter projects CHANGE_REQUEST_RESOLVED with ACKNOWLEDGED_ONLY
      const listed = await service.listActivity(manager, job1.id, { limit: 20, offset: 0 });
      const resolvedDto = listed.items.find((item) => item.eventType === 'JOB_CHANGE_REQUEST_RESOLVED');
      expect(resolvedDto?.details).toEqual({
        kind: 'CHANGE_REQUEST_RESOLVED',
        resolution: 'ACKNOWLEDGED_ONLY',
      });

      // ADMIN succeeds on max-length 2000 note
      clock.now = shift(baseline, 20 * MINUTE_MS);
      const maxNote = 'z'.repeat(2000);
      const receipt2 = await service.resolveChangeRequest(admin, job2.id, req2.changeRequestId, {
        clientActionId: randomUUID(),
        resolution: 'ACKNOWLEDGED_ONLY',
        note: maxNote,
      });
      expect(receipt2.resolution).toBe('ACKNOWLEDGED_ONLY');
      expect(await readChangeRequestRow(pool, req2.changeRequestId)).toMatchObject({
        state: 'CLOSED',
        resolution: 'ACKNOWLEDGED_ONLY',
        resolved_by: adminId,
        resolution_note: maxNote,
      });
    });
  });

  it('ACKNOWLEDGED_ONLY enforces idempotency replay, payload conflict, and single-winner concurrency', async () => {
    await withSchema('rescue003b_idem', async (pool) => {
      const baseline = await readDbBaseline(pool);
      const orgId = await insertOrg(pool, 'RESCUE-003B Idem Org');
      const managerAId = await insertUser(pool, { organizationId: orgId, role: 'MANAGER', name: 'Müdür A' });
      const managerBId = await insertUser(pool, { organizationId: orgId, role: 'MANAGER', name: 'Müdür B' });
      const staffId = await insertUser(pool, { organizationId: orgId, role: 'STAFF', name: 'Personel' });

      const job = await insertJob(pool, {
        organizationId: orgId, type: 'GENERAL_TASK', status: 'IN_PROGRESS',
        assignedTo: staffId, createdBy: managerAId, baseNow: baseline,
      });
      const jobRace = await insertJob(pool, {
        organizationId: orgId, type: 'GENERAL_TASK', status: 'IN_PROGRESS',
        assignedTo: staffId, createdBy: managerAId, baseNow: baseline,
      });

      const clock = { now: shift(baseline, 5 * MINUTE_MS) };
      const { service } = buildJobCardService(pool, clock);
      const staff = actor(staffId, orgId, 'STAFF');
      const managerA = actor(managerAId, orgId, 'MANAGER');
      const managerB = actor(managerBId, orgId, 'MANAGER');

      const req = await service.createChangeRequest(staff, job.id, {
        clientActionId: randomUUID(),
        reasonCode: 'CUSTOMER_POSTPONED',
        reasonText: 'Tekrar testi.',
      });

      const actionId = randomUUID();
      clock.now = shift(baseline, 10 * MINUTE_MS);
      const first = await service.resolveChangeRequest(managerA, job.id, req.changeRequestId, {
        clientActionId: actionId,
        resolution: 'ACKNOWLEDGED_ONLY',
        note: '  Kayda alındı.  ',
      });

      // Exact replay with later clock returns identical receipt with zero extra rows
      clock.now = shift(baseline, 20 * MINUTE_MS);
      const replay = await service.resolveChangeRequest(managerA, job.id, req.changeRequestId, {
        clientActionId: actionId,
        resolution: 'ACKNOWLEDGED_ONLY',
        note: 'Kayda alındı.',
      });
      expect(replay).toEqual(first);
      expect((await selectActivities(pool, orgId, job.id))
        .filter((a) => a.event_type === 'JOB_CHANGE_REQUEST_RESOLVED')).toHaveLength(1);
      expect((await selectNotifications(pool, orgId, job.id))
        .filter((n) => n.kind === 'job.change_request_resolved')).toHaveLength(1);

      // Mismatched payload with same clientActionId -> 409 CLIENT_ACTION_REUSED
      await expect(service.resolveChangeRequest(managerA, job.id, req.changeRequestId, {
        clientActionId: actionId,
        resolution: 'ACKNOWLEDGED_ONLY',
        note: 'Farklı not.',
      })).rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED', statusCode: 409 });

      // Concurrent resolution race: one winner, one 409 CHANGE_REQUEST_NOT_OPEN
      const raceReq = await service.createChangeRequest(staff, jobRace.id, {
        clientActionId: randomUUID(),
        reasonCode: 'OTHER',
        reasonText: 'Yarış testi.',
      });
      const raceResults = await Promise.allSettled([
        service.resolveChangeRequest(managerA, jobRace.id, raceReq.changeRequestId, {
          clientActionId: randomUUID(),
          resolution: 'ACKNOWLEDGED_ONLY',
          note: 'Müdür A kapattı.',
        }),
        service.resolveChangeRequest(managerB, jobRace.id, raceReq.changeRequestId, {
          clientActionId: randomUUID(),
          resolution: 'ACKNOWLEDGED_ONLY',
          note: 'Müdür B kapattı.',
        }),
      ]);
      const winners = raceResults.filter((r) => r.status === 'fulfilled');
      const losers = raceResults.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(losers[0]!.reason).toMatchObject({
        code: 'CHANGE_REQUEST_NOT_OPEN',
        statusCode: 409,
      });
      expect((await selectActivities(pool, orgId, jobRace.id))
        .filter((a) => a.event_type === 'JOB_CHANGE_REQUEST_RESOLVED')).toHaveLength(1);
      expect((await selectNotifications(pool, orgId, jobRace.id))
        .filter((n) => n.kind === 'job.change_request_resolved')).toHaveLength(1);
    });
  });

  it('OVR-7: ACKNOWLEDGED_ONLY keeps STAFF_PROVEN incident in staffResponsibility while subsequent qualifying resolution still regroups', async () => {
    await withSchema('rescue003b_ovr7', async (pool) => {
      const orgId = await insertOrg(pool, 'RESCUE-003B OVR7 Org');
      const managerId = await insertUser(pool, { organizationId: orgId, role: 'MANAGER', name: 'Müdür' });
      const staffId = await insertUser(pool, { organizationId: orgId, role: 'STAFF', name: 'Personel' });

      // Fixed October 2026 instants matching Europe/Istanbul (+03:00).
      const scheduledAt = new Date('2026-10-05T06:00:00.000Z');
      const scheduledEndsAt = new Date('2026-10-05T07:00:00.000Z');
      const acceptedAt = new Date('2026-10-05T06:30:00.000Z');
      const requestedAt = new Date('2026-10-05T08:00:00.000Z');
      const ackResolvedAt = new Date('2026-10-05T09:00:00.000Z');
      const reportTime = new Date('2026-10-05T10:00:00.000Z');

      const customerId = await insertCustomer(pool, orgId, 'OVR-7 Klinik');
      const jobNeutral = await insertJob(pool, {
        organizationId: orgId, type: 'SALES_MEETING', status: 'ACCEPTED',
        assignedTo: staffId, createdBy: managerId, customerId,
        title: 'Nötr kapatılan iş',
        scheduledAt, scheduledEndsAt, acceptedAt, revisionCreatedAt: acceptedAt,
      });
      // Control job with qualifying resolution to prove legacy report grouping stays intact
      const jobQualifying = await insertJob(pool, {
        organizationId: orgId, type: 'SALES_MEETING', status: 'ACCEPTED',
        assignedTo: staffId, createdBy: managerId, customerId,
        title: 'Nitelikli kapatılan iş',
        scheduledAt, scheduledEndsAt, acceptedAt, revisionCreatedAt: acceptedAt,
      });

      const scanner = createOverdueBreachScanner(
        new PostgresOverdueBreachScannerRepository(new PostgresJobCardRepository(pool)),
        { batchSize: 50 },
      );
      expect((await scanner.runOnce(scheduledEndsAt)).inserted).toBe(2);

      const clock = { now: requestedAt };
      const { service } = buildJobCardService(pool, clock);
      const staff = actor(staffId, orgId, 'STAFF');
      const manager = actor(managerId, orgId, 'MANAGER');

      const reqNeutral = await service.createChangeRequest(staff, jobNeutral.id, {
        clientActionId: randomUUID(),
        reasonCode: 'CUSTOMER_POSTPONED',
        reasonText: 'Müşteri erteleme istedi.',
      });
      const reqQualifying = await service.createChangeRequest(staff, jobQualifying.id, {
        clientActionId: randomUUID(),
        reasonCode: 'WRONG_PRODUCT',
        reasonText: 'Yanlış ürün.',
      });

      clock.now = ackResolvedAt;
      await service.resolveChangeRequest(manager, jobNeutral.id, reqNeutral.changeRequestId, {
        clientActionId: randomUUID(),
        resolution: 'ACKNOWLEDGED_ONLY',
        note: 'Talep görüldü, aksiyon alınmadı.',
      });
      await service.resolveChangeRequest(manager, jobQualifying.id, reqQualifying.changeRequestId, {
        clientActionId: randomUUID(),
        resolution: 'CORRECTED',
        note: 'Düzeltildi.',
      });

      const reports = buildReportsService(pool, () => reportTime);
      const range = { from: '2026-10-01', to: '2026-10-31' };
      const staffReport = await reports.getStaffReport(
        safeUser(managerId, orgId, 'MANAGER', 'Müdür'),
        staffId,
        { requestedRange: range },
      );

      expect(staffReport.lateness.staffResponsibility).toMatchObject({
        delayedJobCount: 1,
        incidentCount: 1,
      });
      expect(staffReport.lateness.operational).toEqual({
        delayedJobCount: 1,
        incidentCount: 1,
        byReason: [{ reasonCode: 'WRONG_PRODUCT', incidentCount: 1 }],
      });

      const incidents = await reports.listStaffLatenessIncidents(
        safeUser(managerId, orgId, 'MANAGER', 'Müdür'),
        staffId,
        { requestedRange: range, limit: 50, offset: 0 },
      );
      const neutralItem = incidents.items.find((i) => i.job?.id === jobNeutral.id)!;
      const qualifyingItem = incidents.items.find((i) => i.job?.id === jobQualifying.id)!;
      expect(neutralItem.operationalReason).toBeNull();
      expect(qualifyingItem.operationalReason).toMatchObject({
        reasonCode: 'WRONG_PRODUCT',
        resolution: 'CORRECTED',
      });

      // A subsequent qualifying resolution on a new request for jobNeutral still qualifies
      clock.now = new Date('2026-10-05T09:15:00.000Z');
      const followUpReq = await service.createChangeRequest(staff, jobNeutral.id, {
        clientActionId: randomUUID(),
        reasonCode: 'CUSTOMER_ABSENT',
        reasonText: 'Müşteri yine yoktu, yeni tarih verildi.',
      });
      clock.now = new Date('2026-10-05T09:30:00.000Z');
      await service.patch(manager, jobNeutral.id, {
        expectedVersion: jobNeutral.version,
        scheduledAt: '2026-10-06T09:00:00.000Z',
        scheduledEndsAt: '2026-10-06T10:00:00.000Z',
        deadlineExtensionReason: 'Müşteri talebi üzerine ertelendi.',
        changeRequestResolution: {
          changeRequestId: followUpReq.changeRequestId,
          resolution: 'RESCHEDULED',
          note: 'Yeni güne taşındı.',
        },
      });

      const afterFollowUp = await reports.getStaffReport(
        safeUser(managerId, orgId, 'MANAGER', 'Müdür'),
        staffId,
        { requestedRange: range },
      );
      expect(afterFollowUp.lateness.staffResponsibility).toMatchObject({
        delayedJobCount: 0,
        incidentCount: 0,
      });
      expect(afterFollowUp.lateness.operational).toEqual({
        delayedJobCount: 2,
        incidentCount: 2,
        byReason: expect.arrayContaining([
          { reasonCode: 'WRONG_PRODUCT', incidentCount: 1 },
          { reasonCode: 'CUSTOMER_ABSENT', incidentCount: 1 },
        ]),
      });
    });
  });

  it('OVR-7: failed PATCH CORRECTED keeps STAFF attribution, neutral closure preserves it, and supported evidence-bound correction regroups', async () => {
    await withSchema('rescue003b_ovr7_evidence', async (pool) => {
      const orgId = await insertOrg(pool, 'RESCUE-003B OVR7 Evidence Org');
      const managerId = await insertUser(pool, { organizationId: orgId, role: 'MANAGER', name: 'Müdür' });
      const staffId = await insertUser(pool, { organizationId: orgId, role: 'STAFF', name: 'Personel' });

      const scheduledAt = new Date('2026-10-05T06:00:00.000Z');
      const scheduledEndsAt = new Date('2026-10-05T07:00:00.000Z');
      const acceptedAt = new Date('2026-10-05T06:30:00.000Z');
      const requestedAt = new Date('2026-10-05T08:00:00.000Z');
      const resolvedAt = new Date('2026-10-05T09:00:00.000Z');
      const reportTime = new Date('2026-10-05T10:00:00.000Z');
      const customerId = await insertCustomer(pool, orgId, 'OVR-7 Kanıt Klinik');

      const failedJob = await insertJob(pool, {
        organizationId: orgId, type: 'SALES_MEETING', status: 'ACCEPTED',
        assignedTo: staffId, createdBy: managerId, customerId,
        title: 'Kanıtsız düzeltme denemesi',
        scheduledAt, scheduledEndsAt, acceptedAt, revisionCreatedAt: acceptedAt,
      });
      const neutralJob = await insertJob(pool, {
        organizationId: orgId, type: 'SALES_MEETING', status: 'ACCEPTED',
        assignedTo: staffId, createdBy: managerId, customerId,
        title: 'Nötr kapatılan iş',
        scheduledAt, scheduledEndsAt, acceptedAt, revisionCreatedAt: acceptedAt,
      });
      const qualifyingJob = await insertJob(pool, {
        organizationId: orgId, type: 'SALES_MEETING', status: 'ACCEPTED',
        assignedTo: staffId, createdBy: managerId, customerId,
        title: 'Kanıtlı düzeltilen iş',
        scheduledAt, scheduledEndsAt, acceptedAt, revisionCreatedAt: acceptedAt,
      });

      const scanner = createOverdueBreachScanner(
        new PostgresOverdueBreachScannerRepository(new PostgresJobCardRepository(pool)),
        { batchSize: 50 },
      );
      expect((await scanner.runOnce(scheduledEndsAt)).inserted).toBe(3);

      const clock = { now: requestedAt };
      const { service } = buildJobCardService(pool, clock);
      const staff = actor(staffId, orgId, 'STAFF');
      const manager = actor(managerId, orgId, 'MANAGER');

      const failedReq = await service.createChangeRequest(staff, failedJob.id, {
        clientActionId: randomUUID(),
        reasonCode: 'OTHER',
        reasonText: 'İş bilgisi düzeltilmeli.',
      });
      const neutralReq = await service.createChangeRequest(staff, neutralJob.id, {
        clientActionId: randomUUID(),
        reasonCode: 'CUSTOMER_POSTPONED',
        reasonText: 'Müşteri erteledi.',
      });
      const qualifyingReq = await service.createChangeRequest(staff, qualifyingJob.id, {
        clientActionId: randomUUID(),
        reasonCode: 'OTHER',
        reasonText: 'Açıklama düzeltilmeli.',
      });

      // A title-only edit is not supporting evidence: the whole patch rolls
      // back and the open request cannot affect OVR-7 accountability.
      clock.now = resolvedAt;
      await expect(service.patch(manager, failedJob.id, {
        expectedVersion: failedJob.version,
        title: 'Yalnızca başlık değişti',
        changeRequestResolution: {
          changeRequestId: failedReq.changeRequestId,
          resolution: 'CORRECTED',
          note: 'Başlık düzeltildi.',
        },
      })).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        statusCode: 400,
        details: { fieldErrors: { changeRequestResolution: expect.any(String) } },
      });
      expect((await readChangeRequestRow(pool, failedReq.changeRequestId)).state).toBe('OPEN');

      // Neutral acknowledgement closes the request without changing attribution.
      await service.resolveChangeRequest(manager, neutralJob.id, neutralReq.changeRequestId, {
        clientActionId: randomUUID(),
        resolution: 'ACKNOWLEDGED_ONLY',
        note: 'Talep kayda alındı; iş değişmedi.',
      });

      // Reason OTHER + real description + note is the supported correction and
      // qualifies under the existing OVR-7 allowlist.
      const qualifyingPatched = await service.patch(manager, qualifyingJob.id, {
        expectedVersion: qualifyingJob.version,
        description: 'Açıklama talebe göre düzeltildi.',
        changeRequestResolution: {
          changeRequestId: qualifyingReq.changeRequestId,
          resolution: 'CORRECTED',
          note: 'Açıklama talebe göre düzeltildi.',
        },
      });
      expect(qualifyingPatched.description).toBe('Açıklama talebe göre düzeltildi.');

      const reports = buildReportsService(pool, () => reportTime);
      const range = { from: '2026-10-01', to: '2026-10-31' };
      const staffReport = await reports.getStaffReport(
        safeUser(managerId, orgId, 'MANAGER', 'Müdür'),
        staffId,
        { requestedRange: range },
      );

      expect(staffReport.lateness.staffResponsibility).toMatchObject({
        delayedJobCount: 2,
        incidentCount: 2,
      });
      expect(staffReport.lateness.operational).toEqual({
        delayedJobCount: 1,
        incidentCount: 1,
        byReason: [{ reasonCode: 'OTHER', incidentCount: 1 }],
      });

      const incidents = await reports.listStaffLatenessIncidents(
        safeUser(managerId, orgId, 'MANAGER', 'Müdür'),
        staffId,
        { requestedRange: range, limit: 50, offset: 0 },
      );
      const failedItem = incidents.items.find((i) => i.job?.id === failedJob.id)!;
      const neutralItem = incidents.items.find((i) => i.job?.id === neutralJob.id)!;
      const qualifyingItem = incidents.items.find((i) => i.job?.id === qualifyingJob.id)!;
      expect(failedItem.operationalReason).toBeNull();
      expect(neutralItem.operationalReason).toBeNull();
      expect(qualifyingItem.operationalReason).toMatchObject({
        reasonCode: 'OTHER',
        resolution: 'CORRECTED',
      });
    });
  });

  it('OVR-4 & OVR-6: ACKNOWLEDGED_ONLY resumes undelivered alerts, preserves delivered suppression, clears changeRequestOpenSince, and respects quiet hours', async () => {
    await withSchema('rescue003b_alerts', async (pool) => {
      const baseline = await readDbBaseline(pool);
      const openDay = nextOpenDateKey(baseline, TZ);
      const sundayDay = nextSundayDateKey(baseline, TZ);
      const mondayDay = addDays(sundayDay, 1);

      const orgId = await insertOrg(pool, 'RESCUE-003B Alerts Org', TZ);
      const managerId = await insertUser(pool, { organizationId: orgId, role: 'MANAGER', name: 'Müdür' });
      const staffId = await insertUser(pool, { organizationId: orgId, role: 'STAFF', name: 'Personel' });
      const staff = actor(staffId, orgId, 'STAFF');
      const manager = actor(managerId, orgId, 'MANAGER');

      const clock = { now: atLocal(openDay, 9, 0) };
      const { service } = buildJobCardService(pool, clock);

      // 1) OVR-4: STAFF_REMINDER delivered BEFORE request, MANAGEMENT_ESCALATION undelivered;
      //    after ACKNOWLEDGED_ONLY, escalation sends at original breached_at + 60m and staff reminder stays suppressed.
      const ovr4BreachAt = atLocal(openDay, 10, 0);
      const ovr4Job = await insertJob(pool, {
        organizationId: orgId, type: 'GENERAL_TASK', status: 'IN_PROGRESS',
        assignedTo: staffId, createdBy: managerId,
        title: 'OVR-4 Geciken Görev',
        dueDate: openDay,
        baseNow: ovr4BreachAt,
      });
      await insertIncident(pool, {
        organizationId: orgId, jobCardId: ovr4Job.id, delayType: 'LATE_SUBMISSION',
        deadlineAt: ovr4BreachAt, breachedAt: ovr4BreachAt,
        accountableUserId: staffId, accountableRole: 'STAFF',
      });

      const ovr4Scan = { now: shift(ovr4BreachAt, 20 * MINUTE_MS) };
      const ovr4Worker = buildOverdueReminderWorker(pool, {
        now: () => ovr4Scan.now,
        notificationWindow: ALWAYS_OPEN_NOTIFICATION_WINDOW,
      });
      const initialOvr4 = await ovr4Worker.runOnce(ovr4Scan.now);
      expect(initialOvr4.byKind).toEqual({ STAFF_REMINDER: 1, MANAGEMENT_ESCALATION: 0 });

      // Open request at +25m -> escalation frozen, changeRequestOpenSince populated
      clock.now = shift(ovr4BreachAt, 25 * MINUTE_MS);
      const ovr4Req = await service.createChangeRequest(staff, ovr4Job.id, {
        clientActionId: randomUUID(),
        reasonCode: 'CUSTOMER_POSTPONED',
        reasonText: 'Müşteri bekletiyor.',
      });
      const latenessOpen = await service.getSubmissionLateness(staff, ovr4Job.id);
      expect(latenessOpen.open?.changeRequestOpenSince).toBe(clock.now.toISOString());

      // Escalation tick at +65m while open -> paused
      const pausedOvr4 = await ovr4Worker.runOnce(shift(ovr4BreachAt, 65 * MINUTE_MS));
      expect(pausedOvr4.sent).toBe(0);

      // Close as ACKNOWLEDGED_ONLY -> changeRequestOpenSince clears to null
      clock.now = shift(ovr4BreachAt, 70 * MINUTE_MS);
      await service.resolveChangeRequest(manager, ovr4Job.id, ovr4Req.changeRequestId, {
        clientActionId: randomUUID(),
        resolution: 'ACKNOWLEDGED_ONLY',
        note: 'Bilgi alındı, takip devam edecek.',
      });
      const latenessClosed = await service.getSubmissionLateness(staff, ovr4Job.id);
      expect(latenessClosed.open?.changeRequestOpenSince).toBeNull();

      // Next OVR-4 scan sends only undelivered MANAGEMENT_ESCALATION; STAFF_REMINDER stays suppressed
      const resumedOvr4 = await ovr4Worker.runOnce(shift(ovr4BreachAt, 75 * MINUTE_MS));
      expect(resumedOvr4.byKind).toEqual({ STAFF_REMINDER: 0, MANAGEMENT_ESCALATION: 1 });
      const ovr4Deliveries = await selectOverdueDeliveries(pool, orgId, ovr4Job.id);
      expect(ovr4Deliveries.map((d) => d.kind)).toEqual([
        'STAFF_REMINDER',
        'MANAGEMENT_ESCALATION',
      ]);

      // 2) OVR-6 START_REMINDER undelivered while request open -> resumes on next in-window scan after ACKNOWLEDGED_ONLY
      const startAt = atLocal(openDay, 12, 0);
      const ovr6StartJob = await insertJob(pool, {
        organizationId: orgId, type: 'GENERAL_TASK', status: 'ACCEPTED',
        assignedTo: staffId, createdBy: managerId,
        title: 'OVR-6 Başlangıç Hatırlatma',
        scheduledAt: startAt, scheduledEndsAt: shift(startAt, HOUR_MS),
        baseNow: startAt,
      });
      clock.now = shift(startAt, 5 * MINUTE_MS);
      const startReq = await service.createChangeRequest(staff, ovr6StartJob.id, {
        clientActionId: randomUUID(),
        reasonCode: 'OTHER',
        reasonText: 'Açık talep.',
      });

      const ovr6Scan = { at: shift(startAt, 20 * MINUTE_MS) };
      const ovr6Worker = buildLatenessAlertWorker(pool, {
        now: () => ovr6Scan.at,
        notificationWindow: DEFAULT_NOTIFICATION_WINDOW,
        timing: { startReminderDelayMs: 15 * MINUTE_MS },
      });
      expect((await ovr6Worker.runIteration()).startReminder.sent).toBe(0);

      clock.now = shift(startAt, 25 * MINUTE_MS);
      await service.resolveChangeRequest(manager, ovr6StartJob.id, startReq.changeRequestId, {
        clientActionId: randomUUID(),
        resolution: 'ACKNOWLEDGED_ONLY',
        note: 'Not düşüldü.',
      });
      ovr6Scan.at = shift(startAt, 30 * MINUTE_MS);
      expect((await ovr6Worker.runIteration()).startReminder.sent).toBe(1);
      expect(await selectLatenessDeliveries(pool, orgId, ovr6StartJob.id)).toHaveLength(1);

      // Re-open and close another request on the same planned start -> already-delivered START_REMINDER stays suppressed
      clock.now = shift(startAt, 35 * MINUTE_MS);
      const startReq2 = await service.createChangeRequest(staff, ovr6StartJob.id, {
        clientActionId: randomUUID(),
        reasonCode: 'OTHER',
        reasonText: 'İkinci talep.',
      });
      clock.now = shift(startAt, 40 * MINUTE_MS);
      await service.resolveChangeRequest(manager, ovr6StartJob.id, startReq2.changeRequestId, {
        clientActionId: randomUUID(),
        resolution: 'ACKNOWLEDGED_ONLY',
        note: 'Tekrar gönderilmemeli.',
      });
      ovr6Scan.at = shift(startAt, 45 * MINUTE_MS);
      expect((await ovr6Worker.runIteration()).startReminder.sent).toBe(0);
      expect(await selectLatenessDeliveries(pool, orgId, ovr6StartJob.id)).toHaveLength(1);

      // 3) Quiet hours deferral: close as ACKNOWLEDGED_ONLY on Sunday (quiet hours) ->
      //    Sunday scan defers, Monday 08:00 local window scan sends using original due time.
      const sundayStart = atLocal(sundayDay, 10, 0);
      const quietJob = await insertJob(pool, {
        organizationId: orgId, type: 'GENERAL_TASK', status: 'ACCEPTED',
        assignedTo: staffId, createdBy: managerId,
        title: 'Pazar Sessiz Saat İşi',
        scheduledAt: sundayStart, scheduledEndsAt: shift(sundayStart, HOUR_MS),
        baseNow: sundayStart,
      });
      clock.now = shift(sundayStart, 5 * MINUTE_MS);
      const quietReq = await service.createChangeRequest(staff, quietJob.id, {
        clientActionId: randomUUID(),
        reasonCode: 'CUSTOMER_POSTPONED',
        reasonText: 'Pazar talebi.',
      });
      clock.now = shift(sundayStart, 20 * MINUTE_MS);
      await service.resolveChangeRequest(manager, quietJob.id, quietReq.changeRequestId, {
        clientActionId: randomUUID(),
        resolution: 'ACKNOWLEDGED_ONLY',
        note: 'Sessiz saatte kapatıldı.',
      });

      ovr6Scan.at = atLocal(sundayDay, 14, 0);
      expect((await ovr6Worker.runIteration()).startReminder.sent).toBe(0);
      expect(await selectLatenessDeliveries(pool, orgId, quietJob.id)).toHaveLength(0);

      ovr6Scan.at = atLocal(mondayDay, 8, 0);
      expect((await ovr6Worker.runIteration()).startReminder.sent).toBe(1);
      expect(await selectLatenessDeliveries(pool, orgId, quietJob.id)).toHaveLength(1);
    });
  });

  it('atomic PATCH CORRECTED is evidence-bound to reason OTHER with a management note and rolls back unsupported edits', async () => {
    await withSchema('rescue003b_patch_corrected', async (pool) => {
      const baseline = await readDbBaseline(pool);
      const orgId = await insertOrg(pool, 'RESCUE-003B Patch Corrected Org');
      const otherOrgId = await insertOrg(pool, 'Komşu Patch Org');
      const managerId = await insertUser(pool, { organizationId: orgId, role: 'MANAGER', name: 'Müdür' });
      const adminId = await insertUser(pool, { organizationId: orgId, role: 'ADMIN', name: 'Admin' });
      const staffId = await insertUser(pool, { organizationId: orgId, role: 'STAFF', name: 'Personel' });
      const otherStaffId = await insertUser(pool, { organizationId: orgId, role: 'STAFF', name: 'Diğer Personel' });
      const otherManagerId = await insertUser(pool, { organizationId: otherOrgId, role: 'MANAGER', name: 'Komşu Müdür' });
      const otherStaffForeignId = await insertUser(pool, { organizationId: otherOrgId, role: 'STAFF', name: 'Komşu Personel' });

      const customerA = await insertCustomer(pool, orgId, 'Klinik A');
      const customerB = await insertCustomer(pool, orgId, 'Klinik B');

      const clock = { now: baseline };
      const { service } = buildJobCardService(pool, clock);
      const staff = actor(staffId, orgId, 'STAFF');
      const manager = actor(managerId, orgId, 'MANAGER');
      const admin = actor(adminId, orgId, 'ADMIN');

      const job = await insertJob(pool, {
        organizationId: orgId, type: 'GENERAL_TASK', status: 'IN_PROGRESS',
        assignedTo: staffId, createdBy: managerId,
        title: 'Eski Başlık', customerId: customerA, baseNow: baseline,
      });
      await pool.query('UPDATE job_cards SET description = $2 WHERE id = $1', [
        job.id, 'Eski açıklama',
      ]);
      const foreignJob = await insertJob(pool, {
        organizationId: otherOrgId, type: 'GENERAL_TASK', status: 'IN_PROGRESS',
        assignedTo: otherStaffForeignId, createdBy: otherManagerId,
        title: 'Komşu İş', baseNow: baseline,
      });
      const otherSameOrgJob = await insertJob(pool, {
        organizationId: orgId, type: 'GENERAL_TASK', status: 'ACCEPTED',
        assignedTo: otherStaffId, createdBy: managerId,
        title: 'Başka İş', baseNow: baseline,
      });

      const req = await service.createChangeRequest(staff, job.id, {
        clientActionId: randomUUID(),
        reasonCode: 'OTHER',
        reasonText: 'İş bilgileri talebe göre düzeltilmeli.',
      });
      const foreignReq = await service.createChangeRequest(
        actor(otherStaffForeignId, otherOrgId, 'STAFF'),
        foreignJob.id,
        {
          clientActionId: randomUUID(),
          reasonCode: 'OTHER',
          reasonText: 'Komşu talep.',
        },
      );
      const siblingReq = await service.createChangeRequest(
        actor(otherStaffId, orgId, 'STAFF'),
        otherSameOrgJob.id,
        {
          clientActionId: randomUUID(),
          reasonCode: 'OTHER',
          reasonText: 'Kardeş iş talebi.',
        },
      );

      const jobBefore = await readJobSnapshot(pool, job.id);
      const activitiesBefore = await selectActivities(pool, orgId, job.id);
      const notificationsBefore = await selectNotifications(pool, orgId, job.id);
      const rejected = { code: 'VALIDATION_ERROR', statusCode: 400 } as const;

      // 1) STAFF is rejected with 400 VALIDATION_ERROR + fieldErrors.changeRequestResolution.
      await expect(service.patch(staff, job.id, {
        expectedVersion: job.version,
        description: 'Personel açıklaması',
        changeRequestResolution: {
          changeRequestId: req.changeRequestId,
          resolution: 'CORRECTED',
          note: 'Personel kapatmaya çalıştı.',
        },
      })).rejects.toMatchObject({
        ...rejected,
        details: { fieldErrors: { changeRequestResolution: expect.any(String) } },
      });

      // Cross-organization management cannot see or patch this job.
      await expect(service.patch(actor(otherManagerId, otherOrgId, 'MANAGER'), job.id, {
        expectedVersion: job.version,
        description: 'Komşu kurum düzeltmesi',
        changeRequestResolution: {
          changeRequestId: req.changeRequestId,
          resolution: 'CORRECTED',
          note: 'Komşu kurum denemesi.',
        },
      })).rejects.toMatchObject({ code: 'JOB_CARD_NOT_FOUND', statusCode: 404 });

      // 2) No-op patches never close the request.
      for (const noOpBody of [
        {
          expectedVersion: job.version,
          title: 'Eski Başlık',
          changeRequestResolution: {
            changeRequestId: req.changeRequestId, resolution: 'CORRECTED' as const,
            note: 'Yalnızca aynı başlık.',
          },
        },
        {
          expectedVersion: job.version,
          description: 'Eski açıklama',
          changeRequestResolution: {
            changeRequestId: req.changeRequestId, resolution: 'CORRECTED' as const,
            note: 'Yalnızca aynı açıklama.',
          },
        },
        {
          expectedVersion: job.version,
          changeRequestResolution: {
            changeRequestId: req.changeRequestId, resolution: 'CORRECTED' as const,
            note: 'Alan gönderilmedi.',
          },
        },
      ]) {
        await expect(service.patch(manager, job.id, noOpBody)).rejects.toMatchObject({
          ...rejected,
          details: { fieldErrors: { changeRequestResolution: expect.any(String) } },
        });
      }

      // 3) Missing or foreign changeRequestId rolls back the supported field edit atomically.
      for (const badReqId of [randomUUID(), foreignReq.changeRequestId, siblingReq.changeRequestId]) {
        await expect(service.patch(manager, job.id, {
          expectedVersion: job.version,
          description: 'Geri Alınacak Açıklama',
          changeRequestResolution: {
            changeRequestId: badReqId,
            resolution: 'CORRECTED',
            note: 'Yanlış talep kimliği.',
          },
        })).rejects.toMatchObject({ code: 'CHANGE_REQUEST_NOT_FOUND', statusCode: 404 });
      }

      // 4) A supported field alone is not enough: title/priority/schedule/assignee
      //    or a non-meeting customer edit is rejected for reason OTHER.
      const unsupportedOnlyEdits = [
        { title: 'Yalnızca başlık' },
        { priority: 'high' },
        { scheduledAt: shift(baseline, HOUR_MS).toISOString() },
        { assignedTo: otherStaffId },
        { customerId: customerB },
        { dueDate: '2027-01-15' },
      ] as const;
      for (const edit of unsupportedOnlyEdits) {
        await expect(service.patch(manager, job.id, {
          expectedVersion: job.version,
          ...edit,
          changeRequestResolution: {
            changeRequestId: req.changeRequestId,
            resolution: 'CORRECTED',
            note: 'Desteklenmeyen alan.',
          },
        })).rejects.toMatchObject({
          ...rejected,
          details: { fieldErrors: { changeRequestResolution: expect.any(String) } },
        });
      }

      // 5) The management attestation note is mandatory and trimmed 1-2000 characters.
      const missingNoteBody = {
        expectedVersion: job.version,
        description: 'Notsuz düzeltme',
        changeRequestResolution: {
          changeRequestId: req.changeRequestId,
          resolution: 'CORRECTED',
        },
      } as unknown as Parameters<JobCardService['patch']>[2];
      await expect(service.patch(manager, job.id, missingNoteBody)).rejects.toMatchObject({
        ...rejected,
        details: { fieldErrors: { changeRequestResolution: expect.any(String) } },
      });
      for (const badNote of ['   ', 'x'.repeat(2_001)]) {
        await expect(service.patch(manager, job.id, {
          expectedVersion: job.version,
          description: 'Geçersiz notlu düzeltme',
          changeRequestResolution: {
            changeRequestId: req.changeRequestId,
            resolution: 'CORRECTED',
            note: badNote,
          },
        })).rejects.toMatchObject({
          ...rejected,
          details: { fieldErrors: { changeRequestResolution: expect.any(String) } },
        });
      }

      // No rejected attempt wrote anything: the job, request, activity and
      // notification state are exactly the pre-decision snapshot.
      expect(await readJobSnapshot(pool, job.id)).toEqual(jobBefore);
      expect((await readChangeRequestRow(pool, req.changeRequestId)).state).toBe('OPEN');
      expect(await selectActivities(pool, orgId, job.id)).toEqual(activitiesBefore);
      expect(await selectNotifications(pool, orgId, job.id)).toEqual(notificationsBefore);

      // 6) Reason OTHER + a real description change + trimmed note closes atomically.
      clock.now = shift(baseline, 10 * MINUTE_MS);
      const patched = await service.patch(manager, job.id, {
        expectedVersion: job.version,
        description: '  Düzeltilmiş açıklama  ',
        changeRequestResolution: {
          changeRequestId: req.changeRequestId,
          resolution: 'CORRECTED',
          note: '  Açıklama talebe göre düzeltildi.  ',
        },
      });
      expect(patched).toMatchObject({
        id: job.id,
        version: job.version + 1,
        status: 'IN_PROGRESS',
        title: 'Eski Başlık',
        description: 'Düzeltilmiş açıklama',
      });
      expect(await readChangeRequestRow(pool, req.changeRequestId)).toMatchObject({
        state: 'CLOSED',
        resolution: 'CORRECTED',
        resolved_by: managerId,
        resolved_at: clock.now,
        resolution_note: 'Açıklama talebe göre düzeltildi.',
      });
      expect((await selectActivities(pool, orgId, job.id))
        .filter((a) => a.event_type === 'JOB_CHANGE_REQUEST_RESOLVED')).toHaveLength(1);
      expect((await selectNotifications(pool, orgId, job.id))
        .filter((n) => n.kind === 'job.change_request_resolved')).toHaveLength(1);

      // 7) Reusing the already-closed request rolls back the new field edit.
      await expect(service.patch(manager, job.id, {
        expectedVersion: patched.version,
        description: 'Tekrar Kapatmaya Çalışılan Açıklama',
        changeRequestResolution: {
          changeRequestId: req.changeRequestId,
          resolution: 'CORRECTED',
          note: 'Zaten kapalı.',
        },
      })).rejects.toMatchObject({ code: 'CHANGE_REQUEST_NOT_OPEN', statusCode: 409 });
      expect((await readJobSnapshot(pool, job.id)).description).toBe('Düzeltilmiş açıklama');
      expect((await readJobSnapshot(pool, job.id)).version).toBe(patched.version);

      // 8) WRONG_PRODUCT and every other request reason remain unsupported for
      //    PATCH CORRECTED, even with actual edits and a note.
      const wrongJob = await insertJob(pool, {
        organizationId: orgId, type: 'GENERAL_TASK', status: 'IN_PROGRESS',
        assignedTo: staffId, createdBy: managerId,
        title: 'Yanlış Ürün İşi', baseNow: baseline,
      });
      const wrongReq = await service.createChangeRequest(staff, wrongJob.id, {
        clientActionId: randomUUID(),
        reasonCode: 'WRONG_PRODUCT',
        reasonText: 'Yanlış ürün istendi.',
      });
      const wrongBefore = await readJobSnapshot(pool, wrongJob.id);
      await expect(service.patch(manager, wrongJob.id, {
        expectedVersion: wrongJob.version,
        description: 'Yanlış ürüne rağmen düzeltme',
        changeRequestResolution: {
          changeRequestId: wrongReq.changeRequestId,
          resolution: 'CORRECTED',
          note: 'Ürün düzeltildi.',
        },
      })).rejects.toMatchObject({
        ...rejected,
        details: { fieldErrors: { changeRequestResolution: expect.any(String) } },
      });
      expect(await readJobSnapshot(pool, wrongJob.id)).toEqual(wrongBefore);
      expect((await readChangeRequestRow(pool, wrongReq.changeRequestId)).state).toBe('OPEN');

      // 9) The narrow supported evidence: a permitted SALES_MEETING customer
      //    change (MANAGER) and an engagement-kind change (ADMIN).
      const salesCustomerJob = await insertJob(pool, {
        organizationId: orgId, type: 'SALES_MEETING', status: 'NEW',
        assignedTo: staffId, createdBy: managerId, customerId: customerA,
        title: 'Müşterisi Düzeltilecek Görüşme',
        scheduledAt: shift(baseline, 2 * HOUR_MS),
        scheduledEndsAt: shift(baseline, 3 * HOUR_MS),
        baseNow: baseline,
      });
      const salesCustomerReq = await service.createChangeRequest(staff, salesCustomerJob.id, {
        clientActionId: randomUUID(),
        reasonCode: 'OTHER',
        reasonText: 'Müşteri kaydı yanlış.',
      });
      clock.now = shift(baseline, 15 * MINUTE_MS);
      const salesCustomerPatched = await service.patch(manager, salesCustomerJob.id, {
        expectedVersion: salesCustomerJob.version,
        customerId: customerB,
        changeRequestResolution: {
          changeRequestId: salesCustomerReq.changeRequestId,
          resolution: 'CORRECTED',
          note: 'Müşteri kaydı talebe göre düzeltildi.',
        },
      });
      expect(salesCustomerPatched.customerId).toBe(customerB);
      expect(await readChangeRequestRow(pool, salesCustomerReq.changeRequestId)).toMatchObject({
        state: 'CLOSED',
        resolution: 'CORRECTED',
        resolution_note: 'Müşteri kaydı talebe göre düzeltildi.',
      });

      const salesEngagementJob = await insertJob(pool, {
        organizationId: orgId, type: 'SALES_MEETING', status: 'NEW',
        assignedTo: staffId, createdBy: managerId, customerId: customerA,
        title: 'Türü Düzeltilecek Görüşme',
        scheduledAt: shift(baseline, 4 * HOUR_MS),
        scheduledEndsAt: shift(baseline, 5 * HOUR_MS),
        baseNow: baseline,
      });
      const salesEngagementReq = await service.createChangeRequest(staff, salesEngagementJob.id, {
        clientActionId: randomUUID(),
        reasonCode: 'OTHER',
        reasonText: 'Görüşme türü yanlış.',
      });
      clock.now = shift(baseline, 20 * MINUTE_MS);
      const salesEngagementPatched = await service.patch(admin, salesEngagementJob.id, {
        expectedVersion: salesEngagementJob.version,
        engagementKind: 'CUSTOMER_VISIT',
        changeRequestResolution: {
          changeRequestId: salesEngagementReq.changeRequestId,
          resolution: 'CORRECTED',
          note: 'Görüşme türü talebe göre düzeltildi.',
        },
      });
      expect(salesEngagementPatched.engagementKind).toBe('CUSTOMER_VISIT');
      expect(await readChangeRequestRow(pool, salesEngagementReq.changeRequestId)).toMatchObject({
        state: 'CLOSED',
        resolution: 'CORRECTED',
        resolved_by: adminId,
      });
    });
  });

  it('preserves started/terminal job guards, JOB-009 follow-up continuity, SALE pair guards, and works with optional modules off', async () => {
    await withSchema('rescue003b_guards', async (pool) => {
      const baseline = await readDbBaseline(pool);
      const orgId = await insertOrg(pool, 'RESCUE-003B Guards Org');
      const managerId = await insertUser(pool, { organizationId: orgId, role: 'MANAGER', name: 'Müdür' });
      const adminId = await insertUser(pool, { organizationId: orgId, role: 'ADMIN', name: 'Admin' });
      const staffAId = await insertUser(pool, { organizationId: orgId, role: 'STAFF', name: 'Personel A' });
      const staffBId = await insertUser(pool, { organizationId: orgId, role: 'STAFF', name: 'Personel B' });
      const customerId = await insertCustomer(pool, orgId, 'Guard Klinik');

      const clock = { now: baseline };
      // Optional modules explicitly disabled (calendar/messaging/geo/webPush/assignmentWindow off)
      const { service } = buildJobCardService(pool, clock, { assignmentWindowEnabled: false });
      const manager = actor(managerId, orgId, 'MANAGER');
      const admin = actor(adminId, orgId, 'ADMIN');
      const staffA = actor(staffAId, orgId, 'STAFF');

      // 1) Started job: schedule/assignee PATCH rejected, terminal PATCH rejected, invalidate supersedes open request
      const startedJob = await insertJob(pool, {
        organizationId: orgId, type: 'SALES_MEETING', status: 'IN_PROGRESS',
        assignedTo: staffAId, createdBy: managerId, customerId,
        scheduledAt: shift(baseline, HOUR_MS), scheduledEndsAt: shift(baseline, 2 * HOUR_MS),
        baseNow: baseline,
      });
      const startedReq = await service.createChangeRequest(staffA, startedJob.id, {
        clientActionId: randomUUID(),
        reasonCode: 'OTHER',
        reasonText: 'Başlamış iş talebi.',
      });
      await expect(service.patch(manager, startedJob.id, {
        expectedVersion: startedJob.version,
        assignedTo: staffBId,
        description: 'Başlamış işte açıklama düzeltmesi.',
        changeRequestResolution: {
          changeRequestId: startedReq.changeRequestId,
          resolution: 'CORRECTED',
          note: 'Açıklama talebe göre düzeltildi.',
        },
      })).rejects.toMatchObject({ code: 'JOB_NOT_EDITABLE', statusCode: 409 });

      const completedJob = await insertJob(pool, {
        organizationId: orgId, type: 'GENERAL_TASK', status: 'COMPLETED',
        assignedTo: staffAId, createdBy: managerId, baseNow: baseline,
      });
      await expect(service.patch(manager, completedJob.id, {
        expectedVersion: completedJob.version,
        title: 'Tamamlanmış iş değiştirilemez',
      })).rejects.toMatchObject({ code: 'JOB_NOT_EDITABLE', statusCode: 409 });

      // Invalidating the started job supersedes the open request; subsequent resolve gets 409
      clock.now = shift(baseline, 5 * MINUTE_MS);
      await service.invalidate(admin, startedJob.id, {
        clientActionId: randomUUID(),
        expectedVersion: startedJob.version,
        reasonCode: 'DUPLICATE',
        note: 'Yinelenen kayıt.',
      });
      await expect(service.resolveChangeRequest(manager, startedJob.id, startedReq.changeRequestId, {
        clientActionId: randomUUID(),
        resolution: 'ACKNOWLEDGED_ONLY',
        note: 'Geçersiz kılındıktan sonra kapatılamaz.',
      })).rejects.toMatchObject({ code: 'CHANGE_REQUEST_NOT_OPEN', statusCode: 409 });

      // 2) JOB-009 follow-up continuity: cancelling a follow-up visit still requires continuity
      const sourceVisit = await insertJob(pool, {
        organizationId: orgId, type: 'SALES_MEETING', status: 'COMPLETED',
        assignedTo: staffAId, createdBy: managerId, customerId,
        scheduledAt: shift(baseline, -4 * HOUR_MS), scheduledEndsAt: shift(baseline, -3 * HOUR_MS),
        baseNow: shift(baseline, -5 * HOUR_MS),
      });
      const followUpRow = (await pool.query<{ id: string; version: number }>(
        `INSERT INTO job_cards
           (organization_id, type, status, title, customer_id, assigned_to, created_by,
            source_job_card_id, follow_up_instructions, scheduled_at, scheduled_ends_at, engagement_kind)
         VALUES ($1, 'SALES_MEETING', 'NEW', 'Takip Ziyareti', $2, $3, $4,
                 $5, 'Takip et', $6, $7, 'FOLLOW_UP')
         RETURNING id, version`,
        [
          orgId, customerId, staffAId, managerId, sourceVisit.id,
          shift(baseline, 3 * HOUR_MS), shift(baseline, 4 * HOUR_MS),
        ],
      )).rows[0]!;
      const followUpReq = await service.createChangeRequest(staffA, followUpRow.id, {
        clientActionId: randomUUID(),
        reasonCode: 'CUSTOMER_CHANGED_MIND',
        reasonText: 'Müşteri takibi iptal etmek istiyor.',
      });
      await expect(service.cancel(manager, followUpRow.id, {
        clientActionId: randomUUID(),
        expectedVersion: Number(followUpRow.version),
        cancelReason: 'Müşteri vazgeçti.',
      })).rejects.toMatchObject({ statusCode: 400 });

      await service.cancel(manager, followUpRow.id, {
        clientActionId: randomUUID(),
        expectedVersion: Number(followUpRow.version),
        cancelReason: 'Müşteri vazgeçti.',
        followUpContinuity: { decision: 'END_CYCLE', endReason: 'NOT_INTERESTED' },
      });
      expect(await readChangeRequestRow(pool, followUpReq.changeRequestId)).toMatchObject({
        state: 'CLOSED',
        resolution: 'CANCELLED',
      });

      // 3) SALE-002/003 pair guards: reassigning a sale while its source visit is live via PATCH CORRECTED is rejected
      const visit = await insertJob(pool, {
        organizationId: orgId, type: 'SALES_MEETING', status: 'IN_PROGRESS',
        assignedTo: staffAId, createdBy: managerId, customerId,
        scheduledAt: shift(baseline, 5 * HOUR_MS), scheduledEndsAt: shift(baseline, 6 * HOUR_MS),
        baseNow: baseline,
      });
      const sale = (await pool.query<{ id: string; version: number }>(
        `INSERT INTO job_cards
           (organization_id, type, status, title, customer_id, assigned_to, created_by,
            accepted_at, accepted_by, sale_source_visit_id)
         VALUES ($1, 'SALE', 'ACCEPTED', 'Bağlı Satış', $2, $3, $4, $5, $3, $6)
         RETURNING id, version`,
        [orgId, customerId, staffAId, managerId, shift(baseline, -MINUTE_MS), visit.id],
      )).rows[0]!;
      const saleReq = await service.createChangeRequest(staffA, sale.id, {
        clientActionId: randomUUID(),
        reasonCode: 'OTHER',
        reasonText: 'Satış müşteri/sorumlu değiştirme talebi.',
      });

      await expect(service.patch(manager, sale.id, {
        expectedVersion: Number(sale.version),
        assignedTo: staffBId,
        changeRequestResolution: {
          changeRequestId: saleReq.changeRequestId,
          resolution: 'CORRECTED',
          note: 'Satış sorumlusu düzeltilecek.',
        },
      })).rejects.toMatchObject({ code: 'SALE_PAIR_ASSIGNEE_CONFLICT', statusCode: 409 });
      expect((await readChangeRequestRow(pool, saleReq.changeRequestId)).state).toBe('OPEN');

      const otherCustomer = await insertCustomer(pool, orgId, 'Başka Klinik');
      await expect(service.patch(manager, sale.id, {
        expectedVersion: Number(sale.version),
        customerId: otherCustomer,
        changeRequestResolution: {
          changeRequestId: saleReq.changeRequestId,
          resolution: 'CORRECTED',
          note: 'Satış müşterisi düzeltilecek.',
        },
      })).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
      expect((await readChangeRequestRow(pool, saleReq.changeRequestId)).state).toBe('OPEN');
    });
  });
});
