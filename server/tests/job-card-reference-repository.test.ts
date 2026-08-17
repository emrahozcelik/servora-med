import { describe, expect, it, vi } from 'vitest';

import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';

describe('Product Delivery Customer reference projection', () => {
  it('projects the same-organization responsible Staff without loading Contacts', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{
      id: 'customer-1',
      name: 'Klinik',
      customer_type: 'clinic',
      status: 'active',
      assigned_staff_user_id: 'staff-1',
    }] });
    const repository = new PostgresJobCardRepository({ query } as never);

    await expect(repository.listReferenceCustomers('org-1')).resolves.toEqual([{
      id: 'customer-1',
      name: 'Klinik',
      customerType: 'clinic',
      status: 'active',
      assignedStaffUserId: 'staff-1',
    }]);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('assigned_staff_user_id'),
      ['org-1'],
    );
    expect(query.mock.calls[0]?.[0]).not.toContain('contacts');
  });
});
