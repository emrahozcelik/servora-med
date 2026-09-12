import Fastify, { type preHandlerHookHandler } from 'fastify';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import { toErrorResponse } from '../src/errors/index.js';
import type { SafeUser } from '../src/modules/auth/types.js';
import { messagingRoutes } from '../src/modules/messaging/routes.js';
import { MessagingService } from '../src/modules/messaging/service.js';

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

// Deterministic UUIDs ordered ASC so the a<b<c id order can never rescue a
// timestamp-boundary failure: any A,B,C walk order must come from created_at.
const ID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ID_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const TS_A = '2026-01-15 10:20:30.123900+00';
const TS_B = '2026-01-15 10:20:30.123100+00';
const TS_C = '2026-01-15 10:20:30.122900+00';

type Fixture = {
  pool: Pool;
  schema: string;
  org: string;
  admin: SafeUser;
  staff: SafeUser;
};

async function withFixture(run: (fixture: Fixture) => Promise<void>) {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `msg_cursor_prec_${randomUUID().replaceAll('-', '')}`;
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
      `INSERT INTO organizations (name) VALUES ('Org') RETURNING id`,
    )).rows[0]!.id;
    async function user(name: string, role: string): Promise<SafeUser> {
      const row = (await pool!.query<{ id: string }>(
        `INSERT INTO users (organization_id, name, email, password_hash, role)
         VALUES ($1, $2, $3, 'unused-test-hash', $4) RETURNING id`,
        [org, name, `${randomUUID()}@test.local`, role],
      )).rows[0]!;
      return {
        id: row.id, organizationId: org, name,
        email: `${randomUUID()}@test.local`, role: role as SafeUser['role'],
        mustChangePassword: false, isActive: true, version: 1,
      };
    }
    const admin = await user('Admin', 'ADMIN');
    const staff = await user('Staff', 'STAFF');
    await run({ pool, schema, org, admin, staff });
  } finally {
    if (pool) await pool.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  }
}

