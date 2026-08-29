import { describe, expect, it, vi } from 'vitest';

import { CrmService } from '../src/modules/crm/service.js';
import type { CustomerDetail } from '../src/modules/crm/types.js';
import type { PaginatedJobHistory } from '../src/modules/job-cards/history-port.js';

const actor = { id: 'manager-1', organizationId: 'org-1', role: 'MANAGER' as const };

function detail(): CustomerDetail {
  return {
    id: 'customer-1', organizationId: 'org-1', name: 'Demo Klinik', customerType: 'clinic',
    taxNumber: null, phone: null, email: null, city: null, district: null, address: null,
    assignedStaffUserId: null, status: 'active', version: 1, createdAt: new Date(), updatedAt: new Date(),
    assignedStaffName: null, primaryContact: null, contacts: [], hasOperationHistory: false,
  };
}

function page(total: number): PaginatedJobHistory {
  return { items: [], total, limit: 20, offset: 0 };
}

describe('CRM JobCard history integration', () => {
  it('derives CustomerDetail counts from status-filtered history totals', async () => {
    const repository = {
      execute: vi.fn(),
      listCustomers: vi.fn(),
      getCustomerDetail: vi.fn().mockResolvedValue(detail()),
      listContacts: vi.fn(),
      getContact: vi.fn(),
    };
    const history = {
      listCustomerJobHistory: vi.fn()
        .mockResolvedValueOnce(page(3))
        .mockResolvedValueOnce(page(7)),
      listStaffJobHistory: vi.fn(),
    };
    const service = new CrmService(repository as never, history);

    await expect(service.getCustomer(actor, 'customer-1')).resolves.toMatchObject({
      openJobCount: 3,
      completedJobCount: 7,
    });
    expect(history.listCustomerJobHistory).toHaveBeenNthCalledWith(1, expect.objectContaining({
      actor, customerId: 'customer-1', status: 'open', limit: 1, offset: 0,
    }));
    expect(history.listCustomerJobHistory).toHaveBeenNthCalledWith(2, expect.objectContaining({
      actor, customerId: 'customer-1', status: 'completed', limit: 1, offset: 0,
    }));
  });

  it('keeps existing CustomerDetail behavior when the optional history port is absent', async () => {
    const repository = {
      execute: vi.fn(),
      listCustomers: vi.fn(),
      getCustomerDetail: vi.fn().mockResolvedValue(detail()),
      listContacts: vi.fn(),
      getContact: vi.fn(),
    };
    const service = new CrmService(repository as never);
    await expect(service.getCustomer(actor, 'customer-1')).resolves.not.toHaveProperty('openJobCount');
  });
});
