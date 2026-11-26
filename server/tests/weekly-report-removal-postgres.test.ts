import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { PostgresJobCardRepository, PostgresJobCardTransaction } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import { jobCardRoutes } from '../src/modules/job-cards/routes.js';
import { AppError, toErrorResponse } from '../src/errors/index.js';
import type { JobCardActor } from '../src/modules/job-cards/types.js';
import { parseWeeklyReportBulkRequestInput, parseWeeklyReportCreateInput } from '../src/modules/weekly-reports/create-input.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDirectory = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
const periodStart = '2026-08-03';
const draft = {
  summary: 'Diş kliniklerine yapılan ziyaretlerin özeti.', nextWeekPlan: 'Yeni klinik ziyaretleri.',
  blockers: null, highlights: null, fieldObservations: null, supportNeeded: null,
};

async function insertOpenSubmissionIncident(
  pool: Pool, organizationId: string, jobCardId: string, staffId: string,
): Promise<void> {
  const revisionNo = (await pool.query<{ revision_no: number }>(
    `SELECT MAX(revision_no) AS revision_no FROM job_card_schedule_revisions
      WHERE organization_id = $1 AND job_card_id = $2`,
    [organizationId, jobCardId],
  )).rows[0]!.revision_no;
  await pool.query(
    `INSERT INTO job_card_overdue_incidents
       (organization_id, job_card_id, delay_type, episode_no, schedule_revision_no,
        deadline_at, breached_at, accountable_user_id, accountable_role,
        accountable_source, source)
     VALUES ($1, $2, 'LATE_SUBMISSION', 1, $3, $4, $4, $5, 'STAFF',
             'ASSIGNMENT_AT_BREACH', 'SCANNER')`,
    [organizationId, jobCardId, revisionNo, new Date('2026-08-03T07:30:00.001Z'), staffId],
  );
}

async function selectJobIncidents(pool: Pool, organizationId: string, jobCardId: string) {
  return (await pool.query(
    `SELECT delay_type, episode_no, schedule_revision_no, deadline_at, breached_at,
            accountable_user_id, recovered_at, recovery_actor_user_id,
            ended_at, ended_by_user_id, end_reason, end_note,
            ended_by_schedule_revision_no
       FROM job_card_overdue_incidents
      WHERE organization_id = $1 AND job_card_id = $2
      ORDER BY breached_at ASC, id ASC`,
    [organizationId, jobCardId],
  )).rows as Record<string, unknown>[];
}

async function selectActivityMetadata(
  pool: Pool, organizationId: string, jobCardId: string, eventType: string,
): Promise<Record<string, unknown>[]> {
  return (await pool.query<{ metadata: Record<string, unknown> }>(
    `SELECT metadata FROM job_card_activity_logs
      WHERE organization_id = $1 AND job_card_id = $2 AND event_type = $3
      ORDER BY created_at ASC, id ASC`,
    [organizationId, jobCardId, eventType],
  )).rows.map((row) => row.metadata);
}

