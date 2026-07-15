import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { PostgresReportsRepository } from '../src/modules/reports/repository.js';

const ORG_ONE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const STAFF_ONE = '11111111-1111-4111-8111-111111111111';
const PRODUCT_ONE = '44444444-4444-4444-8444-444444444444';
const range = { from: '2026-07-01', to: '2026-07-31' } as const;
const resolvedRange = {
  from: '2026-07-01',
  to: '2026-07-31',
  timezone: 'Europe/Istanbul',
} as const;
const requestTime = new Date('2026-07-14T09:00:00.000Z');

type RecordedQuery = { text: string; values: unknown[] };

function reportingPool(pageRows: unknown[], total = pageRows.length) {
  const calls: RecordedQuery[] = [];
  const query = vi.fn(async (text: string, values: unknown[] = []) => {
    calls.push({ text, values });
    if (text.includes('AS "from"')) {
      return { rows: [resolvedRange], rowCount: 1 };
    }
    if (text.startsWith('SELECT COUNT(*)')) {
      return { rows: [{ total }], rowCount: 1 };
    }
    return { rows: pageRows, rowCount: pageRows.length };
  });
  return { calls, query, pool: { query } as never };
}

function groupedSqlFromCount(sql: string) {
  const prefix = 'SELECT COUNT(*)::int AS total FROM (';
  const suffix = ') grouped';
  expect(sql.startsWith(prefix)).toBe(true);
  expect(sql.endsWith(suffix)).toBe(true);
  return sql.slice(prefix.length, -suffix.length);
}

function groupedSqlFromPage(sql: string) {
  const orderIndex = sql.lastIndexOf('\nORDER BY ');
  expect(orderIndex).toBeGreaterThan(0);
  return sql.slice(0, orderIndex);
}

