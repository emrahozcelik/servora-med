import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresCalendarRepository } from '../src/modules/calendar/repository.js';
import { CalendarService } from '../src/modules/calendar/service.js';
import type { CalendarActor } from '../src/modules/calendar/types.js';

/**
 * F4 calendar interval-boundary regression suite.
 *
 * Locks the canonical half-open [from,to) contract for the calendar list
 * range query across JOB and MANUAL sources. Derived from the deterministic
 * audit negative control on exact base 07f4a77e (where F4-2 failed because
 * the JOB branch used `COALESCE(...) >= $3` while MANUAL used `ends_at > $3`).
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const organizationId = randomUUID();
const managerId = randomUUID();
const jobStaffId = randomUUID();
const manualStaffId = randomUUID();
const jobId = randomUUID();
const pointJobId = randomUUID();
const upperIntervalJobId = randomUUID();
const upperPointJobId = randomUUID();
const now = new Date('2026-07-28T08:00:00.000Z');

const entityStart = '2026-07-28T09:00:00.000Z';
const entityEnd = '2026-07-28T10:00:00.000Z';
const windowFrom = '2026-07-28T10:00:00.000Z';
const windowTo = '2026-07-28T11:00:00.000Z';
const upperEntityEnd = '2026-07-28T11:30:00.000Z';

describe.skipIf(!databaseUrl)('F4 calendar interval-boundary contract', () => {
  const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
  const repository = pool ? new PostgresCalendarRepository(pool, 30, false) : null;
  const service = repository ? new CalendarService(true, repository, () => now) : null;
  const manager: CalendarActor = {
    id: managerId,
    organizationId,
    role: 'MANAGER',
  };

  let manualId = '';

  beforeAll(async () => {
    await pool!.query(
      `INSERT INTO organizations (id, name, timezone)
       VALUES ($1, 'F4 Boundary Audit', 'Europe/Istanbul')`,
      [organizationId],
    );
    await pool!.query(
      `INSERT INTO users
        (id, organization_id, name, email, password_hash, role)
       VALUES
        ($1, $4, 'F4 Manager', $5, 'hash', 'MANAGER'),
        ($2, $4, 'F4 Job Staff', $6, 'hash', 'STAFF'),
        ($3, $4, 'F4 Manual Staff', $7, 'hash', 'STAFF')`,
      [
        managerId,
        jobStaffId,
        manualStaffId,
        organizationId,
        `${managerId}@f4-boundary.test`,
        `${jobStaffId}@f4-boundary.test`,
        `${manualStaffId}@f4-boundary.test`,
      ],
    );
    await pool!.query(
      `INSERT INTO staff_profiles
        (organization_id, user_id, manager_user_id)
       VALUES ($1, $2, $3), ($1, $4, $3)`,
      [organizationId, jobStaffId, managerId, manualStaffId],
    );
    // Interval JobCard ending exactly at the query lower bound.
    await pool!.query(
      `INSERT INTO job_cards
        (organization_id, id, type, status, title, assigned_to, created_by,
         scheduled_at, scheduled_ends_at, engagement_kind)
       VALUES ($1, $2, 'SALES_MEETING', 'NEW', 'F4 Boundary Job', $3, $4, $5, $6, 'SALES_MEETING')`,
      [organizationId, jobId, jobStaffId, managerId, entityStart, entityEnd],
    );
    // Point-like JobCard exactly at the query lower bound (GENERAL_TASK is
    // open-ended: scheduled_ends_at stays NULL, endsAt projects as null).
    await pool!.query(
      `INSERT INTO job_cards
        (organization_id, id, type, status, title, assigned_to, created_by,
         scheduled_at, scheduled_ends_at)
       VALUES ($1, $2, 'GENERAL_TASK', 'NEW', 'F4 Point Job', $3, $4, $5, NULL)`,
      [organizationId, pointJobId, jobStaffId, managerId, windowFrom],
    );
    // Upper-bound locks: interval starting exactly at `to`, point exactly at `to`.
    await pool!.query(
      `INSERT INTO job_cards
        (organization_id, id, type, status, title, assigned_to, created_by,
         scheduled_at, scheduled_ends_at, engagement_kind)
       VALUES ($1, $2, 'SALES_MEETING', 'NEW', 'F4 Upper Interval Job', $3, $4, $5, $6, 'SALES_MEETING')`,
      [organizationId, upperIntervalJobId, jobStaffId, managerId, windowTo, upperEntityEnd],
    );
    await pool!.query(
      `INSERT INTO job_cards
        (organization_id, id, type, status, title, assigned_to, created_by,
         scheduled_at, scheduled_ends_at)
       VALUES ($1, $2, 'GENERAL_TASK', 'NEW', 'F4 Upper Point Job', $3, $4, $5, NULL)`,
      [organizationId, upperPointJobId, jobStaffId, managerId, windowTo],
    );
    // Contractually equivalent manual event on the identical interval
    // (separate assignee so the two fixtures never conflict each other).
    const created = await service!.create(manager, {
      clientActionId: `f4-boundary-${organizationId}`,
      assignedUserId: manualStaffId,
      title: 'F4 Boundary Manual',
      description: null,
      startsAt: entityStart,
      endsAt: entityEnd,
      timezone: 'Europe/Istanbul',
    });
    manualId = created.id;
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query('DELETE FROM in_app_notifications WHERE organization_id = $1', [organizationId]);
    await pool.query('DELETE FROM realtime_events WHERE organization_id = $1', [organizationId]);
    await pool.query('DELETE FROM calendar_reminders WHERE organization_id = $1', [organizationId]);
    await pool.query('DELETE FROM calendar_events WHERE organization_id = $1', [organizationId]);
    await pool.query('DELETE FROM job_card_schedule_revisions WHERE organization_id = $1', [organizationId]);
    await pool.query('DELETE FROM job_card_assignment_history WHERE organization_id = $1', [organizationId]);
    await pool.query('DELETE FROM job_cards WHERE organization_id = $1', [organizationId]);
    await pool.query('DELETE FROM staff_profiles WHERE organization_id = $1', [organizationId]);
    await pool.query('DELETE FROM users WHERE organization_id = $1', [organizationId]);
    await pool.query('DELETE FROM organizations WHERE id = $1', [organizationId]);
    await pool.end();
  });

  it('F4-1: manual interval ending exactly at `from` is excluded', async () => {
    const listed = await service!.list(manager, {
      from: windowFrom,
      to: windowTo,
      assignedTo: null,
    });
    expect(listed.items.map((item) => item.id)).not.toContain(manualId);
  });

  it('F4-2: interval JobCard ending exactly at `from` is excluded', async () => {
    const listed = await service!.list(manager, {
      from: windowFrom,
      to: windowTo,
      assignedTo: null,
    });
    const ids = listed.items.map((item) => item.id);
    // Canonical [from,to): [09:00,10:00) does not overlap [10:00,11:00).
    expect(ids).not.toContain(jobId);
  });

  it('F4-3: point-like JobCard exactly at `from` stays included', async () => {
    const listed = await service!.list(manager, {
      from: windowFrom,
      to: windowTo,
      assignedTo: null,
    });
    const items = listed.items.filter((item) => item.id === pointJobId);
    // Point rule is from <= scheduled_at < to; NULL-end rows use this arm.
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ source: 'JOB', endsAt: null });
  });

  it('F4-4: interval and point starting exactly at `to` are excluded', async () => {
    const listed = await service!.list(manager, {
      from: windowFrom,
      to: windowTo,
      assignedTo: null,
    });
    const ids = listed.items.map((item) => item.id);
    expect(ids).not.toContain(upperIntervalJobId);
    expect(ids).not.toContain(upperPointJobId);
  });
});
