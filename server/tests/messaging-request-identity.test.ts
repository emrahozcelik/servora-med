import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import { MessagingService } from '../src/modules/messaging/service.js';
import type { SafeUser } from '../src/modules/auth/types.js';
import type { RealtimeEventPublisher } from '../src/modules/realtime/event-bus.js';
import type { RealtimeEventRecord } from '../src/modules/realtime/types.js';

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
  orgA: string;
  adminA: SafeUser;
  staff1A: SafeUser;
};

async function withFixture(run: (fixture: Fixture) => Promise<void>) {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `msg_req_identity_${randomUUID().replaceAll('-', '')}`;
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
        id: row.id,
        organizationId: org,
        name,
        email: `${randomUUID()}@test.local`,
        role: role as SafeUser['role'],
        mustChangePassword: false,
        isActive: true,
        version: 1,
      };
    }

    const adminA = await user(orgA, 'Ayşe Yönetici', 'ADMIN');
    const staff1A = await user(orgA, 'Zeynep Personel', 'STAFF');

    await run({ pool, orgA, adminA, staff1A });
  } finally {
    if (pool) await pool.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  }
}

function service(pool: Pool, publisher?: RealtimeEventPublisher): MessagingService {
  return new MessagingService(pool, true, publisher);
}

/** Durable messages persisted for one idempotency key. */
async function durableMessages(
  pool: Pool,
  conversationId: string,
  clientActionId: string,
): Promise<Array<{ id: string; body: string }>> {
  const r = await pool.query<{ id: string; body: string }>(
    `SELECT id, body FROM messages
      WHERE conversation_id = $1 AND client_action_id = $2
      ORDER BY created_at, id`,
    [conversationId, clientActionId],
  );
  return r.rows;
}

/** MESSAGE_SENT activity rows for one idempotency key. */
async function sentActivityCount(
  pool: Pool,
  conversationId: string,
  clientActionId: string,
): Promise<number> {
  const r = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM messaging_activity_logs
      WHERE conversation_id = $1 AND client_action_id = $2 AND action = 'MESSAGE_SENT'`,
    [conversationId, clientActionId],
  );
  return r.rows[0]!.n;
}

/** Persisted message.sent realtime events for the conversation. */
async function realtimeEventCount(pool: Pool, conversationId: string): Promise<number> {
  const r = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM realtime_events
      WHERE entity_id = $1 AND event_type = 'message.sent'`,
    [conversationId],
  );
  return r.rows[0]!.n;
}

function newConversation(svc: MessagingService, adminA: SafeUser, staff1A: SafeUser) {
  return svc.createOrGetConversation(adminA, {
    contextType: 'GENERAL',
    title: `Request identity ${randomUUID()}`,
    participantUserIds: [staff1A.id],
  });
}

describe('Messaging send request identity (reused clientActionId)', () => {
  it('MSG-ID-1: same key + identical validated body is an exact idempotent replay', async () => {
    await withFixture(async ({ pool, adminA, staff1A }) => {
      const published: RealtimeEventRecord[] = [];
      const svc = service(pool, { publish: (event) => { published.push(event); } });
      const conv = await newConversation(svc, adminA, staff1A);
      const K = `K-${randomUUID()}`;

      const first = await svc.sendMessage(staff1A, conv.id, 'Message A', K);
      expect(first.isDuplicate).toBe(false);
      expect(first.body).toBe('Message A');

      const replay = await svc.sendMessage(staff1A, conv.id, 'Message A', K);
      expect(replay.isDuplicate).toBe(true);
      expect(replay.body).toBe('Message A');
      expect(replay.id).toBe(first.id);

      const rows = await durableMessages(pool, conv.id, K);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.body).toBe('Message A');

      expect(await sentActivityCount(pool, conv.id, K)).toBe(1);
      expect(await realtimeEventCount(pool, conv.id)).toBe(1);
      expect(published.filter((e) => e.type === 'message.sent')).toHaveLength(1);
    });
  });

  it('MSG-ID-2: same key + changed body is rejected and persists nothing new', async () => {
    await withFixture(async ({ pool, adminA, staff1A }) => {
      const svc = service(pool);
      const conv = await newConversation(svc, adminA, staff1A);
      const K = `K-${randomUUID()}`;

      await svc.sendMessage(staff1A, conv.id, 'Message A', K);
      const activityBefore = await sentActivityCount(pool, conv.id, K);
      const realtimeBefore = await realtimeEventCount(pool, conv.id);

      await expect(svc.sendMessage(staff1A, conv.id, 'Message B', K))
        .rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED', statusCode: 409 });

      const rows = await durableMessages(pool, conv.id, K);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.body).toBe('Message A');
      expect(rows.map((r) => r.body)).not.toContain('Message B');

      expect(await sentActivityCount(pool, conv.id, K)).toBe(activityBefore);
      expect(await realtimeEventCount(pool, conv.id)).toBe(realtimeBefore);
    });
  });

  it('MSG-ID-3: leading/trailing whitespace stays semantic, not normalized', async () => {
    await withFixture(async ({ pool, adminA, staff1A }) => {
      const svc = service(pool);
      const conv = await newConversation(svc, adminA, staff1A);
      const K = `K-${randomUUID()}`;

      const first = await svc.sendMessage(staff1A, conv.id, 'Message A', K);
      expect(first.body).toBe('Message A');

      await expect(svc.sendMessage(staff1A, conv.id, ' Message A ', K))
        .rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED', statusCode: 409 });

      const rows = await durableMessages(pool, conv.id, K);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.body).toBe('Message A');
    });
  });

  it('MSG-ID-4: authorization is re-evaluated before a known key is accepted as replay', async () => {
    await withFixture(async ({ pool, orgA, adminA, staff1A }) => {
      const svc = service(pool);
      const conv = await newConversation(svc, adminA, staff1A);
      const K = `K-${randomUUID()}`;

      await svc.sendMessage(staff1A, conv.id, 'Message A', K);

      // STAFF loses the persisted participant row (reassignment / removal).
      await pool.query(
        `DELETE FROM conversation_participants
          WHERE organization_id = $1 AND conversation_id = $2 AND user_id = $3`,
        [orgA, conv.id, staff1A.id],
      );

      // The previously successful key must not bypass current authorization.
      await expect(svc.sendMessage(staff1A, conv.id, 'Message A', K))
        .rejects.toMatchObject({ statusCode: 403 });

      const rows = await durableMessages(pool, conv.id, K);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.body).toBe('Message A');
    });
  });
});
