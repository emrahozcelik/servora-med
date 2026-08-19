import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import { MessagingService } from '../src/modules/messaging/service.js';
import { PostgresMessagingRepository } from '../src/modules/messaging/repository.js';
import { canViewRealtimeEvent } from '../src/modules/realtime/audience.js';
import { PostgresRealtimeEventRepository } from '../src/modules/realtime/repository.js';
import type { SafeUser } from '../src/modules/auth/types.js';
import type { RealtimeEventPublisher } from '../src/modules/realtime/event-bus.js';
import type { RealtimeEventRecord, RealtimeViewer } from '../src/modules/realtime/types.js';

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
] as const;

type Fixture = {
  pool: Pool;
  orgA: string;
  orgB: string;
  adminA: SafeUser;
  adminB: SafeUser;
  managerA: SafeUser;
  managerB: SafeUser;
  managerOrgB: SafeUser;
  adminOrgB: SafeUser;
  staff1A: SafeUser;
  staff2A: SafeUser;
  staff3A: SafeUser;
  staffB: SafeUser;
  job1A: string;
  job2A: string;
  customer1A: string;
};

type RealtimeRow = {
  id: bigint;
  organization_id: string;
  event_type: string;
  entity_type: string;
  entity_id: string;
  actor_user_id: string;
  audience_roles: string[];
  audience_user_ids: string[];
  resource_keys: string[];
  payload: string | null;
};

