import { afterEach, describe, expect, it, vi } from 'vitest';

import { getDataManagementSummary, parseDataManagementSummary } from '../src/services/data-management-api';

afterEach(() => vi.unstubAllGlobals());

describe('Data Management API contract', () => {
  it('parses the bounded count-only response without record fields', () => {
    const result = parseDataManagementSummary({
      customers: { total: 3, prospect: 1, active: 1, inactive: 1 },
      contacts: { total: 2, active: 1, inactive: 1 },
      products: { total: 2, active: 1, inactive: 1 },
      staff: { total: 2, active: 1, inactive: 1 },
      demoDataset: { total: 2, active: 0, purged: 2 },
    });

    expect(result.customers).toEqual({ total: 3, prospect: 1, active: 1, inactive: 1 });
    expect(Object.keys(result)).toEqual(['customers', 'contacts', 'products', 'staff', 'demoDataset']);
    expect(JSON.stringify(result)).not.toMatch(/name|email|phone|address/i);
  });

  it('loads the exact Admin summary endpoint without a request body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      customers: { total: 0, prospect: 0, active: 0, inactive: 0 },
      contacts: { total: 0, active: 0, inactive: 0 },
      products: { total: 0, active: 0, inactive: 0 },
      staff: { total: 0, active: 0, inactive: 0 },
      demoDataset: { total: 0, active: 0, purged: 0 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getDataManagementSummary()).resolves.toMatchObject({
      customers: { total: 0 }, demoDataset: { total: 0 },
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/data-management/summary', {
      credentials: 'include',
    });
  });
});
