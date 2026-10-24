import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import type { SafeUser } from '../src/modules/auth/types.js';
import { PostgresJobCardRepository, type JobCardTransaction, type CriticalActionWorkResult, type CriticalActionClaim,
  type LifecycleIntentClaim, type LifecycleIntentReservation } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCardStatus } from '../src/modules/job-cards/types.js';
import { createOverdueBreachScanner, PostgresOverdueBreachScannerRepository } from '../src/modules/job-cards/overdue-breach-scanner.js';
import { buildWeeklyReportPdfDocumentModel } from '../src/modules/weekly-reports/pdf/document-model.js';
import { PostgresWeeklyReportRepository } from '../src/modules/weekly-reports/repository.js';
import { PostgresStaffOffboardingService } from '../src/modules/people/offboarding.js';
import { parseWeeklyReportCreateInput } from '../src/modules/weekly-reports/create-input.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDirectory = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
const draft = { summary: 'Haftanın özeti.', nextWeekPlan: 'Gelecek hafta planı.', blockers: null,
  highlights: null, fieldObservations: null, supportNeeded: null };
const now = () => new Date('2026-08-03T09:00:00Z');

function gate() {
  let release!: () => void; let entered!: () => void;
  const reached = new Promise<void>((r) => { entered = r; });
  const released = new Promise<void>((r) => { release = r; });
  return { reached, release, pause: async () => { entered(); await released; } };
}

// Observe real repository/client operations; no fake locks or in-memory writes.
class ObservedRepository extends PostgresJobCardRepository {
  readonly trace: string[] = [];
  afterRead?: () => Promise<void>;
  override async getWeeklyReportByJobId(org: string, id: string) {
    const row = await super.getWeeklyReportByJobId(org, id);
    await this.afterRead?.();
    return row;
  }
  before?: (method: string) => Promise<void>;
  after?: (method: string) => Promise<void>;
  wrap(tx: JobCardTransaction): JobCardTransaction {
    return new Proxy(tx, { get: (target, key) => {
      const method = Reflect.get(target, key);
      if (typeof method !== 'function') return method;
      return async (...args: unknown[]) => {
        this.trace.push(String(key));
        await this.before?.(String(key));
        const result = await method.apply(target, args);
        await this.after?.(String(key));
        return result;
      };
    } });
  }
  override executeTransaction<T>(work: (tx: JobCardTransaction) => Promise<T>) {
    return super.executeTransaction((tx) => work(this.wrap(tx)));
  }
  override executeCriticalAction<T>(claim: CriticalActionClaim,
    work: (tx: JobCardTransaction) => Promise<CriticalActionWorkResult<T>>) {
    return super.executeCriticalAction(claim, (tx) => work(this.wrap(tx)));
  }
  override finalizeLifecycleIntent<T>(claim: LifecycleIntentClaim, reservation: LifecycleIntentReservation,
    work: (tx: JobCardTransaction) => Promise<CriticalActionWorkResult<T>>,
    options: { jobCardId: string; lockUsers?: (tx: JobCardTransaction) => Promise<void> }) {
    return super.finalizeLifecycleIntent(claim, reservation, (tx) => work(this.wrap(tx)), options);
  }
}
function service(repo: PostgresJobCardRepository, clock = now) {
  return new JobCardService(repo, clock, { publish: () => undefined }, { enabled: false },
    { enabled: false }, { enabled: false, reminderLeadMinutes: 30 });
}
type Fixture = { pool: Pool; org: string; foreignOrg: string; app: string;
  staff: SafeUser; other: SafeUser; manager: SafeUser; admin: SafeUser; foreign: SafeUser; jobs: JobCardService };
