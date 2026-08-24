import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import { MessagingService } from '../src/modules/messaging/service.js';
import { PostgresMessagingRepository } from '../src/modules/messaging/repository.js';
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
  staffB: SafeUser;
  job1A: string;
  job2A: string;
  customer1A: string;
};

async function withFixture(run: (fixture: Fixture) => Promise<void>) {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `messaging_authz_${randomUUID().replaceAll('-', '')}`;
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
    const managerA = await user(orgA, 'Manager A', 'MANAGER');
    const staff1A = await user(orgA, 'Staff 1 A', 'STAFF');
    const staff2A = await user(orgA, 'Staff 2 A', 'STAFF');
    const staff3A = await user(orgA, 'Staff 3 A', 'STAFF');
    const staffB = await user(orgB, 'Staff B', 'STAFF');

    await pool.query(
      `INSERT INTO staff_profiles (organization_id, user_id, manager_user_id)
       VALUES ($1, $2, $3), ($1, $4, $3), ($1, $5, $3)`,
      [orgA, staff1A.id, managerA.id, staff2A.id, staff3A.id],
    );

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
      pool, orgA, orgB, adminA, managerA, staff1A, staff2A, staff3A, staffB,
      job1A, job2A, customer1A,
    });
  } finally {
    if (pool) await pool.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  }
}

function service(pool: Pool): MessagingService {
  return new MessagingService(pool, true);
}

async function completeJob(pool: Pool, orgA: string, jobId: string, staffId: string, adminId: string) {
  await pool.query(
    `UPDATE job_cards
        SET status = 'COMPLETED',
            started_at = NOW(),
            staff_completed_at = NOW(),
            staff_completed_by = $3,
            manager_approved_at = NOW(),
            manager_approved_by = $4
      WHERE organization_id = $1 AND id = $2`,
    [orgA, jobId, staffId, adminId],
  );
}

