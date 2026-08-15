import { describe, expect, it, vi } from 'vitest';

import { PostgresCalendarRepository } from '../src/modules/calendar/repository.js';
import type { CalendarActor } from '../src/modules/calendar/types.js';

const sourceCompletedAt = new Date('2026-07-22T15:00:00.000Z');
const row = {
  id: 'follow-up-1', source: 'JOB' as const, title: 'Takip planı', description: null,
  starts_at: new Date('2026-07-25T09:00:00.000Z'), ends_at: new Date('2026-07-25T10:00:00.000Z'),
  timezone: 'Europe/Istanbul', assigned_user_id: 'staff-2', assigned_user_name: 'Bora', version: 1,
  status: 'NEW', job_type: 'GENERAL_TASK', job_status: 'NEW', priority: 'normal',
  customer_id: 'customer-1', customer_name: 'Demo Klinik', created_by_id: null, created_by_name: null,
  updated_by_id: null, updated_by_name: null, source_job_card_id: 'source-1',
  source_assigned_to: 'staff-1', source_job_type: 'SALES_MEETING',
  source_planned_at: new Date('2026-07-20T09:00:00.000Z'), source_started_at: new Date('2026-07-20T09:10:00.000Z'),
  source_staff_completed_at: new Date('2026-07-20T10:00:00.000Z'), source_meeting_at: new Date('2026-07-20T09:30:00.000Z'),
  source_completed_at: sourceCompletedAt,
};
const queryInput = { from: '2026-07-25T00:00:00.000Z', to: '2026-07-26T00:00:00.000Z', assignedTo: null };
const manager: CalendarActor = { id: 'manager-1', organizationId: 'org-1', role: 'MANAGER' };
const sourceStaff: CalendarActor = { id: 'staff-1', organizationId: 'org-1', role: 'STAFF' };
const assigneeStaff: CalendarActor = { id: 'staff-2', organizationId: 'org-1', role: 'STAFF' };

describe('Calendar follow-up context', () => {
  it.each([
    [manager, 'FULL', '/jobs/source-1'],
    [sourceStaff, 'FULL', '/jobs/source-1'],
    [assigneeStaff, 'RESTRICTED', null],
  ] as const)('derives %s source access from the shared policy', async (actor, sourceAccess, sourceJobPath) => {
    const query = vi.fn().mockResolvedValue({ rows: [row] });
    const repository = new PostgresCalendarRepository({ query } as never);
    const [event] = await repository.list(actor, queryInput);
    expect(event).toMatchObject({
      source: 'JOB', followUpContext: {
        sourceAccess, sourceJobPath, sourcePlannedAt: '2026-07-20T09:00:00.000Z',
        sourceOccurredAt: '2026-07-20T09:30:00.000Z', sourceCompletedAt: sourceCompletedAt.toISOString(),
      },
    });
    expect(String(query.mock.calls[0]?.[0])).not.toContain('follow_up_instructions');
  });

  it('keeps root events additive with a null context', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ ...row, source_job_card_id: null, source_completed_at: null }] });
    const repository = new PostgresCalendarRepository({ query } as never);
    const [event] = await repository.list(manager, queryInput);
    expect(event).toMatchObject({ source: 'JOB', followUpContext: null });
  });

  it('projects a legacy General Task interval as a point', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [row] });
    const repository = new PostgresCalendarRepository({ query } as never);

    const [event] = await repository.list(manager, queryInput);

    expect(event).toMatchObject({
      source: 'JOB',
      jobType: 'GENERAL_TASK',
      startsAt: '2026-07-25T09:00:00.000Z',
      endsAt: null,
    });
    expect(String(query.mock.calls[0]?.[0])).toContain(
      "CASE WHEN j.type IN ('SALES_MEETING', 'PRODUCT_DELIVERY')",
    );
  });
});
