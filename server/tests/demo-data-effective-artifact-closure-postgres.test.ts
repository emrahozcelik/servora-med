import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import type { SafeUser } from '../src/modules/auth/types.js';
import { PostgresDemoDatasetRepository } from '../src/modules/demo-data/repository.js';
import { DemoDatasetService } from '../src/modules/demo-data/service.js';
import { assertDemoDestructiveTestDatabaseSafe } from './support/demo-destructive-guard.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl) assertDemoDestructiveTestDatabaseSafe(databaseUrl);
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

type DemoFixture = {
  pool: Pool;
  organizationId: string;
  datasetId: string;
  admin: SafeUser;
  demoStaffId: string;
  demoManagerId: string;
  businessStaffId: string;
  demoCustomerId: string;
  service: DemoDatasetService;
};

async function withSchema(run: (pool: Pool) => Promise<void>) {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `demo_eac_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool | null = null;
  try {
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema},public`,
    });
    await runMigrations({
      migrationsDirectory: MIGRATIONS_DIRECTORY,
      store: new PostgresMigrationStore(pool),
    });
    await run(pool);
  } finally {
    await pool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  }
}

async function createDemoFixture(pool: Pool, title: string): Promise<DemoFixture> {
  const organizationId = (await pool.query<{ id: string }>(
    'INSERT INTO organizations (name) VALUES ($1) RETURNING id',
    [`Demo EAC ${title} ${randomUUID()}`],
  )).rows[0]!.id;

  const ids = {
    adminId: randomUUID(),
    demoManagerId: randomUUID(),
    demoStaffId: randomUUID(),
    businessStaffId: randomUUID(),
  };
  await pool.query(
    `INSERT INTO users (id, organization_id, name, email, password_hash, role)
     VALUES
       ($1, $5, 'EAC Admin', $6, 'test-hash', 'ADMIN'),
       ($2, $5, 'Demo Manager', $7, 'test-hash', 'MANAGER'),
       ($3, $5, 'Demo Staff', $8, 'test-hash', 'STAFF'),
       ($4, $5, 'Business Staff', $9, 'test-hash', 'STAFF')`,
    [
      ids.adminId, ids.demoManagerId, ids.demoStaffId, ids.businessStaffId,
      organizationId,
      `${ids.adminId}@eac.local`, `${ids.demoManagerId}@eac.local`,
      `${ids.demoStaffId}@eac.local`, `${ids.businessStaffId}@eac.local`,
    ],
  );

  const datasetId = (await pool.query<{ id: string }>(
    `INSERT INTO demo_datasets (organization_id, dataset_key, seed_version, created_by)
     VALUES ($1, $2, 'eac', $3) RETURNING id`,
    [organizationId, `dataset-${randomUUID()}`, ids.demoStaffId],
  )).rows[0]!.id;
  await pool.query(
    `UPDATE users SET data_class = 'DEMO', demo_dataset_id = $2
     WHERE organization_id = $1 AND id IN ($3::uuid, $4::uuid)`,
    [organizationId, datasetId, ids.demoManagerId, ids.demoStaffId],
  );

  const demoCustomerId = (await pool.query<{ id: string }>(
    `INSERT INTO customers
       (organization_id, name, customer_type, assigned_staff_user_id, status, data_class, demo_dataset_id)
     VALUES ($1, 'Demo Clinic', 'clinic', $2, 'active', 'DEMO', $3) RETURNING id`,
    [organizationId, ids.demoStaffId, datasetId],
  )).rows[0]!.id;

  const admin: SafeUser = {
    id: ids.adminId,
    organizationId,
    name: 'EAC Admin',
    email: `${ids.adminId}@eac.local`,
    role: 'ADMIN',
    mustChangePassword: false,
    isActive: true,
    version: 1,
  };
  return {
    pool,
    organizationId,
    datasetId,
    admin,
    demoStaffId: ids.demoStaffId,
    demoManagerId: ids.demoManagerId,
    businessStaffId: ids.businessStaffId,
    demoCustomerId,
    service: new DemoDatasetService(new PostgresDemoDatasetRepository(pool)),
  };
}

