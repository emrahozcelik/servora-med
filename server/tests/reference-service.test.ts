import { describe, expect, it, vi } from 'vitest';

import { JobCardService } from '../src/modules/job-cards/service.js';

describe('tracer reference service scope', () => {
  it('derives organization ownership from the authenticated actor', async () => {
    const repository = {
      listReferenceCustomers: vi.fn().mockResolvedValue([{ id: 'c1', name: 'Klinik' }]),
      listReferenceProducts: vi.fn().mockResolvedValue([{ id: 'p1', name: 'Set' }]),
    };
    const service = new JobCardService(repository as never);
    const actor = { id: 'staff-1', organizationId: 'org-1', role: 'STAFF' as const };

    await expect(service.listReferenceCustomers(actor)).resolves.toHaveLength(1);
    await expect(service.listReferenceProducts(actor)).resolves.toHaveLength(1);
    expect(repository.listReferenceCustomers).toHaveBeenCalledWith('org-1');
    expect(repository.listReferenceProducts).toHaveBeenCalledWith('org-1');
  });

  it('preserves nullable Product reference fields', async () => {
    const product = { id: 'p1', name: 'İsimsiz Referans', sku: null, model: null, unit: null };
    const repository = {
      listReferenceCustomers: vi.fn(),
      listReferenceProducts: vi.fn().mockResolvedValue([product]),
    };

    await expect(new JobCardService(repository as never).listReferenceProducts({
      id: 'staff-1', organizationId: 'org-1', role: 'STAFF',
    })).resolves.toEqual([product]);
  });
});
