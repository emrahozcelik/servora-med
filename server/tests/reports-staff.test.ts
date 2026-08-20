import { describe, expect, it, vi } from 'vitest';

import { PostgresReportsRepository } from '../src/modules/reports/repository.js';

const ORG_ONE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const STAFF_ONE = '11111111-1111-4111-8111-111111111111';
const INACTIVE_STAFF = '22222222-2222-4222-8222-222222222222';
const HIDDEN_USER = '33333333-3333-4333-8333-333333333333';
const requestTime = new Date('2026-07-14T09:00:00.000Z');
const staffCreatedAt = new Date('2025-01-01T00:00:00.000Z');

type QueryResult = { rows: unknown[] };

function queuedPool(results: QueryResult[]) {
  const query = vi.fn(async () => {
    const result = results.shift();
    if (!result) throw new Error('Unexpected query');
    return { ...result, rowCount: result.rows.length };
  });
  return { query, pool: { query } as never };
}

describe('PostgresReportsRepository Staff report reads', () => {
  it.each([
    {
      label: 'active',
      staffUserId: STAFF_ONE,
      row: { id: STAFF_ONE, name: 'Aktif Personel', is_active: true,
        created_at: staffCreatedAt },
      expected: { userId: STAFF_ONE, name: 'Aktif Personel', isActive: true,
        createdAt: staffCreatedAt.toISOString() },
    },
    {
      label: 'inactive',
      staffUserId: INACTIVE_STAFF,
      row: { id: INACTIVE_STAFF, name: 'Eski Personel', is_active: false,
        created_at: staffCreatedAt },
      expected: { userId: INACTIVE_STAFF, name: 'Eski Personel', isActive: false,
        createdAt: staffCreatedAt.toISOString() },
    },
  ])('returns a concealed $label same-organization Staff identity', async ({
    staffUserId,
    row,
    expected,
  }) => {
    const { pool, query } = queuedPool([{ rows: [row] }]);
    const repository = new PostgresReportsRepository(pool);

    await expect(repository.getStaffIdentity({
      organizationId: ORG_ONE,
      staffUserId,
    })).resolves.toEqual(expected);

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[1]).toEqual([ORG_ONE, staffUserId]);
    const sql = query.mock.calls[0]?.[0] ?? '';
    expect(sql).toContain('u.organization_id = $1');
    expect(sql).toContain('u.id = $2');
    expect(sql).toContain("u.role = 'STAFF'");
    expect(sql).toMatch(/JOIN staff_profiles sp/i);
    expect(sql).not.toMatch(/u\.is_active\s*=/i);
  });

  it('conceals missing, cross-organization, and non-Staff identities as null', async () => {
    const { pool, query } = queuedPool([
      { rows: [] },
      { rows: [] },
      { rows: [] },
    ]);
    const repository = new PostgresReportsRepository(pool);

    await expect(repository.getStaffIdentity({
      organizationId: ORG_ONE,
      staffUserId: HIDDEN_USER,
    })).resolves.toBeNull();
    await expect(repository.getStaffIdentity({
      organizationId: ORG_ONE,
      staffUserId: HIDDEN_USER,
    })).resolves.toBeNull();
    await expect(repository.getStaffIdentity({
      organizationId: ORG_ONE,
      staffUserId: HIDDEN_USER,
    })).resolves.toBeNull();

    expect(query).toHaveBeenCalledTimes(3);
  });

  it('keeps all Staff counters assigned_to-owned and JobCard-type agnostic', async () => {
    const { pool, query } = queuedPool([{ rows: [{
      staff_user_id: STAFF_ONE,
      from_date: '2026-07-01',
      to_date: '2026-07-31',
      timezone: 'Europe/Istanbul',
      open_job_cards: '2',
      waiting_approval: '3',
      revision_requested: '4',
      overdue_job_cards: '5',
      completed_in_period: '6',
    }] }]);
    const repository = new PostgresReportsRepository(pool);

    await expect(repository.getOne({
      organizationId: ORG_ONE,
      staffUserId: STAFF_ONE,
      requestedRange: null,
      requestTime,
    })).resolves.toMatchObject({
      counters: {
        openJobCards: 2,
        waitingApproval: 3,
        revisionRequested: 4,
        overdueJobCards: 5,
        completedInPeriod: 6,
      },
    });

    const sql = query.mock.calls[0]?.[0] ?? '';
    expect(sql).toContain('jc.assigned_to = requested.staff_user_id');
    expect(sql).not.toMatch(/staff_completed_by|created_by|manager_approved_by/i);
    expect(sql).not.toMatch(/job_card_activities|activity/i);
    expect(sql).not.toMatch(/jc\.type\s*=/i);
    expect(sql).toContain('jc.due_date IS NOT NULL');
    expect(sql).toContain(
      'jc.due_date < ($4::timestamptz AT TIME ZONE organization_range.timezone)::date',
    );
    expect(sql).not.toMatch(/scheduled_at/i);
  });

  it('returns canonical current workload type buckets as a range-independent snapshot', async () => {
    const { pool } = queuedPool([{ rows: [{
      staff_user_id: STAFF_ONE,
      from_date: '2026-07-01',
      to_date: '2026-07-31',
      timezone: 'Europe/Istanbul',
      open_job_cards: '3',
      waiting_approval: '1',
      revision_requested: '1',
      overdue_job_cards: '0',
      completed_in_period: '4',
      current_workload_by_type: [
        { type: 'PRODUCT_DELIVERY', count: 2 },
        { type: 'GENERAL_TASK', count: 1 },
        { type: 'SALES_MEETING', count: 2 },
      ],
    }] }]);
    const repository = new PostgresReportsRepository(pool);

    const result = await repository.getOne({
      organizationId: ORG_ONE,
      staffUserId: STAFF_ONE,
      requestedRange: { from: '2024-01-01', to: '2024-01-01' },
      requestTime,
    });

    expect(result?.currentWorkloadByType).toEqual([
      { type: 'PRODUCT_DELIVERY', count: 2 },
      { type: 'GENERAL_TASK', count: 1 },
      { type: 'SALES_MEETING', count: 2 },
    ]);
  });

  it('returns approved Product Delivery purpose totals as exact decimal strings', async () => {
    const rows = [
      { delivery_purpose: 'SALE', unit: 'Kutu', quantity: '3.000' },
      { delivery_purpose: 'SALE', unit: null, quantity: '0.500' },
      { delivery_purpose: 'RETURN', unit: 'kutu', quantity: '12.500' },
    ];
    const { pool, query } = queuedPool([{ rows }]);
    const repository = new PostgresReportsRepository(pool);

    await expect(repository.getStaffDeliveriesByPurpose({
      organizationId: ORG_ONE,
      staffUserId: STAFF_ONE,
      requestedRange: { from: '2026-07-01', to: '2026-07-31' },
      requestTime,
    })).resolves.toEqual([
      { purpose: 'SALE', unit: 'Kutu', quantity: '3.000' },
      { purpose: 'SALE', unit: null, quantity: '0.500' },
      { purpose: 'RETURN', unit: 'kutu', quantity: '12.500' },
    ]);

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[1]).toEqual([
      ORG_ONE,
      STAFF_ONE,
      '2026-07-01',
      '2026-07-31',
      requestTime,
    ]);
    const sql = query.mock.calls[0]?.[0] ?? '';
    expect(sql).toContain('jc.assigned_to = $2');
    expect(sql).toContain("jc.type = 'PRODUCT_DELIVERY'");
    expect(sql).toContain("jc.status = 'COMPLETED'");
    expect(sql).toContain('jc.manager_approved_at IS NOT NULL');
    expect(sql).toContain('di.delivered_at >=');
    expect(sql).toContain('di.delivered_at <');
    expect(sql).not.toMatch(/manager_approved_at\s*(?:>=|<)/i);
    expect(sql).not.toMatch(/staff_completed_by|created_by|manager_approved_by/i);
    expect(sql).not.toMatch(/job_card_activities|activity/i);
    expect(sql).toContain("WHEN 'SALE' THEN 1");
    expect(sql).toContain("WHEN 'SAMPLE' THEN 2");
    expect(sql).toContain("WHEN 'CONSIGNMENT' THEN 3");
    expect(sql).toContain("WHEN 'RETURN' THEN 4");
    expect(sql).toContain("WHEN 'OTHER' THEN 5");
    expect(sql).toContain('di.unit COLLATE "C" ASC NULLS LAST');
  });
});