async function insertJob(pool: Pool, fixture: Pick<DemoFixture, 'organizationId'>, spec: {
  title: string;
  status: string;
  dataClass: 'BUSINESS' | 'DEMO';
  demoDatasetId: string | null;
  customerId: string | null;
  assignedTo: string;
  createdBy: string;
  sourceJobCardId?: string | null;
}) {
  const completed = spec.status === 'COMPLETED';
  const inProgress = spec.status === 'IN_PROGRESS';
  const startedAt = completed || inProgress ? new Date('2026-07-30T09:00:00.000Z') : null;
  const staffCompletedAt = completed ? new Date('2026-07-30T10:00:00.000Z') : null;
  const managerApprovedAt = completed ? new Date('2026-07-30T11:00:00.000Z') : null;
  return (await pool.query<{ id: string }>(
    `INSERT INTO job_cards
       (organization_id, type, status, title, customer_id, assigned_to, created_by,
        priority, started_at, staff_completed_at, staff_completed_by,
        manager_approved_at, manager_approved_by,
        source_job_card_id, follow_up_instructions, data_class, demo_dataset_id)
     VALUES ($1, 'GENERAL_TASK', $2, $3, $4, $5, $6, 'normal', $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING id`,
    [
      fixture.organizationId,
      spec.status,
      spec.title,
      spec.customerId,
      spec.assignedTo,
      spec.createdBy,
      startedAt,
      staffCompletedAt,
      completed ? spec.assignedTo : null,
      managerApprovedAt,
      completed ? spec.createdBy : null,
      spec.sourceJobCardId ?? null,
      spec.sourceJobCardId ? `Follow-up of ${spec.sourceJobCardId}` : null,
      spec.dataClass,
      spec.demoDatasetId,
    ],
  )).rows[0]!.id;
}

async function insertJobActivity(
  pool: Pool,
  orgId: string,
  jobId: string,
  actorId: string,
  eventType = 'JOB_STARTED',
) {
  await pool.query(
    `INSERT INTO job_card_activity_logs
       (organization_id, job_card_id, actor_id, event_type, new_value, client_action_id)
     VALUES ($1, $2, $3, $4, '{}'::jsonb, $5)`,
    [orgId, jobId, actorId, eventType, randomUUID()],
  );
}

async function insertJobNote(
  pool: Pool,
  orgId: string,
  jobId: string,
  authorId: string,
  body = 'EAC synthetic note',
) {
  await pool.query(
    `INSERT INTO job_card_notes (organization_id, job_card_id, author_id, note, record_version)
     VALUES ($1, $2, $3, $4, 0)`,
    [orgId, jobId, authorId, body],
  );
}


