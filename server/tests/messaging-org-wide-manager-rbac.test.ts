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
  staff1A: SafeUser;
  staff2A: SafeUser;
  staff3A: SafeUser;
  inactiveStaffA: SafeUser;
  staffB: SafeUser;
  job1A: string;
  job2A: string;
  customer1A: string;
};

/**
 * Org-wide MANAGER RBAC fixture.
 *
 * managerA is intentionally created WITHOUT any staff_profiles team binding
 * (empty team, mirroring the observed Onur Gürbüz runtime state). Under the
 * frozen organization-wide MANAGER doctrine his empty team must never matter
 * for Messaging authorization.
 */
async function withFixture(run: (fixture: Fixture) => Promise<void>) {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `messaging_orgwide_${randomUUID().replaceAll('-', '')}`;
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
    const adminB = await user(orgA, 'Admin B', 'ADMIN');
    const managerA = await user(orgA, 'Manager A', 'MANAGER');
    const managerB = await user(orgA, 'Manager B', 'MANAGER');
    const managerOrgB = await user(orgB, 'Manager Org B', 'MANAGER');
    const staff1A = await user(orgA, 'Staff 1 A', 'STAFF');
    const staff2A = await user(orgA, 'Staff 2 A', 'STAFF');
    const staff3A = await user(orgA, 'Staff 3 A', 'STAFF');
    const inactiveStaffA = await user(orgA, 'Inactive Staff A', 'STAFF', false);
    const staffB = await user(orgB, 'Staff B', 'STAFF');

    // NOTE: managerA has NO staff_profiles row -> empty team on purpose.

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
      pool, orgA, orgB, adminA, adminB, managerA, managerB, managerOrgB, staff1A, staff2A, staff3A,
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

describe('Organization-wide MANAGER Messaging RBAC (R1)', () => {
  it('O1: empty-team MANAGER may start a GENERAL conversation with an active same-org STAFF', async () => {
    await withFixture(async ({ pool, managerA, staff1A }) => {
      const svc = service(pool);
      const conv = await svc.createOrGetConversation(managerA, {
        contextType: 'GENERAL',
        title: 'Koordinasyon',
        participantUserIds: [staff1A.id],
      });
      const ids = conv.participants.map((p) => p.userId);
      expect(ids).toContain(managerA.id);
      expect(ids).toContain(staff1A.id);
    });
  });

  it('O2: empty-team MANAGER may create a JOB conversation for a same-org Job assigned to active Staff', async () => {
    await withFixture(async ({ pool, managerA, staff1A, job1A }) => {
      const svc = service(pool);
      const conv = await svc.createOrGetConversation(managerA, {
        contextType: 'JOB',
        jobId: job1A,
        participantUserIds: [staff1A.id],
      });
      expect(conv.jobId).toBe(job1A);
      const ids = conv.participants.map((p) => p.userId);
      expect(ids).toContain(staff1A.id);
    });
  });

  it('O3/O4/O5/O6: empty-team MANAGER can open/read/send an existing canonical JOB conversation without being persisted as a participant', async () => {
    await withFixture(async ({ pool, orgA, adminA, managerA, staff1A, job1A }) => {
      const svc = service(pool);
      const repo = new PostgresMessagingRepository(pool);

      // ADMIN creates the canonical thread (persisted participants: adminA + staff1A).
      const canonical = await svc.createOrGetConversation(adminA, {
        contextType: 'JOB',
        jobId: job1A,
        participantUserIds: [staff1A.id],
      });
      await svc.sendMessage(adminA, canonical.id, 'İlk mesaj', `c-${randomUUID()}`);

      // O3: create-or-get returns the canonical conversation to a non-participant Manager.
      const opened = await svc.createOrGetConversation(managerA, {
        contextType: 'JOB',
        jobId: job1A,
        participantUserIds: [staff1A.id],
      });
      expect(opened.id).toBe(canonical.id);
      expect(opened.jobId).toBe(job1A);

      // O4: Manager reads message history.
      const page = await svc.getMessages(managerA, canonical.id, null, 20);
      expect(page.items.length).toBe(1);
      expect(page.items[0]!.body).toBe('İlk mesaj');

      // O5: Manager sends into the conversation.
      const sent = await svc.sendMessage(managerA, canonical.id, 'Manager mesajı', `c-${randomUUID()}`);
      expect(sent.isDuplicate).toBe(false);
      expect((await svc.getMessages(managerA, canonical.id, null, 20)).items.length).toBe(2);

      // O6: Manager must NOT have been silently inserted as a participant.
      const participants = await repo.findParticipants(orgA, canonical.id);
      expect(participants.some((p) => p.userId === managerA.id)).toBe(false);
      expect(participants.map((p) => p.userId).sort())
        .toEqual([adminA.id, staff1A.id].sort());
    });
  });

  it('GENERAL recipients: empty-team MANAGER sees all active same-org ADMIN/MANAGER/STAFF except self', async () => {
    await withFixture(async ({ pool, managerA, adminA, adminB, managerB, staff1A, staff2A, staff3A, inactiveStaffA, staffB }) => {
      const svc = service(pool);
      const recipients = await svc.getRecipients(managerA, 'GENERAL');
      const ids = recipients.map((r) => r.id).sort();
      expect(ids).toEqual(
        [adminA.id, adminB.id, managerB.id, staff1A.id, staff2A.id, staff3A.id].sort(),
      );
      expect(ids).not.toContain(managerA.id);
      expect(ids).not.toContain(inactiveStaffA.id);
      expect(ids).not.toContain(staffB.id);
    });
  });

  it('JOB recipients: empty-team MANAGER sees active same-org STAFF (recipient is the assigned Staff)', async () => {
    await withFixture(async ({ pool, managerA, adminA, adminB, staff1A, staff2A, staff3A, inactiveStaffA }) => {
      const svc = service(pool);
      const recipients = await svc.getRecipients(managerA, 'JOB');
      const ids = recipients.map((r) => r.id).sort();
      expect(ids).toEqual([staff1A.id, staff2A.id, staff3A.id].sort());
      expect(ids).not.toContain(adminA.id);
      expect(ids).not.toContain(adminB.id);
      expect(ids).not.toContain(inactiveStaffA.id);
    });
  });

  it('JOB: canonical create-or-get from non-participant ADMIN also succeeds', async () => {
    await withFixture(async ({ pool, adminA, adminB, staff1A, job1A }) => {
      const svc = service(pool);
      const canonical = await svc.createOrGetConversation(adminA, {
        contextType: 'JOB', jobId: job1A, participantUserIds: [staff1A.id],
      });
      const opened = await svc.createOrGetConversation(adminB, {
        contextType: 'JOB', jobId: job1A, participantUserIds: [staff1A.id],
      });
      expect(opened.id).toBe(canonical.id);
      const page = await svc.getMessages(adminB, canonical.id, null, 20);
      expect(page.items.length).toBe(0);
      await svc.sendMessage(adminB, canonical.id, 'Admin B', `c-${randomUUID()}`);
    });
  });

  it('security: cross-org MANAGER is denied read/send on another organization conversation', async () => {
    await withFixture(async ({ pool, adminA, managerOrgB, staff1A, job1A }) => {
      const svc = service(pool);
      const canonical = await svc.createOrGetConversation(adminA, {
        contextType: 'JOB', jobId: job1A, participantUserIds: [staff1A.id],
      });
      await expect(svc.getMessages(managerOrgB, canonical.id, null, 20))
        .rejects.toMatchObject({ statusCode: 404 });
      await expect(svc.sendMessage(managerOrgB, canonical.id, 'Yok', `c-${randomUUID()}`))
        .rejects.toMatchObject({ statusCode: 404 });
    });
  });

  it('security: cross-org recipient on GENERAL create is denied', async () => {
    await withFixture(async ({ pool, managerA, staffB }) => {
      const svc = service(pool);
      await expect(
        svc.createOrGetConversation(managerA, {
          contextType: 'GENERAL', title: 'X', participantUserIds: [staffB.id],
        }),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  it('security: cross-org Job on JOB create is denied opaquely', async () => {
    await withFixture(async ({ pool, orgB, managerA, staffB }) => {
      const svc = service(pool);
      const jobB = (await pool.query<{ id: string }>(
        `INSERT INTO job_cards
           (organization_id, type, status, title, assigned_to, created_by, accepted_at, accepted_by)
         VALUES ($1, 'GENERAL_TASK', 'ACCEPTED', 'Org B job', $2, $2, NOW(), $2)
         RETURNING id`,
        [orgB, staffB.id],
      )).rows[0]!.id;
      await expect(
        svc.createOrGetConversation(managerA, {
          contextType: 'JOB',
          jobId: jobB,
          participantUserIds: [staffB.id],
        }),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  it('security: inactive recipient on GENERAL create is denied', async () => {
    await withFixture(async ({ pool, managerA, inactiveStaffA }) => {
      const svc = service(pool);
      await expect(
        svc.createOrGetConversation(managerA, {
          contextType: 'GENERAL', title: 'X', participantUserIds: [inactiveStaffA.id],
        }),
      ).rejects.toMatchObject({ statusCode: 403 });
    });
  });

  it('security: STAFF who is not an authorized participant is denied read/send on a same-org conversation', async () => {
    await withFixture(async ({ pool, adminA, staff1A, staff3A, job1A }) => {
      const svc = service(pool);
      const canonical = await svc.createOrGetConversation(adminA, {
        contextType: 'JOB', jobId: job1A, participantUserIds: [staff1A.id],
      });
      await expect(svc.getMessages(staff3A, canonical.id, null, 20))
        .rejects.toMatchObject({ statusCode: 403 });
      await expect(svc.sendMessage(staff3A, canonical.id, 'Yok', `c-${randomUUID()}`))
        .rejects.toMatchObject({ statusCode: 403 });
    });
  });

  it('security: STAFF cannot create arbitrary GENERAL conversations', async () => {
    await withFixture(async ({ pool, staff1A, staff2A }) => {
      const svc = service(pool);
      await expect(
        svc.createOrGetConversation(staff1A, {
          contextType: 'GENERAL', title: 'X', participantUserIds: [staff2A.id],
        }),
      ).rejects.toMatchObject({ statusCode: 403 });
    });
  });

  it('security: JOB recipient must be the current assigned Staff', async () => {
    await withFixture(async ({ pool, managerA, staff1A, staff2A, job1A }) => {
      const svc = service(pool);
      await expect(
        svc.createOrGetConversation(managerA, {
          contextType: 'JOB', jobId: job1A, participantUserIds: [staff2A.id],
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });
  });
});
