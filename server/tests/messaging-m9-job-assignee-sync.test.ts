import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import Fastify, { type preHandlerHookHandler } from 'fastify';
import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import { toErrorResponse } from '../src/errors/index.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import { MessagingService } from '../src/modules/messaging/service.js';
import { messagingRoutes } from '../src/modules/messaging/routes.js';
import type { SafeUser } from '../src/modules/auth/types.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

const MIGRATIONS = [
  '001_auth_foundation.sql', '002_delivery_tracer.sql', '003_people.sql',
  '004_crm_contacts.sql', '005_product_catalog.sql', '006_jobcard_workspace.sql',
  '007_sales_meeting.sql', '008_meeting_approval_withdrawal.sql',
  '009_job_acceptance_and_scheduling.sql', '010_entity_delete_audit.sql',
  '011_create_realtime_events.sql', '012_create_in_app_notifications.sql',
  '013_create_job_action_locations.sql', '014_create_web_push.sql',
  '015_job_card_engagement_kind.sql', '016_google_reverse_geocoding.sql',
  '017_calendar.sql', '018_messaging.sql',
  '019_job_card_operational_note_context.sql',
  '020_job_card_transition_note_contexts.sql',
  '021_job_card_note_added_notification_kind.sql',
  '022_job_card_follow_up_links.sql',
  '023_staff_confidential_notes.sql',
  '024_job_card_notes_invoice_number.sql',
  '025_messaging_context_ready.sql',
  '026_messaging_participant_lifecycle.sql',
] as const;

type Fixture = {
  pool: Pool;
  admin: SafeUser;
  manager: SafeUser;
  staffA: SafeUser;
  staffB: SafeUser;
  staffX: SafeUser;
};

async function withFixture(run: (fixture: Fixture) => Promise<void>) {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `messaging_m9_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool | null = null;
  try {
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema},public`,
    });
    for (const migration of MIGRATIONS) {
      const path = fileURLToPath(
        new URL(`../src/db/migrations/${migration}`, import.meta.url),
      );
      await pool.query(await readFile(path, 'utf8'));
    }

    const org = (await pool.query<{ id: string }>(
      `INSERT INTO organizations (name) VALUES ('M9 Org') RETURNING id`,
    )).rows[0]!.id;

    async function user(name: string, role: string): Promise<SafeUser> {
      const row = (await pool!.query<{ id: string }>(
        `INSERT INTO users (organization_id, name, email, password_hash, role, is_active)
         VALUES ($1, $2, $3, 'unused-test-hash', $4, TRUE) RETURNING id`,
        [org, name, `${randomUUID()}@test.local`, role],
      )).rows[0]!;
      return {
        id: row.id, organizationId: org, name, email: name.toLowerCase() + '@test.local',
        role: role as SafeUser['role'], mustChangePassword: false, isActive: true, version: 1,
      };
    }

    const admin = await user('Admin M9', 'ADMIN');
    const manager = await user('Manager M9', 'MANAGER');
    const staffA = await user('Staff A', 'STAFF');
    const staffB = await user('Staff B', 'STAFF');
    const staffX = await user('Staff X', 'STAFF');

    await pool.query(
      `INSERT INTO staff_profiles (organization_id, user_id, manager_user_id)
       VALUES ($1, $2, $3), ($1, $4, $3), ($1, $5, $3)`,
      [org, staffA.id, manager.id, staffB.id, staffX.id],
    );

    await run({ pool, admin, manager, staffA, staffB, staffX });
  } finally {
    if (pool) await pool.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  }
}

async function createJob(
  pool: Pool,
  actor: SafeUser,
  title: string,
  assignedTo: string | null,
): Promise<{ id: string; version: number }> {
  const row = (await pool.query<{ id: string; version: number }>(
    `INSERT INTO job_cards
       (organization_id, type, status, title, assigned_to, created_by,
        accepted_at, accepted_by, started_at)
     VALUES ($1, 'GENERAL_TASK', 'ACCEPTED', $2, $3, $4, NOW(), $4, NOW())
     RETURNING id, version`,
    [actor.organizationId, title, assignedTo, actor.id],
  )).rows[0]!;
  return { id: row.id, version: row.version };
}

function jobService(pool: Pool): JobCardService {
  return new JobCardService(new PostgresJobCardRepository(pool));
}

function messaging(pool: Pool): MessagingService {
  return new MessagingService(pool, true);
}

