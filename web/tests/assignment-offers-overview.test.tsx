/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { OpenAssignmentOffersSection } from '../src/jobs/AssignmentOffer';
import type { AssignmentOfferNeedingActionItem } from '../src/jobs/jobs-api';
import { RealtimeProvider } from '../src/realtime/RealtimeProvider';
import { ServoraAntProvider } from '../src/ui/antd/ServoraAntProvider';
import { DEFAULT_LIST_PAGE_SIZE } from '../src/ui/pagination';
import { stubDesktopMatchMedia } from './antd-match-media';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
stubDesktopMatchMedia();

const item: AssignmentOfferNeedingActionItem = {
  jobCardId: 'job-1',
  jobTitle: 'Ataşehir klinik ürün teslimi',
  jobType: 'PRODUCT_DELIVERY',
  offerId: 'offer-1',
  state: 'DECLINED',
  closeReason: 'SCHEDULE_CONFLICT',
  closeText: 'Aynı saatte başka teslim var.',
  acceptanceDueAt: '2026-11-21T12:00:00.000Z',
  urgentReason: null,
  scheduledAt: '2026-11-21T13:00:00.000Z',
  assignee: { id: 'staff-1', name: 'Ayşe Personel' },
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
            <OpenAssignmentOffersSection load={load as never} />
          </RealtimeProvider>
        </MemoryRouter>
      </ServoraAntProvider>,
    );
  });
  await act(async () => { await Promise.resolve(); });
  const section = container.querySelector('[data-assignment-offers]');
  const html = container.innerHTML;
  await act(async () => root.unmount());
  container.remove();
  return { section, html };
}

const loaded = (items: AssignmentOfferNeedingActionItem[], total = items.length) =>
  vi.fn().mockResolvedValue({ items, total, limit: 25, offset: 0 });

describe('OpenAssignmentOffersSection', () => {
  it('lists every offer needing a management answer through the OperationalCard adapter', async () => {
    const load = loaded([item]);
    const { section, html } = await render(load);

    expect(load).toHaveBeenCalledWith({ limit: DEFAULT_LIST_PAGE_SIZE, offset: 0 });
    expect(section?.getAttribute('data-assignment-offers')).toBe('true');
    expect(html).toContain('Müdahale gereken atamalar');
    expect(section?.querySelector('.servora-operational-card')).not.toBeNull();
    expect(section?.querySelector('.servora-operational-card__title a')?.getAttribute('href'))
      .toBe('/jobs/job-1');
    expect(section?.querySelector('.servora-operational-card__title a')?.textContent)
      .toBe('Ataşehir klinik ürün teslimi');
  });

  it('keeps state, deadline, assignee, customer and the recorded reason without semantic loss', async () => {
    const { section } = await render(loaded([item]));
    const text = section?.textContent ?? '';
    expect(text).toContain('Reddedildi');
    expect(text).toContain('Ayşe Personel');
    expect(text).toContain('Özel Ağız ve Diş Sağlığı Merkezi');
    expect(text).toContain('Kabul için son');
    expect(text).toContain('Plan çakışması');
    expect(text).toContain('Aynı saatte başka teslim var.');
  });

  it('shows the urgent badge for a customer time at risk', async () => {
    const { section } = await render(loaded([{ ...item, state: 'OPEN', urgentReason: 'START_PASSED' }]));
    expect(section?.querySelector('[data-assignment-offer-urgent="START_PASSED"]')?.textContent)
      .toContain('Başlangıç geçti');
  });

  it('shows the paged total when more offers exist than the page shows', async () => {
    const { section } = await render(loaded([item], 34));
    expect(section?.textContent).toContain('Toplam 34 atama');
  });

  it('renders nothing when nothing needs action', async () => {
    const { section, html } = await render(loaded([]));
    expect(section).toBeNull();
    expect(html).not.toContain('Müdahale gereken atamalar');
  });

  it('shows an error state with retry instead of hiding a failed load', async () => {
    const load = vi.fn().mockRejectedValue(new Error('Sunucuya ulaşılamadı.'));
    const { section, html } = await render(load);

    expect(section?.getAttribute('data-assignment-offers')).toBe('error');
    expect(html).toContain('Müdahale gereken atamalar yüklenemedi');
    expect(html).toContain('Sunucuya ulaşılamadı.');
    expect(html).toContain('Tekrar dene');
  });
});
