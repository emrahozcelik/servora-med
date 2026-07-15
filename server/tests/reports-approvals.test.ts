import { describe, expect, it, vi } from 'vitest';

import { PostgresReportsRepository } from '../src/modules/reports/repository.js';

const ORG_ONE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const requestTime = new Date('2026-07-14T12:00:00.000Z');

type ApprovalSummaryRow = {
  pending_count: string | number;
  oldest_waiting_minutes: string | number | null;
  average_waiting_minutes: string | number | null;
  under_2_hours: string | number;
  between_2_and_8_hours: string | number;
  between_8_and_24_hours: string | number;
  over_24_hours: string | number;
};

function recordingPool(row: ApprovalSummaryRow) {
  const query = vi.fn(async (text: string, values: unknown[] = []) => ({
    rows: [row],
    rowCount: 1,
    text,
    values,
  }));
  return { query, pool: { query } as never };
}

describe('PostgresReportsRepository approval age summary', () => {
  it('includes the named waiting General Task across the whole approval queue', async () => {
    const total = 8;
    const { pool, query } = recordingPool({
      pending_count: String(total),
      oldest_waiting_minutes: '1440',
      // Includes the named waiting General Task at 60 completed whole minutes.
      average_waiting_minutes: '517',
      under_2_hours: '3',
      between_2_and_8_hours: '2',
      between_8_and_24_hours: '2',
      over_24_hours: '1',
    });
    const repository = new PostgresReportsRepository(pool);

    const summary = await repository.getApprovalSummary({
      organizationId: ORG_ONE,
      requestTime,
    });

    expect(summary).toEqual({
      pendingCount: 8,
      oldestWaitingMinutes: 1440,
      averageWaitingMinutes: 517,
      under2Hours: 3,
      between2And8Hours: 2,
      between8And24Hours: 2,
      over24Hours: 1,
    });
    expect(summary.pendingCount).toBe(total);
    expect(summary.pendingCount).toBe(
      summary.under2Hours + summary.between2And8Hours
      + summary.between8And24Hours + summary.over24Hours,
    );
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[1]).toEqual([ORG_ONE, requestTime]);

    const sql = query.mock.calls[0]?.[0] ?? '';
    expect(sql).toContain(
      "GREATEST($2::timestamptz - j.staff_completed_at,\n    interval '0 seconds')",
    );
    expect(sql).toContain("j.status = 'WAITING_APPROVAL'");
    expect(sql).toContain("elapsed < interval '2 hours'");
    expect(sql).toContain("elapsed >= interval '2 hours'");
    expect(sql).toContain("elapsed < interval '8 hours'");
    expect(sql).toContain("elapsed >= interval '8 hours'");
    expect(sql).toContain("elapsed < interval '24 hours'");
    expect(sql).toContain("elapsed >= interval '24 hours'");
    expect(sql).toContain('FLOOR(EXTRACT(EPOCH FROM MAX(elapsed)) / 60)');
    expect(sql).toContain('ROUND(AVG(EXTRACT(EPOCH FROM elapsed)) / 60)');
    expect(sql).not.toMatch(/LIMIT|OFFSET/i);
    expect(sql).not.toMatch(/j\.type\s*=|j\.assigned_to\s*=/i);
  });

  it('puts a future completion timestamp in the under-two-hours bucket at zero age', async () => {
    const { pool } = recordingPool({
      pending_count: 1,
      oldest_waiting_minutes: 0,
      average_waiting_minutes: 0,
      under_2_hours: 1,
      between_2_and_8_hours: 0,
      between_8_and_24_hours: 0,
      over_24_hours: 0,
    });
    const repository = new PostgresReportsRepository(pool);

    const summary = await repository.getApprovalSummary({
      organizationId: ORG_ONE,
      requestTime,
    });

    expect(summary.oldestWaitingMinutes).toBe(0);
    expect(summary.averageWaitingMinutes).toBe(0);
    expect(summary.under2Hours).toBe(1);
    expect(summary.pendingCount).toBe(
      summary.under2Hours + summary.between2And8Hours
      + summary.between8And24Hours + summary.over24Hours,
    );
  });

  it('maps an empty queue to zero buckets and null age aggregates', async () => {
    const { pool } = recordingPool({
      pending_count: '0',
      oldest_waiting_minutes: null,
      average_waiting_minutes: null,
      under_2_hours: '0',
      between_2_and_8_hours: '0',
      between_8_and_24_hours: '0',
      over_24_hours: '0',
    });
    const repository = new PostgresReportsRepository(pool);

    await expect(repository.getApprovalSummary({
      organizationId: ORG_ONE,
      requestTime,
    })).resolves.toEqual({
      pendingCount: 0,
      oldestWaitingMinutes: null,
      averageWaitingMinutes: null,
      under2Hours: 0,
      between2And8Hours: 0,
      between8And24Hours: 0,
      over24Hours: 0,
    });
  });
});
