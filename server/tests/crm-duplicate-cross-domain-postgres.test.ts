import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { expect, it } from 'vitest';
import { withSaleFixture, saleTime } from './support/sale-harness.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { CrmService } from '../src/modules/crm/service.js';
import { PostgresCrmRepository } from '../src/modules/crm/repository.js';
import { PostgresStaffOffboardingService } from '../src/modules/people/offboarding.js';
import { DuplicateComparisonService } from '../src/modules/crm/duplicate-service.js';
import { DuplicateReviewService } from '../src/modules/crm/duplicate-review-service.js';
import { PostgresDuplicateReadRepository } from '../src/modules/crm/duplicate-repository.js';
import { PostgresDuplicateReviewRepository } from '../src/modules/crm/duplicate-review-repository.js';
import { parseDuplicateKeyring } from '../src/modules/crm/duplicate-evidence.js';

const keys = parseDuplicateKeyring(JSON.stringify({ activeKeyId: 'synthetic', keys: { synthetic: Buffer.alloc(32, 41).toString('base64') } }));
const paths = ['sale', 'meeting', 'enrichment', 'offboarding'] as const;
function barrier() {
  let release!: () => void; let reached!: (pid: number) => void;
  const resume = new Promise<void>((done) => { release = done; });
  const entered = new Promise<number>((done) => { reached = done; });
  let hit = false;
  return { entered, release, async stop(pid: number) { if (!hit) { hit = true; reached(pid); await resume; } } };
}