describe.skipIf(!databaseUrl)('Demo effective artifact closure F2 PostgreSQL contract', () => {
  // @formatter:off
  it('RED_FIXTURE_LEGACY_ARTIFACTS_ARE_PLAN_CLOSED: legacy DEMO-derived follow-up with BUSINESS-staff authored activity/note must be fully plan-closed (no FK 23503)', async () => {
    // @expected:preview.safeToPurge=true
    // @expected:preview.activityLogsIncludeLegacyActivity=true
    // @expected:preview.notesIncludeLegacyNote=true
    // @expected:execution:23503-free
    // @expected:execution:status=COMPLETED
    await withSchema(async (pool) => {
      const fixture = await createDemoFixture(pool, 'legacy-closure');

      const parentId = await insertJob(pool, fixture, {
        title: 'Demo parent completed',
        status: 'COMPLETED',
        dataClass: 'DEMO',
        demoDatasetId: fixture.datasetId,
        customerId: fixture.demoCustomerId,
        assignedTo: fixture.demoStaffId,
        createdBy: fixture.demoManagerId,
      });

      // Legacy misclassified follow-up: BUSINESS data_class, BUSINESS-staff assigned,
      // demo_dataset_id NULL, but source_job_card_id points at the DEMO parent.
      // Before the F2 fix, the analyzer's jobIds seed set only contained the parent
      // (and any business-staff-owned jobs), so its BUSINESS-staff-authored activity
      // and note rows were never fetched, never planned, and triggered FK 23503 at
      // purge time when the job_card row was deleted.
      const legacyFollowUpId = await insertJob(pool, fixture, {
        title: 'Legacy follow-up (Business staff)',
        status: 'IN_PROGRESS',
        dataClass: 'BUSINESS',
        demoDatasetId: null,
        customerId: fixture.demoCustomerId,
        assignedTo: fixture.businessStaffId,
        createdBy: fixture.demoManagerId,
        sourceJobCardId: parentId,
      });

      // Two activity logs authored by the BUSINESS staff (not in seed userIds).
      await insertJobActivity(pool, fixture.organizationId, legacyFollowUpId, fixture.businessStaffId, 'JOB_STARTED');
      await insertJobActivity(pool, fixture.organizationId, legacyFollowUpId, fixture.businessStaffId, 'NOTE_ADDED');
      // One note authored by the BUSINESS staff.
      await insertJobNote(pool, fixture.organizationId, legacyFollowUpId, fixture.businessStaffId);

      const preview = await fixture.service.preview(fixture.admin, fixture.datasetId);
      expect(preview.safeToPurge).toBe(true);
      expect(preview.blockers).toEqual([]);

      const activityCount = preview.affectedCounts.activities;
      const noteCount = preview.affectedCounts.notes;
      expect(activityCount).toBeGreaterThanOrEqual(2);
      expect(noteCount).toBeGreaterThanOrEqual(1);

      // Purge must complete without FK 23503 and remove the legacy artifacts.
      const response = await fixture.service.purge(fixture.admin, fixture.datasetId, {
        clientActionId: randomUUID(),
        planHash: preview.planHash,
      });
      expect(response.status).toBe('COMPLETED');

      expect((await pool.query('SELECT id FROM job_cards WHERE id = $1', [parentId])).rows.length).toBe(0);
      expect((await pool.query('SELECT id FROM job_cards WHERE id = $1', [legacyFollowUpId])).rows.length).toBe(0);
      expect((await pool.query('SELECT id FROM job_card_activity_logs WHERE job_card_id = $1', [legacyFollowUpId])).rows.length).toBe(0);
      expect((await pool.query('SELECT id FROM job_card_notes WHERE job_card_id = $1', [legacyFollowUpId])).rows.length).toBe(0);
      // Business staff and their independent identity must survive.
      expect((await pool.query('SELECT id FROM users WHERE id = $1', [fixture.businessStaffId])).rows.length).toBe(1);
    });
  });
  // @formatter:on

  // @formatter:off
  it('REGRESSION_INDEPENDENT_BUSINESS_JOB_ARTIFACTS_BLOCKING_PURGE: artifacts on a non-derived BUSINESS job must still block purge', async () => {
    // @expected:preview.safeToPurge=false
    // @expected:execution:no-mutation
    await withSchema(async (pool) => {
      const fixture = await createDemoFixture(pool, 'business-block');

      // Independent BUSINESS job that references a DEMO customer but has no
      // source_job_card_id lineage back into the DEMO graph.
      const independentJobId = await insertJob(pool, fixture, {
        title: 'Independent BUSINESS job',
        status: 'IN_PROGRESS',
        dataClass: 'BUSINESS',
        demoDatasetId: null,
        customerId: fixture.demoCustomerId,
        assignedTo: fixture.businessStaffId,
        createdBy: fixture.demoManagerId,
      });
      await insertJobActivity(pool, fixture.organizationId, independentJobId, fixture.businessStaffId, 'JOB_STARTED');
      await insertJobNote(pool, fixture.organizationId, independentJobId, fixture.businessStaffId);

      const preview = await fixture.service.preview(fixture.admin, fixture.datasetId);
      expect(preview.safeToPurge).toBe(false);
      const codes = preview.blockers.map((blocker) => blocker.code);
      // The independent BUSINESS job itself (referencing a DEMO customer) must block.
      expect(codes).toContain('DEMO_CUSTOMER_TO_BUSINESS_JOB');

      // Purge must not have run; the independent job and its artifacts remain.
      expect((await pool.query('SELECT id FROM job_cards WHERE id = $1', [independentJobId])).rows.length).toBe(1);
      expect((await pool.query('SELECT id FROM job_card_activity_logs WHERE job_card_id = $1', [independentJobId])).rows.length).toBe(1);
      expect((await pool.query('SELECT id FROM job_card_notes WHERE job_card_id = $1', [independentJobId])).rows.length).toBe(1);
      // Business staff identity preserved regardless.
      expect((await pool.query('SELECT id FROM users WHERE id = $1', [fixture.businessStaffId])).rows.length).toBe(1);
    });
  });
  // @formatter:on

  // @formatter:off
  it('TRANSITIVE_DERIVED_CLOSURE_ARTIFACTS_ARE_PLAN_CLOSED: 3-level lineage chain artifacts on the inner and leaf derived jobs must be fully plan-closed', async () => {
    // @expected:preview.safeToPurge=true
    // @expected:execution:23503-free
    // @expected:execution:status=COMPLETED
    await withSchema(async (pool) => {
      const fixture = await createDemoFixture(pool, 'transitive');

      const parentId = await insertJob(pool, fixture, {
        title: 'Demo root',
        status: 'COMPLETED',
        dataClass: 'DEMO',
        demoDatasetId: fixture.datasetId,
        customerId: fixture.demoCustomerId,
        assignedTo: fixture.demoStaffId,
        createdBy: fixture.demoManagerId,
      });
      // Inner derived follow-up: BUSINESS, assigned to real BUSINESS staff,
      // source_job_card_id -> DEMO root.
      const middleId = await insertJob(pool, fixture, {
        title: 'Inner derived (Business staff)',
        status: 'IN_PROGRESS',
        dataClass: 'BUSINESS',
        demoDatasetId: null,
        customerId: fixture.demoCustomerId,
        assignedTo: fixture.businessStaffId,
        createdBy: fixture.demoManagerId,
        sourceJobCardId: parentId,
      });
      // Leaf derived follow-up: BUSINESS, assigned to a different BUSINESS staff,
      // source_job_card_id -> inner derived job. Activity authored by business staff.
      const leafId = await insertJob(pool, fixture, {
        title: 'Leaf derived (Business staff)',
        status: 'NEW',
        dataClass: 'BUSINESS',
        demoDatasetId: null,
        customerId: fixture.demoCustomerId,
        assignedTo: fixture.businessStaffId,
        createdBy: fixture.demoManagerId,
        sourceJobCardId: middleId,
      });

      await insertJobActivity(pool, fixture.organizationId, middleId, fixture.businessStaffId, 'JOB_STARTED');
      await insertJobActivity(pool, fixture.organizationId, leafId, fixture.businessStaffId, 'JOB_STARTED');
      await insertJobNote(pool, fixture.organizationId, leafId, fixture.businessStaffId);

      const preview = await fixture.service.preview(fixture.admin, fixture.datasetId);
      expect(preview.safeToPurge).toBe(true);
      expect(preview.blockers).toEqual([]);

      const response = await fixture.service.purge(fixture.admin, fixture.datasetId, {
        clientActionId: randomUUID(),
        planHash: preview.planHash,
      });
      expect(response.status).toBe('COMPLETED');

      for (const id of [parentId, middleId, leafId]) {
        expect((await pool.query('SELECT id FROM job_cards WHERE id = $1', [id])).rows.length).toBe(0);
      }
      expect((await pool.query('SELECT id FROM job_card_activity_logs WHERE job_card_id = ANY($1::uuid[])', [[middleId, leafId]])).rows.length).toBe(0);
      expect((await pool.query('SELECT id FROM job_card_notes WHERE job_card_id = ANY($1::uuid[])', [[middleId, leafId]])).rows.length).toBe(0);
      expect((await pool.query('SELECT id FROM users WHERE id = $1', [fixture.businessStaffId])).rows.length).toBe(1);
    });
  });
  // @formatter:on

  // @formatter:off
  it('CONVERSATION_REKEY_EFFECTIVE_JOB_CLOSURE: conversations on an effective legacy DEMO-derived follow-up must be plan-closed; BUSINESS conversation history must fail closed', async () => {
    // @expected:success-side:preview.safeToPurge=true
    // @expected:success-side:preview.conversationsIncludeLegacyConversation=true
    // @expected:success-side:execution:23503-free
    // @expected:success-side:execution:conversation+message+participant+state deleted
    // @expected:blocked-side:preview.blockers contain DEMO_JOB_TO_BUSINESS_CONVERSATION
    // @expected:blocked-side:execution:no-mutation
    // @expected:blocked-side:BUSINESS conversation/message/participant history preserved
    await withSchema(async (pool) => {
      // Success side: a DEMO conversation attached to the legacy derived follow-up
      // was invisible to the seed-jobIds fetch before the F2 fix; the RESTRICT FK
      // on conversations.job_id then surfaced as execution-time 23503. It must now
      // be planned and deleted with its messages/participants/state.
      const success = await createDemoFixture(pool, 'conversation-closure');
      const successParentId = await insertJob(pool, success, {
        title: 'Demo parent completed',
        status: 'COMPLETED',
        dataClass: 'DEMO',
        demoDatasetId: success.datasetId,
        customerId: success.demoCustomerId,
        assignedTo: success.demoStaffId,
        createdBy: success.demoManagerId,
      });
      const successLegacyId = await insertJob(pool, success, {
        title: 'Legacy follow-up with DEMO conversation',
        status: 'IN_PROGRESS',
        dataClass: 'BUSINESS',
        demoDatasetId: null,
        customerId: success.demoCustomerId,
        assignedTo: success.businessStaffId,
        createdBy: success.demoManagerId,
        sourceJobCardId: successParentId,
      });
      const demoConversationId = (await pool.query<{ id: string }>(
        `INSERT INTO conversations
           (organization_id, direct_key, context_type, job_id, data_class, demo_dataset_id, title)
         VALUES ($1, $2, 'JOB', $3, 'DEMO', $4, 'Legacy follow-up conversation') RETURNING id`,
        [success.organizationId, `eac-conv-${randomUUID()}`, successLegacyId, success.datasetId],
      )).rows[0]!.id;
      const demoMessageId = (await pool.query<{ id: string }>(
        `INSERT INTO messages
           (conversation_id, organization_id, sender_user_id, client_action_id, body)
         VALUES ($1, $2, $3, $4, 'EAC synthetic message') RETURNING id`,
        [demoConversationId, success.organizationId, success.demoStaffId, randomUUID()],
      )).rows[0]!.id;
      await pool.query(
        `INSERT INTO conversation_participants
           (conversation_id, user_id, organization_id, last_read_message_id)
         VALUES ($1, $2, $3, $4)`,
        [demoConversationId, success.demoStaffId, success.organizationId, demoMessageId],
      );
      await pool.query(
        `INSERT INTO conversation_user_states (organization_id, conversation_id, user_id)
         VALUES ($1, $2, $3)`,
        [success.organizationId, demoConversationId, success.demoStaffId],
      );
      await pool.query(
        `INSERT INTO messaging_activity_logs
           (organization_id, conversation_id, actor_user_id, action, client_action_id)
         VALUES ($1, $2, $3, 'MESSAGE_SENT', $4)`,
        [success.organizationId, demoConversationId, success.demoManagerId, randomUUID()],
      );

      const successPreview = await success.service.preview(success.admin, success.datasetId);
      expect(successPreview.safeToPurge).toBe(true);
      expect(successPreview.blockers).toEqual([]);
      expect(successPreview.affectedCounts.conversations).toBeGreaterThanOrEqual(1);
      expect(successPreview.affectedCounts.messages).toBeGreaterThanOrEqual(1);

      const successResponse = await success.service.purge(success.admin, success.datasetId, {
        clientActionId: randomUUID(),
        planHash: successPreview.planHash,
      });
      expect(successResponse.status).toBe('COMPLETED');
      expect((await pool.query('SELECT id FROM job_cards WHERE id = $1', [successLegacyId])).rows.length).toBe(0);
      expect((await pool.query('SELECT id FROM conversations WHERE id = $1', [demoConversationId])).rows.length).toBe(0);
      expect((await pool.query('SELECT conversation_id FROM messages WHERE conversation_id = $1', [demoConversationId])).rows.length).toBe(0);
      expect((await pool.query('SELECT conversation_id FROM conversation_participants WHERE conversation_id = $1', [demoConversationId])).rows.length).toBe(0);
      expect((await pool.query('SELECT conversation_id FROM conversation_user_states WHERE conversation_id = $1', [demoConversationId])).rows.length).toBe(0);
      expect((await pool.query('SELECT id FROM users WHERE id = $1', [success.businessStaffId])).rows.length).toBe(1);

      // Blocked side: an independent BUSINESS conversation attached to the same
      // legacy derived Job must block the purge fail-closed. Its BUSINESS message
      // and participant history must never be deleted merely because the Job it
      // references is DEMO-derived.
      const blocked = await createDemoFixture(pool, 'conversation-block');
      const blockedParentId = await insertJob(pool, blocked, {
        title: 'Demo parent completed',
        status: 'COMPLETED',
        dataClass: 'DEMO',
        demoDatasetId: blocked.datasetId,
        customerId: blocked.demoCustomerId,
        assignedTo: blocked.demoStaffId,
        createdBy: blocked.demoManagerId,
      });
      const blockedLegacyId = await insertJob(pool, blocked, {
        title: 'Legacy follow-up with BUSINESS conversation',
        status: 'IN_PROGRESS',
        dataClass: 'BUSINESS',
        demoDatasetId: null,
        customerId: blocked.demoCustomerId,
        assignedTo: blocked.businessStaffId,
        createdBy: blocked.demoManagerId,
        sourceJobCardId: blockedParentId,
      });
      const businessConversationId = (await pool.query<{ id: string }>(
        `INSERT INTO conversations
           (organization_id, direct_key, context_type, job_id, data_class, demo_dataset_id, title)
         VALUES ($1, $2, 'JOB', $3, 'BUSINESS', NULL, 'Business conversation on derived job') RETURNING id`,
        [blocked.organizationId, `eac-conv-${randomUUID()}`, blockedLegacyId],
      )).rows[0]!.id;
      const businessMessageId = (await pool.query<{ id: string }>(
        `INSERT INTO messages
           (conversation_id, organization_id, sender_user_id, client_action_id, body)
         VALUES ($1, $2, $3, $4, 'Business history must survive') RETURNING id`,
        [businessConversationId, blocked.organizationId, blocked.businessStaffId, randomUUID()],
      )).rows[0]!.id;
      await pool.query(
        `INSERT INTO conversation_participants
           (conversation_id, user_id, organization_id, last_read_message_id)
         VALUES ($1, $2, $3, $4)`,
        [businessConversationId, blocked.businessStaffId, blocked.organizationId, businessMessageId],
      );

      const blockedPreview = await blocked.service.preview(blocked.admin, blocked.datasetId);
      expect(blockedPreview.safeToPurge).toBe(false);
      const blockedCodes = blockedPreview.blockers.map((blocker) => blocker.code);
      expect(blockedCodes).toContain('DEMO_JOB_TO_BUSINESS_CONVERSATION');
      await expect(blocked.service.purge(blocked.admin, blocked.datasetId, {
        clientActionId: randomUUID(),
        planHash: blockedPreview.planHash,
      })).rejects.toMatchObject({ code: 'DEMO_DATASET_PURGE_BLOCKED' });

      expect((await pool.query('SELECT id FROM job_cards WHERE id = $1', [blockedLegacyId])).rows.length).toBe(1);
      expect((await pool.query('SELECT id FROM job_cards WHERE id = $1', [blockedParentId])).rows.length).toBe(1);
      expect((await pool.query('SELECT id FROM conversations WHERE id = $1', [businessConversationId])).rows.length).toBe(1);
      expect((await pool.query('SELECT conversation_id FROM messages WHERE conversation_id = $1', [businessConversationId])).rows.length).toBe(1);
      expect((await pool.query('SELECT conversation_id FROM conversation_participants WHERE conversation_id = $1', [businessConversationId])).rows.length).toBe(1);
    });
  });
  // @formatter:on

  // @formatter:off
  it('REMINDER_REKEY_EFFECTIVE_JOB_CLOSURE: reminders on an effective legacy DEMO-derived follow-up must be plan-closed; worker-claimed reminders must fail closed', async () => {
    // @expected:success-side:preview.safeToPurge=true
    // @expected:success-side:preview.remindersIncludeLegacyReminder=true
    // @expected:success-side:execution:reminder deleted
    // @expected:success-side:BUSINESS recipient preserved
    // @expected:blocked-side:preview.blockers contain WORKER_CLAIMED_REMINDER
    // @expected:blocked-side:execution:no-mutation
    await withSchema(async (pool) => {
      // Success side: a PENDING reminder on the legacy derived follow-up with a
      // real BUSINESS recipient is a DEMO-derived derived artifact. Before the F2
      // fix it was invisible to the seed-jobIds fetch and only disappeared via
      // the DB CASCADE at execution time, outside the plan. It must now be
      // planned and deleted while the BUSINESS recipient survives.
      const success = await createDemoFixture(pool, 'reminder-closure');
      const successParentId = await insertJob(pool, success, {
        title: 'Demo parent completed',
        status: 'COMPLETED',
        dataClass: 'DEMO',
        demoDatasetId: success.datasetId,
        customerId: success.demoCustomerId,
        assignedTo: success.demoStaffId,
        createdBy: success.demoManagerId,
      });
      const successLegacyId = await insertJob(pool, success, {
        title: 'Legacy follow-up with reminder',
        status: 'IN_PROGRESS',
        dataClass: 'BUSINESS',
        demoDatasetId: null,
        customerId: success.demoCustomerId,
        assignedTo: success.businessStaffId,
        createdBy: success.demoManagerId,
        sourceJobCardId: successParentId,
      });
      const pendingReminderId = (await pool.query<{ id: string }>(
        `INSERT INTO calendar_reminders
           (organization_id, job_card_id, recipient_user_id, remind_at, next_attempt_at, dedupe_key)
         VALUES ($1, $2, $3, NOW(), NOW(), $4) RETURNING id`,
        [success.organizationId, successLegacyId, success.businessStaffId, `eac-reminder-${randomUUID()}`],
      )).rows[0]!.id;

      const successPreview = await success.service.preview(success.admin, success.datasetId);
      expect(successPreview.safeToPurge).toBe(true);
      expect(successPreview.blockers).toEqual([]);
      expect(successPreview.affectedCounts.reminders).toBeGreaterThanOrEqual(1);

      const successResponse = await success.service.purge(success.admin, success.datasetId, {
        clientActionId: randomUUID(),
        planHash: successPreview.planHash,
      });
      expect(successResponse.status).toBe('COMPLETED');
      expect((await pool.query('SELECT id FROM calendar_reminders WHERE id = $1', [pendingReminderId])).rows.length).toBe(0);
      expect((await pool.query('SELECT id FROM job_cards WHERE id = $1', [successLegacyId])).rows.length).toBe(0);
      expect((await pool.query('SELECT id FROM users WHERE id = $1', [success.businessStaffId])).rows.length).toBe(1);

      // Blocked side: a worker-claimed reminder on the same legacy derived Job
      // must remain a hard blocker before the fix deletes it mid-processing.
      const blocked = await createDemoFixture(pool, 'reminder-claimed');
      const blockedParentId = await insertJob(pool, blocked, {
        title: 'Demo parent completed',
        status: 'COMPLETED',
        dataClass: 'DEMO',
        demoDatasetId: blocked.datasetId,
        customerId: blocked.demoCustomerId,
        assignedTo: blocked.demoStaffId,
        createdBy: blocked.demoManagerId,
      });
      const blockedLegacyId = await insertJob(pool, blocked, {
        title: 'Legacy follow-up with claimed reminder',
        status: 'IN_PROGRESS',
        dataClass: 'BUSINESS',
        demoDatasetId: null,
        customerId: blocked.demoCustomerId,
        assignedTo: blocked.businessStaffId,
        createdBy: blocked.demoManagerId,
        sourceJobCardId: blockedParentId,
      });
      const claimedReminderId = (await pool.query<{ id: string }>(
        `INSERT INTO calendar_reminders
           (organization_id, job_card_id, recipient_user_id, remind_at, state,
            dedupe_key, next_attempt_at, lease_token, lease_until)
         VALUES ($1, $2, $3, NOW(), 'CLAIMED', $4, NOW(), $5, NOW() + INTERVAL '10 minutes') RETURNING id`,
        [blocked.organizationId, blockedLegacyId, blocked.businessStaffId,
          `eac-claimed-reminder-${randomUUID()}`, randomUUID()],
      )).rows[0]!.id;

      const blockedPreview = await blocked.service.preview(blocked.admin, blocked.datasetId);
      expect(blockedPreview.safeToPurge).toBe(false);
      const blockedCodes = blockedPreview.blockers.map((blocker) => blocker.code);
      expect(blockedCodes).toContain('WORKER_CLAIMED_REMINDER');
      await expect(blocked.service.purge(blocked.admin, blocked.datasetId, {
        clientActionId: randomUUID(),
        planHash: blockedPreview.planHash,
      })).rejects.toMatchObject({ code: 'DEMO_DATASET_PURGE_BLOCKED' });

      expect((await pool.query('SELECT id FROM calendar_reminders WHERE id = $1', [claimedReminderId])).rows.length).toBe(1);
      expect((await pool.query('SELECT id FROM job_cards WHERE id = $1', [blockedLegacyId])).rows.length).toBe(1);
      expect((await pool.query('SELECT id FROM users WHERE id = $1', [blocked.businessStaffId])).rows.length).toBe(1);
    });
  });
  // @formatter:on
});