async function withFixture(run: (fixture: {
  pool: Pool; service: JobCardService; admin: JobCardActor; staff: JobCardActor; manager: JobCardActor;
}) => Promise<void>) {
  const owner = new Pool({ connectionString: databaseUrl });
  const schema = `wr_remove_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool | undefined;
  try {
    await owner.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
    await runMigrations({ migrationsDirectory, store: new PostgresMigrationStore(pool) });
    const organizationId = (await pool.query("INSERT INTO organizations (name) VALUES ('Dental Test') RETURNING id")).rows[0].id;
    const user = async (role: JobCardActor['role']): Promise<JobCardActor> => ({
      id: (await pool!.query(`INSERT INTO users (organization_id,name,email,password_hash,role)
        VALUES ($1,$2,$3,'fixture-hash',$2) RETURNING id`, [organizationId,role,`${randomUUID()}@example.test`])).rows[0].id,
      organizationId, role,
    });
    await run({ pool, service: new JobCardService(new PostgresJobCardRepository(pool),
      () => new Date('2026-08-03T09:00:00.000Z')), admin: await user('ADMIN'), staff: await user('STAFF'),
      manager: await user('MANAGER') });
  } finally {
    await pool?.end();
    await owner.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await owner.end();
  }
}

describe.skipIf(!databaseUrl)('Admin Weekly Report removal (PostgreSQL)', () => {
  it('preserves a completed report and frozen submission while freeing the Staff/week', async () => {
    await withFixture(async ({ pool, service, admin, staff }) => {
      const sourceId = (await pool.query(`INSERT INTO job_cards
        (organization_id,type,status,title,assigned_to,created_by,staff_completed_at,staff_completed_by,
          manager_approved_at,manager_approved_by,started_at)
        VALUES ($1,'GENERAL_TASK','COMPLETED','Dental ürün katalog takip görevi',$2,$2,$3,$2,$3,$4,$3) RETURNING id`,
      [staff.organizationId,staff.id,new Date('2026-08-03T08:00:00Z'),admin.id])).rows[0].id;
      const sourceBefore = (await pool.query('SELECT to_jsonb(j) AS value FROM job_cards j WHERE id=$1',[sourceId])).rows[0].value;
      const created = await service.createWeeklyReport(staff,
        parseWeeklyReportCreateInput({ clientActionId: randomUUID(), periodStart }));
      await service.start(staff, created.jobCardId, { clientActionId: randomUUID(), expectedVersion: 1 });
      await service.updateWeeklyReportDraft(staff, created.jobCardId, { expectedVersion: 1, draft, answers: [] });
      await service.submitForApproval(staff, created.jobCardId,
        { clientActionId: randomUUID(), expectedVersion: 2, note: 'Haftalık rapor hazır.' });
      await service.approve(admin, created.jobCardId, { clientActionId: randomUUID(), expectedVersion: 3 });
      const before = await service.getWeeklyReport(admin, created.jobCardId);
      const submissions = await service.listWeeklyReportSubmissions(admin, created.jobCardId);
      expect(submissions[0]?.sourceWork.map((item) => item.jobCardId)).toContain(sourceId);
      const removed = await service.removeWeeklyReport(admin, created.jobCardId, {
        clientActionId: randomUUID(), expectedVersion: before.jobVersion,
        expectedReportVersion: before.version, reason: 'Yanlış raporlama haftası seçildi.',
      });
      expect(removed).toMatchObject({ jobStatus: 'INVALIDATED', canRemove: false,
        removal: { removedBy: admin.id, reason: 'Yanlış raporlama haftası seçildi.' } });
      expect(removed.draft).toEqual(before.draft);
      expect(await service.listWeeklyReportSubmissions(admin, created.jobCardId)).toEqual(submissions);
      expect((await pool.query('SELECT to_jsonb(j) AS value FROM job_cards j WHERE id=$1',[sourceId])).rows[0].value).toEqual(sourceBefore);
      expect((await pool.query('SELECT count(*)::int AS n FROM weekly_reports')).rows[0].n).toBe(1);
      const replacement = await service.createWeeklyReport(staff,
        parseWeeklyReportCreateInput({ clientActionId: randomUUID(), periodStart }));
      expect(replacement.reportId).not.toBe(created.reportId);
      expect(replacement.jobCardId).not.toBe(created.jobCardId);
      expect((await pool.query('SELECT count(*)::int AS n FROM weekly_reports')).rows[0].n).toBe(2);
    });
  });

  it('closes open overdue incidents when removal invalidates the report root', async () => {
    await withFixture(async ({ pool, service, admin, staff }) => {
      const created = await service.createWeeklyReport(staff,
        parseWeeklyReportCreateInput({ clientActionId: randomUUID(), periodStart }));
      await service.start(staff, created.jobCardId, { clientActionId: randomUUID(), expectedVersion: 1 });
      await insertOpenSubmissionIncident(
        pool, staff.organizationId, created.jobCardId, staff.id,
      );
      expect(await selectJobIncidents(pool, staff.organizationId, created.jobCardId))
        .toHaveLength(1);

      const removed = await service.removeWeeklyReport(admin, created.jobCardId, {
        clientActionId: randomUUID(), expectedVersion: 2, expectedReportVersion: 1,
        reason: 'Yanlış raporlama haftası seçildi.',
      });
      expect(removed.jobStatus).toBe('INVALIDATED');

      // Removal uses the same correction semantics as INVALIDATE: the open
      // obligation ends with the card, in the same transaction, with the
      // removal request time and actor. It is closure, not recovery.
      const rows = await selectJobIncidents(pool, staff.organizationId, created.jobCardId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        delay_type: 'LATE_SUBMISSION',
        episode_no: 1,
        accountable_user_id: staff.id,
        recovered_at: null,
        recovery_actor_user_id: null,
        ended_at: new Date('2026-08-03T09:00:00.000Z'),
        ended_by_user_id: admin.id,
        end_reason: 'CARD_INVALIDATED',
        end_note: null,
        ended_by_schedule_revision_no: null,
      });
      const history = await service.listOverdueIncidents(
        admin, created.jobCardId, { limit: 25, offset: 0 },
      );
      expect(history.items).toHaveLength(1);
      expect(history.items[0]).toMatchObject({
        endReason: 'CARD_INVALIDATED',
        endedAt: '2026-08-03T09:00:00.000Z',
        endedBy: { id: admin.id },
        endedByScheduleRevisionNo: null,
        recoveredAt: null,
        recoveryActor: null,
        totalDelaySeconds: null,
      });
      // The closure count lives on the existing command events; no new event
      // type is invented for an administrative closure.
      expect(await selectActivityMetadata(
        pool, staff.organizationId, created.jobCardId, 'JOB_INVALIDATED',
      )).toEqual([expect.objectContaining({ closedOverdueIncidents: 1 })]);
      expect(await selectActivityMetadata(
        pool, staff.organizationId, created.jobCardId, 'WEEKLY_REPORT_REMOVED',
      )).toEqual([expect.objectContaining({ closedOverdueIncidents: 1 })]);
    });
  });

  it('leaves open incidents untouched when the report root was already invalidated', async () => {
    await withFixture(async ({ pool, service, admin, staff }) => {
      const created = await service.createWeeklyReport(staff,
        parseWeeklyReportCreateInput({ clientActionId: randomUUID(), periodStart }));
      await service.start(staff, created.jobCardId, { clientActionId: randomUUID(), expectedVersion: 1 });
      // Historical shape: the root was invalidated before the OVR-2 closure
      // rule existed, so its incident is still open. Removal must not backfill.
      await pool.query(
        `UPDATE job_cards
            SET status = 'INVALIDATED', invalidated_at = $2,
                invalidated_by = $3, invalidation_reason_code = 'DUPLICATE'
          WHERE organization_id = $1 AND id = $4`,
        [staff.organizationId, new Date('2026-07-01T09:00:00.000Z'), admin.id, created.jobCardId],
      );
      await insertOpenSubmissionIncident(
        pool, staff.organizationId, created.jobCardId, staff.id,
      );
      const before = await selectJobIncidents(pool, staff.organizationId, created.jobCardId);
      expect(before).toHaveLength(1);
      expect(before[0]).toMatchObject({
        recovered_at: null, ended_at: null, ended_by_user_id: null, end_reason: null,
      });

      const removed = await service.removeWeeklyReport(admin, created.jobCardId, {
        clientActionId: randomUUID(), expectedVersion: 2, expectedReportVersion: 1,
        reason: 'Yanlış raporlama haftası seçildi.',
      });
      expect(removed.jobStatus).toBe('INVALIDATED');
      expect(await selectJobIncidents(pool, staff.organizationId, created.jobCardId))
        .toEqual(before);
      const history = await service.listOverdueIncidents(
        admin, created.jobCardId, { limit: 25, offset: 0 },
      );
      expect(history.items[0]).toMatchObject({
        endReason: null, endedAt: null, recoveredAt: null, totalDelaySeconds: null,
      });
      // No closure happened here, so no command event is added and the count
      // stays zero on the removal it actually performed.
      expect(await selectActivityMetadata(
        pool, staff.organizationId, created.jobCardId, 'JOB_INVALIDATED',
      )).toEqual([]);
      expect(await selectActivityMetadata(
        pool, staff.organizationId, created.jobCardId, 'WEEKLY_REPORT_REMOVED',
      )).toEqual([expect.objectContaining({ closedOverdueIncidents: 0 })]);
    });
  });

  it('previews active follow-up blockers and preserves the locked removal guard', async () => {
    await withFixture(async ({ pool, service, admin, staff }) => {
      const created = await service.createWeeklyReport(staff,
        parseWeeklyReportCreateInput({ clientActionId: randomUUID(), periodStart }));
      const childId = (await pool.query(`INSERT INTO job_cards
        (organization_id,type,status,title,assigned_to,created_by,source_job_card_id,follow_up_instructions)
        VALUES ($1,'GENERAL_TASK','NEW','Takip işi',$2,$3,$4,'Takip ziyaretini planla') RETURNING id`,
      [staff.organizationId, staff.id, admin.id, created.jobCardId])).rows[0].id;
      expect(await service.weeklyReportRemovalPreview(admin, created.jobCardId)).toMatchObject({
        canRemove: false, removalBlocker: 'ACTIVE_FOLLOW_UPS',
        expectedVersion: 1, expectedReportVersion: 1,
      });
      await expect(service.removeWeeklyReport(admin, created.jobCardId, {
        clientActionId: randomUUID(), expectedVersion: 1, expectedReportVersion: 1,
        reason: 'Yanlış hafta.',
      })).rejects.toMatchObject({ code: 'JOB_HAS_ACTIVE_FOLLOW_UPS' });
      expect((await pool.query('SELECT removed_at FROM weekly_reports WHERE id=$1',[created.reportId]))
        .rows[0].removed_at).toBeNull();
      await pool.query(`UPDATE job_cards SET status='CANCELLED', version=version+1,
        cancelled_at='2026-08-04T09:00:00.000Z', cancelled_by=$2, cancel_reason='Takip gerekmiyor.'
        WHERE id=$1`, [childId, admin.id]);
      expect(await service.weeklyReportRemovalPreview(admin, created.jobCardId))
        .toMatchObject({ canRemove: true, removalBlocker: null });
    });
  });

  it('rejects Manager/Staff, stale versions and stale Admin authority without changing the report', async () => {
    await withFixture(async ({ pool, service, admin, staff, manager }) => {
      const created = await service.createWeeklyReport(staff,
        parseWeeklyReportCreateInput({ clientActionId: randomUUID(), periodStart }));
      const input = { clientActionId: randomUUID(), expectedVersion: 1, expectedReportVersion: 1, reason: 'Yanlış hafta.' };
      for (const actor of [staff, manager]) {
        await expect(service.weeklyReportRemovalPreview(actor,created.jobCardId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
        await expect(service.removeWeeklyReport(actor,created.jobCardId,input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      }
      for (const versions of [{ expectedVersion: 2 }, { expectedReportVersion: 2 }]) {
        await expect(service.removeWeeklyReport(admin,created.jobCardId,{ ...input,...versions,clientActionId: randomUUID() }))
          .rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
      }
      await pool.query("UPDATE users SET role='MANAGER' WHERE id=$1",[admin.id]);
      await expect(service.removeWeeklyReport(admin,created.jobCardId,input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      const report = await service.getWeeklyReport(staff,created.jobCardId);
      expect(report).toMatchObject({ version: 1,jobVersion: 1,jobStatus: 'ACCEPTED',removal: null });
      expect((await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE event_type='WEEKLY_REPORT_REMOVED'")).rows[0].n).toBe(0);
    });
  });

  it('keeps cancellation/invalidation reserved until explicit removal and replays only the original target', async () => {
    await withFixture(async ({ pool, service, admin, staff }) => {
      const create = () => service.createWeeklyReport(staff,
        parseWeeklyReportCreateInput({ clientActionId: randomUUID(),periodStart }));
      const original = await create();
      await service.cancel(admin,original.jobCardId,{ clientActionId: randomUUID(),expectedVersion: 1,cancelReason: 'Yanlış dönem.' });
      await expect(create()).rejects.toMatchObject({ code: 'WEEKLY_REPORT_ALREADY_EXISTS' });
      await service.invalidate(admin,original.jobCardId,{ clientActionId: randomUUID(),expectedVersion: 2,reasonCode: 'CREATED_BY_MISTAKE',note: null });
      await expect(create()).rejects.toMatchObject({ code: 'WEEKLY_REPORT_ALREADY_EXISTS' });
      const input = { clientActionId: randomUUID(),expectedVersion: 3,expectedReportVersion: 1,reason: 'Dönemi yeniden aç.' };
      const removed = await service.removeWeeklyReport(admin,original.jobCardId,input);
      const results = await Promise.allSettled([create(),create()]);
      expect(results.filter((r) => r.status==='fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status==='rejected')).toHaveLength(1);
      expect(await service.removeWeeklyReport(admin,original.jobCardId,input)).toEqual(removed);
      await expect(service.removeWeeklyReport(admin,original.jobCardId,{ ...input,reason: 'Değişen gerekçe.' }))
        .rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED' });
      await expect(service.removeWeeklyReport(admin,original.jobCardId,{ ...input,clientActionId: randomUUID() }))
        .rejects.toMatchObject({ code: 'WEEKLY_REPORT_ALREADY_REMOVED' });
      expect((await pool.query("SELECT count(*)::int AS n FROM job_card_activity_logs WHERE event_type='WEEKLY_REPORT_REMOVED'")).rows[0].n).toBe(1);
      expect((await pool.query('SELECT count(*)::int AS n FROM weekly_reports WHERE removed_at IS NULL')).rows[0].n).toBe(1);
    });
  });

  it('rolls back invalidation and period release when the later report audit fails', async () => {
    await withFixture(async ({ pool, service, admin, staff }) => {
      const created = await service.createWeeklyReport(staff,
        parseWeeklyReportCreateInput({ clientActionId: randomUUID(),periodStart }));
      const actionId = randomUUID();
      const countRealtime = async () => (await pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM realtime_events WHERE organization_id=$1 AND entity_id=$2',
        [admin.organizationId, created.jobCardId],
      )).rows[0]!.n;
      const realtimeBefore = await countRealtime();
      const appendAudit = PostgresJobCardTransaction.prototype.appendAudit;
      const spy = vi.spyOn(PostgresJobCardTransaction.prototype, 'appendAudit')
        .mockImplementation(function (input) {
          if (input.eventType === 'WEEKLY_REPORT_REMOVED') {
            return Promise.reject(new Error('forced removal audit failure'));
          }
          return appendAudit.call(this, input);
        });
      try {
        await expect(service.removeWeeklyReport(admin, created.jobCardId, { clientActionId: actionId,
          expectedVersion: 1, expectedReportVersion: 1, reason: 'Hatalı hafta.' }))
          .rejects.toThrow('forced removal audit failure');
      } finally { spy.mockRestore(); }
      expect(await countRealtime()).toBe(realtimeBefore);
      expect((await pool.query(
        'SELECT count(*)::int AS n FROM processed_actions WHERE client_action_id=$1', [actionId],
      )).rows[0].n).toBe(0);
      expect((await pool.query(
        'SELECT count(*)::int AS n FROM audit_events WHERE subject_id=$1', [created.jobCardId],
      )).rows[0].n).toBe(0);
      expect(await service.getWeeklyReport(admin,created.jobCardId)).toMatchObject({ removal: null,version: 1,jobVersion: 1,jobStatus: 'ACCEPTED' });
      expect((await pool.query("SELECT count(*)::int AS n FROM job_card_activity_logs WHERE event_type IN ('WEEKLY_REPORT_REMOVED','JOB_INVALIDATED')")).rows[0].n).toBe(0);
      await expect(service.createWeeklyReport(staff,parseWeeklyReportCreateInput({ clientActionId: randomUUID(),periodStart })))
        .rejects.toMatchObject({ code: 'WEEKLY_REPORT_ALREADY_EXISTS' });
    });
  });

  it('fails closed for inactive Admin, cross-organization, wrong type and inconsistent ownership', async () => {
    await withFixture(async ({ pool, service, admin, staff }) => {
      const created = await service.createWeeklyReport(staff,
        parseWeeklyReportCreateInput({ clientActionId: randomUUID(), periodStart }));
      const input = () => ({ clientActionId: randomUUID(), expectedVersion: 1, expectedReportVersion: 1, reason: 'Hatalı hafta.' });
      await pool.query('UPDATE users SET is_active=false WHERE id=$1',[admin.id]);
      await expect(service.removeWeeklyReport(admin,created.jobCardId,input())).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await pool.query('UPDATE users SET is_active=true WHERE id=$1',[admin.id]);
      const otherOrganization = (await pool.query("INSERT INTO organizations (name) VALUES ('Other dental company') RETURNING id")).rows[0].id;
      const otherAdminId = (await pool.query(`INSERT INTO users (organization_id,name,email,password_hash,role)
        VALUES ($1,'Other Admin',$2,'fixture-hash','ADMIN') RETURNING id`,[otherOrganization,`${randomUUID()}@example.test`])).rows[0].id;
      const otherAdmin: JobCardActor = { id: otherAdminId, organizationId: otherOrganization, role: 'ADMIN' };
      await expect(service.weeklyReportRemovalPreview(otherAdmin,created.jobCardId)).rejects.toMatchObject({ statusCode: 404 });
      await expect(service.removeWeeklyReport(otherAdmin,created.jobCardId,input())).rejects.toMatchObject({ code: 'WEEKLY_REPORT_NOT_FOUND' });
      const generalTaskId = (await pool.query(`INSERT INTO job_cards (organization_id,type,status,title,assigned_to,created_by)
        VALUES ($1,'GENERAL_TASK','NEW','Dental katalog görevi',$2,$2) RETURNING id`,[staff.organizationId,staff.id])).rows[0].id;
      await expect(service.removeWeeklyReport(admin,generalTaskId,input())).rejects.toMatchObject({ code: 'WEEKLY_REPORT_NOT_FOUND' });
      await pool.query('UPDATE job_cards SET assigned_to=$1 WHERE id=$2',[admin.id,created.jobCardId]);
      await expect(service.removeWeeklyReport(admin,created.jobCardId,input())).rejects.toMatchObject({ code: 'WEEKLY_REPORT_OWNERSHIP_CONFLICT' });
      expect((await pool.query('SELECT removed_at FROM weekly_reports WHERE id=$1',[created.reportId])).rows[0].removed_at).toBeNull();
      expect((await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE event_type='WEEKLY_REPORT_REMOVED'")).rows[0].n).toBe(0);
    });
  });

  it('keeps old receipts and history across single/bulk replacement cycles', async () => {
    await withFixture(async ({ pool, service, admin, staff }) => {
      const input = parseWeeklyReportCreateInput({ clientActionId: randomUUID(), periodStart });
      const original = await service.createWeeklyReport(staff,input);
      await service.removeWeeklyReport(admin,original.jobCardId,{ clientActionId: randomUUID(),
        expectedVersion: 1, expectedReportVersion: 1, reason: 'Birinci hatalı rapor.' });
      const bulkInput = parseWeeklyReportBulkRequestInput({ clientActionId: randomUUID(), periodStart, staffUserIds: [staff.id] });
      const bulk = await service.bulkRequestWeeklyReports(admin,bulkInput);
      expect(bulk.items[0]).toMatchObject({ outcome: 'created', staffUserId: staff.id });
      const replacementId = bulk.items[0]!.jobCardId;
      const existing = await service.bulkRequestWeeklyReports(admin,{ ...bulkInput,clientActionId: randomUUID() });
      expect(existing.items[0]).toMatchObject({ outcome: 'existing', jobCardId: replacementId });
      await service.removeWeeklyReport(admin,replacementId,{ clientActionId: randomUUID(),
        expectedVersion: 1,expectedReportVersion: 1,reason: 'İkinci hatalı rapor.' });
      const latest = await service.createWeeklyReport(staff,{ ...input,clientActionId: randomUUID() });
      expect(latest.jobCardId).not.toBe(replacementId);
      expect(await service.createWeeklyReport(staff,input)).toEqual(original);
      expect(await service.bulkRequestWeeklyReports(admin,bulkInput)).toEqual(bulk);
      const repository = new PostgresJobCardRepository(pool);
      const history = await repository.listForStaff({ organizationId: staff.organizationId,targetUserId: staff.id,actor: staff,limit: 20,offset: 0 });
      expect(history.total).toBe(3);
      expect(history.items[0]).toMatchObject({ jobCardId: latest.jobCardId,removedAt: null });
      expect(history.items.filter(item => item.removedAt!==null)).toHaveLength(2);
      expect((await pool.query('SELECT count(*)::int AS n FROM weekly_reports WHERE removed_at IS NULL')).rows[0].n).toBe(1);
    });
  });

  it('serializes a replacement create behind a removal holding the Staff lock', async () => {
    await withFixture(async ({ pool, service, admin, staff }) => {
      const original = await service.createWeeklyReport(staff,
        parseWeeklyReportCreateInput({ clientActionId: randomUUID(),periodStart }));
      let reached!: () => void;
      const locked = new Promise<void>(resolve => { reached = resolve; });
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const actual = PostgresJobCardTransaction.prototype.removeWeeklyReportRow;
      const spy = vi.spyOn(PostgresJobCardTransaction.prototype,'removeWeeklyReportRow').mockImplementationOnce(async function (input) {
        reached();await gate;return actual.call(this,input);
      });
      let removal: ReturnType<JobCardService['removeWeeklyReport']> | undefined;
      let creation: ReturnType<JobCardService['createWeeklyReport']> | undefined;
      try {
        removal = service.removeWeeklyReport(admin,original.jobCardId,{ clientActionId: randomUUID(),
          expectedVersion: 1,expectedReportVersion: 1,reason: 'Yanlış hafta.' });
        await locked;
        creation = service.createWeeklyReport(staff,parseWeeklyReportCreateInput({ clientActionId: randomUUID(),periodStart }));
        release();
        const [removed,replacement] = await Promise.all([removal,creation]);
        expect(removed.removal).not.toBeNull();
        expect(replacement.jobCardId).not.toBe(original.jobCardId);
        expect((await pool.query('SELECT count(*)::int AS n FROM weekly_reports WHERE removed_at IS NULL')).rows[0].n).toBe(1);
      } finally { release();spy.mockRestore();await Promise.allSettled([removal,creation]); }
    });
  });

  /**
   * Removal now follows the staff-user lock contract, so it requests the owner
   * users row in FOR NO KEY UPDATE mode (via `lockAssigneesInOrder`) before it
   * touches job_cards. A concurrent holder of that row therefore serializes
   * removal instead of letting it slip past on a compatible SHARE lock: the
   * command must wait, write nothing, and finish once the holder releases.
   */
  it('waits for a conflicting users lock on the report owner before touching the report', async () => {
    await withFixture(async ({ pool, service, admin, staff }) => {
      const original = await service.createWeeklyReport(staff,
        parseWeeklyReportCreateInput({ clientActionId: randomUUID(),periodStart }));
      const holder = await pool.connect();
      let removal: ReturnType<JobCardService['removeWeeklyReport']> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await holder.query('BEGIN');
        await holder.query(
          'SELECT id FROM users WHERE organization_id=$1 AND id=$2 FOR SHARE',
          [staff.organizationId, staff.id],
        );
        removal = service.removeWeeklyReport(admin, original.jobCardId, {
          clientActionId: randomUUID(), expectedVersion: 1, expectedReportVersion: 1,
          reason: 'Yanlış hafta seçildi.',
        });
        const outcome = await Promise.race([
          removal.then(() => 'completed' as const),
          new Promise<'blocked'>(resolve => { timer = setTimeout(() => resolve('blocked'), 3000); }),
        ]);
        expect(outcome).toBe('blocked');
        expect((await pool.query('SELECT removed_at FROM weekly_reports WHERE id=$1',
          [original.reportId])).rows[0].removed_at).toBeNull();
        await holder.query('ROLLBACK');
        const removed = await removal;
        expect(removed.removal).not.toBeNull();
      } finally {
        if (timer) clearTimeout(timer);
        await holder.query('ROLLBACK').catch(() => {});
        holder.release();
        await Promise.allSettled([removal]);
      }
    });
  });

  /**
   * Real SUBMIT vs REMOVE race. Both sides follow the staff-user lock contract:
   * each locks the involved staff users rows (SUBMIT: the note author, i.e. the
   * report owner; REMOVE: the acting admin and the owner, sorted and
   * de-duplicated) and only then the JobCard. The owner's users row is thus a
   * single serialization point ahead of every JobCard access, so the two
   * commands cannot form a cross-table 40P01 cycle; both sides run the real
   * production commands.
   */
  it('serializes a concurrent submit and removal without a deadlock', async () => {
    await withFixture(async ({ pool, service, admin, staff }) => {
      const created = await service.createWeeklyReport(staff,
        parseWeeklyReportCreateInput({ clientActionId: randomUUID(),periodStart }));
      await service.start(staff, created.jobCardId,
        { clientActionId: randomUUID(), expectedVersion: 1 });
      await service.updateWeeklyReportDraft(staff, created.jobCardId,
        { expectedVersion: 1, draft, answers: [] });

      const actual = PostgresJobCardTransaction.prototype.getNoteAuthorSnapshot;
      const actualAssigneeForUpdate =
        PostgresJobCardTransaction.prototype.getAssigneeForUpdate;
      let gateSubmit!: () => void;
      const submitAtOwnerLock = new Promise<void>(resolve => { gateSubmit = resolve; });
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let paused = false;
      // Identify the exact backend that runs REMOVE, so the wait can be scoped
      // to that connection instead of any waiter in the whole instance.
      let captureRemovalPid = false;
      let removalPid: number | null = null;
      const spy = vi.spyOn(PostgresJobCardTransaction.prototype,'getNoteAuthorSnapshot')
        .mockImplementation(async function (organizationId, authorId) {
          // SUBMIT reaches this holding the JobCard lock; hold it there once.
          if (!paused && authorId === staff.id) {
            paused = true; gateSubmit(); await gate;
          }
          return actual.call(this, organizationId, authorId);
        });
      // REMOVE now blocks while taking its users-first locks, before it ever
      // reaches the JobCard lock, so its backend is captured on that call.
      const pidSpy = vi.spyOn(PostgresJobCardTransaction.prototype,'getAssigneeForUpdate')
        .mockImplementation(async function (organizationId: string, userId: string) {
          if (captureRemovalPid && removalPid === null) {
            const self = await (this as unknown as {
              client: { query(sql: string): Promise<{ rows: Array<{ pid: number }> }> };
            }).client.query('SELECT pg_backend_pid() AS pid');
            removalPid = self.rows[0]!.pid;
          }
          return actualAssigneeForUpdate.call(this, organizationId, userId);
        });

      const failure = (error: unknown) =>
        (error as { code?: string; driverError?: { code?: string } });
      let submit: ReturnType<JobCardService['submitForApproval']> | undefined;
      let removal: ReturnType<JobCardService['removeWeeklyReport']> | undefined;
      try {
        submit = service.submitForApproval(staff, created.jobCardId,
          { clientActionId: randomUUID(), expectedVersion: 2, note: 'Onaya gönderildi.' });
        await submitAtOwnerLock;
        captureRemovalPid = true;
        removal = service.removeWeeklyReport(admin, created.jobCardId,
          { clientActionId: randomUUID(), expectedVersion: 2, expectedReportVersion: 1, reason: 'Yanlış hafta.' });
        // Deterministic: wait until the REMOVE backend itself is waiting on the
        // submit transaction (the owner users row / JobCard it holds), then
        // release SUBMIT. Scoping the probe to that backend pid keeps unrelated,
        // parallel waiters from satisfying the condition.
        const deadline = Date.now() + 8000;
        let observed = 0;
        for (;;) {
          if (removalPid !== null) {
            const waiting = await pool.query(
              `SELECT count(*)::int AS n FROM pg_locks
                WHERE pid = $1 AND NOT granted`,
              [removalPid],
            );
            observed = waiting.rows[0].n as number;
            if (observed > 0) break;
          }
          if (Date.now() > deadline) {
            throw new Error(
              `REMOVE backend ${removalPid ?? 'unknown'} never waited on the submit transaction (observed=${observed})`,
            );
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        release();
        const [submitted, removed] = await Promise.allSettled([submit, removal]);
        // No side may die from a deadlock, whichever one wins the race.
        for (const settled of [submitted, removed]) {
          if (settled.status === 'rejected') {
            const error = failure(settled.reason);
            expect(error.driverError?.code ?? error.code).not.toBe('40P01');
          }
        }
        expect(submitted.status).toBe('fulfilled');
        // The winner advanced the JobCard version, so the loser must lose cleanly.
        expect(removed.status).toBe('rejected');
        if (removed.status === 'rejected') {
          expect((removed.reason as { code?: string }).code).toBe('VERSION_CONFLICT');
        }

        const job = (await pool.query(
          'SELECT status, version FROM job_cards WHERE id=$1', [created.jobCardId],
        )).rows[0];
        expect(job.status).toBe('WAITING_APPROVAL');
        const report = (await pool.query(
          'SELECT removed_at, version FROM weekly_reports WHERE id=$1', [created.reportId],
        )).rows[0];
        expect(report.removed_at).toBeNull();
        expect((await pool.query(
          'SELECT count(*)::int AS n FROM weekly_report_submissions WHERE weekly_report_id=$1',
          [created.reportId],
        )).rows[0].n).toBe(1);
        expect((await pool.query(
          `SELECT count(*)::int AS n FROM job_card_activity_logs
            WHERE job_card_id=$1 AND event_type='WEEKLY_REPORT_REMOVED'`, [created.jobCardId],
        )).rows[0].n).toBe(0);
        expect((await pool.query(
          'SELECT count(*)::int AS n FROM weekly_reports WHERE removed_at IS NULL',
        )).rows[0].n).toBe(1);
      } finally {
        release();
        spy.mockRestore();
        pidSpy.mockRestore();
        await Promise.allSettled([submit, removal].filter(Boolean) as Promise<unknown>[]);
      }
    });
  }, 20000);

  it('authenticates HTTP commands, validates input and reader-gates the strict existing detail shape', async () => {
    await withFixture(async ({ service, admin, staff, manager }) => {
      const original = await service.createWeeklyReport(staff,
        parseWeeklyReportCreateInput({ clientActionId: randomUUID(),periodStart }));
      let current: JobCardActor | null = null;
      const app = Fastify({ logger: false });
      app.setErrorHandler((error,_request,reply) => {
        const result = toErrorResponse(error);reply.code(result.statusCode).send(result.body);
      });
      await app.register(jobCardRoutes,{ prefix: '/api/job-cards',service,authenticate: async request => {
        if (!current) throw new AppError('UNAUTHORIZED',401,'Oturum açın.');
        request.currentUser = { ...current,name:'Test user',email:'test@example.test',isActive:true,mustChangePassword:false,version:1 };
      } });
      const base = `/api/job-cards/${original.jobCardId}/weekly-report`;
      const payload = { clientActionId: randomUUID(),expectedVersion: 1,expectedReportVersion: 1,reason: '  Yanlış hafta.  ' };
      try {
        expect((await app.inject({ method:'GET',url:`${base}/removal-preview` })).statusCode).toBe(401);
        expect((await app.inject({ method:'POST',url:`${base}/remove`,payload })).statusCode).toBe(401);
        current = manager;
        expect((await app.inject({ method:'GET',url:`${base}/removal-preview` })).statusCode).toBe(403);
        expect((await app.inject({ method:'POST',url:`${base}/remove`,payload })).statusCode).toBe(403);
        current = admin;
        const legacy = (await app.inject({ method:'GET',url:base })).json();
        expect(legacy).not.toHaveProperty('canRemove');expect(legacy).not.toHaveProperty('removal');
        const capable = (await app.inject({ method:'GET',url:`${base}?includeWeeklyReportRemovalCapability=true` })).json();
        expect(capable).toMatchObject({ canRemove:true,removal:null });
        const advisory = (await app.inject({ method:'GET',url:`${base}/removal-preview` })).json();
        expect(advisory).toMatchObject({ canRemove: true, removalBlocker: null });
        expect((await app.inject({ method:'POST',url:`${base}/remove`,payload:{ ...payload,reason:' ' } })).statusCode).toBe(400);
        expect((await app.inject({ method:'POST',url:`${base}/remove`,payload:{ ...payload,deleteSourceWork:true } })).statusCode).toBe(400);
        const response = await app.inject({ method:'POST',url:`${base}/remove`,payload });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ canRemove:false,removal:{ reason:'Yanlış hafta.',removedBy:admin.id } });
        current = staff;
        expect((await app.inject({ method:'GET',url:`${base}?includeWeeklyReportRemovalCapability=true` })).json())
          .toMatchObject({ canRemove:false,removal:{ reason:'Yanlış hafta.' } });
      } finally { await app.close(); }
    });
  });
});
