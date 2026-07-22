import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import type { JobCardListQuery } from '../src/modules/job-cards/types.js';
import type { ApprovalQueueItemPort } from '../src/modules/reports/ports.js';

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
  limit: 25,
  offset: 0,
};

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

describe('PostgresJobCardRepository workspace list', () => {
  it('applies organization, Staff scope, every filter, escaped search, and inclusive due bounds', async () => {
    const { pool, calls } = poolDouble();
    const repository = new PostgresJobCardRepository(pool as never);

    await repository.listJobCards(
      { organizationId: 'org-1', assignedTo: 'staff-1' },
      {
        ...baseQuery,
        q: String.raw`50%_\implant`,
        assignedTo: 'staff-1',
        type: 'PRODUCT_DELIVERY',
        customerId: 'customer-1',
        priority: 'urgent',
        dueAfter: '2026-07-01',
        dueBefore: '2026-07-31',
        limit: 10,
        offset: 20,
      },
    );

    expect(calls).toHaveLength(2);
    for (const { sql } of calls) {
      expect(sql).toContain('j.organization_id = $1');
      expect(sql.match(/j\.assigned_to = \$\d+/g)).toHaveLength(2);
      expect(sql).toContain('j.type = $4');
      expect(sql).toContain('j.customer_id = $5');
      expect(sql).toContain('j.priority = $6');
      expect(sql).toContain('j.due_date >= $7::date');
      expect(sql).toContain('j.due_date <= $8::date');
      expect(sql).toContain('j.status = ANY($9::varchar[])');
      expect(sql).toContain("j.title ILIKE $10 ESCAPE '\\'");
      expect(sql).toContain("c.name ILIKE $10 ESCAPE '\\'");
      expect(sql).toContain("ct.name ILIKE $10 ESCAPE '\\'");
      expect(sql).not.toMatch(/description|note|snapshot/i);
    }
    expect(calls[0]!.values).toEqual([
      'org-1', 'staff-1', 'staff-1', 'PRODUCT_DELIVERY', 'customer-1', 'urgent',
      '2026-07-01', '2026-07-31',
      ['NEW', 'ACCEPTED', 'IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED'],
      String.raw`%50\%\_\\implant%`,
    ]);
    expect(calls[1]!.values).toEqual([...calls[0]!.values, 10, 20]);
  });

  it.each([
    ['active', ['NEW', 'ACCEPTED', 'IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED']],
    ['closed', ['COMPLETED', 'CANCELLED']],
    ['NEW', ['NEW']],
  ] as const)('expands %s status exactly', async (status, expected) => {
    const { pool, calls } = poolDouble();
    await new PostgresJobCardRepository(pool as never).listJobCards(
      { organizationId: 'org-1', assignedTo: null },
      { ...baseQuery, status },
    );
    expect(calls[0]!.values).toContainEqual(expected);
  });

  it('adds no status predicate for all', async () => {
    const { pool, calls } = poolDouble();
    await new PostgresJobCardRepository(pool as never).listJobCards(
      { organizationId: 'org-1', assignedTo: null },
      { ...baseQuery, status: 'all' },
    );
    expect(calls[0]!.sql).not.toContain('j.status = ANY');
    expect(calls[0]!.values).toEqual(['org-1']);
  });

  it('uses the optional Manager assignee filter without adding a Staff scope', async () => {
    const { pool, calls } = poolDouble();
    await new PostgresJobCardRepository(pool as never).listJobCards(
      { organizationId: 'org-1', assignedTo: null },
      { ...baseQuery, assignedTo: 'staff-2', status: 'all' },
    );
    expect(calls[0]!.sql.match(/j\.assigned_to = \$\d+/g)).toHaveLength(1);
    expect(calls[0]!.values).toEqual(['org-1', 'staff-2']);
  });

  it('parameterizes a General Task type filter and maps zero delivery items', async () => {
    const createdAt = new Date('2026-07-15T08:00:00.000Z');
    const { pool, calls } = poolDouble([{
      id: 'job-general', type: 'GENERAL_TASK', status: 'NEW', version: 1,
      title: 'Doktoru ara', priority: 'normal', due_date: null, scheduled_at: null,
      engagement_kind: null,
      created_at: createdAt, updated_at: createdAt, staff_completed_at: null,
      customer_id: null, customer_name: null, contact_id: null, contact_name: null,
      assignee_id: 'staff-1', assignee_name: 'Ayşe Personel', delivery_item_count: 0,
    }], 1);

    const result = await new PostgresJobCardRepository(pool as never).listJobCards(
      { organizationId: 'org-1', assignedTo: null },
      { ...baseQuery, type: 'GENERAL_TASK' },
    );

    expect(calls[0]!.sql).toContain('j.type = $2');
    expect(calls[0]!.values).toContain('GENERAL_TASK');
    expect(result.items[0]).toMatchObject({
      id: 'job-general', type: 'GENERAL_TASK', customer: null, contact: null,
      deliveryItemCount: 0, scheduledAt: null,
    });
  });

  it('parameterizes a Sales Meeting filter without joining structured details', async () => {
    const createdAt = new Date('2026-07-15T08:00:00.000Z');
    const scheduledAt = new Date('2026-07-20T10:00:00.000Z');
    const { pool, calls } = poolDouble([{
      id: 'job-meeting', type: 'SALES_MEETING', status: 'ACCEPTED', version: 2,
      title: 'Kontrol görüşmesi', priority: 'normal', due_date: '2026-07-20',
      scheduled_at: scheduledAt,
      engagement_kind: 'SALES_MEETING',
      created_at: createdAt, updated_at: createdAt, staff_completed_at: null,
      customer_id: 'customer-1', customer_name: 'ABC Klinik',
      contact_id: null, contact_name: null,
      assignee_id: 'staff-1', assignee_name: 'Ayşe Personel', delivery_item_count: 0,
    }], 1);

    const result = await new PostgresJobCardRepository(pool as never).listJobCards(
      { organizationId: 'org-1', assignedTo: null },
      { ...baseQuery, type: 'SALES_MEETING' },
    );

    expect(calls[0]!.values).toContain('SALES_MEETING');
    expect(calls[1]!.sql).toContain('j.scheduled_at');
    expect(calls[1]!.sql).not.toContain('job_card_meeting_details');
    expect(result.items[0]).toMatchObject({
      id: 'job-meeting', type: 'SALES_MEETING', deliveryItemCount: 0,
      customer: { id: 'customer-1', name: 'ABC Klinik' },
      scheduledAt: scheduledAt.toISOString(),
    });
  });

  it('projects related names and delivery item count without summing mixed quantities', async () => {
    const createdAt = new Date('2026-07-13T08:00:00.000Z');
    const updatedAt = new Date('2026-07-13T09:00:00.000Z');
    const staffCompletedAt = new Date('2026-07-13T10:00:00.000Z');
    const scheduledAt = new Date('2026-07-20T09:00:00.000Z');
    const { pool, calls } = poolDouble([{
      id: 'job-1',
      type: 'PRODUCT_DELIVERY',
      status: 'WAITING_APPROVAL',
      version: 3,
      title: 'Klinik teslimi',
      priority: 'high',
      due_date: '2026-07-20',
      scheduled_at: scheduledAt,
      engagement_kind: null,
      created_at: createdAt,
      updated_at: updatedAt,
      staff_completed_at: staffCompletedAt,
      customer_id: 'customer-1',
      customer_name: 'ABC Klinik',
      contact_id: 'contact-1',
      contact_name: 'Dr. Deniz',
      assignee_id: 'staff-1',
      assignee_name: 'Ayşe Personel',
      delivery_item_count: 2,
    }], 7);

    const page = await new PostgresJobCardRepository(pool as never).listJobCards(
      { organizationId: 'org-1', assignedTo: null },
      { ...baseQuery, limit: 1, offset: 4 },
    );

    expect(page).toEqual({
      items: [{
        id: 'job-1', type: 'PRODUCT_DELIVERY', status: 'WAITING_APPROVAL', version: 3,
        title: 'Klinik teslimi', priority: 'high', dueDate: '2026-07-20',
        scheduledAt: scheduledAt.toISOString(), engagementKind: null,
        createdAt: createdAt.toISOString(), updatedAt: updatedAt.toISOString(),
        staffCompletedAt: staffCompletedAt.toISOString(),
        customer: { id: 'customer-1', name: 'ABC Klinik' },
        contact: { id: 'contact-1', name: 'Dr. Deniz' },
        assignee: { id: 'staff-1', name: 'Ayşe Personel' }, deliveryItemCount: 2,
      }],
      total: 7,
      limit: 1,
      offset: 4,
    });
    expect(calls[1]!.sql).toContain('COUNT(*)');
    expect(calls[1]!.sql).not.toContain('SUM(');
    expect(calls[0]!.values).not.toContain(1);
    expect(calls[0]!.values).not.toContain(4);
  });

  it('uses deterministic default and exact approval ordering', async () => {
    const standard = poolDouble();
    await new PostgresJobCardRepository(standard.pool as never).listJobCards(
      { organizationId: 'org-1', assignedTo: null }, baseQuery,
    );
    expect(standard.calls[1]!.sql).toContain('ORDER BY j.updated_at DESC, j.id DESC');

    const approval = poolDouble();
    await new PostgresJobCardRepository(approval.pool as never).listJobCards(
      { organizationId: 'org-1', assignedTo: null },
      { ...baseQuery, status: 'WAITING_APPROVAL' },
    );
    expect(approval.calls[1]!.sql).toContain('ORDER BY j.staff_completed_at ASC, j.id ASC');
  });

  it('reuses the canonical JobCard projection for deterministic approval pages', async () => {
    const createdAt = new Date('2026-07-13T08:00:00.000Z');
    const updatedAt = new Date('2026-07-13T09:00:00.000Z');
    const staffCompletedAt = new Date('2026-07-13T10:00:00.000Z');
    const rows = [
      {
        id: 'job-delivery',
        type: 'PRODUCT_DELIVERY',
        status: 'WAITING_APPROVAL',
        version: 3,
        title: 'Klinik teslimi',
        priority: 'high',
        due_date: '2026-07-20',
        scheduled_at: null,
        engagement_kind: null,
        created_at: createdAt,
        updated_at: updatedAt,
        staff_completed_at: staffCompletedAt,
        customer_id: 'customer-1',
        customer_name: 'ABC Klinik',
        contact_id: 'contact-1',
        contact_name: 'Dr. Deniz',
        assignee_id: 'staff-1',
        assignee_name: 'Ayşe Personel',
        delivery_item_count: 2,
        waiting_minutes: 119,
      },
      {
        id: 'job-general',
        type: 'GENERAL_TASK',
        status: 'WAITING_APPROVAL',
        version: 1,
        title: 'Genel görev',
        priority: 'normal',
        due_date: null,
        scheduled_at: null,
        engagement_kind: null,
        created_at: createdAt,
        updated_at: updatedAt,
        staff_completed_at: new Date('2026-07-14T12:01:00.000Z'),
        customer_id: null,
        customer_name: null,
        contact_id: null,
        contact_name: null,
        assignee_id: 'staff-2',
        assignee_name: 'Gelecek Personel',
        delivery_item_count: 0,
        waiting_minutes: 0,
      },
    ];
    const { pool, calls } = poolDouble(rows);
    const repository = new PostgresJobCardRepository(pool as never);
    const approvalItems: ApprovalQueueItemPort = repository;
    const approvalRequestTime = new Date('2026-07-14T12:00:00.000Z');

    const firstPage = await approvalItems.getApprovalItems({
      organizationId: 'org-1',
      requestTime: approvalRequestTime,
      limit: 2,
      offset: 0,
    });
    await approvalItems.getApprovalItems({
      organizationId: 'org-1',
      requestTime: approvalRequestTime,
      limit: 2,
      offset: 2,
    });

    expect(firstPage).toEqual([
      {
        id: 'job-delivery', type: 'PRODUCT_DELIVERY', status: 'WAITING_APPROVAL',
        version: 3, title: 'Klinik teslimi', priority: 'high', dueDate: '2026-07-20',
        scheduledAt: null, engagementKind: null,
        createdAt: createdAt.toISOString(), updatedAt: updatedAt.toISOString(),
        staffCompletedAt: staffCompletedAt.toISOString(),
        customer: { id: 'customer-1', name: 'ABC Klinik' },
        contact: { id: 'contact-1', name: 'Dr. Deniz' },
        assignee: { id: 'staff-1', name: 'Ayşe Personel' },
        deliveryItemCount: 2, waitingMinutes: 119,
      },
      {
        id: 'job-general', type: 'GENERAL_TASK', status: 'WAITING_APPROVAL',
        version: 1, title: 'Genel görev', priority: 'normal', dueDate: null,
        scheduledAt: null, engagementKind: null,
        createdAt: createdAt.toISOString(), updatedAt: updatedAt.toISOString(),
        staffCompletedAt: '2026-07-14T12:01:00.000Z', customer: null, contact: null,
        assignee: { id: 'staff-2', name: 'Gelecek Personel' },
        deliveryItemCount: 0, waitingMinutes: 0,
      },
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.values).toEqual(['org-1', approvalRequestTime, 2, 0]);
    expect(calls[1]!.values).toEqual(['org-1', approvalRequestTime, 2, 2]);
    for (const { sql } of calls) {
      expect(sql).toContain("GREATEST(\n         $2::timestamptz - j.staff_completed_at,\n         interval '0 seconds')");
      expect(sql).toContain("j.status = 'WAITING_APPROVAL'");
      expect(sql).toContain('ORDER BY j.staff_completed_at ASC, j.id ASC');
      expect(sql).toContain('LIMIT $3 OFFSET $4');
      expect(sql).not.toMatch(/j\.type\s*=|j\.assigned_to\s*=/i);
    }

    const source = readFileSync(
      new URL('../src/modules/job-cards/repository.ts', import.meta.url),
      'utf8',
    );
    const method = source.slice(
      source.indexOf('async getApprovalItems'),
      source.indexOf('async listJobCards'),
    );
    expect(method).toContain('SELECT ${JOB_CARD_LIST_COLUMNS}');
    expect(method).toContain('${WORKSPACE_ITEM_JOINS}');
    expect(method).toContain('...mapJobCardListItem(row)');
    expect(method).toContain('waitingMinutes: Number(row.waiting_minutes)');
  });
});
