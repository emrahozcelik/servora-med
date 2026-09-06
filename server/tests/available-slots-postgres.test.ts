import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCardActor, JobCardType } from '../src/modules/job-cards/types.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const organizationId = randomUUID();
const otherOrganizationId = randomUUID();
const managerId = randomUUID();
const staffId = randomUUID();
const otherStaffId = randomUUID();
const customerId = randomUUID();
const otherCustomerId = randomUUID();

const requestedStartsAt = '2026-08-16T14:00:00.000Z';
const requestedEndsAt = '2026-08-16T15:00:00.000Z';
const fixedNow = () => new Date('2026-08-16T00:00:00.000Z');

describe.skipIf(!databaseUrl)('available slots PostgreSQL authority', () => {
  const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
  const repository = pool ? new PostgresJobCardRepository(pool) : null;
  const service = repository
    ? new JobCardService(
        repository,
        fixedNow,
        undefined,
        undefined,
        undefined,
        { enabled: true, reminderLeadMinutes: 30 },
      )
    : null;
  const manager: JobCardActor = { id: managerId, organizationId, role: 'MANAGER' };

  beforeAll(async () => {
    await pool!.query(
      `INSERT INTO organizations (id, name, timezone)
       VALUES ($1, 'NJ-S2 Slot Search', 'America/New_York'),
              ($2, 'NJ-S2 Other Organization', 'America/New_York')`,
      [organizationId, otherOrganizationId],
    );
    await pool!.query(
      `INSERT INTO users
        (id, organization_id, name, email, password_hash, role)
       VALUES
        ($1, $4, 'NJ-S2 Manager', $5, 'test-hash', 'MANAGER'),
        ($2, $4, 'NJ-S2 Staff', $6, 'test-hash', 'STAFF'),
        ($3, $7, 'NJ-S2 Other Staff', $8, 'test-hash', 'STAFF')`,
      [
        managerId,
        staffId,
        otherStaffId,
        organizationId,
        `${managerId}@nj-s2.test`,
        `${staffId}@nj-s2.test`,
        otherOrganizationId,
        `${otherStaffId}@nj-s2.test`,
      ],
    );
    await pool!.query(
      `INSERT INTO customers (id, organization_id, name, customer_type, status)
       VALUES ($1, $3, 'NJ-S2 Target Customer', 'clinic', 'active'),
              ($2, $3, 'NJ-S2 Other Customer', 'clinic', 'active')`,
      [customerId, otherCustomerId, organizationId],
    );

    await insertJob({
      id: randomUUID(), type: 'GENERAL_TASK', title: 'Legacy point task',
      customerId: null, assignedTo: staffId,
      startsAt: '2026-08-17T14:00:00.000Z', endsAt: '2026-08-17T15:00:00.000Z',
    });
    await insertJob({
      id: randomUUID(), type: 'SALES_MEETING', title: 'Sales blocker',
      customerId: otherCustomerId, assignedTo: staffId,
      startsAt: '2026-08-18T14:00:00.000Z', endsAt: '2026-08-18T15:00:00.000Z',
    });
    await insertCalendarEvent(
      '2026-08-19T14:00:00.000Z',
      '2026-08-19T15:00:00.000Z',
      'Manual blocker',
    );
    await insertJob({
      id: randomUUID(), type: 'PRODUCT_DELIVERY', title: 'Delivery blocker',
      customerId: otherCustomerId, assignedTo: staffId,
      startsAt: '2026-08-20T14:00:00.000Z', endsAt: '2026-08-20T15:00:00.000Z',
    });
    await insertJob({
      id: randomUUID(), type: 'SALES_MEETING', title: 'Customer day blocker',
      customerId, assignedTo: managerId,
      startsAt: '2026-08-21T14:00:00.000Z', endsAt: '2026-08-21T15:00:00.000Z',
    });
    // Exact adjacency is allowed: this event ends when the Aug 22 candidate starts.
    await insertCalendarEvent(
      '2026-08-22T13:00:00.000Z',
      '2026-08-22T14:00:00.000Z',
      'Adjacent manual event',
    );
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query('DELETE FROM calendar_events WHERE organization_id = ANY($1::uuid[])', [
      [organizationId, otherOrganizationId],
    ]);
    await pool.query('DELETE FROM job_card_schedule_revisions WHERE organization_id = ANY($1::uuid[])', [
      [organizationId, otherOrganizationId],
    ]);
    await pool.query('DELETE FROM job_card_assignment_history WHERE organization_id = ANY($1::uuid[])', [
      [organizationId, otherOrganizationId],
    ]);
    await pool.query('DELETE FROM job_cards WHERE organization_id = ANY($1::uuid[])', [
      [organizationId, otherOrganizationId],
    ]);
    await pool.query('DELETE FROM customers WHERE organization_id = $1', [organizationId]);
    await pool.query('DELETE FROM users WHERE organization_id = ANY($1::uuid[])', [
      [organizationId, otherOrganizationId],
    ]);
    await pool.query('DELETE FROM organizations WHERE id = ANY($1::uuid[])', [
      [organizationId, otherOrganizationId],
    ]);
    await pool.end();
  });

  async function insertJob(input: {
    id: string;
    type: JobCardType;
    title: string;
    customerId: string | null;
    assignedTo: string;
    startsAt: string;
    endsAt: string;
  }) {
    await pool!.query(
      `INSERT INTO job_cards
        (id, organization_id, type, status, title, customer_id, assigned_to, created_by,
         scheduled_at, scheduled_ends_at, engagement_kind)
       VALUES ($1, $2, $3, 'NEW', $4, $5, $6, $7, $8, $9, $10)`,
      [
        input.id,
        organizationId,
        input.type,
        input.title,
        input.customerId,
        input.assignedTo,
        managerId,
        input.startsAt,
        input.endsAt,
        input.type === 'SALES_MEETING' ? 'SALES_MEETING' : null,
      ],
    );
  }

  async function insertCalendarEvent(startsAt: string, endsAt: string, title: string) {
    await pool!.query(
      `INSERT INTO calendar_events
        (id, organization_id, assigned_user_id, title, starts_at, ends_at, timezone,
         created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'America/New_York', $7, $7)`,
      [randomUUID(), organizationId, staffId, title, startsAt, endsAt, managerId],
    );
  }

  it('uses the canonical positive blocking set, customer policy, and half-open SQL overlap', async () => {
    const result = await service!.availableSlots(manager, {
      type: 'SALES_MEETING',
      customerId,
      assignedTo: staffId,
      scheduledAt: requestedStartsAt,
      scheduledEndsAt: requestedEndsAt,
    });

    expect(result.slots.slice(0, 2)).toEqual([
      {
        startsAt: '2026-08-17T14:00:00.000Z',
        endsAt: '2026-08-17T15:00:00.000Z',
      },
      {
        startsAt: '2026-08-22T14:00:00.000Z',
        endsAt: '2026-08-22T15:00:00.000Z',
      },
    ]);
    expect(result.slots.map((slot) => slot.startsAt)).not.toContain('2026-08-18T14:00:00.000Z');
    expect(result.slots.map((slot) => slot.startsAt)).not.toContain('2026-08-19T14:00:00.000Z');
    expect(result.slots.map((slot) => slot.startsAt)).not.toContain('2026-08-20T14:00:00.000Z');
    expect(result.slots.map((slot) => slot.startsAt)).not.toContain('2026-08-21T14:00:00.000Z');
  });
});