describe('M3 messaging resource-based authorization', () => {
  it('JOB active: assigned Staff participant can list, open, mark read and send', async () => {
    await withFixture(async ({ pool, orgA, managerA, staff1A, job1A }) => {
      const svc = service(pool);
      const t = await svc.createOrGetConversation(managerA, {
        recipientUserId: staff1A.id, contextType: 'JOB', jobId: job1A,
      });

      const sent = await svc.sendMessage(managerA, t.id, 'Teslimat hazır mı?', `c-${randomUUID()}`);
      expect(sent.isDuplicate).toBe(false);

      const staffList = await svc.getConversations(staff1A, null, 20);
      expect(staffList.items.some((c) => c.id === t.id)).toBe(true);

      const page = await svc.getMessages(staff1A, t.id, null, 20);
      expect(page.items.length).toBe(1);

      await svc.markRead(staff1A, t.id, page.items[0]!.id);

      const reply = await svc.sendMessage(staff1A, t.id, 'Evet, bugün teslim ederim.', `c-${randomUUID()}`);
      expect(reply.isDuplicate).toBe(false);

      const all = (await svc.getMessages(staff1A, t.id, null, 20)).items;
      expect(all.length).toBe(2);
    });
  });

  it('JOB active: participant but unassigned Staff is denied everywhere', async () => {
    await withFixture(async ({ pool, orgA, adminA, staff1A, staff2A, job2A }) => {
      const svc = service(pool);
      const repo = new PostgresMessagingRepository(pool);
      const t = await svc.createOrGetConversation(adminA, {
        recipientUserId: staff2A.id, contextType: 'JOB', jobId: job2A,
      });
      // staff1A is a participant but the job is assigned to staff2A.
      await repo.addParticipants(orgA, t.id, [staff1A.id]);

      const staff1List = await svc.getConversations(staff1A, null, 20);
      expect(staff1List.items.some((c) => c.id === t.id)).toBe(false);

      await expect(svc.getMessages(staff1A, t.id, null, 20)).rejects.toMatchObject({ statusCode: 403 });
      await expect(
        svc.sendMessage(staff1A, t.id, 'Yetkisiz', `c-${randomUUID()}`),
      ).rejects.toMatchObject({ statusCode: 403 });
      await expect(svc.markRead(staff1A, t.id, randomUUID())).rejects.toMatchObject({ statusCode: 403 });
    });
  });

  it('JOB active: authorized Staff who is not a participant is denied', async () => {
    await withFixture(async ({ pool, orgA, adminA, staff1A, job1A }) => {
      const svc = service(pool);
      const t = await svc.createOrGetConversation(adminA, {
        recipientUserId: staff1A.id, contextType: 'JOB', jobId: job1A,
      });

      // Construct the "resource-authorized but not a member" state in the
      // isolated fixture: staff1A is the assigned Staff of job1A but is no
      // longer a stored participant.
      await pool.query(
        `DELETE FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2`,
        [t.id, staff1A.id],
      );

      const list = await svc.getConversations(staff1A, null, 20);
      expect(list.items.some((c) => c.id === t.id)).toBe(false);
      await expect(svc.getMessages(staff1A, t.id, null, 20)).rejects.toMatchObject({ statusCode: 403 });
      await expect(
        svc.sendMessage(staff1A, t.id, 'Yetkisiz', `c-${randomUUID()}`),
      ).rejects.toMatchObject({ statusCode: 403 });
    });
  });

  it('JOB assignment change: stale Staff loses access without participant-row deletion', async () => {
    await withFixture(async ({ pool, orgA, adminA, managerA, staff1A, staff2A, job1A }) => {
      const svc = service(pool);
      const repo = new PostgresMessagingRepository(pool);
      const t = await svc.createOrGetConversation(adminA, {
        recipientUserId: staff1A.id, contextType: 'JOB', jobId: job1A,
      });

      await svc.sendMessage(staff1A, t.id, 'Görevdeyim', `c-${randomUUID()}`);

      // Reassign the job away from staff1A.
      await pool.query(
        `UPDATE job_cards SET assigned_to = $3 WHERE organization_id = $1 AND id = $2`,
        [orgA, job1A, staff2A.id],
      );

      const listAfter = await svc.getConversations(staff1A, null, 20);
      expect(listAfter.items.some((c) => c.id === t.id)).toBe(false);
      await expect(svc.getMessages(staff1A, t.id, null, 20)).rejects.toMatchObject({ statusCode: 403 });
      await expect(
        svc.sendMessage(staff1A, t.id, 'Hâlâ görevdeyim', `c-${randomUUID()}`),
      ).rejects.toMatchObject({ statusCode: 403 });

      // Participant row intentionally preserved.
      const participants = await repo.findParticipants(orgA, t.id);
      expect(participants.some((p) => p.userId === staff1A.id)).toBe(true);

      // The newly assigned staff is authorized for the Job but not a
      // participant: still denied (membership + resource both required).
      const newStaffList = await svc.getConversations(staff2A, null, 20);
      expect(newStaffList.items.some((c) => c.id === t.id)).toBe(false);
      await expect(svc.getMessages(staff2A, t.id, null, 20)).rejects.toMatchObject({ statusCode: 403 });
    });
  });

  it('JOB terminal: authorized participants read; send is 403 for every role with no side effects', async () => {
    await withFixture(async ({ pool, orgA, adminA, managerA, staff2A, job2A }) => {
      const svc = service(pool);
      const repo = new PostgresMessagingRepository(pool);
      const t = await svc.createOrGetConversation(managerA, {
        recipientUserId: staff2A.id, contextType: 'JOB', jobId: job2A,
      });
      await svc.sendMessage(managerA, t.id, 'Gönderim yapıldı', `c-${randomUUID()}`);
      await repo.addParticipants(orgA, t.id, [adminA.id]);

      await completeJob(pool, orgA, job2A, staff2A.id, adminA.id);

      // History remains readable for authorized participants (all roles).
      expect((await svc.getMessages(managerA, t.id, null, 20)).items.length).toBe(1);
      expect((await svc.getMessages(staff2A, t.id, null, 20)).items.length).toBe(1);
      expect((await svc.getMessages(adminA, t.id, null, 20)).items.length).toBe(1);
      const adminList = await svc.getConversations(adminA, null, 20);
      expect(adminList.items.some((c) => c.id === t.id)).toBe(true);

      // Send is rejected for every role.
      for (const actor of [adminA, managerA, staff2A]) {
        await expect(
          svc.sendMessage(actor, t.id, 'Yeni mesaj', `c-${randomUUID()}`),
        ).rejects.toMatchObject({ statusCode: 403 });
      }

      const messageCount = (await pool.query(
        `SELECT COUNT(*)::int AS c FROM messages WHERE conversation_id = $1`,
        [t.id],
      )).rows[0]!.c;
      expect(messageCount).toBe(1);

      const sentActivity = (await pool.query(
        `SELECT COUNT(*)::int AS c FROM messaging_activity_logs
          WHERE conversation_id = $1 AND action = 'MESSAGE_SENT'`,
        [t.id],
      )).rows[0]!.c;
      expect(sentActivity).toBe(1);
    });
  });

  it('CUSTOMER: participant Staff replies; non-participant Staff denied', async () => {
    await withFixture(async ({ pool, orgA, adminA, staff1A, staff3A, customer1A }) => {
      const svc = service(pool);
      const t = await svc.createOrGetConversation(adminA, {
        recipientUserId: staff1A.id,
        contextType: 'CUSTOMER',
        customerId: customer1A,
        title: 'Koordinasyon',
      });

      const reply = await svc.sendMessage(staff1A, t.id, 'Müşteriye ulaştım', `c-${randomUUID()}`);
      expect(reply.isDuplicate).toBe(false);

      const staff3List = await svc.getConversations(staff3A, null, 20);
      expect(staff3List.items.some((c) => c.id === t.id)).toBe(false);
      await expect(svc.getMessages(staff3A, t.id, null, 20)).rejects.toMatchObject({ statusCode: 403 });
      await expect(
        svc.sendMessage(staff3A, t.id, 'Yetkisiz', `c-${randomUUID()}`),
      ).rejects.toMatchObject({ statusCode: 403 });
    });
  });

  it('titled GENERAL: participant Staff replies; non-participant denied; N>2 send authorized', async () => {
    await withFixture(async ({ pool, orgA, adminA, staff1A, staff2A, staff3A }) => {
      const svc = service(pool);
      const repo = new PostgresMessagingRepository(pool);
      const t = await svc.createOrGetConversation(adminA, {
        recipientUserId: staff1A.id,
        contextType: 'GENERAL',
        title: 'Stok kontrolü',
      });
      await repo.addParticipants(orgA, t.id, [staff2A.id]);

      const reply = await svc.sendMessage(staff1A, t.id, 'Stoklar güncellendi', `c-${randomUUID()}`);
      expect(reply.isDuplicate).toBe(false);
      const second = await svc.sendMessage(staff2A, t.id, 'Teşekkürler', `c-${randomUUID()}`);
      expect(second.isDuplicate).toBe(false);

      await expect(
        svc.sendMessage(staff3A, t.id, 'Yetkisiz', `c-${randomUUID()}`),
      ).rejects.toMatchObject({ statusCode: 403 });
    });
  });

  it('legacy titleless GENERAL: N=2 pairwise behavior preserved; N>2 stays fail-closed', async () => {
    await withFixture(async ({ pool, orgA, adminA, staff1A, staff2A }) => {
      const svc = service(pool);
      const repo = new PostgresMessagingRepository(pool);
      const t = await svc.createOrGetConversation(adminA, {
        recipientUserId: staff1A.id, contextType: 'GENERAL',
      });
      expect(t.title).toBeNull();

      // Legacy N=2: existing pairwise policy — Staff to Admin remains allowed.
      const reply = await svc.sendMessage(staff1A, t.id, 'Merhaba', `c-${randomUUID()}`);
      expect(reply.isDuplicate).toBe(false);

      // N>2 titleless legacy stays fail-closed.
      await repo.addParticipants(orgA, t.id, [staff2A.id]);
      await expect(
        svc.sendMessage(staff1A, t.id, 'Herkes mi?', `c-${randomUUID()}`),
      ).rejects.toMatchObject({ statusCode: 403 });
      await expect(
        svc.sendMessage(staff2A, t.id, 'Ben de varım', `c-${randomUUID()}`),
      ).rejects.toMatchObject({ statusCode: 403 });
    });
  });

  it('N>2 JOB: authorized participants send; stale participant denied; audience excludes stale', async () => {
    await withFixture(async ({ pool, orgA, managerA, staff1A, staff3A, job1A }) => {
      const svc = service(pool);
      const repo = new PostgresMessagingRepository(pool);
      const t = await svc.createOrGetConversation(managerA, {
        recipientUserId: staff1A.id, contextType: 'JOB', jobId: job1A,
      });
      // staff3A is a stored participant of the JOB thread but has no access to
      // the underlying JobCard.
      await repo.addParticipants(orgA, t.id, [staff3A.id]);

      const sent = await svc.sendMessage(managerA, t.id, 'Numuneler hazır', `c-${randomUUID()}`);
      expect(sent.isDuplicate).toBe(false);

      const assigned = await svc.sendMessage(staff1A, t.id, 'Aldım, teslim ediyorum', `c-${randomUUID()}`);
      expect(assigned.isDuplicate).toBe(false);

      await expect(
        svc.sendMessage(staff3A, t.id, 'Yetkisiz', `c-${randomUUID()}`),
      ).rejects.toMatchObject({ statusCode: 403 });

      const messageCount = (await pool.query(
        `SELECT COUNT(*)::int AS c FROM messages WHERE conversation_id = $1`,
        [t.id],
      )).rows[0]!.c;
      expect(messageCount).toBe(2);

      // Realtime audience for the manager's send must exclude the stale staff.
      const rtAudiences = (await pool.query<{ audience_user_ids: string[] }>(
        `SELECT audience_user_ids FROM realtime_events
          WHERE entity_id = $1 AND event_type = 'message.sent'
          ORDER BY created_at`,
        [t.id],
      )).rows;
      const firstSendAudience = rtAudiences[0]?.audience_user_ids ?? [];
      expect(firstSendAudience).toContain(managerA.id);
      expect(firstSendAudience).toContain(staff1A.id);
      expect(firstSendAudience).not.toContain(staff3A.id);

      // In-app notification recipients for the manager's send exclude the
      // stale staff (actor itself never receives its own notification).
      const notificationRecipients = (await pool.query<{ recipient_user_id: string }>(
        `SELECT n.recipient_user_id
           FROM in_app_notifications n
           JOIN realtime_events r ON r.id = n.source_realtime_event_id
          WHERE r.entity_id = $1
            AND r.event_type = 'message.sent'
            AND r.actor_user_id = $2
          ORDER BY n.created_at`,
        [t.id, managerA.id],
      )).rows.map((row) => row.recipient_user_id);
      expect(notificationRecipients).toContain(staff1A.id);
      expect(notificationRecipients).not.toContain(staff3A.id);
      expect(notificationRecipients).not.toContain(managerA.id);
    });
  });

  it('unread aggregate: hidden JOB threads no longer contribute for stale Staff', async () => {
    await withFixture(async ({ pool, orgA, managerA, staff1A, staff2A, job1A }) => {
      const svc = service(pool);
      const repo = new PostgresMessagingRepository(pool);
      const t = await svc.createOrGetConversation(managerA, {
        recipientUserId: staff1A.id, contextType: 'JOB', jobId: job1A,
      });

      // Authorized contribution while Staff A is assigned.
      await svc.sendMessage(managerA, t.id, 'Görev başlıyor', `c-${randomUUID()}`);
      expect(await svc.getUnreadCount(staff1A)).toBe(1);

      // Reassign the job away from Staff A; participant row remains.
      await pool.query(
        `UPDATE job_cards SET assigned_to = $3 WHERE organization_id = $1 AND id = $2`,
        [orgA, job1A, staff2A.id],
      );
      expect((await repo.findParticipants(orgA, t.id)).some((p) => p.userId === staff1A.id)).toBe(true);

      // Existing M3 behavior still holds.
      const list = await svc.getConversations(staff1A, null, 20);
      expect(list.items.some((c) => c.id === t.id)).toBe(false);
      await expect(svc.getMessages(staff1A, t.id, null, 20)).rejects.toMatchObject({ statusCode: 403 });
      await expect(svc.markRead(staff1A, t.id, randomUUID())).rejects.toMatchObject({ statusCode: 403 });

      // The hidden thread is excluded from the aggregate entirely.
      const baselineBefore = await svc.getUnreadCount(staff1A);
      expect(baselineBefore).toBe(0);

      // An authorized participant sends another message in the now-hidden thread.
      await svc.sendMessage(managerA, t.id, 'Gizli mesaj', `c-${randomUUID()}`);

      // Staff A unread aggregate must not move because of the hidden thread.
      expect(await svc.getUnreadCount(staff1A)).toBe(baselineBefore);

      // New assignee without membership: no access, no unread contribution.
      expect(await svc.getUnreadCount(staff2A)).toBe(0);
      await expect(svc.getMessages(staff2A, t.id, null, 20)).rejects.toMatchObject({ statusCode: 403 });
    });
  });

  it('unread aggregate: CUSTOMER and titled GENERAL participant threads still contribute', async () => {
    await withFixture(async ({ pool, orgA, adminA, staff1A, staff3A, customer1A }) => {
      const svc = service(pool);
      const c = await svc.createOrGetConversation(adminA, {
        recipientUserId: staff1A.id,
        contextType: 'CUSTOMER',
        customerId: customer1A,
        title: 'Koordinasyon',
      });
      const g = await svc.createOrGetConversation(adminA, {
        recipientUserId: staff1A.id,
        contextType: 'GENERAL',
        title: 'Stok kontrolü',
      });
      await svc.sendMessage(adminA, c.id, 'Müşteri mesajı', `c-${randomUUID()}`);
      await svc.sendMessage(adminA, g.id, 'Genel mesaj', `c-${randomUUID()}`);

      expect(await svc.getUnreadCount(staff1A)).toBe(2);

      // Non-participant gets no unread contribution.
      expect(await svc.getUnreadCount(staff3A)).toBe(0);
    });
  });

  it('creation regression: STAFF cannot create JOB/CUSTOMER/GENERAL; ADMIN/MANAGER rules intact', async () => {
    await withFixture(async ({ pool, staff1A, staff2A, job2A, customer1A }) => {
      const svc = service(pool);
      await expect(
        svc.createOrGetConversation(staff1A, {
          recipientUserId: staff2A.id, contextType: 'JOB', jobId: job2A,
        }),
      ).rejects.toMatchObject({ statusCode: 403 });
      await expect(
        svc.createOrGetConversation(staff1A, {
          recipientUserId: staff2A.id, contextType: 'CUSTOMER',
          customerId: customer1A, title: 'Konu',
        }),
      ).rejects.toMatchObject({ statusCode: 403 });
      await expect(
        svc.createOrGetConversation(staff1A, {
          recipientUserId: staff2A.id, contextType: 'GENERAL',
        }),
      ).rejects.toMatchObject({ statusCode: 403 });
    });
  });
});
