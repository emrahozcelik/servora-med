import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MessagingService } from '../src/modules/messaging/service.js';
import type { SafeUser } from '../src/modules/auth/types.js';
import type { RealtimeEventPublisher } from '../src/modules/realtime/event-bus.js';

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
  '029_messaging_conversation_archive.sql',
  '030_backup_domain_foundation.sql',
  '031_backup_engine_failure_taxonomy_and_dump_version.sql',
  '032_backup_r2_failure_taxonomy.sql',
  '033_backup_worker_runtime.sql',
  '034_demo_data_foundation.sql',
  '035_demo_data_purge_foundation.sql',
  '036_job_card_invalidated.sql',
] as const;

type Fixture = {
  pool: Pool;
  adminA: SafeUser;
  adminB: SafeUser;
  staff1A: SafeUser;
  job1A: string;
};

async function withFixture(run: (fixture: Fixture) => Promise<void>) {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `messaging_m7_${randomUUID().replaceAll('-', '')}`;
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

    const orgA = (await pool.query<{ id: string }>(
      `INSERT INTO organizations (name) VALUES ('Org A') RETURNING id`,
    )).rows[0]!.id;

    async function user(org: string, name: string, role: string): Promise<SafeUser> {
      const row = (await pool!.query<{ id: string }>(
        `INSERT INTO users (organization_id, name, email, password_hash, role)
         VALUES ($1, $2, $3, 'unused-test-hash', $4) RETURNING id`,
        [org, name, `${randomUUID()}@test.local`, role],
      )).rows[0]!;
      return {
        id: row.id, organizationId: org, name, email: name.toLowerCase().replaceAll(' ', '-') + '@test.local',
        role: role as SafeUser['role'], mustChangePassword: false, isActive: true, version: 1,
      };
    }

    const adminA = await user(orgA, 'Admin A', 'ADMIN');
    const adminB = await user(orgA, 'Admin B', 'ADMIN');
    const staff1A = await user(orgA, 'Staff 1 A', 'STAFF');

    const job1A = (await pool.query<{ id: string }>(
      `INSERT INTO job_cards
         (organization_id, type, status, title, assigned_to, created_by, accepted_at, accepted_by)
       VALUES ($1, 'GENERAL_TASK', 'ACCEPTED', 'Race job', $2, $2, NOW(), $2)
       RETURNING id`,
      [orgA, staff1A.id],
    )).rows[0]!.id;

    await run({ pool, adminA, adminB, staff1A, job1A });
  } finally {
    if (pool) await pool.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  }
}

function itSlow(name: string, fn: () => Promise<void>): void {
  it(name, fn, 30_000);
}

/**
 * Deterministic concurrency barrier.
 *
 * Wraps the shared pool so both racing transactions must reach the
 * `INSERT INTO conversations` statement before either one may proceed.
 * This guarantees BOTH requests observed "no canonical conversation" in the
 * pre-check AND in the transaction re-check, because neither has committed yet
 * when the second request performs its reads. The two INSERTs are then
 * released together against the real partial unique index.
 *
 * Note: pg's Pool.query internally acquires clients through the callback form
 * of connect(), so the wrapper must support both callback and promise forms.
 */
function withInsertBarrier(pool: Pool): {
  pool: Pool;
  waitForBothArrivals: () => Promise<void>;
} {
  let arrived = 0;
  let release!: () => void;
  const bothArrived = new Promise<void>((resolve) => {
    release = resolve;
  });

  function wrapClient(client: Parameters<typeof pool.connect>[0] extends never
    ? never
    : any): any {
    const originalQuery = client.query.bind(client);
    client.query = (...qargs: unknown[]) => {
      const text = typeof qargs[0] === 'string' ? qargs[0] : (qargs[0] as { text?: string } | undefined)?.text;
      if (text && text.includes('INSERT INTO conversations')) {
        arrived += 1;
        if (arrived === 2) release();
        return Promise.resolve(bothArrived).then(() => originalQuery(...qargs));
      }
      return originalQuery(...qargs);
    };
    return client;
  }

  const originalConnect = pool.connect.bind(pool);
  pool.connect = (...args: unknown[]) => {
    const last = args[args.length - 1];
    if (typeof last === 'function') {
      const callback = args.pop() as (
        err: Error | null,
        client?: unknown,
        releaseFn?: () => void,
      ) => void;
      originalConnect(...args, (err: Error | null, client?: unknown, releaseFn?: () => void) => {
        if (err) return callback(err);
        callback(null, client ? wrapClient(client) : client, releaseFn);
      });
      return;
    }
    return originalConnect(...args).then((client: unknown) => wrapClient(client));
  };

  return {
    pool,
    waitForBothArrivals: () => bothArrived,
  };
}

function makePublisher(): {
  publisher: RealtimeEventPublisher;
  conversationCreatedEvents: Array<{ entityId: string; actorUserId: string }>;
} {
  const conversationCreatedEvents: Array<{ entityId: string; actorUserId: string }> = [];
  return {
    publisher: {
      publish: (event) => {
        if (event.type === 'conversation.created') {
          conversationCreatedEvents.push({
            entityId: event.entityId,
            actorUserId: event.actorUserId,
          });
        }
      },
    },
    conversationCreatedEvents,
  };
}

