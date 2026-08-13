import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import Fastify, { type preHandlerHookHandler } from 'fastify';
import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import { MessagingService } from '../src/modules/messaging/service.js';
import { messagingRoutes } from '../src/modules/messaging/routes.js';
import { toErrorResponse } from '../src/errors/index.js';
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
  orgA: string;
  orgB: string;
  adminA: SafeUser;
  adminB: SafeUser;
  managerA: SafeUser;
  managerB: SafeUser;
  staff1A: SafeUser;
  staff2A: SafeUser;
  staffB: SafeUser;
  activeJob1A: string;
  terminalJobA: string;
};

async function withFixture(run: (fixture: Fixture) => Promise<void>) {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `messaging_m5_${randomUUID().replaceAll('-', '')}`;
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
    const staff1A = await user(orgA, 'Staff 1 A', 'STAFF');
    const staff2A = await user(orgA, 'Staff 2 A', 'STAFF');
    const staffB = await user(orgB, 'Staff B', 'STAFF');

    await pool.query(
      `INSERT INTO staff_profiles (organization_id, user_id, manager_user_id)
       VALUES ($1, $2, $3), ($1, $4, $3)`,
      [orgA, staff1A.id, managerA.id, staff2A.id],
    );

    async function job(org: string, assignedTo: string, status: string): Promise<string> {
      return (await pool!.query<{ id: string }>(
        `INSERT INTO job_cards
           (organization_id, type, status, title, assigned_to, created_by,
            accepted_at, accepted_by, started_at,
            staff_completed_at, staff_completed_by,
            manager_approved_at, manager_approved_by)
         VALUES ($1, 'GENERAL_TASK', $2, 'İş kaydı', $3, $3, NOW(), $3, NOW(),
            NOW(), $3, NOW(), $3)
         RETURNING id`,
        [org, status, assignedTo],
      )).rows[0]!.id;
    }

    const activeJob1A = await job(orgA, staff1A.id, 'ACCEPTED');
    const terminalJobA = await job(orgA, staff2A.id, 'COMPLETED');

    await run({
      pool, orgA, orgB, adminA, adminB, managerA, managerB,
      staff1A, staff2A, staffB, activeJob1A, terminalJobA,
    });
  } finally {
    if (pool) await pool.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  }
}


async function withLookupApp(pool: Pool, actor: SafeUser) {
  const svc = service(pool);
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
    service: svc,
    authenticate,
  });
  return app;
}

async function getLookup(app: Awaited<ReturnType<typeof withLookupApp>>, jobId: string) {
  const res = await app.inject({
    method: 'GET',
    url: `/api/messaging/conversations/job/${jobId}`,
  });
  return { status: res.statusCode, body: JSON.parse(res.body) as Record<string, unknown> };
}

function service(pool: Pool): MessagingService {
  return new MessagingService(pool, true);
}

async function createCanonical(
  pool: Pool,
  actor: SafeUser,
  jobId: string,
  assignedStaff: SafeUser,
): Promise<string> {
  const svc = service(pool);
  const conv = await svc.createOrGetConversation(actor, {
    participantUserIds: [assignedStaff.id],
    contextType: 'JOB',
    jobId,
  });
  return conv.id;
}

// Each test rebuilds a full migration schema; allow generous fixture time.
function itSlow(name: string, fn: () => Promise<void>): void {
  it(name, fn, 30_000);
}

