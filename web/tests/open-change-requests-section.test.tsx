/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { OpenChangeRequestsSection } from '../src/jobs/ChangeRequests';
import type { OpenChangeRequestItem } from '../src/jobs/jobs-api';
import { RealtimeProvider } from '../src/realtime/RealtimeProvider';
import { ServoraAntProvider } from '../src/ui/antd/ServoraAntProvider';
import { DEFAULT_LIST_PAGE_SIZE } from '../src/ui/pagination';
import { stubDesktopMatchMedia } from './antd-match-media';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
stubDesktopMatchMedia();

const item: OpenChangeRequestItem = {
  changeRequestId: 'request-1',
  jobCardId: 'job-1',
  jobTitle: 'Ataşehir klinik ürün teslimi',
  jobType: 'PRODUCT_DELIVERY',
  jobStatus: 'ACCEPTED',
  reasonCode: 'CUSTOMER_POSTPONED',
  reasonText: 'Müşteri kliniği bugün kapalı, teslim yapılamadı.',
  requestedAt: '2026-11-20T09:15:00.000Z',
  requestedBy: { id: 'staff-1', name: 'Ayşe Personel' },
  customer: { id: 'customer-1', name: 'Özel Ağız ve Diş Sağlığı Merkezi' },
  jobPath: '/jobs/job-1',
};

async function render(load: ReturnType<typeof vi.fn>) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ServoraAntProvider>
        <MemoryRouter>
          <RealtimeProvider>
            <OpenChangeRequestsSection load={load as never} />
          </RealtimeProvider>
        </MemoryRouter>
      </ServoraAntProvider>,
    );
  });
  await act(async () => { await Promise.resolve(); });
  const section = container.querySelector('[data-open-change-requests]');
  const html = container.innerHTML;
  await act(async () => root.unmount());
  container.remove();
  return { section, html };
}

const loaded = (items: OpenChangeRequestItem[], total = items.length) =>
  vi.fn().mockResolvedValue({ items, total, limit: 25, offset: 0 });

describe('OpenChangeRequestsSection', () => {
  it('lists each open Staff request through the OperationalCard adapter', async () => {
    const load = loaded([item]);
    const { section, html } = await render(load);

    expect(load).toHaveBeenCalledWith({ limit: DEFAULT_LIST_PAGE_SIZE, offset: 0 });
    expect(section?.getAttribute('data-open-change-requests')).toBe('true');
    expect(html).toContain('Personel önerileri');
    expect(section?.querySelector('.servora-operational-card')).not.toBeNull();
    expect(section?.querySelector('.servora-operational-card__title a')?.getAttribute('href'))
      .toBe('/jobs/job-1');
    expect(section?.querySelector('.servora-operational-card__title a')?.textContent)
      .toBe('Ataşehir klinik ürün teslimi');
  });

  it('keeps requester, customer, reason and explanation without semantic loss', async () => {
    const { section } = await render(loaded([item]));
    const text = section?.textContent ?? '';
    expect(text).toContain('Ayşe Personel');
    expect(text).toContain('Özel Ağız ve Diş Sağlığı Merkezi');
    expect(text).toContain('Müşteri erteledi');
    expect(text).toContain('Müşteri kliniği bugün kapalı, teslim yapılamadı.');
  });

  it('shows the paged total when more requests exist than the page shows', async () => {
    const { section } = await render(loaded([item], 34));
    expect(section?.textContent).toContain('Toplam 34 öneri');
  });

  it('renders nothing when there is no open request', async () => {
    const { section, html } = await render(loaded([]));
    expect(section).toBeNull();
    expect(html).not.toContain('Personel önerileri');
  });

  it('shows an error state with retry instead of hiding a failed load', async () => {
    const load = vi.fn().mockRejectedValue(new Error('Sunucuya ulaşılamadı.'));
    const { section, html } = await render(load);

    expect(section?.getAttribute('data-open-change-requests')).toBe('error');
    expect(html).toContain('Personel önerileri yüklenemedi');
    expect(html).toContain('Sunucuya ulaşılamadı.');
    expect(html).toContain('Tekrar dene');
  });
});
