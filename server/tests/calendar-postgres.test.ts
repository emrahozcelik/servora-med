import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresCalendarRepository } from '../src/modules/calendar/repository.js';
import { CalendarService } from '../src/modules/calendar/service.js';
import type { CalendarActor, CalendarQuery } from '../src/modules/calendar/types.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const organizationId = randomUUID();
const managerId = randomUUID();
const teamStaffId = randomUUID();
const outsideStaffId = randomUUID();
const now = new Date('2026-07-26T08:00:00.000Z');
const query: CalendarQuery = {
  from: '2026-07-27T00:00:00.000Z',
  to: '2026-08-03T00:00:00.000Z',
  assignedTo: null,
};

describe.skipIf(!databaseUrl)('calendar PostgreSQL authorization and transactions', () => {
  const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
  const repository = pool ? new PostgresCalendarRepository(pool, 30, false) : null;
  const service = repository ? new CalendarService(true, repository, () => now) : null;
  const manager: CalendarActor = {
    id: managerId,
    organizationId,
    role: 'MANAGER',
  };
  const teamStaff: CalendarActor = {
    id: teamStaffId,
    organizationId,
    role: 'STAFF',
  };
  const admin: CalendarActor = {
    id: managerId,
    organizationId,
    role: 'ADMIN',
  };

  beforeAll(async () => {
    await pool!.query(
      `INSERT INTO organizations (id, name, timezone)
       VALUES ($1, 'U2 Calendar PostgreSQL', 'Europe/Istanbul')`,
      [organizationId],
    );
    await pool!.query(
      `INSERT INTO users
        (id, organization_id, name, email, password_hash, role)
       VALUES
        ($1, $4, 'Takvim Yöneticisi', $5, 'hash', 'MANAGER'),
        ($2, $4, 'Ekip Personeli', $6, 'hash', 'STAFF'),
        ($3, $4, 'Yetki Dışı Personel', $7, 'hash', 'STAFF')`,
      [
        managerId,
        teamStaffId,
        outsideStaffId,
        organizationId,
        `${managerId}@example.test`,
        `${teamStaffId}@example.test`,
        `${outsideStaffId}@example.test`,
      ],
    );
    await pool!.query(
      `INSERT INTO staff_profiles
        (organization_id, user_id, manager_user_id)
       VALUES ($1, $2, $3), ($1, $4, NULL)`,
      [organizationId, teamStaffId, managerId, outsideStaffId],
    );
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query('DELETE FROM in_app_notifications WHERE organization_id = $1', [organizationId]);
    await pool.query('DELETE FROM realtime_events WHERE organization_id = $1', [organizationId]);
    await pool.query('DELETE FROM calendar_reminders WHERE organization_id = $1', [organizationId]);
    await pool.query('DELETE FROM calendar_events WHERE organization_id = $1', [organizationId]);
    await pool.query('DELETE FROM staff_profiles WHERE organization_id = $1', [organizationId]);
    await pool.query('DELETE FROM users WHERE organization_id = $1', [organizationId]);
    await pool.query('DELETE FROM organizations WHERE id = $1', [organizationId]);
    await pool.end();
  });

  it('restricts Manager assignees and all-team reads to the existing team relation', async () => {
    await expect(service!.assignees(manager)).resolves.toEqual({
      items: [expect.objectContaining({ id: teamStaffId })],
    });
    await expect(service!.create(manager, {
      clientActionId: 'outside-assignment',
      assignedUserId: outsideStaffId,
      title: 'Yetki dışı plan',
      description: null,
      startsAt: '2026-07-28T09:00:00.000Z',
      endsAt: '2026-07-28T10:00:00.000Z',
      timezone: 'Europe/Istanbul',
    })).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });

    await service!.create(admin, {
      clientActionId: 'outside-admin-plan',
      assignedUserId: outsideStaffId,
      title: 'Yetki dışı kayıt',
      description: null,
      startsAt: '2026-07-28T09:00:00.000Z',
      endsAt: '2026-07-28T10:00:00.000Z',
      timezone: 'Europe/Istanbul',
    });
    const listed = await service!.list(manager, query);
    expect(listed.items).toEqual([]);
  });

  it('creates idempotently, preserves half-open adjacency and rejects overlap safely', async () => {
    const input = {
      clientActionId: 'team-plan-create',
      assignedUserId: teamStaffId,
      title: 'Klinik hazırlığı',
      description: 'Sentetik test açıklaması',
      startsAt: '2026-07-29T09:00:00.000Z',
      endsAt: '2026-07-29T10:00:00.000Z',
      timezone: 'Europe/Istanbul',
    } as const;
    const created = await service!.create(manager, input);
    const replayed = await service!.create(manager, input);
    expect(replayed.id).toBe(created.id);

    await expect(service!.create(teamStaff, {
      ...input,
      clientActionId: 'adjacent-plan',
      title: 'Ardışık plan',
      startsAt: '2026-07-29T10:00:00.000Z',
      endsAt: '2026-07-29T11:00:00.000Z',
    })).resolves.toMatchObject({ source: 'MANUAL' });

    await expect(service!.create(manager, {
      ...input,
      clientActionId: 'overlap-plan',
      title: 'Çakışan plan',
      startsAt: '2026-07-29T09:30:00.000Z',
      endsAt: '2026-07-29T10:30:00.000Z',
    })).rejects.toMatchObject({
      code: 'CALENDAR_CONFLICT',
      statusCode: 409,
      details: {
        conflicts: expect.arrayContaining([
          expect.objectContaining({ id: created.id, source: 'MANUAL' }),
        ]),
      },
    });

    const reminders = await pool!.query<{
      state: string;
      recipient_user_id: string;
    }>(
      `SELECT state, recipient_user_id FROM calendar_reminders
       WHERE organization_id = $1 AND calendar_event_id = $2`,
      [organizationId, created.id],
    );
    expect(reminders.rows).toEqual([
      { state: 'PENDING', recipient_user_id: teamStaffId },
    ]);
  });
});
