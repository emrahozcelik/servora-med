import { describe, expect, it, vi } from 'vitest';

import { PostgresReportsRepository } from '../src/modules/reports/repository.js';

const ORG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const requestTime = new Date('2026-07-14T09:00:00.000Z');

type DashboardRow = {
  from_date: string;
  to_date: string;
  timezone: string;
  active_job_cards: string | number;
  overdue_job_cards: string | number;
  waiting_approval: string | number;
  revision_requested: string | number;
  completed_in_period: string | number;
  cancelled_in_period: string | number;
  completed_trend: Array<{ date: string; count: string | number }>;
};

function row(overrides: Partial<DashboardRow> = {}): DashboardRow {
  return {
    from_date: '2026-07-01',
    to_date: '2026-07-03',
    timezone: 'Europe/Istanbul',
    active_job_cards: '18',
    overdue_job_cards: '3',
    waiting_approval: '4',
    revision_requested: '2',
    completed_in_period: '3',
    cancelled_in_period: '1',
    completed_trend: [
      { date: '2026-07-01', count: 2 },
      { date: '2026-07-02', count: 0 },
      { date: '2026-07-03', count: 1 },
    ],
    ...overrides,
  };
}

function recordingPool(resolveRow: (values: unknown[]) => DashboardRow = () => row()) {
  const query = vi.fn(async (text: string, values: unknown[] = []) => ({
    rows: [resolveRow(values)],
    rowCount: 1,
    text,
    values,
  }));
  return { query, pool: { query } as never };
}

describe('PostgresReportsRepository dashboard', () => {
  it('maps counters and a complete zero-filled trend from one statement', async () => {
    const { pool, query } = recordingPool();
    const repository = new PostgresReportsRepository(pool);

    const result = await repository.getDashboard({
      organizationId: ORG_ID,
      requestedRange: { from: '2026-07-01', to: '2026-07-03' },
      requestTime,
    });

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[1]).toEqual([
      ORG_ID,
      '2026-07-01',
      '2026-07-03',
      requestTime,
    ]);
    expect(result).toEqual({
      range: { from: '2026-07-01', to: '2026-07-03', timezone: 'Europe/Istanbul' },
      counters: {
        activeJobCards: 18,
        overdueJobCards: 3,
        waitingApproval: 4,
        revisionRequested: 2,
        completedInPeriod: 3,
        cancelledInPeriod: 1,
      },
      completedTrend: [
        { date: '2026-07-01', count: 2 },
        { date: '2026-07-02', count: 0 },
        { date: '2026-07-03', count: 1 },
      ],
    });
  });

  it('keeps point-in-time counters stable across requested periods', async () => {
    const { pool } = recordingPool((values) => values[1] === '2026-06-01'
      ? row({
          from_date: '2026-06-01',
          to_date: '2026-06-30',
          completed_in_period: '8',
          cancelled_in_period: '2',
          completed_trend: [{ date: '2026-06-01', count: 8 }],
        })
      : row({
          from_date: '2026-07-01',
          to_date: '2026-07-31',
          completed_in_period: '3',
          cancelled_in_period: '1',
          completed_trend: [{ date: '2026-07-01', count: 3 }],
        }));
    const repository = new PostgresReportsRepository(pool);

    const june = await repository.getDashboard({
      organizationId: ORG_ID,
      requestedRange: { from: '2026-06-01', to: '2026-06-30' },
      requestTime,
    });
    const july = await repository.getDashboard({
      organizationId: ORG_ID,
      requestedRange: { from: '2026-07-01', to: '2026-07-31' },
      requestTime,
    });

    expect({
      active: june.counters.activeJobCards,
      overdue: june.counters.overdueJobCards,
      waiting: june.counters.waitingApproval,
      revision: june.counters.revisionRequested,
    }).toEqual({
      active: july.counters.activeJobCards,
      overdue: july.counters.overdueJobCards,
      waiting: july.counters.waitingApproval,
      revision: july.counters.revisionRequested,
    });
    expect(june.counters.completedInPeriod).not.toBe(july.counters.completedInPeriod);
    expect(june.counters.cancelledInPeriod).not.toBe(july.counters.cancelledInPeriod);
    expect(june.completedTrend).not.toEqual(july.completedTrend);
  });

  it('uses canonical timestamps, organization-local boundaries, and all JobCard types', async () => {
    const { pool, query } = recordingPool();
    const repository = new PostgresReportsRepository(pool);

    await repository.getDashboard({
      organizationId: ORG_ID,
      requestedRange: null,
      requestTime,
    });

    const sql = query.mock.calls[0]?.[0] ?? '';
    expect(query.mock.calls[0]?.[1]).toEqual([ORG_ID, null, null, requestTime]);
    expect(sql).toContain('generate_series');
    expect(sql).toContain('manager_approved_at');
    expect(sql).toContain('cancelled_at');
    expect(sql).toContain('AT TIME ZONE organization_range.timezone');
    expect(sql).toContain("to_char(trend.day, 'YYYY-MM-DD')");
    expect(sql.match(/\$4::timestamptz/g)?.length).toBeGreaterThanOrEqual(2);
    expect(sql).not.toMatch(/(?:jc\.)?type\s*=/i);
    expect(sql).not.toMatch(/delivered_at|job_card_delivery_items/i);
  });
});
