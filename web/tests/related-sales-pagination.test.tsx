/** @vitest-environment jsdom */
import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RelatedSalesSection } from '../src/jobs/SaleDetails';
import { RealtimeProvider, type RealtimeEventSource } from '../src/realtime/RealtimeProvider';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

vi.mock('../src/jobs/sale-api', () => ({
  listRelatedSales: vi.fn(),
  getSaleCreateContext: vi.fn(),
}));

import { getSaleCreateContext, listRelatedSales } from '../src/jobs/sale-api';

class FakeRealtimeEventSource implements RealtimeEventSource {
  private readonly listeners = new Map<string, Set<EventListener>>();

  addEventListener(type: string, listener: EventListener) {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener) {
    this.listeners.get(type)?.delete(listener);
  }

  close() {}

  emitVisitChange(id: string) {
    const event = new MessageEvent('servora.change', {
      data: JSON.stringify({
        id,
        type: 'job.updated',
        entity: { type: 'job-card', id: 'visit-1' },
        resourceKeys: ['job-detail:visit-1'],
        occurredAt: '2026-07-20T10:00:00.000Z',
      }),
    });
    this.listeners.get('servora.change')?.forEach((listener) => listener(event));
  }
}

const saleLink = (index: number) => ({
  access: 'FULL' as const, id: `sale-${index}`, title: `Sale ${index}`, status: 'ACCEPTED' as const,
});

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  vi.clearAllMocks();
});

async function renderSection(source: FakeRealtimeEventSource) {
  await act(async () => {
    root.render(<StrictMode>
      <RealtimeProvider eventSourceFactory={() => source}>
        <RelatedSalesSection visitId="visit-1" />
      </RealtimeProvider>
    </StrictMode>);
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function buttons() {
  return [...host.querySelectorAll('button')].map((button) => button.textContent);
}

describe('RelatedSales pagination recovery', () => {
  it('keeps previous-page navigation when the accessible total shrinks below the current offset', async () => {
    let shrunken = false;
    vi.mocked(listRelatedSales).mockImplementation(async (_visitId: string, offset = 0) => {
      if (!shrunken) {
        const total = 21;
        const items = offset === 0
          ? Array.from({ length: 20 }, (_, index) => saleLink(index))
          : [saleLink(20)];
        return { items, total, limit: 20, offset };
      }
      if (offset === 0) {
        return { items: Array.from({ length: 20 }, (_, index) => saleLink(index)), total: 20, limit: 20, offset };
      }
      return { items: [], total: 20, limit: 20, offset };
    });
    vi.mocked(getSaleCreateContext).mockResolvedValue({ activeSale: null } as never);
    const source = new FakeRealtimeEventSource();
    await renderSection(source);
    expect(host.textContent).toContain('Sale 0');
    await act(async () => {
      host.querySelectorAll('button')[1]!.click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).toContain('Sale 20');
    shrunken = true;
    await act(async () => {
      source.emitVisitChange('2');
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await settle();
    // Offset clamps back to the first valid page: items are visible again,
    // the empty-page trap is gone, and no pager is needed on a single page.
    expect(host.textContent).toContain('Sale 0');
    expect(host.textContent).not.toContain('Erişilebilir satış kaydı bulunmuyor.');
  });

  it('clamps to the last valid page and keeps previous navigation on multi-page totals', async () => {
    let shrunken = false;
    const page = (offset: number, total: number) => ({
      items: Array.from({ length: Math.min(20, total - offset) }, (_, index) => saleLink(offset + index)),
      total, limit: 20, offset,
    });
    vi.mocked(listRelatedSales).mockImplementation(async (_visitId: string, offset = 0) => (
      shrunken ? (offset >= 25 ? { items: [], total: 25, limit: 20, offset } : page(offset, 25)) : page(offset, 45)
    ));
    vi.mocked(getSaleCreateContext).mockResolvedValue({ activeSale: null } as never);
    const source = new FakeRealtimeEventSource();
    await renderSection(source);
    for (const label of ['Sonraki', 'Sonraki']) {
      await act(async () => {
        [...host.querySelectorAll('button')].find((button) => button.textContent === label)!.click();
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    expect(host.textContent).toContain('Sale 40');
    shrunken = true;
    await act(async () => {
      source.emitVisitChange('2');
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await settle();
    expect(host.textContent).toContain('Sale 20');
    expect(host.textContent).not.toContain('Sale 40');
    expect(buttons()).toContain('Önceki');
  });

  it('recovers to the first page when the accessible total reaches zero', async () => {
    let emptied = false;
    vi.mocked(listRelatedSales).mockImplementation(async (_visitId: string, offset = 0) => {
      if (!emptied) {
        const items = offset === 0
          ? Array.from({ length: 20 }, (_, index) => saleLink(index))
          : [saleLink(20)];
        return { items, total: 21, limit: 20, offset };
      }
      return { items: [], total: 0, limit: 20, offset: 0 };
    });
    vi.mocked(getSaleCreateContext).mockResolvedValue({ activeSale: null } as never);
    const source = new FakeRealtimeEventSource();
    await renderSection(source);
    await act(async () => {
      host.querySelectorAll('button')[1]!.click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).toContain('Sale 20');
    emptied = true;
    await act(async () => {
      source.emitVisitChange('2');
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await settle();
    expect(host.textContent).toContain('Erişilebilir satış kaydı bulunmuyor.');
  });
});

it('offers Sale creation only from the server eligibility projection', async () => {
  vi.mocked(listRelatedSales).mockResolvedValue({items:[],total:0,limit:20,offset:0});
  vi.mocked(getSaleCreateContext).mockResolvedValue({eligible:true, activeSale:null} as never);
  await renderSection(new FakeRealtimeEventSource());
  expect(host.querySelector('a[href="/jobs/visit-1/new-sale"]')?.textContent).toBe('Satış kaydı oluştur');
});