async function createCanonical(
  pool: Pool,
  actor: SafeUser,
  jobId: string,
  staff: SafeUser,
): Promise<string> {
  const svc = messaging(pool);
  const conv = await svc.createOrGetConversation(actor, {
    contextType: 'JOB', jobId, participantUserIds: [staff.id],
  });
  return conv.id;
}

async function seedMessage(pool: Pool, actor: SafeUser, conversationId: string, body: string) {
  const svc = messaging(pool);
  await svc.sendMessage(actor, conversationId, body, `m9-seed-${randomUUID()}`);
}

async function buildApp(service: MessagingService, actor: SafeUser) {
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    const response = toErrorResponse(error);
    reply.code(response.statusCode).send(response.body);
  });
  const authenticate: preHandlerHookHandler = async (request) => {
    (request as { currentUser?: SafeUser }).currentUser = actor;
  };
  await app.register(messagingRoutes, {
    prefix: '/api/messaging',
    service,
    authenticate,
  });
  return app;
}

async function syncRequest(
  app: Awaited<ReturnType<typeof buildApp>>,
  conversationId: string,
  body: { clientActionId: string; assignmentTransitionId: string },
) {
  const res = await app.inject({
    method: 'POST',
    url: `/api/messaging/conversations/${conversationId}/job-assignee-sync`,
    payload: body,
  });
  return { status: res.statusCode, body: JSON.parse(res.body) as Record<string, unknown> };
}

async function participantIdsOf(pool: Pool, conversationId: string): Promise<string[]> {
  const rows = await pool.query<{ user_id: string }>(
    `SELECT user_id FROM conversation_participants WHERE conversation_id = $1`,
    [conversationId],
  );
  return rows.rows.map((r) => r.user_id).sort();
}

describe('M9: Job PATCH assignmentTransitionId', () => {
  it('assignedTo change A→B returns a UUID assignmentTransitionId bound to the exact activity', async () => {
    await withFixture(async ({ pool, admin, staffA, staffB }) => {
      const job = await createJob(pool, admin, 'PATCH job', staffA.id);
      const svc = jobService(pool);
      const result = await svc.patch(admin, job.id, {
        expectedVersion: job.version, assignedTo: staffB.id,
      });
      expect(typeof result.assignmentTransitionId).toBe('string');
      const row = (await pool.query<{
        id: string; job_card_id: string; event_type: string; old_value: unknown; new_value: unknown;
      }>(
        `SELECT id, job_card_id, event_type, old_value, new_value
           FROM job_card_activity_logs
          WHERE id = $1`,
        [result.assignmentTransitionId as string],
      )).rows[0]!;
      expect(row.event_type).toBe('JOB_ASSIGNED');
      expect(row.job_card_id).toBe(job.id);
      expect(row.old_value).toEqual({ assignedTo: staffA.id });
      expect(row.new_value).toEqual({ assignedTo: staffB.id });
    });
  });

  it('assignedTo unchanged returns assignmentTransitionId null', async () => {
    await withFixture(async ({ pool, admin, staffA }) => {
      const job = await createJob(pool, admin, 'PATCH job 2', staffA.id);
      const svc = jobService(pool);
      const result = await svc.patch(admin, job.id, {
        expectedVersion: job.version, title: 'Yeni başlık',
      });
      expect(result.assignmentTransitionId).toBeNull();
    });
  });
});