describe('M5 exact JOB conversation lookup (GET /api/messaging/conversations/job/:jobId)', () => {
  itSlow('A: participant Admin + active Job + canonical conversation resolves 200 with conversation', async () => {
    await withFixture(async ({ pool, adminA, staff1A, activeJob1A }) => {
      const canonicalId = await createCanonical(pool, adminA, activeJob1A, staff1A);
      const app = await withLookupApp(pool, adminA);
      const res = await getLookup(app, activeJob1A);

      expect(res.status).toBe(200);
      const { body } = res;
      expect(body.id).toBe(canonicalId);
      expect(body.contextType).toBe('JOB');
      expect(body.jobId).toBe(activeJob1A);
      expect(body.participants).toContainEqual(
        expect.objectContaining({ userId: adminA.id }),
      );
      expect(body.participants).toContainEqual(
        expect.objectContaining({ userId: staff1A.id }),
      );
      await app.close();
    });
  });

  itSlow('B: participant Manager + active Job resolves 200', async () => {
    await withFixture(async ({ pool, managerA, staff1A, activeJob1A }) => {
      await createCanonical(pool, managerA, activeJob1A, staff1A);
      const app = await withLookupApp(pool, managerA);
      const res = await getLookup(app, activeJob1A);

      expect(res.status).toBe(200);
      const { body } = res;
      expect(body.contextType).toBe('JOB');
      expect(body.jobId).toBe(activeJob1A);
      await app.close();
    });
  });

  itSlow('C: assigned participant Staff resolves 200', async () => {
    await withFixture(async ({ pool, adminA, staff1A, activeJob1A }) => {
      await createCanonical(pool, adminA, activeJob1A, staff1A);
      const app = await withLookupApp(pool, staff1A);
      const res = await getLookup(app, activeJob1A);

      expect(res.status).toBe(200);
      const { body } = res;
      expect(body.contextType).toBe('JOB');
      await app.close();
    });
  });

  itSlow('D: same-org Job-authorized Admin who is NOT a participant resolves 200 with canonical metadata', async () => {
    await withFixture(async ({ pool, adminA, adminB, staff1A, activeJob1A }) => {
      const canonicalId = await createCanonical(pool, adminA, activeJob1A, staff1A);
      const app = await withLookupApp(pool, adminB);
      const res = await getLookup(app, activeJob1A);

      expect(res.status).toBe(200);
      const { body } = res;
      expect(body.contextType).toBe('JOB');
      expect(body.jobId).toBe(activeJob1A);
      expect(body.id).toBe(canonicalId);
      await app.close();
    });
  });

  itSlow('E: Job-authorized Manager who is NOT a participant resolves 200 with canonical metadata', async () => {
    await withFixture(async ({ pool, adminA, managerA, managerB, staff1A, activeJob1A }) => {
      const canonicalId = await createCanonical(pool, adminA, activeJob1A, staff1A);
      const app = await withLookupApp(pool, managerB);
      const res = await getLookup(app, activeJob1A);

      expect(res.status).toBe(200);
      const { body } = res;
      expect(body.id).toBe(canonicalId);
      expect(body.jobId).toBe(activeJob1A);
      await app.close();
    });
  });

  itSlow('F: newly assigned Staff who is NOT a participant gets 404 with zero metadata', async () => {
    await withFixture(async ({ pool, adminA, staff1A, staff2A, activeJob1A }) => {
      const canonicalId = await createCanonical(pool, adminA, activeJob1A, staff1A);
      await pool.query(
        `UPDATE job_cards SET assigned_to = $1 WHERE id = $2`,
        [staff2A.id, activeJob1A],
      );
      const app = await withLookupApp(pool, staff2A);
      const res = await getLookup(app, activeJob1A);

      expect(res.status).toBe(404);
      const { body } = res;
      expect(JSON.stringify(body)).not.toContain(canonicalId);
      await app.close();
    });
  });

  itSlow('G: stale old Staff participant after reassignment gets 404 (M3 current resource authorization)', async () => {
    await withFixture(async ({ pool, adminA, staff1A, staff2A, activeJob1A }) => {
      await createCanonical(pool, adminA, activeJob1A, staff1A);
      await pool.query(
        `UPDATE job_cards SET assigned_to = $1 WHERE id = $2`,
        [staff2A.id, activeJob1A],
      );
      const app = await withLookupApp(pool, staff1A);
      const res = await getLookup(app, activeJob1A);

      expect(res.status).toBe(404);
      await app.close();
    });
  });

  itSlow('H: wrong-org caller gets 404 with zero metadata', async () => {
    await withFixture(async ({ pool, adminA, staff1A, staffB, activeJob1A }) => {
      const canonicalId = await createCanonical(pool, adminA, activeJob1A, staff1A);
      const app = await withLookupApp(pool, staffB);
      const res = await getLookup(app, activeJob1A);

      expect(res.status).toBe(404);
      const { body } = res;
      expect(JSON.stringify(body)).not.toContain(canonicalId);
      await app.close();
    });
  });

  itSlow('I: no canonical conversation gets safe 404', async () => {
    await withFixture(async ({ pool, adminA, staff1A, activeJob1A }) => {
      const app = await withLookupApp(pool, adminA);
      const res = await getLookup(app, activeJob1A);

      expect(res.status).toBe(404);
      const { body } = res;
      expect(JSON.stringify(body)).not.toContain(staff1A.id);
      expect(JSON.stringify(body)).not.toContain('participant');
      await app.close();
    });
  });

  itSlow('J: terminal Job + authorized participant resolves 200 (readable)', async () => {
    await withFixture(async ({ pool, adminA, staff2A, terminalJobA }) => {
      const canonicalId = await createCanonical(pool, adminA, terminalJobA, staff2A);
      const app = await withLookupApp(pool, staff2A);
      const res = await getLookup(app, terminalJobA);

      expect(res.status).toBe(200);
      const { body } = res;
      expect(body.id).toBe(canonicalId);
      expect(body.jobId).toBe(terminalJobA);
      await app.close();
    });
  });

  itSlow('service-level: messaging disabled returns 404 and no metadata', async () => {
    await withFixture(async ({ pool, adminA, activeJob1A }) => {
      const disabled = new MessagingService(pool, false);
      await expect(
        disabled.getJobConversation(adminA, activeJob1A),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });
});
