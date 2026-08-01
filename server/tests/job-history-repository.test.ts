import { describe, expect, it, vi } from 'vitest';

import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';

const baseRow = {
  id: 'job-1', title: 'Takip işi', type: 'GENERAL_TASK', status: 'COMPLETED', priority: 'normal',
  scheduled_at: new Date('2026-07-20T08:00:00.000Z'), due_date: '2026-07-21',
  created_at: new Date('2026-07-19T08:00:00.000Z'), updated_at: new Date('2026-07-22T08:00:00.000Z'),
  manager_approved_at: new Date('2026-07-22T08:00:00.000Z'), source_job_card_id: 'source-1',
  customer_id: 'customer-1', customer_name: 'Demo Klinik', contact_id: 'contact-1', contact_name: 'Dr. Ayşe',
  assignee_id: 'staff-1', assignee_name: 'Ayşe', child_count: 4,
};

const management = { id: 'manager-1', organizationId: 'org-1', role: 'MANAGER' as const };
const staff = { id: 'staff-1', organizationId: 'org-1', role: 'STAFF' as const };

describe('PostgresJobCardRepository history read port', () => {
  it('uses one shared organization/customer/status predicate and exposes management child counts', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ total: '7' }] })
      .mockResolvedValueOnce({ rows: [baseRow] });
    const repository = new PostgresJobCardRepository({ query } as never);
    const result = await repository.listCustomerJobHistory({
      organizationId: 'untrusted-org', customerId: 'customer-1', actor: management,
      status: 'completed', limit: 20, offset: 40,
    });
    expect(result).toMatchObject({ total: 7, limit: 20, offset: 40, items: [{ childCount: 4, followUp: { sourceJobCardId: 'source-1' } }] });
    expect(query.mock.calls[0]?.[1]).toEqual(['org-1', 'customer-1']);
    expect(query.mock.calls[1]?.[1]).toEqual(['org-1', 'customer-1', 20, 40]);
    expect(String(query.mock.calls[0]?.[0])).toContain("j.status = 'COMPLETED'");
    expect(String(query.mock.calls[1]?.[0])).toContain("j.status = 'COMPLETED'");
    expect(String(query.mock.calls[1]?.[0])).not.toContain('follow_up_instructions');
  });

  it('forces Staff history to the authenticated assignee and nulls childCount', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ total: '1' }] })
      .mockResolvedValueOnce({ rows: [{ ...baseRow, assignee_id: 'staff-1', child_count: null }] });
    const repository = new PostgresJobCardRepository({ query } as never);
    const result = await repository.listStaffJobHistory({
      organizationId: 'org-other', targetUserId: 'staff-2', actor: staff,
      status: ['IN_PROGRESS', 'COMPLETED'], limit: 10, offset: 0,
    });
    expect(result.items[0]?.childCount).toBeNull();
    expect(query.mock.calls[0]?.[1]).toEqual(['org-1', 'staff-1', ['IN_PROGRESS', 'COMPLETED']]);
    expect(query.mock.calls[1]?.[1]).toEqual(['org-1', 'staff-1', ['IN_PROGRESS', 'COMPLETED'], 10, 0]);
    expect(String(query.mock.calls[0]?.[0])).toContain('j.assigned_to = $2');
    expect(String(query.mock.calls[1]?.[0])).toContain('NULL::int AS child_count');
  });
});
