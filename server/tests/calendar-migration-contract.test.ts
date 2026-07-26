import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('../src/db/migrations/017_calendar.sql', import.meta.url),
  'utf8',
);
const databaseUrl = process.env.TEST_DATABASE_URL;

describe('calendar migration contract', () => {
  it('keeps JobCards authoritative and stores only manual calendar events', () => {
    expect(migration).toContain('ADD COLUMN scheduled_ends_at TIMESTAMPTZ NULL');
    expect(migration).toContain('CREATE TABLE calendar_events');
    expect(migration).not.toMatch(/source_type|source_job_id/);
  });

  it('protects interval, organization, version and cancellation invariants', () => {
    expect(migration).toContain('ends_at > starts_at');
    expect(migration).toContain('version >= 1');
    expect(migration).toContain('calendar_events_cancelled_fields_check');
    expect(migration).toContain(
      'FOREIGN KEY (organization_id, assigned_user_id)',
    );
  });

  it('uses exactly one reminder source and bounded worker states', () => {
    expect(migration).toContain('calendar_reminders_source_check');
    expect(migration).toContain('(job_card_id IS NOT NULL)::INTEGER');
    expect(migration).toContain('(calendar_event_id IS NOT NULL)::INTEGER');
    expect(migration).toContain(
      "'PENDING', 'CLAIMED', 'PROJECTED', 'CANCELLED', 'ABANDONED'",
    );
    expect(migration).toContain('UNIQUE (dedupe_key)');
  });

  it('extends notification and realtime constraints with dotted calendar kinds', () => {
    for (const kind of [
      'calendar.assigned',
      'calendar.rescheduled',
      'calendar.cancelled',
      'calendar.reminder',
    ]) {
      expect(migration).toContain(`'${kind}'`);
    }
    expect(migration).toContain("'calendar-event'");
    expect(migration).toContain('realtime_events_activity_source_check');
  });
});

describe.skipIf(!databaseUrl)('calendar migration PostgreSQL invariants', () => {
  const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
  const organizationId = randomUUID();
  const otherOrganizationId = randomUUID();
  const staffId = randomUUID();
  const otherStaffId = randomUUID();

  beforeAll(async () => {
    await pool!.query(
      `INSERT INTO organizations (id, name) VALUES ($1, 'U2 Takvim'), ($2, 'U2 Diğer')`,
      [organizationId, otherOrganizationId],
    );
    await pool!.query(
      `INSERT INTO users
        (id, organization_id, name, email, password_hash, role)
       VALUES
        ($1, $2, 'Takvim Personeli', $3, 'hash', 'STAFF'),
        ($4, $5, 'Diğer Personel', $6, 'hash', 'STAFF')`,
      [
        staffId,
        organizationId,
        `${staffId}@example.test`,
        otherStaffId,
        otherOrganizationId,
        `${otherStaffId}@example.test`,
      ],
    );
  });

  afterAll(async () => {
    await pool?.query(
      'DELETE FROM users WHERE organization_id = ANY($1::uuid[])',
      [[organizationId, otherOrganizationId]],
    );
    await pool?.query(
      'DELETE FROM organizations WHERE id = ANY($1::uuid[])',
      [[organizationId, otherOrganizationId]],
    );
    await pool?.end();
  });

  it('rejects invalid JobCard intervals and cross-organization manual assignees', async () => {
    await expect(pool!.query(
      `INSERT INTO job_cards
        (organization_id, type, status, title, assigned_to, created_by,
         scheduled_at, scheduled_ends_at)
       VALUES ($1, 'GENERAL_TASK', 'NEW', 'Ters aralık', $2, $2, $3, $4)`,
      [
        organizationId,
        staffId,
        '2026-07-30T10:00:00.000Z',
        '2026-07-30T09:00:00.000Z',
      ],
    )).rejects.toMatchObject({ code: '23514' });

    await expect(pool!.query(
      `INSERT INTO calendar_events
        (organization_id, assigned_user_id, title, starts_at, ends_at,
         timezone, created_by, updated_by)
       VALUES ($1, $2, 'Yetkisiz plan', $3, $4, 'Europe/Istanbul', $5, $5)`,
      [
        organizationId,
        otherStaffId,
        '2026-07-30T09:00:00.000Z',
        '2026-07-30T10:00:00.000Z',
        staffId,
      ],
    )).rejects.toMatchObject({ code: '23503' });
  });

  it('enforces exactly one authoritative reminder source', async () => {
    await expect(pool!.query(
      `INSERT INTO calendar_reminders
        (organization_id, recipient_user_id, remind_at, next_attempt_at, dedupe_key)
       VALUES ($1, $2, NOW(), NOW(), $3)`,
      [organizationId, staffId, `invalid:${randomUUID()}`],
    )).rejects.toMatchObject({ code: '23514' });
  });
});