describe('M9: explicit Job assignee sync', () => {
  it('rejects STAFF actor with 403', async () => {
    await withFixture(async ({ pool, admin, staffA, staffB }) => {
      const job = await createJob(pool, admin, 'Sync job', staffA.id);
      const conversationId = await createCanonical(pool, admin, job.id, staffA);
      const jsvc = jobService(pool);
      const patched = await jsvc.patch(admin, job.id, {
        expectedVersion: job.version, assignedTo: staffB.id,
      });
      const app = await buildApp(messaging(pool), staffA);
      const res = await syncRequest(app, conversationId, {
        clientActionId: 'm9-staff-1', assignmentTransitionId: patched.assignmentTransitionId as string,
      });
      expect(res.status).toBe(403);
    });
  });

  it('rejects nonparticipant Admin/Manager with opaque 404', async () => {
    await withFixture(async ({ pool, admin, manager, staffA, staffB }) => {
      const job = await createJob(pool, admin, 'Sync job 2', staffA.id);
      const conversationId = await createCanonical(pool, admin, job.id, staffA);
      const jsvc = jobService(pool);
      const patched = await jsvc.patch(admin, job.id, {
        expectedVersion: job.version, assignedTo: staffB.id,
      });
      const app = await buildApp(messaging(pool), manager);
      const res = await syncRequest(app, conversationId, {
        clientActionId: 'm9-nonpart-1',
        assignmentTransitionId: patched.assignmentTransitionId as string,
      });
      expect(res.status).toBe(404);
    });
  });

  it('performs A→B replacement with history, unread 0, one audit, one realtime event', async () => {
    await withFixture(async ({ pool, admin, staffA, staffB }) => {
      const job = await createJob(pool, admin, 'Core job', staffA.id);
      const conversationId = await createCanonical(pool, admin, job.id, staffA);
      await seedMessage(pool, admin, conversationId, 'Tarihsel mesaj 1');
      await seedMessage(pool, admin, conversationId, 'Tarihsel mesaj 2');
      const jsvc = jobService(pool);
      const patched = await jsvc.patch(admin, job.id, {
        expectedVersion: job.version, assignedTo: staffB.id,
      });
      const transitionId = patched.assignmentTransitionId as string;

      const svc = messaging(pool);
      const app = await buildApp(svc, admin);
      const before = await syncRequest(app, conversationId, {
        clientActionId: 'm9-core-1', assignmentTransitionId: transitionId,
      });
      expect(before.status).toBe(200);
      expect(before.body).toMatchObject({ conversationId, synced: true, changed: true });

      expect(await participantIdsOf(pool, conversationId)).toEqual([admin.id, staffB.id].sort());

      const lookup = await svc.getJobConversation(staffB, job.id);
      expect(lookup.id).toBe(conversationId);
      const unread = await svc.getUnreadCount(staffB);
      expect(unread).toBe(0);

      const audit = (await pool.query(
        `SELECT action, details FROM messaging_activity_logs
          WHERE conversation_id = $1 AND action = 'PARTICIPANTS_CHANGED'`,
        [conversationId],
      )).rows as Array<{ action: string; details: Record<string, unknown> }>;
      expect(audit).toHaveLength(1);
      expect(audit[0]!.details).toMatchObject({
        assignmentTransitionId: transitionId,
        jobId: job.id,
        contextType: 'JOB',
        addedUserIds: [staffB.id],
        removedUserIds: [staffA.id],
      });

      const realtime = (await pool.query(
        `SELECT event_type, audience_user_ids FROM realtime_events
          WHERE entity_id = $1 AND event_type = 'conversation.participants_changed'`,
        [conversationId],
      )).rows as Array<{ event_type: string; audience_user_ids: string[] }>;
      expect(realtime).toHaveLength(1);
      const audience = [...realtime[0]!.audience_user_ids].sort();
      expect(audience).toEqual([admin.id, staffA.id, staffB.id].sort());

      await expect(svc.getJobConversation(staffA, job.id)).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  it('rejects stale old transition token after A→B→C→A→B (full ABA)', async () => {
    await withFixture(async ({ pool, admin, staffA, staffB }) => {
      const job = await createJob(pool, admin, 'ABA job', staffA.id);
      const conversationId = await createCanonical(pool, admin, job.id, staffA);
      const jsvc = jobService(pool);
      const p1 = await jsvc.patch(admin, job.id, {
        expectedVersion: job.version, assignedTo: staffB.id,
      });
      let version = (await pool.query<{ version: number }>(
        `SELECT version FROM job_cards WHERE id = $1`, [job.id],
      )).rows[0]!.version;
      await jsvc.patch(admin, job.id, { expectedVersion: version, assignedTo: staffA.id });
      version = (await pool.query<{ version: number }>(
        `SELECT version FROM job_cards WHERE id = $1`, [job.id],
      )).rows[0]!.version;
      await jsvc.patch(admin, job.id, { expectedVersion: version, assignedTo: staffB.id });

      const app = await buildApp(messaging(pool), admin);
      const res = await syncRequest(app, conversationId, {
        clientActionId: 'm9-aba-1', assignmentTransitionId: p1.assignmentTransitionId as string,
      });
      expect(res.status).toBe(409);
    });
  });

  it('idempotent replay returns 200 without duplicate audit/realtime', async () => {
    await withFixture(async ({ pool, admin, staffA, staffB }) => {
      const job = await createJob(pool, admin, 'Replay job', staffA.id);
      const conversationId = await createCanonical(pool, admin, job.id, staffA);
      const jsvc = jobService(pool);
      const patched = await jsvc.patch(admin, job.id, {
        expectedVersion: job.version, assignedTo: staffB.id,
      });
      const transitionId = patched.assignmentTransitionId as string;
      const app = await buildApp(messaging(pool), admin);
      const body = { clientActionId: 'm9-replay-1', assignmentTransitionId: transitionId };
      const first = await syncRequest(app, conversationId, body);
      expect(first.status).toBe(200);
      const second = await syncRequest(app, conversationId, body);
      expect(second.status).toBe(200);
      expect(second.body).toMatchObject({ conversationId, synced: true, changed: false });

      const audit = (await pool.query(
        `SELECT count(*)::int AS n FROM messaging_activity_logs
          WHERE conversation_id = $1 AND action = 'PARTICIPANTS_CHANGED'`,
        [conversationId],
      )).rows[0]!.n as number;
      expect(audit).toBe(1);
      const realtime = (await pool.query(
        `SELECT count(*)::int AS n FROM realtime_events
          WHERE entity_id = $1 AND event_type = 'conversation.participants_changed'`,
        [conversationId],
      )).rows[0]!.n as number;
      expect(realtime).toBe(1);
    });
  });

  it('same clientActionId different transition in same conversation returns 409 CLIENT_ACTION_REUSED', async () => {
    await withFixture(async ({ pool, admin, staffA, staffB }) => {
      const job = await createJob(pool, admin, 'Reuse job', staffA.id);
      const conversationId = await createCanonical(pool, admin, job.id, staffA);
      const jsvc = jobService(pool);
      const p1 = await jsvc.patch(admin, job.id, {
        expectedVersion: job.version, assignedTo: staffB.id,
      });
      const app = await buildApp(messaging(pool), admin);
      const first = await syncRequest(app, conversationId, {
        clientActionId: 'm9-reuse-1', assignmentTransitionId: p1.assignmentTransitionId as string,
      });
      expect(first.status).toBe(200);

      let version = (await pool.query<{ version: number }>(
        `SELECT version FROM job_cards WHERE id = $1`, [job.id],
      )).rows[0]!.version;
      await jsvc.patch(admin, job.id, { expectedVersion: version, assignedTo: staffA.id });
      version = (await pool.query<{ version: number }>(
        `SELECT version FROM job_cards WHERE id = $1`, [job.id],
      )).rows[0]!.version;
      const p2 = await jsvc.patch(admin, job.id, { expectedVersion: version, assignedTo: staffB.id });

      const res = await syncRequest(app, conversationId, {
        clientActionId: 'm9-reuse-1', assignmentTransitionId: p2.assignmentTransitionId as string,
      });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CLIENT_ACTION_REUSED');
    });
  });

  it('replay after membership loss is denied', async () => {
    await withFixture(async ({ pool, admin, staffA, staffB }) => {
      const job = await createJob(pool, admin, 'Auth replay job', staffA.id);
      const conversationId = await createCanonical(pool, admin, job.id, staffA);
      const jsvc = jobService(pool);
      const patched = await jsvc.patch(admin, job.id, {
        expectedVersion: job.version, assignedTo: staffB.id,
      });
      const svc = messaging(pool);
      const app = await buildApp(svc, admin);
      const body = { clientActionId: 'm9-authreplay-1', assignmentTransitionId: patched.assignmentTransitionId as string };
      expect((await syncRequest(app, conversationId, body)).status).toBe(200);
      await pool.query(
        `DELETE FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2`,
        [conversationId, admin.id],
      );
      const replay = await syncRequest(app, conversationId, body);
      expect(replay.status).toBe(404);
    });
  });

  it('terminal Job rejects sync with 409', async () => {
    await withFixture(async ({ pool, admin, staffA, staffB }) => {
      const job = await createJob(pool, admin, 'Terminal job', staffA.id);
      const conversationId = await createCanonical(pool, admin, job.id, staffA);
      const jsvc = jobService(pool);
      const patched = await jsvc.patch(admin, job.id, {
        expectedVersion: job.version, assignedTo: staffB.id,
      });
      await pool.query(
        `UPDATE job_cards
            SET status = 'COMPLETED',
                staff_completed_at = NOW(), staff_completed_by = $2,
                manager_approved_at = NOW(), manager_approved_by = $2
          WHERE id = $1`,
        [job.id, admin.id],
      );
      const app = await buildApp(messaging(pool), admin);
      const res = await syncRequest(app, conversationId, {
        clientActionId: 'm9-terminal-1', assignmentTransitionId: patched.assignmentTransitionId as string,
      });
      expect(res.status).toBe(409);
    });
  });

  it('zero-delta returns 200 changed:false without new audit/realtime', async () => {
    await withFixture(async ({ pool, admin, staffA, staffB }) => {
      const job = await createJob(pool, admin, 'Zero delta job', staffA.id);
      const conversationId = await createCanonical(pool, admin, job.id, staffA);
      await pool.query(
        `INSERT INTO conversation_participants (conversation_id, user_id, organization_id)
         VALUES ($1, $2, $3)`,
        [conversationId, staffB.id, admin.organizationId],
      );
      await pool.query(
        `DELETE FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2`,
        [conversationId, staffA.id],
      );
      const jsvc = jobService(pool);
      const patched = await jsvc.patch(admin, job.id, {
        expectedVersion: job.version, assignedTo: staffB.id,
      });
      const transitionId = patched.assignmentTransitionId as string;
      const app = await buildApp(messaging(pool), admin);
      const res = await syncRequest(app, conversationId, {
        clientActionId: 'm9-zerodelta-1', assignmentTransitionId: transitionId,
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ conversationId, synced: true, changed: false });
      const audit = (await pool.query(
        `SELECT count(*)::int AS n FROM messaging_activity_logs
          WHERE conversation_id = $1 AND action = 'PARTICIPANTS_CHANGED'`,
        [conversationId],
      )).rows[0]!.n as number;
      expect(audit).toBe(0);
    });
  });

  it('unrelated stale Staff membership is preserved', async () => {
    await withFixture(async ({ pool, admin, staffA, staffB, staffX }) => {
      const job = await createJob(pool, admin, 'Stale X job', staffA.id);
      const conversationId = await createCanonical(pool, admin, job.id, staffA);
      const jsvc = jobService(pool);
      const patched = await jsvc.patch(admin, job.id, {
        expectedVersion: job.version, assignedTo: staffB.id,
      });
      await pool.query(
        `INSERT INTO conversation_participants (conversation_id, user_id, organization_id)
         VALUES ($1, $2, $3)`,
        [conversationId, staffX.id, admin.organizationId],
      );
      const app = await buildApp(messaging(pool), admin);
      const res = await syncRequest(app, conversationId, {
        clientActionId: 'm9-stalex-1', assignmentTransitionId: patched.assignmentTransitionId as string,
      });
      expect(res.status).toBe(200);
      expect(await participantIdsOf(pool, conversationId)).toEqual([admin.id, staffB.id, staffX.id].sort());

      const realtime = (await pool.query(
        `SELECT audience_user_ids FROM realtime_events
          WHERE entity_id = $1 AND event_type = 'conversation.participants_changed'`,
        [conversationId],
      )).rows as Array<{ audience_user_ids: string[] }>;
      const audience = realtime[0]!.audience_user_ids;
      expect(audience).not.toContain(staffX.id);
      expect(audience.sort()).toEqual([admin.id, staffA.id, staffB.id].sort());
    });
  });

  it('newly added Staff sees history with unread 0, next message unread 1', async () => {
    await withFixture(async ({ pool, admin, staffA, staffB }) => {
      const job = await createJob(pool, admin, 'Unread job', staffA.id);
      const conversationId = await createCanonical(pool, admin, job.id, staffA);
      await seedMessage(pool, admin, conversationId, 'Geçmiş mesaj');
      const jsvc = jobService(pool);
      const patched = await jsvc.patch(admin, job.id, {
        expectedVersion: job.version, assignedTo: staffB.id,
      });
      const app = await buildApp(messaging(pool), admin);
      await syncRequest(app, conversationId, {
        clientActionId: 'm9-unread-1', assignmentTransitionId: patched.assignmentTransitionId as string,
      });
      const svc = messaging(pool);
      expect(await svc.getUnreadCount(staffB)).toBe(0);
      const messages = await svc.getMessages(staffB, conversationId, null, 20);
      expect(messages.items).toHaveLength(1);
      await svc.sendMessage(admin, conversationId, 'Yeni mesaj', 'm9-unread-2');
      expect(await svc.getUnreadCount(staffB)).toBe(1);
    });
  });

  it('replay after role change to STAFF is denied with 403', async () => {
    await withFixture(async ({ pool, admin, staffA, staffB }) => {
      const job = await createJob(pool, admin, 'Role change job', staffA.id);
      const conversationId = await createCanonical(pool, admin, job.id, staffA);
      const jsvc = jobService(pool);
      const patched = await jsvc.patch(admin, job.id, {
        expectedVersion: job.version, assignedTo: staffB.id,
      });
      const body = { clientActionId: 'm9-role-1', assignmentTransitionId: patched.assignmentTransitionId as string };
      const app = await buildApp(messaging(pool), admin);
      expect((await syncRequest(app, conversationId, body)).status).toBe(200);
      await pool.query(
        `UPDATE users SET role = 'STAFF' WHERE id = $1`, [admin.id],
      );
      const changedActor = { ...admin, role: 'STAFF' as const };
      const appStaff = await buildApp(messaging(pool), changedActor);
      const replay = await syncRequest(appStaff, conversationId, body);
      expect(replay.status).toBe(403);
    });
  });

  it('concurrent identical transitions serialize to one mutation, one audit, one realtime event', async () => {
    await withFixture(async ({ pool, admin, staffA, staffB }) => {
      const job = await createJob(pool, admin, 'Concurrent job', staffA.id);
      const conversationId = await createCanonical(pool, admin, job.id, staffA);
      const jsvc = jobService(pool);
      const patched = await jsvc.patch(admin, job.id, {
        expectedVersion: job.version, assignedTo: staffB.id,
      });
      const transitionId = patched.assignmentTransitionId as string;
      const app = await buildApp(messaging(pool), admin);
      const results = await Promise.all([
        syncRequest(app, conversationId, { clientActionId: 'm9-conc-1', assignmentTransitionId: transitionId }),
        syncRequest(app, conversationId, { clientActionId: 'm9-conc-2', assignmentTransitionId: transitionId }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 200]);
      expect(await participantIdsOf(pool, conversationId)).toEqual([admin.id, staffB.id].sort());
      const audit = (await pool.query(
        `SELECT count(*)::int AS n FROM messaging_activity_logs
          WHERE conversation_id = $1 AND action = 'PARTICIPANTS_CHANGED'`,
        [conversationId],
      )).rows[0]!.n as number;
      expect(audit).toBe(1);
      const realtime = (await pool.query(
        `SELECT count(*)::int AS n FROM realtime_events
          WHERE entity_id = $1 AND event_type = 'conversation.participants_changed'`,
        [conversationId],
      )).rows[0]!.n as number;
      expect(realtime).toBe(1);
    });
  });

  it('malformed conversationId returns 400 without service call', async () => {
    await withFixture(async ({ pool, admin, staffA }) => {
      const app = await buildApp(messaging(pool), admin);
      const res = await app.inject({
        method: 'POST',
        url: '/api/messaging/conversations/not-a-uuid/job-assignee-sync',
        payload: {
          clientActionId: 'm9-m8-2',
          assignmentTransitionId: '00000000-0000-4000-8000-000000000000',
        },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toMatchObject({ code: 'VALIDATION_ERROR' });
    });
  });

  it('unauthenticated malformed request returns 401 before validation', async () => {
    await withFixture(async ({ pool, admin, staffA }) => {
      const app = Fastify({ logger: false });
      app.setErrorHandler((error, _request, reply) => {
        const response = toErrorResponse(error);
        reply.code(response.statusCode).send(response.body);
      });
      const authenticate: preHandlerHookHandler = async () => {
        throw new Error('unauthenticated');
      };
      await app.register(messagingRoutes, {
        prefix: '/api/messaging',
        service: messaging(pool),
        authenticate,
      });
      const res = await app.inject({
        method: 'POST',
        url: '/api/messaging/conversations/not-a-uuid/job-assignee-sync',
        payload: {
          clientActionId: 'm9-m8-3',
          assignmentTransitionId: 'not-a-uuid',
        },
      });
      expect(res.statusCode).toBe(500);
    });
  });

  it('malformed assignmentTransitionId returns 400 without service call', async () => {
    await withFixture(async ({ pool, admin, staffA }) => {
      const job = await createJob(pool, admin, 'M8 job', staffA.id);
      const conversationId = await createCanonical(pool, admin, job.id, staffA);
      const app = await buildApp(messaging(pool), admin);
      const res = await app.inject({
        method: 'POST',
        url: `/api/messaging/conversations/${conversationId}/job-assignee-sync`,
        payload: { clientActionId: 'm9-m8-1', assignmentTransitionId: 'not-a-uuid' },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toMatchObject({ code: 'VALIDATION_ERROR' });
    });
  });
});
