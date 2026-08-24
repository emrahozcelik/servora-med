import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import { MessagingService } from '../src/modules/messaging/service.js';
import { PostgresMessagingRepository } from '../src/modules/messaging/repository.js';
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
  orgB: string;
  adminA: SafeUser;
  managerA: SafeUser;
  staff1A: SafeUser;
  staff2A: SafeUser;
  staff3A: SafeUser;
  managerOrgB: SafeUser;
  staffB: SafeUser;
};

async function withFixture(run: (fixture: Fixture) => Promise<void>) {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `msg_sender_attr_${randomUUID().replaceAll('-', '')}`;
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
    const managerA = await user(orgA, 'Mehmet Yönetici', 'MANAGER');
    const staff1A = await user(orgA, 'Zeynep Personel', 'STAFF');
    const staff2A = await user(orgA, 'Ali Personel', 'STAFF');
    const staff3A = await user(orgA, 'Elif Personel', 'STAFF');
    const managerOrgB = await user(orgB, 'Org B Yönetici', 'MANAGER');
    const staffB = await user(orgB, 'Org B Personel', 'STAFF');

    await run({
      pool, orgA, orgB, adminA, managerA, staff1A, staff2A, staff3A, managerOrgB, staffB,
    });
  } finally {
    if (pool) await pool.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  }
}

function service(pool: Pool): MessagingService {
  return new MessagingService(pool, true, undefined);
}

describe('Message sender attribution projection (multiparty repair)', () => {
  it('S3: historical sender no longer a participant still resolves senderName from the persisted user', async () => {
    await withFixture(async ({ pool, orgA, adminA, staff1A, staff2A }) => {
      const svc = service(pool);
      const conv = await svc.createOrGetConversation(adminA, {
        contextType: 'GENERAL',
        title: 'Geçmiş atama',
        participantUserIds: [staff1A.id, staff2A.id],
      });
      await svc.sendMessage(staff1A, conv.id, 'Teslimatı ben yaptım', `h-${randomUUID()}`);
      await svc.sendMessage(staff2A, conv.id, 'Teşekkürler', `h-${randomUUID()}`);

      // Simulate the real reassignment path (syncJobAssignee deleteParticipant):
      // Staff 1 A leaves the thread while their historical message remains.
      await pool.query(
        `DELETE FROM conversation_participants
          WHERE organization_id = $1 AND conversation_id = $2 AND user_id = $3`,
        [orgA, conv.id, staff1A.id],
      );

      const participants = await new PostgresMessagingRepository(pool)
        .findParticipants(orgA, conv.id);
      expect(participants.map((p) => p.userId)).not.toContain(staff1A.id);

      const page = await svc.getMessages(adminA, conv.id, null, 50);
      const historical = page.items.find((m) => m.body === 'Teslimatı ben yaptım');
      expect(historical).toBeDefined();
      expect(historical!.senderUserId).toBe(staff1A.id);
      expect(historical!.senderName).toBe('Zeynep Personel');
    });
  });

  it('S1: two different incoming senders resolve to correct distinct names', async () => {
    await withFixture(async ({ pool, adminA, staff1A, staff2A }) => {
      const svc = service(pool);
      const conv = await svc.createOrGetConversation(adminA, {
        contextType: 'GENERAL',
        title: 'Çoklu gönderici',
        participantUserIds: [staff1A.id, staff2A.id],
      });
      await svc.sendMessage(staff1A, conv.id, 'Zeynep mesajı', `t-${randomUUID()}`);
      await svc.sendMessage(staff2A, conv.id, 'Ali mesajı', `t-${randomUUID()}`);

      const page = await svc.getMessages(adminA, conv.id, null, 50);
      const zeynep = page.items.find((m) => m.body === 'Zeynep mesajı');
      const ali = page.items.find((m) => m.body === 'Ali mesajı');
      expect(zeynep).toBeDefined();
      expect(ali).toBeDefined();
      expect(zeynep!.senderName).toBe('Zeynep Personel');
      expect(ali!.senderName).toBe('Ali Personel');
      expect(zeynep!.senderName).not.toBe(ali!.senderName);
      // Attribution tied to the correct message, not positional.
      expect(zeynep!.senderUserId).toBe(staff1A.id);
      expect(ali!.senderUserId).toBe(staff2A.id);
    });
  });

  it('sendMessage returns senderName immediately and on idempotent duplicate replay', async () => {
    await withFixture(async ({ pool, adminA, staff1A }) => {
      const svc = service(pool);
      const conv = await svc.createOrGetConversation(adminA, {
        contextType: 'GENERAL',
        title: 'Gönderim zenginleştirme',
        participantUserIds: [staff1A.id],
      });
      const clientActionId = `dup-${randomUUID()}`;
      const first = await svc.sendMessage(staff1A, conv.id, 'İlk gönderim', clientActionId);
      expect(first.isDuplicate).toBe(false);
      expect(first.senderName).toBe('Zeynep Personel');

      const replay = await svc.sendMessage(staff1A, conv.id, 'İlk gönderim', clientActionId);
      expect(replay.isDuplicate).toBe(true);
      expect(replay.senderName).toBe('Zeynep Personel');
    });
  });

  it('S7: sender enrichment does not widen authorization — cross-org and nonparticipant STAFF still fail closed', async () => {
    await withFixture(async ({ pool, adminA, managerA, staff1A, staff3A, managerOrgB, staffB }) => {
      const svc = service(pool);
      const conv = await svc.createOrGetConversation(adminA, {
        contextType: 'GENERAL',
        title: 'Yetki sınırı',
        participantUserIds: [staff1A.id],
      });
      await svc.sendMessage(adminA, conv.id, 'Gizli kapsam', `a-${randomUUID()}`);

      // Same-org nonparticipant STAFF: fail closed.
      await expect(svc.getMessages(staff3A, conv.id, null, 50))
        .rejects.toMatchObject({ statusCode: 403 });
      // Cross-org MANAGER and STAFF: fail closed (conversation not in their org scope).
      await expect(svc.getMessages(managerOrgB, conv.id, null, 50))
        .rejects.toMatchObject({ statusCode: 404 });
      await expect(svc.getMessages(staffB, conv.id, null, 50))
        .rejects.toMatchObject({ statusCode: 404 });

      // Same-org MANAGER keeps R1 organization-wide read authority.
      const orgARead = await svc.getMessages(managerA, conv.id, null, 50);
      expect(orgARead.items.length).toBeGreaterThan(0);
    });
  });

  it('realtime message.sent payload remains bodyless and senderName-free', async () => {
    await withFixture(async ({ pool, adminA, staff1A }) => {
      const published: RealtimeEventRecord[] = [];
      const publisher: RealtimeEventPublisher = {
        publish: (event) => { published.push(event); },
      };
      const svc = new MessagingService(pool, true, publisher);
      const conv = await svc.createOrGetConversation(adminA, {
        contextType: 'GENERAL',
        title: 'Gizlilik',
        participantUserIds: [staff1A.id],
      });
      await svc.sendMessage(adminA, conv.id, 'Bodyless kalmalı', `p-${randomUUID()}`);

      const envelope = published.find((e) => e.type === 'message.sent');
      expect(envelope).toBeDefined();
      expect(Object.keys(envelope!)).not.toContain('senderName');
      const bodyFree = [
        envelope!.type, envelope!.entityType, envelope!.entityId,
        ...envelope!.resourceKeys, ...envelope!.audience.roles,
        ...envelope!.audience.userIds,
      ].join('|');
      expect(bodyFree).not.toContain('Bodyless kalmalı');
    });
  });
});
