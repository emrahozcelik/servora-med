import { describe, expect, it, vi } from 'vitest';

import { JobCardService } from '../src/modules/job-cards/service.js';

describe('tracer reference service scope', () => {
  it('derives organization ownership from the authenticated actor', async () => {
    const repository = {
      listReferenceCustomers: vi.fn().mockResolvedValue([{ id: 'c1', name: 'Klinik' }]),
    };
    const service = new JobCardService(repository as never);
    const actor = { id: 'staff-1', organizationId: 'org-1', role: 'STAFF' as const };

    await expect(service.listReferenceCustomers(actor)).resolves.toHaveLength(1);
    expect(repository.listReferenceCustomers).toHaveBeenCalledWith('org-1');
  });

  it('keeps responsible Staff metadata out of the Staff reference projection', async () => {
    const customer = {
      id: 'c1', name: 'Klinik', customerType: 'clinic', status: 'active',
      assignedStaffUserId: 'staff-2',
    };
    const repository = { listReferenceCustomers: vi.fn().mockResolvedValue([customer]) };
    const service = new JobCardService(repository as never);

    await expect(service.listReferenceCustomers({
      id: 'staff-1', organizationId: 'org-1', role: 'STAFF',
    })).resolves.toEqual([{
      id: 'c1', name: 'Klinik', customerType: 'clinic', status: 'active',
    }]);
    await expect(service.listReferenceCustomers({
      id: 'manager-1', organizationId: 'org-1', role: 'MANAGER',
    })).resolves.toEqual([customer]);
  });
});