describe('M7 canonical JOB create concurrency race', () => {
  let adminPool: Pool;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrl });
  });

  afterAll(async () => {
    await adminPool.end();
  });

  itSlow('two different Admin actors racing the same JOB: single canonical, winner owns membership, loser resolves canonical without side effects', async () => {
    await withFixture(async ({ pool, adminA, adminB, staff1A, job1A }) => {
      const { pool: barrierPool, waitForBothArrivals } = withInsertBarrier(pool);
      const { publisher, conversationCreatedEvents } = makePublisher();
      const svc = new MessagingService(barrierPool, true, publisher);

      const first = svc.createOrGetConversation(adminA, {
        participantUserIds: [staff1A.id],
        contextType: 'JOB',
        jobId: job1A,
      });
      const second = svc.createOrGetConversation(adminB, {
        participantUserIds: [staff1A.id],
        contextType: 'JOB',
        jobId: job1A,
      });

      await waitForBothArrivals();

      const [resultA, resultB] = await Promise.allSettled([first, second]);

      // Organization-wide MANAGER/ADMIN RBAC: both Admins resolve the single
      // canonical conversation. Only the insert-winner persists members and
      // emits creation side effects; the loser gets the canonical-return
      // semantics with no membership mutation and no duplicate events.
      expect(resultA.status).toBe('fulfilled');
      expect(resultB.status).toBe('fulfilled');
      const valueA = (resultA as PromiseFulfilledResult<Awaited<ReturnType<MessagingService['createOrGetConversation']>>>).value;
      const valueB = (resultB as PromiseFulfilledResult<Awaited<ReturnType<MessagingService['createOrGetConversation']>>>).value;
      expect(valueA.id).toBe(valueB.id);

      const canonicalRows = await pool.query(
        `SELECT id FROM conversations
          WHERE context_type = 'JOB' AND job_id = $1`,
        [job1A],
      );
      expect(canonicalRows.rows).toHaveLength(1);
      const canonicalId = canonicalRows.rows[0]!.id as string;

      const participantRows = await pool.query<{ user_id: string }>(
        `SELECT user_id FROM conversation_participants
          WHERE conversation_id = $1 ORDER BY user_id`,
        [canonicalId],
      );
      const participantIds = participantRows.rows.map((r) => r.user_id);

      const winnerActor = valueA.participants.some((p) => p.userId === adminA.id)
        ? adminA
        : adminB;

      expect(new Set(participantIds)).toEqual(
        new Set([winnerActor.id, staff1A.id]),
      );
      expect(participantIds).toHaveLength(2);

      const activityCount = await pool.query<{ c: string }>(
        `SELECT COUNT(*)::int AS c FROM messaging_activity_logs
          WHERE conversation_id = $1 AND action = 'CONVERSATION_CREATED'`,
        [canonicalId],
      );
      expect(activityCount.rows[0]!.c).toBe(1);

      expect(conversationCreatedEvents).toHaveLength(1);
      expect(conversationCreatedEvents[0]!.entityId).toBe(canonicalId);
      expect(conversationCreatedEvents[0]!.actorUserId).toBe(winnerActor.id);
    });
  });

  itSlow('same Admin actor concurrent identical retries: single canonical, idempotent membership, one side effect set', async () => {
    await withFixture(async ({ pool, adminA, staff1A, job1A }) => {
      const { pool: barrierPool, waitForBothArrivals } = withInsertBarrier(pool);
      const { publisher, conversationCreatedEvents } = makePublisher();
      const svc = new MessagingService(barrierPool, true, publisher);

      const first = svc.createOrGetConversation(adminA, {
        participantUserIds: [staff1A.id],
        contextType: 'JOB',
        jobId: job1A,
      });
      const second = svc.createOrGetConversation(adminA, {
        participantUserIds: [staff1A.id],
        contextType: 'JOB',
        jobId: job1A,
      });

      await waitForBothArrivals();

      const results = await Promise.allSettled([first, second]);
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

      const canonicalRows = await pool.query(
        `SELECT id FROM conversations
          WHERE context_type = 'JOB' AND job_id = $1`,
        [job1A],
      );
      expect(canonicalRows.rows).toHaveLength(1);
      const canonicalId = canonicalRows.rows[0]!.id as string;

      const participantRows = await pool.query<{ user_id: string }>(
        `SELECT user_id FROM conversation_participants
          WHERE conversation_id = $1 ORDER BY user_id`,
        [canonicalId],
      );
      const participantIds = participantRows.rows.map((r) => r.user_id);
      expect(new Set(participantIds)).toEqual(new Set([adminA.id, staff1A.id]));
      expect(participantIds).toHaveLength(2);

      const activityCount = await pool.query<{ c: string }>(
        `SELECT COUNT(*)::int AS c FROM messaging_activity_logs
          WHERE conversation_id = $1 AND action = 'CONVERSATION_CREATED'`,
        [canonicalId],
      );
      expect(activityCount.rows[0]!.c).toBe(1);
      expect(conversationCreatedEvents).toHaveLength(1);
    });
  });

  itSlow('pre-existing canonical: non-participant Admin resolves canonical, membership unchanged', async () => {
    await withFixture(async ({ pool, adminA, adminB, staff1A, job1A }) => {
      const svc = new MessagingService(pool, true);
      const created = await svc.createOrGetConversation(adminA, {
        participantUserIds: [staff1A.id],
        contextType: 'JOB',
        jobId: job1A,
      });

      const opened = await svc.createOrGetConversation(adminB, {
        participantUserIds: [staff1A.id],
        contextType: 'JOB',
        jobId: job1A,
      });
      expect(opened.id).toBe(created.id);

      const participantRows = await pool.query<{ user_id: string }>(
        `SELECT user_id FROM conversation_participants
          WHERE conversation_id = $1 ORDER BY user_id`,
        [created.id],
      );
      expect(participantRows.rows.map((r) => r.user_id)).toEqual(
        [adminA.id, staff1A.id].sort(),
      );
    });
  });
});
