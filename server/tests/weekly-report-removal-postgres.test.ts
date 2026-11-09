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

  it('previews active follow-up blockers and preserves the locked removal guard', async () => {
    await withFixture(async ({ pool, service, admin, staff }) => {
      const created = await service.createWeeklyReport(staff,
        parseWeeklyReportCreateInput({ clientActionId: randomUUID(), periodStart }));
      const childId = (await pool.query(`INSERT INTO job_cards
        (organization_id,type,status,title,assigned_to,created_by,source_job_card_id)
        VALUES ($1,'GENERAL_TASK','NEW','Takip işi',$2,$3,$4) RETURNING id`,
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
      await pool.query("UPDATE job_cards SET status='CANCELLED', version=version+1 WHERE id=$1",[childId]);
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

  it('rolls back removal, invalidation and period release when an audit write fails', async () => {
    await withFixture(async ({ pool, service, admin, staff }) => {
      const created = await service.createWeeklyReport(staff,
        parseWeeklyReportCreateInput({ clientActionId: randomUUID(),periodStart }));
      const spy = vi.spyOn(PostgresJobCardTransaction.prototype,'appendAudit').mockRejectedValueOnce(new Error('forced audit failure'));
      try {
        await expect(service.removeWeeklyReport(admin,created.jobCardId,{ clientActionId: randomUUID(),
          expectedVersion: 1,expectedReportVersion: 1,reason: 'Hatalı hafta.' })).rejects.toThrow('forced audit failure');
      } finally { spy.mockRestore(); }
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
   * SUBMIT holds the JobCard lock and then requests FOR SHARE on its note
   * author — which for a weekly report is the report owner. Removal runs
   * users -> job_cards, so it must acquire that same row in a mode compatible
   * with SHARE. A NO KEY UPDATE request would invert the order and deadlock
   * the two commands.
   */
  it('acquires the report owner without a lock mode that deadlocks a concurrent submit', async () => {
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
        expect(outcome).toBe('completed');
        expect((await removal).removal).not.toBeNull();
      } finally {
        if (timer) clearTimeout(timer);
        await holder.query('ROLLBACK').catch(() => {});
        holder.release();
        await Promise.allSettled([removal]);
      }
    });
  });

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