// Observe real service SQL and pause only after PostgreSQL has acquired the
// selected lock. No service, policy or lock statement is substituted.
function observedPool(pool: Pool, after: (sql: string, pid: number) => Promise<void>, trace: string[]): Pool {
  return new Proxy(pool, { get(target, key) {
    if (key === 'connect') return async () => {
      const client = await target.connect();
      const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
      return new Proxy(client, { get(connection, field) {
        if (field === 'query') return async (...args: unknown[]) => {
          const sql = typeof args[0] === 'string' ? args[0] : '';
          trace.push(sql);
          const result = await Reflect.apply(connection.query, connection, args);
          await after(sql, pid);
          return result;
        };
        const value = Reflect.get(connection, field);
        return typeof value === 'function' ? value.bind(connection) : value;
      } }) as PoolClient;
    };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

async function bounded<T>(work: Promise<T>, ms = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Synthetic barrier deadline')), ms); })])
    .finally(() => clearTimeout(timer));
}

async function waitBlocked(pool: Pool, blocker: number) {
  const until = performance.now() + 1_000;
  while (performance.now() < until) {
    const rows = await pool.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))", [blocker]);
    if (rows.rowCount) return rows.rows[0].pid as number;
    await new Promise((done) => setTimeout(done, 5));
  }
  throw new Error('Expected owned service lock wait was not observed');
}

for (const path of paths) for (const order of ['writer-first', 'review-first'] as const) {
  it.skipIf(!process.env.TEST_DATABASE_URL)(`TX-09 ${path} ${order}: real services cannot form a reverse lock cycle`, async () => {
    await withSaleFixture(async (f) => {
      const peer = (await f.pool.query("INSERT INTO customers(organization_id,name,customer_type,status) VALUES($1,'Dental Klinik','clinic','active') RETURNING id", [f.organizationId])).rows[0].id;
      if (path === 'enrichment' || path === 'offboarding') await f.pool.query('UPDATE customers SET assigned_staff_user_id=$2 WHERE id=$1', [f.customerId, path === 'enrichment' ? f.otherStaff.id : f.staff.id]);
      const current = await new DuplicateComparisonService(new PostgresDuplicateReadRepository(f.pool), keys).comparison(f.manager, f.customerId, peer);
      const command = { clientActionId: randomUUID(), expectedReviewVersion: 0, expectedEvidenceRevision: current.evidence.revision,
        matchingRuleVersion: current.evidence.matchingRuleVersion, decision: 'DISMISSED' as const, reasonCode: 'DISTINCT_BRANCH' as const };
      const gate = barrier(); const reviewTrace: string[] = []; const writerTrace: string[] = [];
      const reviewPool = observedPool(f.pool, async (sql, pid) => {
        if (order === 'review-first' && /FROM contacts[\s\S]*FOR SHARE NOWAIT/.test(sql)) await gate.stop(pid);
      }, reviewTrace);
      const writerPool = observedPool(f.pool, async (sql, pid) => {
        const selected = path === 'meeting' ? /FROM contacts[\s\S]*FOR UPDATE/.test(sql)
          : path === 'enrichment' ? /FROM job_cards[\s\S]*FOR SHARE NOWAIT/.test(sql)
          : /FROM customers[\s\S]*FOR UPDATE/.test(sql);
        if (order === 'writer-first' && selected) await gate.stop(pid);
      }, writerTrace);
      const review = new DuplicateReviewService(new PostgresDuplicateReviewRepository(reviewPool, keys));
      const admin = { ...f.admin, name: 'Synthetic admin', email: 'synthetic@example.invalid', mustChangePassword: false, isActive: true, version: 1 };
      const offboarding = new PostgresStaffOffboardingService(writerPool, undefined, () => saleTime);
      const plan = path === 'offboarding' ? await offboarding.preview(admin, f.staff.id) : null;
      const writer = () => path === 'sale'
        ? new JobCardService(new PostgresJobCardRepository(writerPool), () => saleTime).createSaleFromVisit(f.staff, f.visitId, { ...f.input, clientActionId: randomUUID() })
        : path === 'meeting'
          ? new JobCardService(new PostgresJobCardRepository(writerPool), () => saleTime).patchMeetingDetails(f.staff, f.visitId, { clientActionId: randomUUID(), expectedVersion: f.input.expectedSourceVersion, metContactId: f.metContactId, meetingSummary: 'Synthetic lock race' })
          : path === 'enrichment'
            ? new CrmService(new PostgresCrmRepository(writerPool)).enrichCustomer(f.staff, f.customerId, { expectedVersion: 1, city: 'Synthetic city' })
            : offboarding.execute(admin, f.staff.id, { clientActionId: randomUUID(), planHash: plan!.planHash, reasonCode: 'ACCESS_ENDED',
              jobDecisions: plan!.jobs.map((job) => ({ jobCardId: job.id, replacementUserId: f.otherStaff.id })),
              customerDecisions: plan!.customers.map((customer) => ({ customerId: customer.id, action: 'UNASSIGN' })),
              calendarDecisions: [], followUpDecisions: [], reminderDecisions: [] });
      let running: Promise<unknown> | null = null;
      try {
        if (order === 'writer-first') {
          running = writer(); await bounded(gate.entered);
          const start = performance.now();
          await expect(review.decide(f.manager, f.customerId, peer, command)).rejects.toMatchObject({ code: 'REVIEW_BUSY', statusCode: 409 });
          expect(performance.now() - start).toBeLessThan(1_000);
          expect((await f.pool.query('SELECT count(*) FROM customer_duplicate_reviews')).rows[0].count).toBe('0');
          gate.release(); await bounded(running);
        } else {
          running = review.decide(f.manager, f.customerId, peer, command);
          const reviewPid = await bounded(gate.entered);
          const writing = writer();
          try {
            const writerPid = await waitBlocked(f.pool, reviewPid);
            expect((await f.pool.query('SELECT pg_blocking_pids($1) AS blockers', [reviewPid])).rows[0].blockers).not.toContain(writerPid);
            gate.release(); await expect(bounded(running)).resolves.toMatchObject({ receipt: { reviewVersion: 1 } });
            await bounded(writing);
          } finally { gate.release(); await writing.catch(() => {}); }
        }
        expect(writerTrace.some((sql) => /FROM job_cards[\s\S]*FOR (UPDATE|SHARE)/.test(sql))).toBe(true);
        expect(reviewTrace.some((sql) => /\b(job_cards|job_card_meeting_details|job_card_sale_details)\b/.test(sql))).toBe(false);
        expect(f.pool.waitingCount).toBe(0);
      } finally { gate.release(); await running?.catch(() => {}); }
    });
  }, 15_000);
}
