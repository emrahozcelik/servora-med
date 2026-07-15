import { describe, expect, it, vi } from 'vitest';

import { PostgresReportsRepository } from '../src/modules/reports/repository.js';

const ORG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const STAFF_ONE = '11111111-1111-4111-8111-111111111111';
const STAFF_TWO = '22222222-2222-4222-8222-222222222222';
const UNKNOWN_STAFF = '33333333-3333-4333-8333-333333333333';
const requestTime = new Date('2026-07-14T09:00:00.000Z');

type StaffSummaryRow = {
  staff_user_id: string;
  from_date: string;
  to_date: string;
  timezone: string;
  open_job_cards: string | number;
  waiting_approval: string | number;
  revision_requested: string | number;
  overdue_job_cards: string | number;
  completed_in_period: string | number;
};

function row(
  staffUserId: string,
  counters: Partial<StaffSummaryRow> = {},
): StaffSummaryRow {
  return {
    staff_user_id: staffUserId,
    from_date: '2026-07-01',
    to_date: '2026-07-31',
    timezone: 'Europe/Istanbul',
    open_job_cards: '0',
    waiting_approval: '0',
    revision_requested: '0',
    overdue_job_cards: '0',
    completed_in_period: '0',
    ...counters,
  };
}

function recordingPool(rows: StaffSummaryRow[] = []) {
  const query = vi.fn(async (text: string, values: unknown[] = []) => ({
    rows,
    rowCount: rows.length,
    text,
    values,
  }));
  return { query, pool: { query } as never };
}

describe('PostgresReportsRepository Staff operational summaries', () => {
  it('returns an empty Map without querying for an empty Staff list', async () => {
    const { pool, query } = recordingPool();
    const repository = new PostgresReportsRepository(pool);

    await expect(repository.getMany({
      organizationId: ORG_ID,
      staffUserIds: [],
      requestedRange: null,
      requestTime,
    })).resolves.toEqual(new Map());
    expect(query).not.toHaveBeenCalled();
  });

  it('loads a deduplicated Staff list in one query and maps zero counters', async () => {
    const { pool, query } = recordingPool([
      row(STAFF_ONE, {
        open_job_cards: '3',
        waiting_approval: '2',
        revision_requested: '1',
        overdue_job_cards: '1',
        completed_in_period: '4',
      }),
      row(STAFF_TWO),
    ]);
    const repository = new PostgresReportsRepository(pool);

    const summaries = await repository.getMany({
      organizationId: ORG_ID,
      staffUserIds: [STAFF_ONE, STAFF_TWO, STAFF_ONE, UNKNOWN_STAFF],
      requestedRange: { from: '2026-07-01', to: '2026-07-31' },
      requestTime,
    });

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[1]).toEqual([
      ORG_ID,
      '2026-07-01',
      '2026-07-31',
      requestTime,
      [STAFF_ONE, STAFF_TWO, UNKNOWN_STAFF],
    ]);
    expect([...summaries.keys()]).toEqual([STAFF_ONE, STAFF_TWO]);
    expect(summaries.get(STAFF_ONE)).toEqual({
      staffUserId: STAFF_ONE,
      range: { from: '2026-07-01', to: '2026-07-31', timezone: 'Europe/Istanbul' },
      counters: {
        openJobCards: 3,
        waitingApproval: 2,
        revisionRequested: 1,
        overdueJobCards: 1,
        completedInPeriod: 4,
      },
    });
    expect(summaries.get(STAFF_TWO)?.counters).toEqual({
      openJobCards: 0,
      waitingApproval: 0,
      revisionRequested: 0,
      overdueJobCards: 0,
      completedInPeriod: 0,
    });
    expect(summaries.has(UNKNOWN_STAFF)).toBe(false);
  });

  it('implements getOne through one single-ID batch query', async () => {
    const { pool, query } = recordingPool([row(STAFF_ONE)]);
    const repository = new PostgresReportsRepository(pool);

    await expect(repository.getOne({
      organizationId: ORG_ID,
      staffUserId: STAFF_ONE,
      requestedRange: null,
      requestTime,
    })).resolves.toMatchObject({ staffUserId: STAFF_ONE });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[1]).toEqual([
      ORG_ID,
      null,
      null,
      requestTime,
      [STAFF_ONE],
    ]);
  });

  it('returns null when getOne cannot resolve a same-organization Staff profile', async () => {
    const { pool, query } = recordingPool();
    const repository = new PostgresReportsRepository(pool);

    await expect(repository.getOne({
      organizationId: ORG_ID,
      staffUserId: UNKNOWN_STAFF,
      requestedRange: null,
      requestTime,
    })).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('uses assigned Staff attribution, organization-local dates, and every JobCard type', async () => {
    const { pool, query } = recordingPool();
    const repository = new PostgresReportsRepository(pool);

    await repository.getMany({
      organizationId: ORG_ID,
      staffUserIds: [STAFF_ONE],
      requestedRange: null,
      requestTime,
    });

    const sql = query.mock.calls[0]?.[0] ?? '';
    expect(sql).toContain('jc.assigned_to = requested.staff_user_id');
    expect(sql).toContain('u.organization_id = $1');
    expect(sql).toContain("u.role = 'STAFF'");
    expect(sql).toContain('AT TIME ZONE organization_range.timezone');
    expect(sql).toContain("to_char(organization_range.from_date, 'YYYY-MM-DD')");
    expect(sql).toContain("to_char(organization_range.to_date, 'YYYY-MM-DD')");
    expect(sql).toContain('jc.manager_approved_at');
    expect(sql).not.toMatch(/staff_completed_by|created_by|manager_approved_by/i);
    expect(sql).not.toMatch(/job_card_activities|activity/i);
    expect(sql).not.toMatch(/jc\.type\s*=/i);
  });
});
