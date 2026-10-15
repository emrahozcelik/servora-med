// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { parseSaleDetails } from '../src/jobs/sale-api';
import { SaleDetailsSection } from '../src/jobs/SaleDetails';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const detail = {
  jobCardId: 'sale', jobCardVersion: 1, soldAt: '2026-10-15T08:00:00.000Z',
  saleContact: null, sourceVisit: { access: 'RESTRICTED', kind: 'SALE_FROM_VISIT' },
  items: [{ id: 'line', productId: 'product', name: 'Bonding liquid', sku: 'SKU',
    brand: 'Brand', model: null, unit: 'ml', quantity: '5' }],
};

describe('Sale integer product counts', () => {
  beforeEach(() => vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
    matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(),
  })));
  afterEach(() => vi.unstubAllGlobals());
  it('shows product counts separately from measurement metadata', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(<SaleDetailsSection details={parseSaleDetails(detail)} />));
      const count = host.querySelector('.sale-product-quantity');
      expect(count?.textContent).toBe('5 ürün');
      expect(count?.getAttribute('aria-label')).toBe('Satış adedi');
      expect(host.querySelector('.sale-product-line p')?.textContent).toContain('ml');
      expect(count?.textContent).not.toMatch(/ml|mg|litre/);
    } finally { await act(async () => root.unmount()); host.remove(); }
  });
  it.each(['0', '-1', '0.001', '0.5', '1.5', '2.75', '1.000', '01', '1000000000', 'NaN', 'Infinity', 1, null])(
    'rejects noncanonical or noninteger quantity %s', (quantity) => {
      expect(() => parseSaleDetails({ ...detail, items: [{ ...detail.items[0], quantity }] }))
        .toThrowError(expect.objectContaining({ code: 'INVALID_RESPONSE' }));
    },
  );
  it('reads canonical positive integer strings independently of catalog units', () => {
    expect(parseSaleDetails(detail).items[0]).toMatchObject({ quantity: '5', unit: 'ml' });
  });
});