async function withFixture(run: (f: Fixture) => Promise<void>) {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const app = `sof2b_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool | undefined;
  try {
    await adminPool.query(`CREATE SCHEMA ${app}`);
    pool = new Pool({ connectionString: databaseUrl, application_name: app,
      options: `-c search_path=${app},public -c statement_timeout=8000 -c lock_timeout=6000` });
    await runMigrations({ migrationsDirectory, store: new PostgresMigrationStore(pool) });
    const org = (await pool.query(`INSERT INTO organizations(name,timezone)
      VALUES ('SOF2B', 'Europe/Istanbul') RETURNING id`)).rows[0].id;
    const foreignOrg = (await pool.query(`INSERT INTO organizations(name) VALUES ('foreign') RETURNING id`)).rows[0].id;
    async function user(role: SafeUser['role'], organizationId = org): Promise<SafeUser> {
      const email = `${randomUUID()}@example.test`;
      const { id } = (await pool!.query(`INSERT INTO users(organization_id,name,email,password_hash,role)
        VALUES ($1,$2,$3,'test-hash',$2) RETURNING id`, [organizationId, role, email])).rows[0];
      return { id, organizationId, role, name: role, email, isActive: true, mustChangePassword: false, version: 1 };
    }
    const staff = await user('STAFF'); const other = await user('STAFF');
    const manager = await user('MANAGER'); const admin = await user('ADMIN'); const foreign = await user('ADMIN', foreignOrg);
    await pool.query(`CREATE TABLE draft_writes(report_id UUID NOT NULL);
      CREATE FUNCTION trace_draft_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN INSERT INTO draft_writes VALUES (NEW.id); RETURN NEW; END $$;
      CREATE TRIGGER trace_draft_write AFTER UPDATE OF draft_summary, draft_blockers, draft_next_week_plan,
        draft_highlights, draft_field_observations, draft_support_needed, manager_answers ON weekly_reports
        FOR EACH ROW EXECUTE FUNCTION trace_draft_write()`);
    await run({ pool, org, foreignOrg, app, staff, other, manager, admin, foreign,
      jobs: service(new PostgresJobCardRepository(pool)) });
  } finally {
    await pool?.end(); await adminPool.query(`DROP SCHEMA IF EXISTS ${app} CASCADE`); await adminPool.end();
  }
}
async function weekly(f: Fixture, status: JobCardStatus = 'IN_PROGRESS') {
  const { jobCardId: id } = await f.jobs.createWeeklyReport(f.manager, parseWeeklyReportCreateInput({
    clientActionId: randomUUID(), assignedTo: f.staff.id, periodStart: '2026-08-03',
  }));
  if (status !== 'NEW') await f.jobs.acceptAssignment(f.staff, id, await intent(f, id));
  if (!['NEW', 'ACCEPTED'].includes(status)) await f.jobs.start(f.staff, id, await intent(f, id));
  if (['WAITING_APPROVAL', 'REVISION_REQUESTED', 'COMPLETED', 'CANCELLED'].includes(status)) {
    await f.jobs.updateWeeklyReportDraft(f.staff, id, { expectedVersion: 1, draft, answers: [] });
    await f.jobs.submitForApproval(f.staff, id, { ...await intent(f, id), note: 'Rapor gönderimi.' });
  }
  if (status === 'REVISION_REQUESTED') await f.jobs.requestRevision(f.manager, id,
    { ...await intent(f, id), revisionReason: 'Açıklama gerekiyor.' });
  if (status === 'COMPLETED') await f.jobs.approve(f.manager, id, await intent(f, id));
  if (status === 'CANCELLED') await f.jobs.cancel(f.manager, id,
    { ...await intent(f, id), cancelReason: 'Yönetici kararı.' });
  return id;
}
async function intent(f: Fixture, id: string) {
  return { clientActionId: randomUUID(), expectedVersion: (await f.jobs.detail(f.manager, id)).version };
}
async function report(f: Fixture, id: string) {
  return (await f.pool.query(`SELECT to_jsonb(w) AS row FROM weekly_reports w WHERE job_card_id=$1`, [id])).rows[0].row;
}
async function writes(f: Fixture) { return Number((await f.pool.query(`SELECT COUNT(*) AS n FROM draft_writes`)).rows[0].n); }
async function materializeLateSubmission(f: Fixture) {
  // Lifecycle reservations use the database clock. Sample that same clock
  // after START so a small host/PG skew cannot hide the test's overdue episode.
  const scanTime = (await f.pool.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;
  const result = await createOverdueBreachScanner(new PostgresOverdueBreachScannerRepository(
    new PostgresJobCardRepository(f.pool))).runOnce(scanTime);
  expect(result.inserted).toBe(1);
  return () => scanTime;
}
async function outcome<T>(promise: Promise<T>) {
  return promise.then((value) => ({ value }), (error: unknown) => ({ error }));
}
async function waitForLock(f: Fixture) {
  const until = Date.now() + 3500;
  while (Date.now() < until) {
    const r = await f.pool.query(`SELECT pid, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
      WHERE application_name=$1 AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0`, [f.app]);
    if (r.rowCount) return r.rows;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Expected a real PostgreSQL row lock wait');
}

async function state(f: Fixture) {
  const result: Record<string, unknown> = {};
  for (const table of ['job_cards', 'users', 'weekly_reports', 'weekly_report_submissions', 'job_card_activity_logs',
    'job_card_notes', 'job_card_assignment_history', 'job_card_accountability_facts', 'audit_events', 'processed_actions',
    'sessions', 'calendar_events', 'calendar_reminders', 'realtime_events', 'job_card_lifecycle_intents']) {
    result[table] = (await f.pool.query(`SELECT to_jsonb(t) row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
  }
  return result;
}

