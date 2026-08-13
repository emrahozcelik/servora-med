import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresCalendarRepository } from '../src/modules/calendar/repository.js';
import { CalendarService } from '../src/modules/calendar/service.js';
import type { CalendarActor, CalendarQuery } from '../src/modules/calendar/types.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const organizationId = randomUUID();
const otherOrganizationId = randomUUID();
const managerId = randomUUID();
const teamStaffId = randomUUID();
const outsideStaffId = randomUUID();
const extraStaffId = randomUUID();
const managerBId = randomUUID();
const staffBId = randomUUID();
const outsideJobId = randomUUID();
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
  const managerB: CalendarActor = {
    id: managerBId,
    organizationId: otherOrganizationId,
    role: 'MANAGER',
  };

  beforeAll(async () => {
    await pool!.query(
      `INSERT INTO organizations (id, name, timezone)
       VALUES ($1, 'U2 Calendar PostgreSQL', 'Europe/Istanbul'),
              ($2, 'U2 Calendar Foreign', 'Europe/Istanbul')`,
      [organizationId, otherOrganizationId],
    );
    await pool!.query(
      `INSERT INTO users
        (id, organization_id, name, email, password_hash, role)
       VALUES
        ($1, $7, 'Takvim Yöneticisi', $8, 'hash', 'MANAGER'),
        ($2, $7, 'Ekip Personeli', $9, 'hash', 'STAFF'),
        ($3, $7, 'Ekip Dışı Personel', $10, 'hash', 'STAFF'),
        ($4, $7, 'İkinci Ekip Dışı Personel', $11, 'hash', 'STAFF'),
        ($5, $14, 'Yabancı Yönetici', $12, 'hash', 'MANAGER'),
        ($6, $14, 'Yabancı Personel', $13, 'hash', 'STAFF')`,
      [
        managerId,
        teamStaffId,
        outsideStaffId,
        extraStaffId,
        managerBId,
        staffBId,
        organizationId,
        `${managerId}@example.test`,
        `${teamStaffId}@example.test`,
        `${outsideStaffId}@example.test`,
        `${extraStaffId}@example.test`,
        `${managerBId}@example.test`,
        `${staffBId}@example.test`,
        otherOrganizationId,
      ],
    );
    await pool!.query(
      `INSERT INTO staff_profiles
        (organization_id, user_id, manager_user_id)
       VALUES ($1, $2, $3), ($1, $4, NULL), ($1, $5, NULL), ($6, $7, NULL)`,
      [organizationId, teamStaffId, managerId, outsideStaffId, extraStaffId,
        otherOrganizationId, staffBId],
    );
    // JOB-source event for Staff outside the former team: same window as query.
    await pool!.query(
      `INSERT INTO job_cards
        (organization_id, id, type, status, title, assigned_to, created_by,
         scheduled_at, scheduled_ends_at)
       VALUES ($1, $2, 'GENERAL_TASK', 'NEW', 'R2 Dışı İş Kaydı', $3, $3, $4, $5)`,
      [
        organizationId,
        outsideJobId,
        outsideStaffId,
        '2026-07-28T09:00:00.000Z',
        '2026-07-28T10:00:00.000Z',
      ],
    );
  });

  afterAll(async () => {
    if (!pool) return;
    const orgs = [organizationId, otherOrganizationId];
    await pool.query('DELETE FROM in_app_notifications WHERE organization_id = ANY($1::uuid[])', [orgs]);
    await pool.query('DELETE FROM realtime_events WHERE organization_id = ANY($1::uuid[])', [orgs]);
    await pool.query('DELETE FROM calendar_reminders WHERE organization_id = ANY($1::uuid[])', [orgs]);
    await pool.query('DELETE FROM calendar_events WHERE organization_id = ANY($1::uuid[])', [orgs]);
    await pool.query('DELETE FROM job_cards WHERE organization_id = ANY($1::uuid[])', [orgs]);
    await pool.query('DELETE FROM staff_profiles WHERE organization_id = ANY($1::uuid[])', [orgs]);
    await pool.query('DELETE FROM users WHERE organization_id = ANY($1::uuid[])', [orgs]);
    await pool.query('DELETE FROM organizations WHERE id = ANY($1::uuid[])', [orgs]);
    await pool.end();
  });

  function input(
    clientActionId: string,
    assignedUserId: string,
    startsAt: string,
    title: string,
  ) {
    return {
      clientActionId,
      assignedUserId,
      title,
      description: null,
      startsAt,
      endsAt: new Date(new Date(startsAt).getTime() + 60 * 60 * 1000).toISOString(),
      timezone: 'Europe/Istanbul',
    } as const;
  }

  it('R2-C1: Manager list includes MANUAL and JOB events for Staff outside the former team', async () => {
    const created = await service!.create(admin, input(
      'r2-c1-manual', outsideStaffId, '2026-07-29T09:00:00.000Z', 'R2 C1 Manuel',
    ));
    expect(created.source).toBe('MANUAL');

    const listed = await service!.list(manager, query);
    const ids = listed.items.map((item) => item.id);
    expect(ids).toContain(created.id);
    expect(ids).toContain(outsideJobId);
  });

  it('R2-C2: Manager assignees include active same-org Staff outside the former team', async () => {
    const result = await service!.assignees(manager);
    const ids = result.items.map((user) => user.id);
    expect(ids).toContain(teamStaffId);
    expect(ids).toContain(outsideStaffId);
    expect(ids).toContain(extraStaffId);
    // Role boundary: MANAGER/ADMIN actors are not STAFF assignees.
    expect(ids).not.toContain(managerId);
  });

  it('R2-C3: Manager creates a manual event for Staff outside the former team', async () => {
    const created = await service!.create(manager, input(
      'r2-c3-create', outsideStaffId, '2026-07-30T09:00:00.000Z', 'R2 C3 Oluştur',
    ));
    expect(created).toMatchObject({ source: 'MANUAL', canEdit: true, canCancel: true });
    expect(created.assignedUser.id).toBe(outsideStaffId);
  });

  it('R2-C4: Manager patches and reassigns an event assigned to Staff outside the former team', async () => {
    const created = await service!.create(manager, input(
      'r2-c4-create', outsideStaffId, '2026-07-30T11:00:00.000Z', 'R2 C4 Önce',
    ));
    const patched = await service!.patch(manager, created.id, {
      clientActionId: 'r2-c4-patch',
      expectedVersion: created.version,
      title: 'R2 C4 Sonra',
      assignedUserId: extraStaffId,
    });
    expect(patched.title).toBe('R2 C4 Sonra');
    expect(patched.assignedUser.id).toBe(extraStaffId);
    expect(patched.version).toBe(created.version + 1);
  });

  it('R2-C5: Manager cancels a cancellable event assigned to Staff outside the former team', async () => {
    const created = await service!.create(manager, input(
      'r2-c5-create', outsideStaffId, '2026-07-30T13:00:00.000Z', 'R2 C5 İptal',
    ));
    const cancelled = await service!.cancel(manager, created.id, {
      clientActionId: 'r2-c5-cancel',
      expectedVersion: created.version,
      cancelReason: 'R2 kabul senaryosu',
    });
    expect(cancelled.status).toBe('CANCELLED');

    // State rule survives: a cancelled event cannot be cancelled again.
    await expect(service!.cancel(manager, created.id, {
      clientActionId: 'r2-c5-cancel-again',
      expectedVersion: cancelled.version,
      cancelReason: 'Tekrar iptal',
    })).rejects.toMatchObject({ code: 'CALENDAR_NOT_EDITABLE', statusCode: 409 });
  });

  it('R2-C6: Staff remains self-scoped', async () => {
    const assignees = await service!.assignees(teamStaff);
    expect(assignees.items.map((user) => user.id)).toEqual([teamStaffId]);

    await expect(service!.create(teamStaff, input(
      'r2-c6-create', outsideStaffId, '2026-07-31T09:00:00.000Z', 'Yetkisiz plan',
    ))).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });

    const own = await service!.create(teamStaff, input(
      'r2-c6-own', teamStaffId, '2026-07-31T09:30:00.000Z', 'Kendi planı',
    ));
    const listed = await service!.list(teamStaff, query);
    expect(listed.items.length).toBeGreaterThan(0);
    expect(listed.items.every((item) => item.assignedUser.id === teamStaffId)).toBe(true);
    expect(listed.items.map((item) => item.id)).toContain(own.id);

    const foreign = await service!.create(manager, input(
      'r2-c6-foreign', outsideStaffId, '2026-07-31T11:00:00.000Z', 'Yabancı kayıt',
    ));
    await expect(service!.detail(teamStaff, foreign.id))
      .rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
  });

  it('R2-C7: Admin remains organization-wide', async () => {
    const assignees = await service!.assignees(admin);
    const ids = assignees.items.map((user) => user.id);
    expect(ids).toContain(teamStaffId);
    expect(ids).toContain(outsideStaffId);
    expect(ids).toContain(extraStaffId);

    const teamEvent = await service!.create(admin, input(
      'r2-c7-team', teamStaffId, '2026-07-31T13:00:00.000Z', 'R2 C7 Ekip',
    ));
    const listed = await service!.list(admin, query);
    const listedIds = listed.items.map((item) => item.id);
    expect(listedIds).toContain(teamEvent.id);
    expect(listedIds).toContain(outsideJobId);
  });

  it('R2-C8: Cross-org Manager cannot access foreign Calendar resources', async () => {
    const listed = await service!.list(managerB, query);
    expect(listed.items).toEqual([]);

    const foreign = await service!.create(admin, input(
      'r2-c8-foreign', outsideStaffId, '2026-07-31T15:00:00.000Z', 'Yabancı kayıt',
    ));
    await expect(service!.detail(managerB, foreign.id))
      .rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
    await expect(service!.patch(managerB, foreign.id, {
      clientActionId: 'r2-c8-patch',
      expectedVersion: foreign.version,
      title: 'Yabancı güncelleme',
    })).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
    await expect(service!.cancel(managerB, foreign.id, {
      clientActionId: 'r2-c8-cancel',
      expectedVersion: foreign.version,
      cancelReason: 'Yabancı iptal',
    })).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
  });

  it('R2-C9: Manager cannot assign a same-org event to cross-org Staff', async () => {
    await expect(service!.create(manager, input(
      'r2-c9-cross-org', staffBId, '2026-07-31T17:00:00.000Z', 'Sınır ihlali',
    ))).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
  });

  it('R2-C10: list/detail consistency for an event assigned outside the former team', async () => {
    const created = await service!.create(manager, input(
      'r2-c10-create', extraStaffId, '2026-08-01T09:00:00.000Z', 'R2 C10 Tutarlılık',
    ));
    const listed = await service!.list(manager, query);
    expect(listed.items.map((item) => item.id)).toContain(created.id);
    const detailed = await service!.detail(manager, created.id);
    expect(detailed.id).toBe(created.id);
    expect(detailed.assignedUser.id).toBe(extraStaffId);
  });

  it('creates idempotently, preserves half-open adjacency and rejects overlap safely', async () => {
    const idempotentInput = input(
      'team-plan-create', teamStaffId, '2026-07-29T09:00:00.000Z', 'Klinik hazırlığı',
    );
    const created = await service!.create(manager, idempotentInput);
    const replayed = await service!.create(manager, idempotentInput);
    expect(replayed.id).toBe(created.id);

    await expect(service!.create(teamStaff, {
      ...idempotentInput,
      clientActionId: 'adjacent-plan',
      title: 'Ardışık plan',
      startsAt: '2026-07-29T10:00:00.000Z',
      endsAt: '2026-07-29T11:00:00.000Z',
    })).resolves.toMatchObject({ source: 'MANUAL' });

    await expect(service!.create(manager, {
      ...idempotentInput,
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