function expectCanonicalDeliverySql(calls: RecordedQuery[]) {
  expect(calls).toHaveLength(3);
  const countSql = calls[1]?.text ?? '';
  const pageSql = calls[2]?.text ?? '';
  const groupedSql = groupedSqlFromCount(countSql);

  expect(groupedSqlFromPage(pageSql)).toBe(groupedSql);
  expect(groupedSql).toContain("jc.type = 'PRODUCT_DELIVERY'");
  expect(groupedSql).toContain("jc.status = 'COMPLETED'");
  expect(groupedSql).toContain('jc.manager_approved_at IS NOT NULL');
  expect(groupedSql).toContain('di.delivered_at >=');
  expect(groupedSql).toContain('di.delivered_at <');
  expect(groupedSql).toContain('AT TIME ZONE organization_range.timezone');
  expect(groupedSql).not.toMatch(/(?:lower|upper|trim)\s*\(/i);
  expect(groupedSql).not.toMatch(/coalesce\s*\(\s*(?:di\.)?unit/i);
  expect(pageSql).not.toMatch(/\$(?:limit|offset)/i);
}

function input(groupBy: 'day' | 'purpose' | 'product' | 'staff') {
  return {
    organizationId: ORG_ONE,
    requestedRange: range,
    requestTime,
    groupBy,
    staffUserId: null,
    limit: 50,
    offset: 0,
  } as const;
}

describe('PostgresReportsRepository grouped delivery reports', () => {
  it('returns day groups with exact quantities and canonical group totals', async () => {
    const { pool, calls } = reportingPool([
      { date: '2026-07-14', unit: null, quantity: '0.500' },
    ], 7);
    const repository = new PostgresReportsRepository(pool);

    const result = await repository.getDeliveryReport(input('day'));

    expect(result).toEqual({
      groupBy: 'day',
      range: resolvedRange,
      items: [{ date: '2026-07-14', unit: null, quantity: '0.500' }],
      total: 7,
      limit: 50,
      offset: 0,
    });
    expect(result.items[0]).not.toHaveProperty('purpose');
    expectCanonicalDeliverySql(calls);
    expect(calls[2]?.text).toContain('date DESC');
  });

  it('keeps delivery purpose quantities unchanged when General Tasks exist', async () => {
    const rows = [
      { delivery_purpose: 'SALE', unit: 'Kutu', quantity: '3.000' },
      { delivery_purpose: 'SALE', unit: 'kutu', quantity: '12.500' },
      { delivery_purpose: 'SALE', unit: null, quantity: '0.500' },
    ];
    const { pool, calls } = reportingPool(rows);
    const repository = new PostgresReportsRepository(pool);

    const result = await repository.getDeliveryReport(input('purpose'));

    expect(result).toEqual({
      groupBy: 'purpose',
      range: resolvedRange,
      items: [
        { purpose: 'SALE', unit: 'Kutu', quantity: '3.000' },
        { purpose: 'SALE', unit: 'kutu', quantity: '12.500' },
        { purpose: 'SALE', unit: null, quantity: '0.500' },
      ],
      total: 3,
      limit: 50,
      offset: 0,
    });
    expect(result.items[0]).not.toHaveProperty('date');
    expect(result.items.map((item) => item.quantity)).toEqual(['3.000', '12.500', '0.500']);
    expectCanonicalDeliverySql(calls);
    expect(calls[2]?.text).toContain("WHEN 'SALE' THEN 1");
    expect(calls[2]?.text).toContain("WHEN 'OTHER' THEN 5");
    expect(calls[2]?.text).toContain('di.unit COLLATE "C" ASC NULLS LAST');
  });

  it('uses persisted product snapshots without joining the mutable catalog', async () => {
    const { pool, calls } = reportingPool([{
      product_id: PRODUCT_ONE,
      product_name_snapshot: 'Eski Ürün Adı',
      product_sku_snapshot: 'SKU-OLD',
      product_model_snapshot: null,
      unit: 'Kutu',
      quantity: '3.000',
    }]);
    const repository = new PostgresReportsRepository(pool);

    const result = await repository.getDeliveryReport(input('product'));

    expect(result).toEqual({
      groupBy: 'product',
      range: resolvedRange,
      items: [{
        productId: PRODUCT_ONE,
        productNameSnapshot: 'Eski Ürün Adı',
        productSkuSnapshot: 'SKU-OLD',
        productModelSnapshot: null,
        unit: 'Kutu',
        quantity: '3.000',
      }],
      total: 1,
      limit: 50,
      offset: 0,
    });
    expect(result.items[0]).not.toHaveProperty('staff');
    expectCanonicalDeliverySql(calls);
    const groupedSql = groupedSqlFromCount(calls[1]?.text ?? '');
    expect(groupedSql).toContain('di.product_name_snapshot');
    expect(groupedSql).toContain('di.product_sku_snapshot');
    expect(groupedSql).toContain('di.product_model_snapshot');
    expect(groupedSql).not.toMatch(/JOIN products/i);
  });

  it('attributes staff groups through assigned_to and keeps inactive Staff visible', async () => {
    const { pool, calls } = reportingPool([{
      staff_user_id: STAFF_ONE,
      staff_name: 'Eski Personel',
      is_active: false,
      unit: null,
      quantity: '12.500',
    }]);
    const repository = new PostgresReportsRepository(pool);

    const result = await repository.getDeliveryReport(input('staff'));

    expect(result).toEqual({
      groupBy: 'staff',
      range: resolvedRange,
      items: [{
        staff: { userId: STAFF_ONE, name: 'Eski Personel', isActive: false },
        unit: null,
        quantity: '12.500',
      }],
      total: 1,
      limit: 50,
      offset: 0,
    });
    expect(result.items[0]).not.toHaveProperty('productId');
    expectCanonicalDeliverySql(calls);
    const groupedSql = groupedSqlFromCount(calls[1]?.text ?? '');
    expect(groupedSql).toContain('u.id = jc.assigned_to');
    expect(groupedSql).toContain("u.role = 'STAFF'");
    expect(groupedSql).toMatch(/JOIN staff_profiles sp/i);
    expect(groupedSql).not.toMatch(/u\.is_active\s*=/i);
  });

  it('applies the optional Staff filter and positional pagination parameters', async () => {
    const { pool, calls } = reportingPool([]);
    const repository = new PostgresReportsRepository(pool);

    await repository.getDeliveryReport({
      ...input('purpose'),
      staffUserId: STAFF_ONE,
      limit: 25,
      offset: 50,
    });

    expect(calls[0]?.values).toEqual([ORG_ONE, range.from, range.to, requestTime]);
    expect(calls[1]?.values).toEqual([
      ORG_ONE, range.from, range.to, requestTime, STAFF_ONE,
    ]);
    expect(calls[2]?.values).toEqual([
      ORG_ONE, range.from, range.to, requestTime, STAFF_ONE, 25, 50,
    ]);
    expect(calls[1]?.text).toContain('jc.assigned_to = $5');
    expect(calls[2]?.text).toContain('LIMIT $6');
    expect(calls[2]?.text).toContain('OFFSET $7');
    expectCanonicalDeliverySql(calls);
  });

  it('resolves range independently when canonical grouped rows are empty', async () => {
    const { pool, calls } = reportingPool([], 0);
    const repository = new PostgresReportsRepository(pool);

    await expect(repository.getDeliveryReport({
      ...input('day'),
      limit: 20,
      offset: 40,
    })).resolves.toEqual({
      groupBy: 'day',
      range: resolvedRange,
      items: [],
      total: 0,
      limit: 20,
      offset: 40,
    });

    expect(calls[0]?.text).toContain("to_char(from_date, 'YYYY-MM-DD')");
    expect(calls[0]?.text).toContain("to_char(to_date, 'YYYY-MM-DD')");
    expect(calls[1]?.values).toEqual([ORG_ONE, range.from, range.to, requestTime]);
    expect(calls[2]?.values).toEqual([ORG_ONE, range.from, range.to, requestTime, 20, 40]);
    expect(calls[2]?.text).toContain('LIMIT $5');
    expect(calls[2]?.text).toContain('OFFSET $6');
  });

  it('does not parse or recompute grouped quantity strings in application code', () => {
    const source = readFileSync(
      new URL('../src/modules/reports/repository.ts', import.meta.url),
      'utf8',
    );
    const method = source.slice(source.indexOf('async getDeliveryReport'));

    expect(method).not.toMatch(/(?:Number|parseFloat)\s*\([^)]*quantity/i);
  });
});