describe.skipIf(!databaseUrl)('SOF-2B atomic weekly draft (PostgreSQL)', () => {
  it('rejects a delayed draft after manager CANCEL commits, with zero draft UPDATE', async () => withFixture(async (f) => {
    const id = await weekly(f); const before = await report(f, id);
    const cancelRepo = new ObservedRepository(f.pool); const locked = gate();
    cancelRepo.after = async (method) => { if (method === 'getJobForUpdate') await locked.pause(); };
    const cancellation = outcome(service(cancelRepo).cancel(f.manager, id,
      { ...await intent(f, id), cancelReason: 'Rapor talebi geri çekildi.' }));
    await locked.reached;
    const draftRepo = new ObservedRepository(f.pool); const read = gate();
    draftRepo.afterRead = () => read.pause();
    const delayed = outcome(service(draftRepo).updateWeeklyReportDraft(f.staff, id,
      { expectedVersion: before.version, draft, answers: [] }));
    let observation: string;
    try { observation = await Promise.race([waitForLock(f).then(() => 'blocked'), read.reached.then(() => 'unlocked-read')]); }
    finally { locked.release(); }
    const cancelled = await cancellation; read.release();
    expect(cancelled).toHaveProperty('value');
    expect(await delayed).toMatchObject({ error: { code: 'WEEKLY_REPORT_DRAFT_LOCKED', statusCode: 409 } });
    expect(observation).toBe('blocked');
    expect(await report(f, id)).toEqual(before);
    expect(await writes(f)).toBe(0);
  }));
  it('never exposes or executes a new STAFF weekly CANCEL', async () => withFixture(async (f) => {
    const id = await weekly(f, 'ACCEPTED'); const input = { ...await intent(f, id), cancelReason: 'Personel isteği.' };
    expect((await f.jobs.detail(f.staff, id)).workflowContext.allowedCommands).not.toContain('CANCEL');
    await expect(f.jobs.cancel(f.staff, id, input)).rejects.toMatchObject({ code: 'INVALID_TRANSITION', statusCode: 409 });
  }));

  it('exposes no standalone draft writer that bypasses JobCard lifecycle authorization', async () => withFixture(async (f) => {
    const repo = new PostgresWeeklyReportRepository(f.pool);
    expect('updateDraft' in repo).toBe(false);
    expect('updateWeeklyReportDraftRow' in new PostgresJobCardRepository(f.pool)).toBe(false);
  }));

  it('serializes weekly manual reminder and draft without a User/JobCard deadlock', async () => withFixture(async (f) => {
    const id = await weekly(f);
    const reminderNow = await materializeLateSubmission(f);
    const repo = new ObservedRepository(f.pool); const locked = gate();
    repo.after = async (method) => { if (method === 'getJobForUpdate') await locked.pause(); };
    const reminder = outcome(service(repo, reminderNow).sendSubmissionReminder(f.manager, id, await intent(f, id)));
    await locked.reached;
    const replacement = outcome(f.jobs.updateWeeklyReportDraft(f.staff, id, { expectedVersion: 1, draft, answers: [] }));
    try { expect((await waitForLock(f)).length).toBeGreaterThan(0); } finally { locked.release(); }
    expect(await reminder).toHaveProperty('value');
    expect(await replacement).toHaveProperty('value');
    expect(await writes(f)).toBe(1);
  }));
  for (const command of ['CANCEL', 'SUBMIT', 'APPROVE', 'REVISION', 'RESUME'] as const) {
    for (const first of ['draft', 'lifecycle'] as const) {
      it(`${command}: ${first} locks first; actual wait and fresh editable-state validation`, async () => withFixture(async (f) => {
        const status = command === 'APPROVE' || command === 'REVISION' ? 'WAITING_APPROVAL'
          : command === 'RESUME' ? 'REVISION_REQUESTED' : 'IN_PROGRESS';
        const id = await weekly(f, status);
        if (command === 'SUBMIT') await f.jobs.updateWeeklyReportDraft(f.staff, id,
          { expectedVersion: 1, draft, answers: [] });
        const before = await report(f, id); const countBefore = await writes(f);
        const repo = new ObservedRepository(f.pool); const locked = gate();
        repo.after = async (method) => {
          if (method === (first === 'draft' ? 'getWeeklyReportByJobForUpdate' : 'getJobForUpdate')) await locked.pause();
        };
        const firstService = service(repo);
        const input = await intent(f, id);
        const transition = (jobs: JobCardService) => command === 'CANCEL'
          ? jobs.cancel(f.manager, id, { ...input, cancelReason: 'Yönetici kararı.' })
          : command === 'SUBMIT' ? jobs.submitForApproval(f.staff, id, { ...input, note: 'Haftalık sonuç.' })
          : command === 'APPROVE' ? jobs.approve(f.manager, id, input)
          : command === 'REVISION' ? jobs.requestRevision(f.manager, id, { ...input, revisionReason: 'Ek açıklama.' })
          : jobs.resume(f.staff, id, input);
        const replace = (jobs: JobCardService) => jobs.updateWeeklyReportDraft(f.staff, id,
          { expectedVersion: before.version, draft: { ...draft, summary: 'Yeni taslak.' }, answers: [] });
        const a = outcome(first === 'draft' ? replace(firstService) : transition(firstService));
        await locked.reached;
        const b = outcome(first === 'draft' ? transition(f.jobs) : replace(f.jobs));
        try { expect((await waitForLock(f)).length).toBeGreaterThan(0); } finally { locked.release(); }
        const draftResult = await (first === 'draft' ? a : b); const lifecycleResult = await (first === 'draft' ? b : a);
        expect(lifecycleResult).toHaveProperty('value');
        const editable = first === 'draft' ? command === 'CANCEL' || command === 'SUBMIT' : command === 'RESUME';
        if (editable) expect(draftResult).toHaveProperty('value');
        else expect(draftResult).toMatchObject({ error: { code: 'WEEKLY_REPORT_DRAFT_LOCKED' } });
        expect(await writes(f)).toBe(countBefore + (editable ? 1 : 0));
        const current = await report(f, id);
        expect(current.staff_user_id).toBe(f.staff.id);
        expect(current.draft_summary).toBe(editable ? 'Yeni taslak.' : before.draft_summary);
        expect(current.version).toBe(before.version + (editable ? 1 : 0) + (command === 'SUBMIT' ? 1 : 0));
        if (command === 'SUBMIT') {
          const history = await f.jobs.listWeeklyReportSubmissions(f.manager, id);
          expect(history[0]?.body.summary).toBe(first === 'draft' ? 'Yeni taslak.' : draft.summary);
        }
      }));
    }
  }

  for (const status of ['NEW', 'ACCEPTED', 'IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED'] as const) {
    for (const role of ['staff', 'manager', 'admin'] as const) {
      it(`${role} CANCEL ${status}: canonical capability and reservation authorization agree`, async () => withFixture(async (f) => {
        const id = await weekly(f, status); const actor = f[role];
        const input = { ...await intent(f, id), cancelReason: 'Rapor talebi sonuçlandırıldı.' };
        const before = await state(f);
        const detail = await f.jobs.detail(actor, id);
        if (role === 'staff') {
          await expect(f.jobs.cancel(actor, id, input)).rejects.toMatchObject({ code: 'INVALID_TRANSITION', statusCode: 409 });
          expect(detail.workflowContext.allowedCommands).not.toContain('CANCEL');
          expect(await state(f)).toEqual(before);
        } else {
          expect(detail.workflowContext.allowedCommands).toContain('CANCEL');
          await f.jobs.cancel(actor, id, input);
          const activity = (await f.pool.query(`SELECT actor_id, metadata FROM job_card_activity_logs
            WHERE job_card_id=$1 AND event_type='JOB_CANCELLED'`, [id])).rows;
          expect(activity).toHaveLength(1); expect(activity[0].actor_id).toBe(actor.id);
          const note = (await f.pool.query(`SELECT to_jsonb(n) row FROM job_card_notes n WHERE id=$1`,
            [activity[0].metadata.noteId])).rows[0].row;
          expect(JSON.stringify(note)).toContain(input.cancelReason); expect(note.author_id).toBe(actor.id);
          expect((await report(f, id)).staff_user_id).toBe(f.staff.id);
          expect((await state(f)).weekly_reports).toEqual(before.weekly_reports);
          expect((await state(f)).job_card_assignment_history).toEqual(before.job_card_assignment_history);
          const frozen = before.weekly_report_submissions;
          expect((await state(f)).weekly_report_submissions).toEqual(frozen);
        }
      }));
    }
  }

  it('rejects an already-reserved STAFF CANCEL at locked finalize with no business mutation', async () => withFixture(async (f) => {
    const id = await weekly(f); const input = { ...await intent(f, id), cancelReason: 'Legacy pending intent.' };
    // Model a reservation accepted before the amendment, not a new authorization.
    const repo = new ObservedRepository(f.pool);
    repo.reserveLifecycleIntent = (claim, options) => PostgresJobCardRepository.prototype.reserveLifecycleIntent.call(
      repo, claim, { ...options, preflight: undefined });
    const before = await report(f, id); const activities = (await state(f)).job_card_activity_logs;
    await expect(service(repo).cancel(f.staff, id, input)).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    expect(await report(f, id)).toEqual(before);
    expect((await f.jobs.detail(f.manager, id)).status).toBe('IN_PROGRESS');
    expect((await state(f)).job_card_activity_logs).toEqual(activities);
    expect((await f.pool.query(`SELECT COUNT(*)::int n FROM processed_actions WHERE client_action_id=$1`, [input.clientActionId])).rows[0].n).toBe(0);
    expect((await f.pool.query(`SELECT state FROM job_card_lifecycle_intents WHERE client_action_id=$1`, [input.clientActionId])).rows[0].state).toBe('FAILED');
  }));

  it('serializes competing full replacements and refuses stale/future report versions without UPDATE', async () => withFixture(async (f) => {
    const id = await weekly(f); const original = await state(f);
    const repo = new ObservedRepository(f.pool); const locked = gate();
    repo.after = async (method) => { if (method === 'updateWeeklyReportDraftRow') await locked.pause(); };
    const first = outcome(service(repo).updateWeeklyReportDraft(f.staff, id,
      { expectedVersion: 1, draft: { ...draft, blockers: 'İlk engel.' }, answers: [] }));
    await locked.reached;
    const second = outcome(f.jobs.updateWeeklyReportDraft(f.staff, id,
      { expectedVersion: 1, draft: { ...draft, summary: 'Kaybeden taslak.' }, answers: [] }));
    try { await waitForLock(f); } finally { locked.release(); }
    expect(await first).toHaveProperty('value'); expect(await second).toMatchObject({ error: { code: 'VERSION_CONFLICT' } });
    for (const expectedVersion of [1, 3, 99, 0, 1.5]) await expect(f.jobs.updateWeeklyReportDraft(f.staff, id,
      { expectedVersion, draft, answers: [] })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(await writes(f)).toBe(1);
    await f.jobs.updateWeeklyReportDraft(f.staff, id, { expectedVersion: 2, draft: { summary: 'Yeni', nextWeekPlan: 'Plan' }, answers: [] });
    expect((await report(f, id)).draft_blockers).toBeNull();
    expect((await report(f, id)).version).toBe(3);
    expect((await state(f)).job_card_activity_logs).toEqual(original.job_card_activity_logs);
    expect((await state(f)).processed_actions).toEqual(original.processed_actions);
  }));

  it('rolls back a draft, version and trigger evidence after a late transaction error', async () => withFixture(async (f) => {
    const id = await weekly(f); const before = await state(f); const repo = new ObservedRepository(f.pool);
    repo.after = async (method) => { if (method === 'updateWeeklyReportDraftRow') throw new Error('late transaction error'); };
    await expect(service(repo).updateWeeklyReportDraft(f.staff, id,
      { expectedVersion: 1, draft, answers: [] })).rejects.toThrow('late transaction error');
    expect(await state(f)).toEqual(before); expect(await writes(f)).toBe(0);
  }));

  for (const actor of ['other', 'manager', 'admin', 'foreign'] as const) {
    it(`rejects ${actor} draft writer with no mutation or tenant detail`, async () => withFixture(async (f) => {
      const id = await weekly(f); const before = await state(f);
      await expect(f.jobs.updateWeeklyReportDraft(f[actor], id,
        { expectedVersion: 1, draft, answers: [] })).rejects.toMatchObject({ statusCode: actor === 'other' ? 404 : 403 });
      expect(await state(f)).toEqual(before); expect(await writes(f)).toBe(0);
    }));
  }
  for (const change of ['inactive', 'role', 'foreign-tenant', 'assignee', 'owner', 'missing-report'] as const) {
    it(`revalidates ${change} under locks, including historical owner/assignee mismatch`, async () => withFixture(async (f) => {
      const id = await weekly(f);
      if (change === 'inactive') await f.pool.query(`UPDATE users SET is_active=false WHERE id=$1`, [f.staff.id]);
      if (change === 'role') await f.pool.query(`UPDATE users SET role='MANAGER' WHERE id=$1`, [f.staff.id]);
      if (change === 'assignee') await f.pool.query(`UPDATE job_cards SET assigned_to=$2 WHERE id=$1`, [id, f.other.id]);
      if (change === 'owner') await f.pool.query(`UPDATE weekly_reports SET staff_user_id=$2 WHERE job_card_id=$1`, [id, f.other.id]);
      if (change === 'missing-report') await f.pool.query(`DELETE FROM weekly_reports WHERE job_card_id=$1`, [id]);
      const before = await state(f);
      const actor = change === 'foreign-tenant' ? { ...f.staff, organizationId: f.foreignOrg } : f.staff;
      await expect(f.jobs.updateWeeklyReportDraft(actor, id, { expectedVersion: 1, draft, answers: [] })).rejects.toHaveProperty('statusCode');
      expect(await state(f)).toEqual(before); expect(await writes(f)).toBe(0);
      if (change === 'assignee') await expect(f.jobs.updateWeeklyReportDraft(f.other, id,
        { expectedVersion: 1, draft, answers: [] })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }));
  }

  it('freezes seq1/seq2 PDF models and attribution across revision, manager cancellation and rejected late draft', async () => withFixture(async (f) => {
    const id = await weekly(f, 'WAITING_APPROVAL');
    await f.jobs.requestRevision(f.manager, id, { ...await intent(f, id), revisionReason: 'İkinci sürüm.' });
    await f.jobs.resume(f.staff, id, await intent(f, id));
    const current = await report(f, id);
    await f.jobs.updateWeeklyReportDraft(f.staff, id, { expectedVersion: current.version, draft: { ...draft, summary: 'Sürüm iki.' }, answers: [] });
    await f.jobs.submitForApproval(f.staff, id, { ...await intent(f, id), note: 'Sürüm iki gönderildi.' });
    const history = await f.jobs.listWeeklyReportSubmissions(f.manager, id);
    const models = history.map((submission) => buildWeeklyReportPdfDocumentModel({ submission, staffName: f.staff.name }));
    expect(history.map((s) => s.seqNo)).toEqual([1, 2]);
    expect(history.every((s) => s.submittedBy === f.staff.id)).toBe(true);
    const input = { ...await intent(f, id), cancelReason: 'Açık rapor yönetici tarafından kapatıldı.' };
    await f.jobs.cancel(f.manager, id, input);
    const before = await state(f);
    await expect(f.jobs.updateWeeklyReportDraft(f.staff, id,
      { expectedVersion: (await report(f, id)).version, draft, answers: [] })).rejects.toMatchObject({ code: 'WEEKLY_REPORT_DRAFT_LOCKED' });
    expect(await state(f)).toEqual(before);
    const after = await f.jobs.listWeeklyReportSubmissions(f.manager, id);
    expect(after).toEqual(history);
    expect(after.map((submission) => buildWeeklyReportPdfDocumentModel({ submission, staffName: f.staff.name }))).toEqual(models);
    await f.jobs.cancel(f.manager, id, input); expect(await state(f)).toEqual(before);
  }));

  for (const type of ['GENERAL_TASK', 'PRODUCT_DELIVERY', 'SALES_MEETING'] as const) {
    it(`preserves STAFF reasoned CANCEL for ${type}`, async () => withFixture(async (f) => {
      const { id } = (await f.pool.query(`INSERT INTO job_cards(organization_id,type,status,title,assigned_to,created_by,engagement_kind)
        VALUES ($1,$2,'NEW','Normal görev',$3,$4,$5) RETURNING id`, [f.org, type, f.staff.id, f.manager.id, type === 'SALES_MEETING' ? 'SALES_MEETING' : null])).rows[0];
      expect((await f.jobs.detail(f.staff, id)).workflowContext.allowedCommands).toContain('CANCEL');
      await f.jobs.cancel(f.staff, id, { ...await intent(f, id), cancelReason: 'Normal görev iptali.' });
      expect((await f.jobs.detail(f.staff, id)).status).toBe('CANCELLED');
    }));
  }
  for (const first of ['draft', 'offboarding'] as const) {
    it(`draft/offboarding: ${first} holds User first; no deadlock or partial offboarding`, async () => withFixture(async (f) => {
      const offboarding = new PostgresStaffOffboardingService(f.pool);
      const plan = await offboarding.preview(f.admin, f.staff.id);
      const id = await weekly(f); const before = await state(f);
      const input = { clientActionId: randomUUID(), planHash: plan.planHash, reasonCode: 'ACCESS_ENDED' as const,
        jobDecisions: [], customerDecisions: [], calendarDecisions: [], followUpDecisions: [], reminderDecisions: [] };
      const repo = new ObservedRepository(f.pool); const locked = gate();
      repo.after = async (method) => { if (method === 'updateWeeklyReportDraftRow') await locked.pause(); };
      const heldPool = new Proxy(f.pool, { get(target, key) {
        if (key === 'connect') return async () => {
          const client = await target.connect();
          return new Proxy(client, { get(c, k) {
            if (k === 'query') return async (sql: string, values?: unknown[]) => {
              const result = await c.query(sql, values);
              if (sql.includes('ORDER BY id FOR UPDATE')) await locked.pause();
              return result;
            };
            const value = Reflect.get(c, k); return typeof value === 'function' ? value.bind(c) : value;
          } });
        };
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      } });
      const offboard = () => new PostgresStaffOffboardingService(first === 'offboarding' ? heldPool : f.pool)
        .execute(f.admin, f.staff.id, input);
      const replace = () => (first === 'draft' ? service(repo) : f.jobs).updateWeeklyReportDraft(f.staff, id,
        { expectedVersion: 1, draft, answers: [] });
      const a = outcome(first === 'draft' ? replace() : offboard()); await locked.reached;
      const b = outcome(first === 'draft' ? offboard() : replace());
      try { await waitForLock(f); } finally { locked.release(); }
      expect(await (first === 'draft' ? a : b)).toHaveProperty('value');
      expect(await (first === 'draft' ? b : a)).toMatchObject({ error: { code: 'OFFBOARDING_WEEKLY_REPORT_REQUIRES_RESOLUTION' } });
      const after = await state(f);
      for (const key of Object.keys(before).filter((k) => k !== 'weekly_reports')) expect(after[key]).toEqual(before[key]);
      expect(await writes(f)).toBe(1);
    }));
  }

  it('blocks actor deactivation under the draft SHARE lock and revalidates after a prior deactivation', async () => withFixture(async (f) => {
    const id = await weekly(f); const repo = new ObservedRepository(f.pool); const locked = gate();
    repo.after = async (method) => { if (method === 'getNoteAuthorSnapshot') await locked.pause(); };
    const replacement = outcome(service(repo).updateWeeklyReportDraft(f.staff, id, { expectedVersion: 1, draft, answers: [] }));
    await locked.reached;
    const deactivation = outcome(f.pool.query(`UPDATE users SET is_active=false WHERE id=$1`, [f.staff.id]));
    try { await waitForLock(f); } finally { locked.release(); }
    expect(await replacement).toHaveProperty('value'); expect(await deactivation).toHaveProperty('value');
    await expect(f.jobs.updateWeeklyReportDraft(f.staff, id, { expectedVersion: 2, draft, answers: [] }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await writes(f)).toBe(1);
  }));

  it('replays a seeded historical STAFF receipt exactly, but never authorizes a fresh STAFF cancellation', async () => withFixture(async (f) => {
    const id = await weekly(f); const input = { ...await intent(f, id), cancelReason: 'Historical completed intent.' };
    await f.jobs.cancel(f.manager, id, input);
    // Existing completed receipt under the old STAFF scope; no policy bypass in a new command.
    await f.pool.query(`INSERT INTO processed_actions(organization_id,user_id,client_action_id,operation_key,
      request_hash,status,status_code,response_body,completed_at)
      SELECT organization_id,$2,client_action_id,operation_key,request_hash,status,status_code,response_body,completed_at
      FROM processed_actions WHERE user_id=$1 AND client_action_id=$3`, [f.manager.id, f.staff.id, input.clientActionId]);
    const before = await state(f);
    const replay = await f.jobs.cancel(f.staff, id, input); expect(replay.status).toBe('CANCELLED');
    await f.jobs.cancel(f.staff, id, input); expect(await state(f)).toEqual(before);
    await expect(f.jobs.cancel(f.staff, id, { ...input, cancelReason: 'Different intent.' }))
      .rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED' });
    await expect(f.jobs.cancel(f.staff, id, { ...input, ...await intent(f, id) }))
      .rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    await expect(f.jobs.cancel(f.other, id, { ...input, expectedVersion: (await intent(f, id)).expectedVersion })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(f.jobs.cancel(f.foreign, id, input)).rejects.toMatchObject({ code: 'JOB_CARD_NOT_FOUND' });
    expect(await state(f)).toEqual(before);
  }));

  it('reconciles a lost post-commit cancellation response by exact receipt replay, without changing OF-09', async () => withFixture(async (f) => {
    const id = await weekly(f); const input = { ...await intent(f, id), cancelReason: 'Response lost after commit.' };
    const repo = new PostgresJobCardRepository(f.pool);
    const read = repo.findJobCardDetail.bind(repo); let lost = true;
    repo.findJobCardDetail = async (...args) => { if (lost) throw new Error('simulated post-commit response loss'); return read(...args); };
    const jobs = service(repo);
    await expect(jobs.cancel(f.manager, id, input)).rejects.toThrow('simulated post-commit response loss');
    const before = await state(f); lost = false;
    expect((await jobs.cancel(f.manager, id, input)).status).toBe('CANCELLED');
    expect(await state(f)).toEqual(before);
    expect((await f.pool.query(`SELECT COUNT(*)::int n FROM job_card_activity_logs
      WHERE job_card_id=$1 AND event_type='JOB_CANCELLED'`, [id])).rows[0].n).toBe(1);
  }));

  it('keeps reason validation and exact manager replay after the policy change', async () => withFixture(async (f) => {
    const id = await weekly(f); const before = await state(f);
    await expect(f.jobs.cancel(f.manager, id, { ...await intent(f, id), cancelReason: ' ' }))
      .rejects.toMatchObject({ code: 'CANCEL_REASON_REQUIRED' });
    expect(await state(f)).toEqual(before);
  }));

  it('keeps weekly note-author SHARE compatible with a competing manual reminder', async () => withFixture(async (f) => {
    const id = await weekly(f);
    const reminderNow = await materializeLateSubmission(f);
    const repo = new ObservedRepository(f.pool); const locked = gate();
    repo.after = async (method) => { if (method === 'getJobForUpdate') await locked.pause(); };
    const note = outcome(service(repo).addNote(f.staff, id, { clientActionId: randomUUID(), note: 'Haftalık açıklama.' }));
    await locked.reached;
    const reminder = outcome(service(new PostgresJobCardRepository(f.pool), reminderNow)
      .sendSubmissionReminder(f.manager, id, await intent(f, id)));
    try { await waitForLock(f); } finally { locked.release(); }
    expect(await note).toHaveProperty('value'); expect(await reminder).toHaveProperty('value');
  }));

  for (const status of ['NEW', 'REVISION_REQUESTED', 'WAITING_APPROVAL', 'COMPLETED', 'CANCELLED', 'INVALIDATED'] as const) {
    it(`refuses draft replacement in ${status} with zero UPDATE and no historical mutation`, async () => withFixture(async (f) => {
      const id = await weekly(f, status === 'INVALIDATED' ? 'COMPLETED' : status);
      if (status === 'INVALIDATED') await f.jobs.invalidate(f.admin, id,
        { ...await intent(f, id), reasonCode: 'CREATED_BY_MISTAKE', note: null });
      const before = await state(f); const count = await writes(f);
      await expect(f.jobs.updateWeeklyReportDraft(f.staff, id,
        { expectedVersion: (await report(f, id)).version, draft, answers: [] }))
        .rejects.toMatchObject({ code: 'WEEKLY_REPORT_DRAFT_LOCKED' });
      expect(await state(f)).toEqual(before); expect(await writes(f)).toBe(count);
    }));
  }

  it('lets a weekly reminder wait behind a draft without changing report-version or assignment semantics', async () => withFixture(async (f) => {
    const id = await weekly(f);
    const reminderNow = await materializeLateSubmission(f);
    const repo = new ObservedRepository(f.pool); const locked = gate();
    repo.after = async (method) => { if (method === 'updateWeeklyReportDraftRow') await locked.pause(); };
    const replacement = outcome(service(repo).updateWeeklyReportDraft(f.staff, id, { expectedVersion: 1, draft, answers: [] }));
    await locked.reached;
    const reminder = outcome(service(new PostgresJobCardRepository(f.pool), reminderNow)
      .sendSubmissionReminder(f.manager, id, await intent(f, id)));
    try { await waitForLock(f); } finally { locked.release(); }
    expect(await replacement).toHaveProperty('value'); expect(await reminder).toHaveProperty('value');
    expect((await report(f, id)).version).toBe(2); expect(await writes(f)).toBe(1);
  }));

});
