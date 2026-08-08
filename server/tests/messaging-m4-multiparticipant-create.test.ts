import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import { MessagingService } from '../src/modules/messaging/service.js';
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
  staff3A: SafeUser;
  inactiveStaffA: SafeUser;
  staffB: SafeUser;
  job1A: string;
  job2A: string;
  customer1A: string;
};

async function withFixture(run: (fixture: Fixture) => Promise<void>) {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `messaging_m4_${randomUUID().replaceAll('-', '')}`;
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

    async function user(org: string, name: string, role: string, isActive = true): Promise<SafeUser> {
      const row = (await pool!.query<{ id: string }>(
        `INSERT INTO users (organization_id, name, email, password_hash, role, is_active)
         VALUES ($1, $2, $3, 'unused-test-hash', $4, $5) RETURNING id`,
        [org, name, `${randomUUID()}@test.local`, role, isActive],
      )).rows[0]!;
      return {
        id: row.id, organizationId: org, name, email: name.toLowerCase().replaceAll(' ', '-') + '@test.local',
        role: role as SafeUser['role'], mustChangePassword: false, isActive, version: 1,
      };
    }

    const adminA = await user(orgA, 'Admin A', 'ADMIN');
    const managerA = await user(orgA, 'Manager A', 'MANAGER');
    const staff1A = await user(orgA, 'Staff 1 A', 'STAFF');
    const staff2A = await user(orgA, 'Staff 2 A', 'STAFF');
    const staff3A = await user(orgA, 'Staff 3 A', 'STAFF');
    const inactiveStaffA = await user(orgA, 'Inactive Staff A', 'STAFF', false);
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

    const customer1A = (await pool.query<{ id: string }>(
      `INSERT INTO customers (organization_id, name, customer_type)
       VALUES ($1, 'Klinik A', 'clinic') RETURNING id`,
      [orgA],
    )).rows[0]!.id;

    await run({
      pool, orgA, orgB, adminA, managerA, staff1A, staff2A, staff3A,
      inactiveStaffA, staffB, job1A, job2A, customer1A,
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

async function countRows(pool: Pool, table: string, organizationId: string): Promise<number> {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS c FROM ${table} WHERE organization_id = $1`,
    [organizationId],
  );
  return result.rows[0]!.c;
}

// Each test rebuilds a full migration schema; allow generous fixture time.
function itSlow(name: string, fn: () => Promise<void>): void {
  it(name, fn, 30_000);
}

describe('M4 initial multi-participant create contract', () => {
  itSlow('ADMIN CUSTOMER: creator + two selected Staff persisted, 3 unique participants returned', async () => {
    await withFixture(async ({ pool, orgA, adminA, staff1A, staff2A, customer1A }) => {
      const svc = service(pool);
      const conv = await svc.createOrGetConversation(adminA, {
        participantUserIds: [staff1A.id, staff2A.id],
        contextType: 'CUSTOMER',
        customerId: customer1A,
        title: 'Yeni cihaz demo',
      });

      const ids = conv.participants.map((p) => p.userId);
      expect(new Set(ids).size).toBe(3);
      expect(ids).toContain(adminA.id);
      expect(ids).toContain(staff1A.id);
      expect(ids).toContain(staff2A.id);

      const rows = await pool.query(
        `SELECT user_id FROM conversation_participants WHERE conversation_id = $1`,
        [conv.id],
      );
      expect(rows.rows.map((r) => r.user_id).sort()).toEqual(
        [adminA.id, staff1A.id, staff2A.id].sort(),
      );
      expect(conv.customerId).toBe(customer1A);
      expect(conv.title).toBe('Yeni cihaz demo');
      expect(conv.customerName).toBe('Klinik A');
      expect(await countRows(pool, 'conversations', orgA)).toBe(1);
    });
  });

  itSlow('MANAGER GENERAL: creator + multiple team Staff persisted', async () => {
    await withFixture(async ({ pool, managerA, staff1A, staff2A }) => {
      const svc = service(pool);
      const conv = await svc.createOrGetConversation(managerA, {
        participantUserIds: [staff1A.id, staff2A.id],
        contextType: 'GENERAL',
        title: 'Ay sonu toplantı',
      });

      const ids = conv.participants.map((p) => p.userId);
      expect(new Set(ids).size).toBe(3);
      expect(ids).toContain(managerA.id);
      expect(ids).toContain(staff1A.id);
      expect(ids).toContain(staff2A.id);
    });
  });

  itSlow('MANAGER out-of-scope Staff: denied, no conversation, no participant rows', async () => {
    await withFixture(async ({ pool, orgA, managerA, staff1A, staff3A }) => {
      const svc = service(pool);
      await expect(
        svc.createOrGetConversation(managerA, {
          participantUserIds: [staff1A.id, staff3A.id],
          contextType: 'GENERAL',
          title: 'Kapsam dışı deneme',
        }),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(await countRows(pool, 'conversations', orgA)).toBe(0);
      expect(await countRows(pool, 'conversation_participants', orgA)).toBe(0);
    });
  });

  itSlow('STAFF create with participantUserIds: 403', async () => {
    await withFixture(async ({ pool, staff1A, adminA, staff2A }) => {
      const svc = service(pool);
      await expect(
        svc.createOrGetConversation(staff1A, {
          participantUserIds: [adminA.id, staff2A.id],
          contextType: 'GENERAL',
          title: 'Personel denemesi',
        }),
      ).rejects.toMatchObject({ statusCode: 403 });
    });
  });

  itSlow('duplicate participant IDs dedupe deterministically', async () => {
    await withFixture(async ({ pool, adminA, staff1A, staff2A, customer1A }) => {
      const svc = service(pool);
      const conv = await svc.createOrGetConversation(adminA, {
        participantUserIds: [staff1A.id, staff2A.id, staff1A.id],
        contextType: 'CUSTOMER',
        customerId: customer1A,
        title: 'Tekrar katılımcı',
      });

      const ids = conv.participants.map((p) => p.userId);
      expect(new Set(ids).size).toBe(3);
      expect(ids.filter((id) => id === staff1A.id).length).toBe(1);
    });
  });

  itSlow('creator listed in participantUserIds is deduped but still auto-participates', async () => {
    await withFixture(async ({ pool, adminA, staff1A, customer1A }) => {
      const svc = service(pool);
      const conv = await svc.createOrGetConversation(adminA, {
        participantUserIds: [adminA.id, staff1A.id],
        contextType: 'CUSTOMER',
        customerId: customer1A,
        title: 'Kendini ekleyen',
      });

      const ids = conv.participants.map((p) => p.userId);
      expect(ids).toContain(adminA.id);
      expect(ids).toContain(staff1A.id);
      expect(ids.length).toBe(2);
    });
  });

  itSlow('wrong-org participant mixed with valid one: denied, zero partial persistence', async () => {
    await withFixture(async ({ pool, orgA, adminA, staff1A, staffB, customer1A }) => {
      const svc = service(pool);
      await expect(
        svc.createOrGetConversation(adminA, {
          participantUserIds: [staff1A.id, staffB.id],
          contextType: 'CUSTOMER',
          customerId: customer1A,
          title: 'Yanlış org',
        }),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(await countRows(pool, 'conversations', orgA)).toBe(0);
      expect(await countRows(pool, 'conversation_participants', orgA)).toBe(0);
    });
  });

  itSlow('inactive recipient: denied', async () => {
    await withFixture(async ({ pool, adminA, inactiveStaffA, customer1A }) => {
      const svc = service(pool);
      await expect(
        svc.createOrGetConversation(adminA, {
          participantUserIds: [inactiveStaffA.id],
          contextType: 'CUSTOMER',
          customerId: customer1A,
          title: 'Pasif kullanıcı',
        }),
      ).rejects.toMatchObject({ statusCode: 403 });
    });
  });

  itSlow('JOB: non-assigned Staff in participant list rejected', async () => {
    await withFixture(async ({ pool, adminA, staff2A, job1A }) => {
      const svc = service(pool);
      await expect(
        svc.createOrGetConversation(adminA, {
          participantUserIds: [staff2A.id],
          contextType: 'JOB',
          jobId: job1A,
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  itSlow('JOB: assigned Staff + creator create the thread', async () => {
    await withFixture(async ({ pool, adminA, staff1A, job1A }) => {
      const svc = service(pool);
      const conv = await svc.createOrGetConversation(adminA, {
        participantUserIds: [staff1A.id],
        contextType: 'JOB',
        jobId: job1A,
      });

      const ids = conv.participants.map((p) => p.userId);
      expect(ids).toContain(adminA.id);
      expect(ids).toContain(staff1A.id);
      expect(conv.jobId).toBe(job1A);
    });
  });

  itSlow('JOB canonical retry: same conversation, membership unchanged, no mutation', async () => {
    await withFixture(async ({ pool, orgA, adminA, staff1A, staff2A, job1A }) => {
      const svc = service(pool);
      const first = await svc.createOrGetConversation(adminA, {
        participantUserIds: [staff1A.id],
        contextType: 'JOB',
        jobId: job1A,
      });

      const second = await svc.createOrGetConversation(adminA, {
        participantUserIds: [staff2A.id],
        contextType: 'JOB',
        jobId: job1A,
      });

      expect(second.id).toBe(first.id);

      const rows = await pool.query(
        `SELECT user_id FROM conversation_participants WHERE conversation_id = $1 ORDER BY user_id`,
        [first.id],
      );
      expect(rows.rows.map((r) => r.user_id)).toEqual([adminA.id, staff1A.id].sort());
      expect(rows.rows.map((r) => r.user_id)).not.toContain(staff2A.id);

      const count = (await pool.query(
        `SELECT COUNT(*)::int AS c FROM conversations
          WHERE organization_id = $1 AND context_type = 'JOB' AND job_id = $2`,
        [orgA, job1A],
      )).rows[0]!.c;
      expect(count).toBe(1);
    });
  });

  itSlow('legacy recipientUserId titleless GENERAL create still works', async () => {
    await withFixture(async ({ pool, adminA, staff1A }) => {
      const svc = service(pool);
      const conv = await svc.createOrGetConversation(adminA, {
        recipientUserId: staff1A.id,
        contextType: 'GENERAL',
      });
      expect(conv.title).toBeNull();
      expect(conv.contextType).toBe('GENERAL');
      const ids = conv.participants.map((p) => p.userId);
      expect(ids).toContain(adminA.id);
      expect(ids).toContain(staff1A.id);
    });
  });

  itSlow('ambiguous participantUserId + participantUserIds: deterministic 400', async () => {
    await withFixture(async ({ pool, adminA, staff1A, staff2A }) => {
      const svc = service(pool);
      await expect(
        svc.createOrGetConversation(adminA, {
          recipientUserId: staff1A.id,
          participantUserIds: [staff2A.id],
          contextType: 'GENERAL',
          title: 'Çift format',
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  itSlow('new-contract GENERAL without title: rejected (no titleless creation path)', async () => {
    await withFixture(async ({ pool, adminA, staff1A }) => {
      const svc = service(pool);
      await expect(
        svc.createOrGetConversation(adminA, {
          participantUserIds: [staff1A.id],
          contextType: 'GENERAL',
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  itSlow('neither participantUserId nor participantUserIds: rejected', async () => {
    await withFixture(async ({ pool, adminA }) => {
      const svc = service(pool);
      await expect(
        svc.createOrGetConversation(adminA, {
          contextType: 'GENERAL',
          title: 'Katılımcısız',
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  itSlow('new-contract GENERAL does not collide with a legacy pair thread for the same staff', async () => {
    await withFixture(async ({ pool, adminA, staff1A }) => {
      const svc = service(pool);
      const legacy = await svc.createOrGetConversation(adminA, {
        recipientUserId: staff1A.id,
        contextType: 'GENERAL',
      });
      expect(legacy.title).toBeNull();

      const topic = await svc.createOrGetConversation(adminA, {
        participantUserIds: [staff1A.id],
        contextType: 'GENERAL',
        title: 'Yeni genel konu',
      });

      expect(topic.id).not.toBe(legacy.id);
      expect(topic.title).toBe('Yeni genel konu');
      expect(topic.participants.map((p) => p.userId)).toContain(staff1A.id);
      expect(legacy.title).toBeNull();
    });
  });

  itSlow('new-contract GENERAL: repeated titled creates stay distinct topics (no pair identity)', async () => {
    await withFixture(async ({ pool, adminA, staff1A, staff2A }) => {
      const svc = service(pool);
      const first = await svc.createOrGetConversation(adminA, {
        participantUserIds: [staff1A.id, staff2A.id],
        contextType: 'GENERAL',
        title: 'Haftalık koordinasyon',
      });
      const second = await svc.createOrGetConversation(adminA, {
        participantUserIds: [staff2A.id, staff1A.id],
        contextType: 'GENERAL',
        title: 'Haftalık koordinasyon',
      });

      expect(second.id).not.toBe(first.id);
      expect(second.title).toBe('Haftalık koordinasyon');
      expect(second.participants.map((p) => p.userId).sort()).toEqual(
        [adminA.id, staff1A.id, staff2A.id].sort(),
      );
    });
  });
});