async function insertMessage(
  pool: Pool, org: string, conversationId: string, senderId: string,
  input: { id: string; body: string; createdAt: string },
) {
  await pool.query(
    `INSERT INTO messages
       (id, conversation_id, organization_id, sender_user_id, client_action_id, body, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [input.id, conversationId, org, senderId, `K-${input.id}`, input.body, input.createdAt],
  );
}

function decodeCursor(cursor: string): { ca: string; id: string } {
  return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8'));
}

describe('MSG-CURSOR-PRECISION negative control (sub-millisecond keyset boundary)', () => {
  it('CURSOR-PREC-1: microsecond timestamps survive one DB round-trip with full precision', async () => {
    await withFixture(async ({ pool, org, admin, staff }) => {
      const svc = new MessagingService(pool, true);
      const conv = await svc.createOrGetConversation(admin, {
        contextType: 'GENERAL', title: 'precision', participantUserIds: [staff.id],
      });
      await insertMessage(pool, org, conv.id, staff.id, { id: ID_A, body: 'A', createdAt: TS_A });
      const raw = (await pool.query<{ v: string }>(
        `SELECT to_char(created_at, 'SS.US') AS v
           FROM messages WHERE id = $1`, [ID_A],
      )).rows[0]!.v;
      // Characterization: PostgreSQL itself keeps microseconds
      // (seconds + microseconds part, timezone-independent).
      expect(raw).toBe('30.123900');
    });
  });

  it('CURSOR-PREC-2: walking A,B,C with limit=1 through the real HTTP cursor contract returns every row', async () => {
    await withFixture(async ({ pool, org, admin, staff }) => {
      const svc = new MessagingService(pool, true);
      const conv = await svc.createOrGetConversation(admin, {
        contextType: 'GENERAL', title: 'precision', participantUserIds: [staff.id],
      });
      await insertMessage(pool, org, conv.id, staff.id, { id: ID_A, body: 'A', createdAt: TS_A });
      await insertMessage(pool, org, conv.id, staff.id, { id: ID_B, body: 'B', createdAt: TS_B });
      await insertMessage(pool, org, conv.id, staff.id, { id: ID_C, body: 'C', createdAt: TS_C });

      const app = Fastify({ logger: false });
      app.setErrorHandler((error, _request, reply) => {
        const response = toErrorResponse(error);
        reply.code(response.statusCode).send(response.body);
      });
      const authenticate: preHandlerHookHandler = async (request) => {
        (request as { currentUser?: SafeUser }).currentUser = staff;
      };
      await app.register(messagingRoutes, { prefix: '/api/messaging', service: svc, authenticate });

      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 5; page += 1) {
        const url = cursor
          ? `/api/messaging/conversations/${conv.id}/messages?limit=1&cursor=${cursor}`
          : `/api/messaging/conversations/${conv.id}/messages?limit=1`;
        const res = await app.inject({ method: 'GET', url });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body) as {
          items: Array<{ id: string }>; nextCursor: string | null;
        };
        seen.push(...body.items.map((item) => item.id));
        cursor = body.nextCursor;
        if (page === 0) {
          // The fixed server emits the canonical UTC microsecond boundary.
          expect(decodeCursor(cursor!).ca).toBe('2026-01-15T10:20:30.123900Z');
        }
        if (!cursor) break;
      }
      await app.close();

      // Desired contract: A, B, C with no skipped rows.
      expect(seen).toEqual([ID_A, ID_B, ID_C]);
    });
  });

  it('CURSOR-PREC-3: identical database timestamps keep deterministic id tie-breaking with no skip/dup', async () => {    await withFixture(async ({ pool, org, admin, staff }) => {
      const svc = new MessagingService(pool, true);
      const conv = await svc.createOrGetConversation(admin, {
        contextType: 'GENERAL', title: 'tiebreak', participantUserIds: [staff.id],
      });
      const SAME = '2026-01-15 10:20:30.123000+00';
      const ID_X = '11111111-1111-4111-8111-111111111111';
      const ID_Y = '22222222-2222-4222-8222-222222222222';
      const ID_Z = '33333333-3333-4333-8333-333333333333';
      await insertMessage(pool, org, conv.id, staff.id, { id: ID_X, body: 'X', createdAt: SAME });
      await insertMessage(pool, org, conv.id, staff.id, { id: ID_Y, body: 'Y', createdAt: SAME });
      await insertMessage(pool, org, conv.id, staff.id, { id: ID_Z, body: 'Z', createdAt: SAME });

      const seen: string[] = [];
      let cursor: { createdAt: Date; id: string } | null = null;
      for (let page = 0; page < 5; page += 1) {
        const result = await svc.getMessages(staff, conv.id, cursor, 1);
        seen.push(...result.items.map((item) => item.id));
        cursor = result.nextCursor;
        if (!cursor) break;
      }
      expect([...seen].sort()).toEqual([ID_X, ID_Y, ID_Z]);
      expect(new Set(seen).size).toBe(3);
      // created_at DESC, id DESC: highest UUID first.
      expect(seen).toEqual([ID_Z, ID_Y, ID_X]);
    });
  });

  it('CURSOR-PREC-4: exact boundary round-trips identically under UTC and Europe/Istanbul sessions', async () => {
    await withFixture(async ({ schema, org, admin, staff }) => {
      async function walkWithTimezone(timezone: string, idPrefix: string) {
        const ids = [ID_A, ID_B, ID_C].map((id) => `${idPrefix}${id.slice(1)}`);
        const tzPool = new Pool({
          connectionString: databaseUrl,
          max: 1,
          options: `-c search_path=${schema},public -c TimeZone=${timezone}`,
        });
        try {
          const svc = new MessagingService(tzPool, true);
          const conv = await svc.createOrGetConversation(admin, {
            contextType: 'GENERAL', title: `tz-${timezone}`, participantUserIds: [staff.id],
          });
          await insertMessage(tzPool, org, conv.id, staff.id, { id: ids[0]!, body: 'A', createdAt: TS_A });
          await insertMessage(tzPool, org, conv.id, staff.id, { id: ids[1]!, body: 'B', createdAt: TS_B });
          await insertMessage(tzPool, org, conv.id, staff.id, { id: ids[2]!, body: 'C', createdAt: TS_C });
          const seen: string[] = [];
          const emitted: string[] = [];
          let cursor: { createdAt: Date; createdAtExact?: string; id: string } | null = null;
          for (let page = 0; page < 5; page += 1) {
            const result = await svc.getMessages(staff, conv.id, cursor, 1);
            seen.push(...result.items.map((item) => item.id));
            if (result.nextCursor) {
              emitted.push(result.nextCursor.createdAtExact ?? 'MISSING_EXACT');
            }
            cursor = result.nextCursor;
            if (!cursor) break;
          }
          return { seen, emitted };
        } finally {
          await tzPool.end();
        }
      }
      const utc = await walkWithTimezone('UTC', 'd');
      const istanbul = await walkWithTimezone('Europe/Istanbul', '0');
      const [utcA, utcB, utcC] = [ID_A, ID_B, ID_C].map((id) => `d${id.slice(1)}`);
      const [istA, istB, istC] = [ID_A, ID_B, ID_C].map((id) => `0${id.slice(1)}`);
      expect(utc.seen).toEqual([utcA, utcB, utcC]);
      expect(istanbul.seen).toEqual([istA, istB, istC]);
      // Canonical UTC representation: identical cursor text under both zones,
      // all 6 microsecond digits preserved.
      expect(utc.emitted).toEqual([
        '2026-01-15T10:20:30.123900Z',
        '2026-01-15T10:20:30.123100Z',
      ]);
      expect(istanbul.emitted).toEqual(utc.emitted);
    });
  });

  it('CURSOR-PREC-5: legacy millisecond cursor is accepted; next server cursor is exact', async () => {
    await withFixture(async ({ pool, org, admin, staff }) => {
      const svc = new MessagingService(pool, true);
      const conv = await svc.createOrGetConversation(admin, {
        contextType: 'GENERAL', title: 'legacy', participantUserIds: [staff.id],
      });
      await insertMessage(pool, org, conv.id, staff.id, { id: ID_A, body: 'A', createdAt: TS_A });
      await insertMessage(pool, org, conv.id, staff.id, { id: ID_B, body: 'B', createdAt: TS_B });
      await insertMessage(pool, org, conv.id, staff.id, { id: ID_C, body: 'C', createdAt: TS_C });
      await insertMessage(pool, org, conv.id, staff.id, {
        id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        body: 'D',
        createdAt: '2026-01-15 10:20:30.121000+00',
      });

      const app = Fastify({ logger: false });
      app.setErrorHandler((error, _request, reply) => {
        const response = toErrorResponse(error);
        reply.code(response.statusCode).send(response.body);
      });
      const authenticate: preHandlerHookHandler = async (request) => {
        (request as { currentUser?: SafeUser }).currentUser = staff;
      };
      await app.register(messagingRoutes, { prefix: '/api/messaging', service: svc, authenticate });

      // Hand-crafted legacy token: millisecond precision, as older servers issued.
      const legacy = Buffer.from(JSON.stringify({ ca: '2026-01-15T10:20:30.123Z', id: ID_A })).toString('base64url');
      const res = await app.inject({
        method: 'GET',
        url: `/api/messaging/conversations/${conv.id}/messages?limit=1&cursor=${legacy}`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        items: Array<{ id: string }>; nextCursor: string | null;
      };
      // Legacy millisecond boundary semantics preserved: B (.123100) is above
      // the .123000 boundary the old token can express, so the page holds C.
      // The token never contained microseconds; nothing is recoverable here.
      expect(body.items.map((item) => item.id)).toEqual([ID_C]);
      // ...but the server-issued continuation cursor is exact from now on
      // (it points at shown row C), and walking it reaches D and terminates.
      expect(decodeCursor(body.nextCursor!).ca).toBe('2026-01-15T10:20:30.122900Z');
      const res2 = await app.inject({
        method: 'GET',
        url: `/api/messaging/conversations/${conv.id}/messages?limit=1&cursor=${body.nextCursor}`,
      });
      const body2 = JSON.parse(res2.body) as {
        items: Array<{ id: string }>; nextCursor: string | null;
      };
      expect(body2.items.map((item) => item.id)).toEqual(['dddddddd-dddd-4ddd-8ddd-dddddddddddd']);
      expect(body2.nextCursor).toBeNull();
      await app.close();
    });
  });
});
