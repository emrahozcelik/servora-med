/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { OpenSubmissionLateSection } from '../src/jobs/SubmissionLateness';
import type { OpenSubmissionLateItem } from '../src/jobs/jobs-api';
import { RealtimeProvider } from '../src/realtime/RealtimeProvider';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const LONG_TITLE = 'Ataşehir bölgesi klinik ziyaret turu ve ürün tanıtım planı hazırlığı çalışması';
const LONG_CUSTOMER = 'Özel Akademik Ağız ve Diş Sağlığı Merkezi Ataşehir Şubesi ve Çene Cerrahisi Kliniği';

const item: OpenSubmissionLateItem = {
  jobCardId: 'job-late-1',
  jobTitle: LONG_TITLE,
  episodeNo: 1,
  deadlineAt: '2026-10-06T03:57:35.103Z',
  breachedAt: '2026-10-06T04:57:35.103Z',
  elapsedSeconds: 93600,
  staff: { id: 'staff-1', name: 'Denetim Personeli' },
  customer: { id: 'customer-1', name: LONG_CUSTOMER },
  jobPath: '/jobs/job-late-1',
};

async function renderHtml(load = vi.fn().mockResolvedValue({ items: [item], total: 1 })) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter>
        <RealtimeProvider>
          <OpenSubmissionLateSection load={load} />
        </RealtimeProvider>
      </MemoryRouter>,
    );
  });
  await act(async () => { await Promise.resolve(); });
  const section = container.querySelector('[data-open-submission-late]');
  const html = container.innerHTML;
  await act(async () => root.unmount());
  container.remove();
  return { section, html };
}

describe('OpenSubmissionLateSection (UI polish slice A)', () => {
  it('presents each late row through the OperationalCard adapter', async () => {
    const { section, html } = await renderHtml();
    expect(section).not.toBeNull();
    expect(html).toContain('Onaya göndermesi geciken işler');
    expect(section?.querySelector('.servora-operational-card')).not.toBeNull();
  });

  it('keeps the job navigation target on the card title', async () => {
    const { section } = await renderHtml();
    const link = section?.querySelector('.servora-operational-card__title a');
    expect(link?.getAttribute('href')).toBe('/jobs/job-late-1');
    expect(link?.textContent).toBe(LONG_TITLE);
  });

  it('keeps staff, customer and elapsed metadata without semantic loss', async () => {
    const { section } = await renderHtml();
    const text = section?.textContent ?? '';
    expect(text).toContain('Denetim Personeli');
    expect(text).toContain(LONG_CUSTOMER);
    expect(text).toContain('gecikti');
  });

  it('keeps title and metadata in distinct elements', async () => {
    const { section } = await renderHtml();
    const link = section?.querySelector('.servora-operational-card__title a');
    expect(link).not.toBeNull();
    // The title link must not swallow the metadata line.
    expect(link?.textContent).not.toContain('Denetim Personeli');
    expect(link?.textContent).not.toContain('gecikti');
  });
});
