import { describe, expect, it, vi } from 'vitest';

import { PostgresOverviewRepository } from '../src/modules/overview/repository.js';

describe('PostgresOverviewRepository', () => {
  it('bounds and assignment-scopes Staff recent work and notes with stable ordering', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const reports = {
      getOne: vi.fn().mockResolvedValue({
        range: { from: '2026-07-01', to: '2026-07-31', timezone: 'Europe/Istanbul' },
        counters: {
          openJobCards: 2,
          waitingApproval: 1,
          revisionRequested: 0,
          overdueJobCards: 0,
          completedInPeriod: 3,
        },
      }),
    };
    const repository = new PostgresOverviewRepository(
      { query } as never,
      reports as never,
    );

    await repository.getStaffOverview({
      id: '11111111-1111-4111-8111-111111111111',
      organizationId: '22222222-2222-4222-8222-222222222222',
      name: 'Ayşe',
      email: 'ayse@example.test',
      role: 'STAFF',
      mustChangePassword: false,
      isActive: true,
      version: 1,
    }, { requestedRange: null }, new Date('2026-07-26T08:00:00.000Z'));

    expect(query).toHaveBeenCalledTimes(2);
    const sql = query.mock.calls.map(([text]) => text).join('\n');
    expect(sql).toContain('j.organization_id = $1');
    expect(sql).toContain('j.assigned_to = $4');
    expect(sql).toContain('LIMIT 10');
    expect(sql).toContain('ORDER BY j.manager_approved_at DESC, j.id DESC');
    expect(sql).toContain('ORDER BY n.created_at DESC, n.id DESC');
    expect(sql).not.toContain('n.note');
    expect(sql).not.toContain('preview');
    expect(query.mock.calls[0]![1]).toEqual([
      '22222222-2222-4222-8222-222222222222',
      '2026-07-01',
      '2026-07-31',
      '11111111-1111-4111-8111-111111111111',
    ]);
  });

  it.each(['MANAGER', 'ADMIN'] as const)(
    'keeps %s recent data organization-scoped and reuses report calculations',
    async (role) => {
      const query = vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });
      const reports = {
        getDashboard: vi.fn().mockResolvedValue({
          range: { from: '2026-07-01', to: '2026-07-31', timezone: 'Europe/Istanbul' },
          counters: {
            activeJobCards: 4, overdueJobCards: 1, waitingApproval: 2,
            revisionRequested: 1, completedInPeriod: 8, cancelledInPeriod: 1,
          },
          completedTrend: [],
        }),
        getApprovalSummary: vi.fn().mockResolvedValue({
          pendingCount: 2, oldestWaitingMinutes: 20,
        }),
      };
      const repository = new PostgresOverviewRepository({ query } as never, reports as never);
      const actor = {
        id: `${role.toLowerCase()}-1`,
        organizationId: '22222222-2222-4222-8222-222222222222',
        name: role, email: `${role.toLowerCase()}@example.test`, role,
        mustChangePassword: false, isActive: true, version: 1,
      };
      await repository.getManagementOverview(
        actor,
        { requestedRange: { from: '2026-07-01', to: '2026-07-31' } },
        new Date('2026-07-26T08:00:00.000Z'),
      );
      expect(reports.getDashboard).toHaveBeenCalledOnce();
      expect(reports.getApprovalSummary).toHaveBeenCalledOnce();
      expect(query.mock.calls[0]![1]![3]).toBeNull();
      expect(query.mock.calls[1]![1]![3]).toBeNull();
      expect(query.mock.calls[0]![1]![0]).toBe(actor.organizationId);
    },
  );
});
