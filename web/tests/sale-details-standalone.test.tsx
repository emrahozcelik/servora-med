/** @vitest-environment jsdom */
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RelatedSalesSection, SaleDetailsSection } from '../src/jobs/SaleDetails';
import type { SaleDetails } from '../src/jobs/sale-api';
import { stubMatchMedia } from './customer-search-select-harness';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

vi.mock('../src/jobs/sale-api', () => ({ listRelatedSales: vi.fn(), getSaleCreateContext: vi.fn() }));
vi.mock('../src/realtime/RealtimeProvider', () => ({ useRealtimeInvalidation: () => {} }));

import { getSaleCreateContext, listRelatedSales } from '../src/jobs/sale-api';

const baseDetails: SaleDetails = {
  jobCardId: 'sale-1', jobCardVersion: 3, soldAt: '2026-11-23T09:30:00.000Z', saleContact: null,
  sourceVisit: { kind: 'STANDALONE' }, items: [],
};

let root: Root;
let host: HTMLDivElement;

async function render(node: ReactNode) {
  await act(async () => root.render(node));
  await act(async () => { await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 0)); });
}

beforeEach(() => {
  stubMatchMedia();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('sale origin projection', () => {
  it('renders a standalone sale as an independent record, never as a concealed source', async () => {
    await render(<SaleDetailsSection details={baseDetails} />);
    expect(host.textContent).toContain('Bağımsız satış kaydı (ziyaret yok)');
    expect(host.textContent).not.toContain('Kaynak ziyarete erişiminiz yok');
    expect(host.textContent).not.toContain('Kaynak ziyaret erişimi doğrulanıyor');
    expect(host.querySelector('a[href^="/jobs/"]')).toBeNull();
  });

  it('keeps the restricted visit origin unchanged', async () => {
    await render(<SaleDetailsSection
      details={{ ...baseDetails, sourceVisit: { access: 'RESTRICTED', kind: 'SALE_FROM_VISIT' } }} />);
    expect(host.textContent).toContain('Kaynak ziyarete erişiminiz yok');
    expect(host.textContent).not.toContain('Bağımsız satış kaydı');
  });

  it('still links a readable source visit with its historical snapshots', async () => {
    await render(<SaleDetailsSection details={{
      ...baseDetails,
      sourceVisit: {
        access: 'FULL', kind: 'SALE_FROM_VISIT', id: 'visit-1', title: 'Güncel ziyaret',
        status: 'COMPLETED', versionAtCreation: 4, titleSnapshot: 'Kayıt anındaki ziyaret',
        customerNameSnapshot: 'ABC Klinik', plannedContact: null,
        metContact: { id: 'contact-1', name: 'Doktor B', title: 'Dr.' },
      },
    }} />);
    expect(host.querySelector('a[href="/jobs/visit-1"]')?.textContent).toBe('Güncel ziyaret');
    expect(host.textContent).toContain('Kayıt anındaki ziyaret');
    expect(host.textContent).toContain('Doktor B');
  });
});

describe('completed visit sale entry', () => {
  const context = {
    sourceVisitId: 'visit-1', sourceVersion: 5, eligible: true, blockedReason: null,
    customer: { id: 'customer-1', name: 'ABC Klinik' }, assignee: { id: 'staff-1', name: 'Ayşe' },
    plannedContact: null, metContact: null, activeSale: null,
  };

  it('offers Satış kaydı oluştur when the server marks a COMPLETED visit eligible', async () => {
    vi.mocked(listRelatedSales).mockResolvedValue({ items: [], total: 0, limit: 20, offset: 0 });
    vi.mocked(getSaleCreateContext).mockResolvedValue(context as never);
    await render(<RelatedSalesSection visitId="visit-1" />);
    expect(host.textContent).toContain('Bağlı satışlar');
    expect(host.querySelector('a[href="/jobs/visit-1/new-sale"]')?.textContent).toBe('Satış kaydı oluştur');
  });

  it('hides the entry when the server still blocks the source', async () => {
    vi.mocked(listRelatedSales).mockResolvedValue({ items: [], total: 0, limit: 20, offset: 0 });
    vi.mocked(getSaleCreateContext).mockResolvedValue({
      ...context, eligible: false, blockedReason: 'SOURCE_NOT_ELIGIBLE',
    } as never);
    await render(<RelatedSalesSection visitId="visit-1" />);
    expect(host.querySelector('a[href="/jobs/visit-1/new-sale"]')).toBeNull();
    expect(host.textContent).not.toContain('erişemediğiniz bir aktif satış kaydı');
  });
});