async function withFixture(run: (fixture: Fixture) => Promise<void>) {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `msg_rt_audience_${randomUUID().replaceAll('-', '')}`;
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
    const orgB = (await pool.query<{ id: string }>(
      `INSERT INTO organizations (name) VALUES ('Org B') RETURNING id`,
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
    const managerA = await user(orgA, 'Manager A', 'MANAGER');
    const managerB = await user(orgA, 'Manager B', 'MANAGER');
    const managerOrgB = await user(orgB, 'Manager Org B', 'MANAGER');
    const adminOrgB = await user(orgB, 'Admin Org B', 'ADMIN');
    const staff1A = await user(orgA, 'Staff 1 A', 'STAFF');
    const staff2A = await user(orgA, 'Staff 2 A', 'STAFF');
    const staff3A = await user(orgA, 'Staff 3 A', 'STAFF');
    const staffB = await user(orgB, 'Staff B', 'STAFF');

    async function job(org: string, assignedTo: string): Promise<string> {
      return (await pool!.query<{ id: string }>(
        `INSERT INTO job_cards
           (organization_id, type, status, title, assigned_to, created_by, accepted_at, accepted_by)
         VALUES ($1, 'GENERAL_TASK', 'ACCEPTED', 'İş kaydı', $2, $2, NOW(), $2)
         RETURNING id`,
        [org, assignedTo],
      )).rows[0]!.id;
    }

    const job1A = await job(orgA, staff1A.id);
    const job2A = await job(orgA, staff2A.id);

    const customer1A = (await pool.query<{ id: string }>(
      `INSERT INTO customers (organization_id, name, customer_type)
       VALUES ($1, 'Klinik A', 'clinic') RETURNING id`,
      [orgA],
    )).rows[0]!.id;

    await run({
      pool, orgA, orgB, adminA, adminB, managerA, managerB, managerOrgB, adminOrgB,
      staff1A, staff2A, staff3A, staffB, job1A, job2A, customer1A,
    });
  } finally {
    if (pool) await pool.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  }
}

function service(pool: Pool, publisher?: RealtimeEventPublisher): MessagingService {
  return new MessagingService(pool, true, publisher);
}

async function latestMessageSent(
  pool: Pool,
  conversationId: string,
): Promise<RealtimeRow> {
  const row = (await pool.query<RealtimeRow>(
    `SELECT id, organization_id, event_type, entity_type, entity_id, actor_user_id,
            audience_roles, audience_user_ids, resource_keys
       FROM realtime_events
      WHERE entity_id = $1 AND event_type = 'message.sent'
      ORDER BY id DESC LIMIT 1`,
    [conversationId],
  )).rows[0];
  if (!row) throw new Error('expected a persisted message.sent event');
  return row;
}

function viewer(u: SafeUser): RealtimeViewer {
  return { organizationId: u.organizationId, userId: u.id, role: u.role };
}

describe('Organization-wide MANAGER/ADMIN realtime audience for message.sent (R1 repair)', () => {
  it('GENERAL: nonparticipant MANAGER and ADMIN receive message.sent via role audience; participant Staff unchanged; nonparticipant Staff and cross-org excluded', async () => {
    await withFixture(async ({
      pool, orgA, adminA, adminB, managerA, managerOrgB, adminOrgB, staff1A, staff3A, staffB,
    }) => {
      const svc = service(pool);
      const conv = await svc.createOrGetConversation(adminA, {
        contextType: 'GENERAL',
        title: 'Koordinasyon',
        participantUserIds: [staff1A.id],
      });
      await svc.sendMessage(adminA, conv.id, 'Herkese merhaba', `c-${randomUUID()}`);

      const row = await latestMessageSent(pool, conv.id);
      expect(row.organization_id).toBe(orgA);
      expect(row.event_type).toBe('message.sent');
      expect(row.entity_type).toBe('conversation');
      expect(row.entity_id).toBe(conv.id);
      expect(row.audience_roles).toEqual(['ADMIN', 'MANAGER']);
      // Persisted participants must remain in audienceUserIds.
      expect(row.audience_user_ids).toEqual(
        expect.arrayContaining([adminA.id, staff1A.id]),
      );
      expect(row.audience_user_ids).not.toContain(managerA.id);
      expect(row.audience_user_ids).not.toContain(staff3A.id);

      const event = { organizationId: row.organization_id, audience: { roles: row.audience_roles, userIds: row.audience_user_ids } };
      // Effective SSE delivery authorization.
      expect(canViewRealtimeEvent(viewer(managerA), event)).toBe(true);
      expect(canViewRealtimeEvent(viewer(adminB), event)).toBe(true);
      expect(canViewRealtimeEvent(viewer(staff1A), event)).toBe(true);
      expect(canViewRealtimeEvent(viewer(staff3A), event)).toBe(false);
      expect(canViewRealtimeEvent(viewer(managerOrgB), event)).toBe(false);
      expect(canViewRealtimeEvent(viewer(adminOrgB), event)).toBe(false);
      expect(canViewRealtimeEvent(viewer(staffB), event)).toBe(false);
    });
  });

  it('CUSTOMER: nonparticipant MANAGER receives message.sent role audience; unrelated Staff excluded', async () => {
    await withFixture(async ({ pool, orgA, adminA, managerA, staff1A, staff3A, customer1A }) => {
      const svc = service(pool);
      const conv = await svc.createOrGetConversation(adminA, {
        contextType: 'CUSTOMER',
        customerId: customer1A,
        title: 'Emel Bayram Diş Kliniği',
        participantUserIds: [staff1A.id],
      });
      await svc.sendMessage(adminA, conv.id, 'Klinik ile iletişim', `c-${randomUUID()}`);

      const row = await latestMessageSent(pool, conv.id);
      expect(row.audience_roles).toEqual(['ADMIN', 'MANAGER']);
      expect(row.audience_user_ids).toEqual(
        expect.arrayContaining([adminA.id, staff1A.id]),
      );
      const event = { organizationId: row.organization_id, audience: { roles: row.audience_roles, userIds: row.audience_user_ids } };
      expect(canViewRealtimeEvent(viewer(managerA), event)).toBe(true);
      expect(canViewRealtimeEvent(viewer(staff1A), event)).toBe(true);
      expect(canViewRealtimeEvent(viewer(staff3A), event)).toBe(false);
    });
  });

  it('JOB: nonparticipant MANAGER receives message.sent role audience; stale/unrelated Staff still excluded from event', async () => {
    await withFixture(async ({ pool, orgA, adminA, managerA, staff1A, staff3A, job1A }) => {
      const svc = service(pool);
      const conv = await svc.createOrGetConversation(adminA, {
        contextType: 'JOB',
        jobId: job1A,
        participantUserIds: [staff1A.id],
      });
      await svc.sendMessage(adminA, conv.id, 'Teslimat planı', `c-${randomUUID()}`);

      const row = await latestMessageSent(pool, conv.id);
      expect(row.audience_roles).toEqual(['ADMIN', 'MANAGER']);
      // assigned Staff and persisted participant remain in audienceUserIds.
      expect(row.audience_user_ids).toEqual(
        expect.arrayContaining([adminA.id, staff1A.id]),
      );
      expect(row.audience_user_ids).not.toContain(staff3A.id);

      const event = { organizationId: row.organization_id, audience: { roles: row.audience_roles, userIds: row.audience_user_ids } };
      expect(canViewRealtimeEvent(viewer(managerA), event)).toBe(true);
      expect(canViewRealtimeEvent(viewer(staff1A), event)).toBe(true);
      expect(canViewRealtimeEvent(viewer(staff3A), event)).toBe(false);
    });
  });

  it('publishes a bodyless message.sent envelope with role audience on the in-memory bus', async () => {
    await withFixture(async ({ pool, adminA, staff1A }) => {
      const published: RealtimeEventRecord[] = [];
      const publisher: RealtimeEventPublisher = {
        publish: (event) => { published.push(event); },
      };
      const svc = service(pool, publisher);
      const conv = await svc.createOrGetConversation(adminA, {
        contextType: 'GENERAL',
        title: 'Yayın',
        participantUserIds: [staff1A.id],
      });
      await svc.sendMessage(adminA, conv.id, 'Gerçek mesaj metni', `c-${randomUUID()}`);

      const envelope = published.find((e) => e.type === 'message.sent');
      expect(envelope).toBeDefined();
      expect(envelope!.audience.roles).toEqual(['ADMIN', 'MANAGER']);
      expect(envelope!.audience.userIds).toEqual(
        expect.arrayContaining([adminA.id, staff1A.id]),
      );
      expect(envelope!.entityType).toBe('conversation');
      expect(envelope!.entityId).toBe(conv.id);
      expect(envelope!.organizationId).toBe(adminA.organizationId);
      const bodyFree = [
        envelope!.type, envelope!.entityType, envelope!.entityId,
        ...envelope!.resourceKeys, ...envelope!.audience.roles,
        ...envelope!.audience.userIds,
      ].join('|');
      expect(bodyFree).not.toContain('Gerçek mesaj metni');
    });
  });

  it('does not mutate participants or fan out notifications for a nonparticipant MANAGER', async () => {
    await withFixture(async ({ pool, orgA, adminA, managerA, staff1A }) => {
      const svc = service(pool);
      const repo = new PostgresMessagingRepository(pool);
      const conv = await svc.createOrGetConversation(adminA, {
        contextType: 'GENERAL',
        title: 'Bildirim yok',
        participantUserIds: [staff1A.id],
      });
      await svc.sendMessage(adminA, conv.id, 'Mesaj', `c-${randomUUID()}`);

      // No participant insertion for the nonparticipant Manager.
      const participants = await repo.findParticipants(orgA, conv.id);
      expect(participants.some((p) => p.userId === managerA.id)).toBe(false);
      expect(participants.map((p) => p.userId).sort())
        .toEqual([adminA.id, staff1A.id].sort());

      // No notification row for the nonparticipant Manager.
      const notifRecipients = (await pool.query<{ recipient_user_id: string }>(
        `SELECT n.recipient_user_id
           FROM in_app_notifications n
           JOIN realtime_events r ON r.id = n.source_realtime_event_id
          WHERE r.entity_id = $1 AND r.event_type = 'message.sent'`,
        [conv.id],
      )).rows.map((row) => row.recipient_user_id);
      expect(notifRecipients).toContain(staff1A.id);
      expect(notifRecipients).not.toContain(managerA.id);
    });
  });

  it('replay visibility honors the role audience for MANAGER/ADMIN and excludes nonparticipant STAFF', async () => {
    await withFixture(async ({ pool, adminA, managerA, staff1A, staff3A }) => {
      const svc = service(pool);
      const conv = await svc.createOrGetConversation(adminA, {
        contextType: 'GENERAL',
        title: 'Replay',
        participantUserIds: [staff1A.id],
      });

      const repo = new PostgresRealtimeEventRepository(pool);
      const managerBefore = await repo.visibleHighWater(viewer(managerA));

      await svc.sendMessage(adminA, conv.id, 'İlk mesaj', `c-${randomUUID()}`);

      const adminHigh = await repo.visibleHighWater(viewer(adminA));
      const visibleManager = await repo.replayVisible(viewer(managerA), managerBefore, 50);
      const visibleAdmin = await repo.replayVisible(viewer(adminA), 0n, 50);
      const visibleStaff = await repo.replayVisible(viewer(staff1A), 0n, 50);
      const visibleUnrelatedStaff = await repo.replayVisible(viewer(staff3A), 0n, 50);

      expect(visibleManager.some((e) => e.entityId === conv.id && e.type === 'message.sent')).toBe(true);
      expect(visibleAdmin.some((e) => e.entityId === conv.id && e.type === 'message.sent')).toBe(true);
      expect(visibleStaff.some((e) => e.entityId === conv.id && e.type === 'message.sent')).toBe(true);
      expect(visibleUnrelatedStaff.some((e) => e.entityId === conv.id && e.type === 'message.sent')).toBe(false);
      // The nonparticipant MANAGER's high-water must include the message event.
      expect(await repo.visibleHighWater(viewer(managerA))).toBe(adminHigh);
    });
  });
});
