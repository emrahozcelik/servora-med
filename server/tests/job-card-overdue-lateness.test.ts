import { describe, expect, it } from 'vitest';

import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import type { JobCardListQuery } from '../src/modules/job-cards/types.js';

type QueryCall = { sql: string; values: unknown[] };

const baseQuery: JobCardListQuery = {
  q: null,
  status: 'active',
  type: null,
  assignedTo: null,
  customerId: null,
  priority: null,
  dueBefore: null,
  dueAfter: null,
  followUp: null,
  limit: 25,
  offset: 0,
  overdue: false,
};

const requestTime = new Date('2026-07-14T12:00:00.000Z');

function poolDouble(itemRows: unknown[] = [], total = 0) {
  const calls: QueryCall[] = [];
  return {
    calls,
    pool: {
      async query(sql: string, values: unknown[] = []) {
        calls.push({ sql, values });
        if (/AS total/.test(sql)) return { rows: [{ total }] };
        return { rows: itemRows };
      },
    },
  };
}

function listRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    type: 'PRODUCT_DELIVERY',
    status: 'ACCEPTED',
    version: 1,
    title: 'Geciken teslim',
    priority: 'normal',
    due_date: '2026-07-13',
    scheduled_at: null,
    scheduled_ends_at: null,
    engagement_kind: null,
    created_at: new Date('2026-07-01T08:00:00.000Z'),
    updated_at: new Date('2026-07-14T11:00:00.000Z'),
    staff_completed_at: null,
    customer_id: null,
    customer_name: null,
    contact_id: null,
    contact_name: null,
    assignee_id: 'staff-1',
    assignee_name: 'Ayşe Personel',
    delivery_item_count: 0,
    source_job_card_id: null,
    ...overrides,
  };
}

async function listOverdue(itemRows: unknown[] = [], total = 0) {
  const { pool, calls } = poolDouble(itemRows, total);
  const page = await new PostgresJobCardRepository(pool as never).listJobCards(
    { organizationId: 'org-1', assignedTo: null },
    { ...baseQuery, overdue: true },
    requestTime,
  );
  return { page, calls };
}

describe('OVR-1 current overdue lateness', () => {
  it('keeps the shipped V1 membership predicate on the overdue list', async () => {
    const { calls } = await listOverdue();
    for (const { sql } of calls) {
      expect(sql).toContain('JOIN organizations o ON o.id = j.organization_id');
      expect(sql).toContain('j.due_date IS NOT NULL');
      expect(sql).toContain('j.due_date < ($3::timestamptz AT TIME ZONE o.timezone)::date');
      expect(sql).not.toMatch(/NOW\(\)/i);
    }
    expect(calls[0]!.values).toEqual([
      'org-1',
      ['NEW', 'ACCEPTED', 'IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED'],
      requestTime,
    ]);
  });

  it('projects the derived overdue instant and lateness in the overdue list', async () => {
    const { calls } = await listOverdue();
    const itemSql = calls[1]!.sql;
    expect(itemSql).toContain(
      '((j.due_date + 1)::timestamp AT TIME ZONE o.timezone) AS overdue_since',
    );
    expect(itemSql).toContain(
      'GREATEST(FLOOR(EXTRACT(EPOCH FROM ($3::timestamptz '
      + '- ((j.due_date + 1)::timestamp AT TIME ZONE o.timezone))))::int, 0) AS lateness_seconds',
    );
    // The count query carries the same membership clause and no derived columns.
    expect(calls[0]!.sql).not.toContain('overdue_since');
  });

  it('orders the overdue view longest-overdue first with a deterministic tie-break', async () => {
    const { calls } = await listOverdue();
    expect(calls[1]!.sql).toContain('ORDER BY overdue_since ASC, j.id ASC');
    expect(calls[1]!.sql).not.toContain('ORDER BY j.updated_at DESC');
  });

  it('leaves the default and approval list ordering untouched', async () => {
    const standard = poolDouble();
    await new PostgresJobCardRepository(standard.pool as never).listJobCards(
      { organizationId: 'org-1', assignedTo: null }, baseQuery, requestTime,
    );
    expect(standard.calls[1]!.sql).toContain('ORDER BY j.updated_at DESC, j.id DESC');
    expect(standard.calls[1]!.sql).not.toContain('overdue_since');

    const approval = poolDouble();
    await new PostgresJobCardRepository(approval.pool as never).listJobCards(
      { organizationId: 'org-1', assignedTo: null },
      { ...baseQuery, status: 'WAITING_APPROVAL' },
      requestTime,
    );
    expect(approval.calls[1]!.sql).toContain('ORDER BY j.staff_completed_at ASC, j.id ASC');
    expect(approval.calls[1]!.sql).not.toContain('overdue_since');
  });

  it('maps the derived snapshot onto the overdue list item', async () => {
    const { page } = await listOverdue([listRow({
      overdue_since: new Date('2026-07-13T21:00:00.000Z'),
      lateness_seconds: 54_000,
    })], 1);
    expect(page.items[0]).toMatchObject({
      id: 'job-1',
      dueDate: '2026-07-13',
      overdueSince: '2026-07-13T21:00:00.000Z',
      latenessSeconds: 54_000,
    });
  });

  it('omits the derived snapshot from every non-overdue list surface', async () => {
    const { pool } = poolDouble([listRow()], 1);
    const page = await new PostgresJobCardRepository(pool as never).listJobCards(
      { organizationId: 'org-1', assignedTo: null }, baseQuery, requestTime,
    );
    expect(page.items[0]).not.toHaveProperty('overdueSince');
    expect(page.items[0]).not.toHaveProperty('latenessSeconds');
  });

  it('does not add a lifecycle status for overdue', async () => {
    const { calls } = await listOverdue();
    expect(calls[1]!.sql).not.toMatch(/'OVERDUE'/);
  });
});
