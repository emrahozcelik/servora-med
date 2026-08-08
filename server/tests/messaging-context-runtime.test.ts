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
] as const;

type Fixture = {
  pool: Pool;
  orgA: string;
  orgB: string;
  adminA: SafeUser;
  managerA: SafeUser;
  staff1A: SafeUser;
  staff2A: SafeUser;
  staffB: SafeUser;
  job1A: string;
  job2A: string;
  customer1A: string;
  customer2A: string;
  customer1B: string;
};

async function withFixture(run: (fixture: Fixture) => Promise<void>) {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `messaging_context_${randomUUID().replaceAll('-', '')}`;
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
    const staffB = await user(orgB, 'Staff B', 'STAFF');

    await pool.query(
      `INSERT INTO staff_profiles (organization_id, user_id, manager_user_id)
       VALUES ($1, $2, $3), ($1, $4, $3)`,
      [orgA, staff1A.id, managerA.id, staff2A.id],
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

    async function customer(org: string, name: string): Promise<string> {
      return (await pool!.query<{ id: string }>(
        `INSERT INTO customers (organization_id, name, customer_type)
         VALUES ($1, $2, 'clinic') RETURNING id`,
        [org, name],
      )).rows[0]!.id;
    }

    const customer1A = await customer(orgA, 'Klinik A');
    const customer2A = await customer(orgA, 'Klinik B');
    const customer1B = await customer(orgB, 'Klinik B-Org');

    await run({
      pool, orgA, orgB, adminA, managerA, staff1A, staff2A, staffB,
      job1A, job2A, customer1A, customer2A, customer1B,
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

describe('M2 messaging context runtime contracts', () => {
  it('JOB: repeated create resolves to the canonical thread for a persisted participant creator', async () => {
    await withFixture(async ({ pool, orgA, adminA, managerA, staff1A, job1A }) => {
      const svc = service(pool);
      const first = await svc.createOrGetConversation(adminA, {
        recipientUserId: staff1A.id,
        contextType: 'JOB',
        jobId: job1A,
      });
      const second = await svc.createOrGetConversation(adminA, {
        recipientUserId: staff1A.id,
        contextType: 'JOB',
        jobId: job1A,
      });
      expect(second.id).toBe(first.id);

      // M4 security contract: a Job-resource-authorized non-participant is
      // NOT granted Messaging membership through create/get.
      await expect(
        svc.createOrGetConversation(managerA, {
          recipientUserId: staff1A.id,
          contextType: 'JOB',
          jobId: job1A,
        }),
      ).rejects.toMatchObject({ statusCode: 403 });

      const count = (await pool.query(
        `SELECT COUNT(*)::int AS c FROM conversations
          WHERE organization_id = $1 AND context_type = 'JOB' AND job_id = $2`,
        [orgA, job1A],
      )).rows[0]!.c;
      expect(count).toBe(1);
    });
  });

  it('JOB: different jobs produce different threads', async () => {
    await withFixture(async ({ pool, orgA, adminA, staff1A, staff2A, job1A, job2A }) => {
      const svc = service(pool);
      const t1 = await svc.createOrGetConversation(adminA, {
        recipientUserId: staff1A.id, contextType: 'JOB', jobId: job1A,
      });
      const t2 = await svc.createOrGetConversation(adminA, {
        recipientUserId: staff2A.id, contextType: 'JOB', jobId: job2A,
      });
      expect(t1.id).not.toBe(t2.id);
      expect(t1.contextType).toBe('JOB');
      expect(t1.jobId).toBe(job1A);
      expect(t2.jobId).toBe(job2A);
    });
  });

  it('JOB: database rejects a second canonical thread for the same org + job', async () => {
    await withFixture(async ({ pool, orgA, adminA, staff1A, job1A }) => {
      const svc = service(pool);
      const t = await svc.createOrGetConversation(adminA, {
        recipientUserId: staff1A.id, contextType: 'JOB', jobId: job1A,
      });
      await expect(
        pool.query(
          `INSERT INTO conversations (organization_id, direct_key, context_type, job_id)
           VALUES ($1, $2, 'JOB', $3)`,
          [orgA, `context:JOB:${job1A}:dup`, job1A],
        ),
      ).rejects.toThrow(/unique/i);
      expect(t.id).toBeTruthy();
    });
  });

  it('CUSTOMER: persists context and allows multiple titled threads per customer', async () => {
    await withFixture(async ({ pool, orgA, adminA, staff1A, customer1A }) => {
      const svc = service(pool);
      const t1 = await svc.createOrGetConversation(adminA, {
        recipientUserId: staff1A.id,
        contextType: 'CUSTOMER',
        customerId: customer1A,
        title: 'Teslimat koordinasyonu',
      });
      const t2 = await svc.createOrGetConversation(adminA, {
        recipientUserId: staff1A.id,
        contextType: 'CUSTOMER',
        customerId: customer1A,
        title: 'Numune takibi',
      });
      expect(t1.id).not.toBe(t2.id);
      expect(t1.customerId).toBe(customer1A);
      expect(t1.title).toBe('Teslimat koordinasyonu');
      expect(t2.title).toBe('Numune takibi');

      const count = (await pool.query(
        `SELECT COUNT(*)::int AS c FROM conversations
          WHERE organization_id = $1 AND context_type = 'CUSTOMER' AND customer_id = $2`,
        [orgA, customer1A],
      )).rows[0]!.c;
      expect(count).toBe(2);
    });
  });

  it('CUSTOMER: cross-org customer is rejected by service and by FK', async () => {
    await withFixture(async ({ pool, adminA, staff1A, customer1B }) => {
      const svc = service(pool);
      await expect(
        svc.createOrGetConversation(adminA, {
          recipientUserId: staff1A.id,
          contextType: 'CUSTOMER',
          customerId: customer1B,
          title: 'Sızıntı',
        }),
      ).rejects.toMatchObject({ statusCode: 404 });

      // Direct DB insert of a cross-org customer link must also fail
      await expect(
        pool.query(
          `INSERT INTO conversations (organization_id, direct_key, context_type, customer_id, title)
           VALUES ($1, $2, 'CUSTOMER', $3, 'Sızıntı')`,
          [adminA.organizationId, `context:CUSTOMER:${customer1B}:x`, customer1B],
        ),
      ).rejects.toThrow(/foreign key/i);
    });
  });

  it('CUSTOMER: requires a non-blank title', async () => {
    await withFixture(async ({ pool, adminA, staff1A, customer1A }) => {
      const svc = service(pool);
      await expect(
        svc.createOrGetConversation(adminA, {
          recipientUserId: staff1A.id,
          contextType: 'CUSTOMER',
          customerId: customer1A,
          title: '   ',
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
      await expect(
        svc.createOrGetConversation(adminA, {
          recipientUserId: staff1A.id,
          contextType: 'CUSTOMER',
          customerId: customer1A,
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  it('GENERAL: legacy direct conversation without title stays valid and create-or-get', async () => {
    await withFixture(async ({ pool, adminA, staff1A }) => {
      const svc = service(pool);
      const t1 = await svc.createOrGetConversation(adminA, {
        recipientUserId: staff1A.id, contextType: 'GENERAL',
      });
      const t2 = await svc.createOrGetConversation(adminA, {
        recipientUserId: staff1A.id, contextType: 'GENERAL',
      });
      expect(t2.id).toBe(t1.id);
      expect(t1.title).toBeNull();
    });
  });

  it('GENERAL: titled topic persists with trimmed title; blank title rejected', async () => {
    await withFixture(async ({ pool, adminA, staff1A }) => {
      const svc = service(pool);
      const t = await svc.createOrGetConversation(adminA, {
        recipientUserId: staff1A.id,
        contextType: 'GENERAL',
        title: '  Stok kontrolü  ',
      });
      expect(t.title).toBe('Stok kontrolü');

      await expect(
        svc.createOrGetConversation(adminA, {
          recipientUserId: staff1A.id,
          contextType: 'GENERAL',
          title: '   ',
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  it('GENERAL: title longer than 255 characters is rejected', async () => {
    await withFixture(async ({ pool, adminA, staff1A }) => {
      const svc = service(pool);
      await expect(
        svc.createOrGetConversation(adminA, {
          recipientUserId: staff1A.id,
          contextType: 'GENERAL',
          title: 'a'.repeat(256),
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  it('authorization regression: STAFF cannot create any context', async () => {
    await withFixture(async ({ pool, staff1A, staff2A, job2A, customer1A }) => {
      const svc = service(pool);
      await expect(
        svc.createOrGetConversation(staff1A, {
          recipientUserId: staff2A.id, contextType: 'GENERAL',
        }),
      ).rejects.toMatchObject({ statusCode: 403 });
      await expect(
        svc.createOrGetConversation(staff1A, {
          recipientUserId: staff2A.id, contextType: 'JOB', jobId: job2A,
        }),
      ).rejects.toMatchObject({ statusCode: 403 });
      await expect(
        svc.createOrGetConversation(staff1A, {
          recipientUserId: staff2A.id, contextType: 'CUSTOMER',
          customerId: customer1A, title: 'Test',
        }),
      ).rejects.toMatchObject({ statusCode: 403 });
    });
  });

  it('JOB: assigned STAFF participant can reply in their own JOB thread (M3 fix)', async () => {
    await withFixture(async ({ pool, managerA, staff2A, job2A }) => {
      const svc = service(pool);
      const t = await svc.createOrGetConversation(managerA, {
        recipientUserId: staff2A.id, contextType: 'JOB', jobId: job2A,
      });
      const reply = await svc.sendMessage(staff2A, t.id, 'Merhaba', `c-${randomUUID()}`);
      expect(reply.isDuplicate).toBe(false);
    });
  });

  it('multi-participant: repository persistence supports N participants without duplication', async () => {
    await withFixture(async ({ pool, orgA, adminA, managerA, staff1A, staff2A }) => {
      const svc = service(pool);
      const repo = new PostgresMessagingRepository(pool);
      const t = await svc.createOrGetConversation(adminA, {
        recipientUserId: staff1A.id, contextType: 'GENERAL',
      });

      await repo.addParticipants(orgA, t.id, [managerA.id, staff2A.id]);
      const participants = await repo.findParticipants(orgA, t.id);
      expect(participants.length).toBe(4);

      const list = await svc.getConversations(adminA, null, 20);
      expect(list.items.length).toBe(1);
      expect(list.items[0]!.id).toBe(t.id);
      expect(list.items[0]!.participants.length).toBe(4);
      // Deterministic primary-other projection: earliest other participant.
      expect(list.items[0]!.participantId).toBe(staff1A.id);

      // Repository-level message insertion proves N-participant storage and
      // per-participant unread/read state without going through service send.
      const inserted = await repo.insertMessage(
        orgA, t.id, adminA.id, `repo-msg-${randomUUID()}`, 'Herkese merhaba',
      );
      expect(inserted.id).toBeTruthy();

      const page = await repo.listMessages(orgA, t.id, null, 20);
      expect(page.items.length).toBe(1);
      expect(page.items[0]!.body).toBe('Herkese merhaba');

      expect(await svc.getUnreadCount(managerA)).toBe(1);
      expect(await svc.getUnreadCount(staff1A)).toBe(1);
      expect(await svc.getUnreadCount(staff2A)).toBe(1);
      expect(await svc.getUnreadCount(adminA)).toBe(0);

      const staffList = await svc.getConversations(staff1A, null, 20);
      expect(staffList.items.length).toBe(1);
      expect(staffList.items[0]!.participants.length).toBe(4);
    });
  });

  it('multi-participant: service send fails closed for N>2 with no side effects', async () => {
    await withFixture(async ({ pool, orgA, adminA, managerA, staff1A, staff2A }) => {
      const svc = service(pool);
      const repo = new PostgresMessagingRepository(pool);
      const t = await svc.createOrGetConversation(adminA, {
        recipientUserId: staff1A.id, contextType: 'GENERAL',
      });
      await repo.addParticipants(orgA, t.id, [managerA.id, staff2A.id]);
      expect((await repo.findParticipants(orgA, t.id)).length).toBe(4);

      // ADMIN in an N>2 conversation is not authorized to send until M3.
      await expect(
        svc.sendMessage(adminA, t.id, 'Herkese merhaba', `c-${randomUUID()}`),
      ).rejects.toMatchObject({ statusCode: 403 });
      // STAFF in an N>2 conversation is equally rejected.
      await expect(
        svc.sendMessage(staff1A, t.id, 'Ben de yazayım', `c-${randomUUID()}`),
      ).rejects.toMatchObject({ statusCode: 403 });

      const messageCount = (await pool.query(
        `SELECT COUNT(*)::int AS c FROM messages WHERE conversation_id = $1`,
        [t.id],
      )).rows[0]!.c;
      expect(messageCount).toBe(0);

      const sentActivity = (await pool.query(
        `SELECT COUNT(*)::int AS c FROM messaging_activity_logs
          WHERE conversation_id = $1 AND action = 'MESSAGE_SENT'`,
        [t.id],
      )).rows[0]!.c;
      expect(sentActivity).toBe(0);
    });
  });

  it('JOB: delete of the JobCard is blocked by the restrictive FK', async () => {
    await withFixture(async ({ pool, orgA, adminA, staff1A, job1A }) => {
      const svc = service(pool);
      await svc.createOrGetConversation(adminA, {
        recipientUserId: staff1A.id, contextType: 'JOB', jobId: job1A,
      });
      await expect(
        pool.query(`DELETE FROM job_cards WHERE organization_id = $1 AND id = $2`, [orgA, job1A]),
      ).rejects.toThrow(/foreign key|violates/i);
    });
  });

  it('CUSTOMER: delete of the customer is blocked by the restrictive FK', async () => {
    await withFixture(async ({ pool, orgA, adminA, staff1A, customer1A }) => {
      const svc = service(pool);
      await svc.createOrGetConversation(adminA, {
        recipientUserId: staff1A.id, contextType: 'CUSTOMER',
        customerId: customer1A, title: 'Koordinasyon',
      });
      await expect(
        pool.query(`DELETE FROM customers WHERE organization_id = $1 AND id = $2`, [orgA, customer1A]),
      ).rejects.toThrow(/foreign key|violates/i);
    });
  });
});
