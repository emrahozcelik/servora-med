/** @vitest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { OpenSubmissionLateSection, OverdueIncidentHistorySection, historyDetail } from '../src/jobs/SubmissionLateness';
import { ServoraAntProvider } from '../src/ui/antd/ServoraAntProvider';
import { stubDesktopMatchMedia } from './antd-match-media';
import type { OpenSubmissionLateItem, OverdueIncidentHistoryItem } from '../src/jobs/jobs-api';
import { RealtimeProvider } from '../src/realtime/RealtimeProvider';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
stubDesktopMatchMedia();

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
      <ServoraAntProvider>
        <MemoryRouter>
          <RealtimeProvider>
            <OpenSubmissionLateSection load={load} />
          </RealtimeProvider>
        </MemoryRouter>
      </ServoraAntProvider>,
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

  it('shows an error state instead of hiding a failed load', async () => {
    const { section, html } = await renderHtml(vi.fn().mockRejectedValue(new Error('Sunucuya ulaşılamadı.')));
    expect(section?.getAttribute('data-open-submission-late')).toBe('error');
    expect(html).toContain('Gecikme listesi yüklenemedi');
    expect(html).toContain('Sunucuya ulaşılamadı.');
    expect(html).toContain('Tekrar dene');
  });

  it('says when more jobs are late than the list shows', async () => {
    const { section } = await renderHtml(vi.fn().mockResolvedValue({ items: [item], total: 34 }));
    expect(section?.textContent).toContain('Toplam 34 geciken iş');
  });

  it('labels history rows by delay type and keeps the recovery label neutral', () => {
    const base = {
      id: 'i', episodeNo: 1, scheduleRevisionNo: 1,
      deadlineAt: '2026-10-06T03:57:35.103Z', breachedAt: '2026-10-06T03:57:35.103Z',
      accountableRole: 'STAFF', accountableSource: 'ASSIGNMENT_AT_BREACH', accountableUser: null,
      source: 'SCANNER', recordedAt: '2026-10-06T03:58:00.000Z',
      recoveredAt: '2026-10-06T05:00:00.000Z', recoveryActor: null,
      totalDelaySeconds: 3745, manualReminderSentAt: null, manualReminderCount: 0,
      postReminderDelaySeconds: null,
    } as const;
    const start = historyDetail({ ...base, delayType: 'LATE_START' });
    expect(start).toContain('Planlanan bitiş:');
    expect(start).toContain('Gecikme bitişi:');
    expect(start).not.toContain('gönderim');
    const approval = historyDetail({ ...base, delayType: 'APPROVAL_WAIT' });
    expect(approval).toContain('Onay süresi sonu:');
    expect(approval).not.toContain('gönderim');
    expect(historyDetail({ ...base, delayType: 'LATE_SUBMISSION' })).toContain('Son gönderim zamanı:');
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

const openRows = Array.from({ length: 13 }, (_, i): OpenSubmissionLateItem => ({
  ...item,
  jobCardId: `late-${i + 1}`,
  jobTitle: `Geciken iş ${i + 1}`,
  jobPath: `/jobs/late-${i + 1}`,
}));

const historyRows: OverdueIncidentHistoryItem[] = Array.from({ length: 13 }, (_, i) => ({
  id: `history-${i + 1}`,
  delayType: (['LATE_START', 'LATE_SUBMISSION', 'APPROVAL_WAIT'] as const)[i % 3]!,
  episodeNo: i + 1,
  scheduleRevisionNo: 1,
  deadlineAt: '2026-10-06T03:57:35.103Z',
  breachedAt: '2026-10-06T03:57:35.103Z',
  accountableRole: 'STAFF',
  accountableSource: 'ASSIGNMENT_AT_BREACH',
  accountableUser: null,
  source: 'SCANNER',
  recordedAt: '2026-10-06T03:58:00.000Z',
  recoveredAt: null,
  recoveryActor: null,
  totalDelaySeconds: null,
  manualReminderSentAt: null,
  manualReminderCount: 0,
  postReminderDelaySeconds: null,
}));

async function mountView(view: ReactNode) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = async (next: ReactNode) => {
    await act(async () => {
      root.render(
        <ServoraAntProvider>
          <MemoryRouter>
            <RealtimeProvider>{next}</RealtimeProvider>
          </MemoryRouter>
        </ServoraAntProvider>,
      );
    });
  };
  await render(view);
  return {
    container,
    render,
    async dispose() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

describe('OVR-4 canonical six-record paging', () => {
  it('pages open-late jobs 6/6/1 using server limit and offset, hiding a one-page pager', async () => {
    const load = vi.fn(async ({ limit = 6, offset = 0 }: { limit?: number; offset?: number } = {}) => ({
      items: openRows.slice(offset, offset + limit),
      total: openRows.length,
      limit, offset,
    }));
    const view = await mountView(<OpenSubmissionLateSection load={load} />);
    try {
      expect(load).toHaveBeenNthCalledWith(1, { limit: 6, offset: 0 });
      expect(view.container.querySelectorAll('.submission-late-card')).toHaveLength(6);
      expect(view.container.textContent).toContain('Sayfa 1 / 3');
      await act(async () => {
        view.container.querySelector<HTMLButtonElement>('.servora-ant-pagination-next button')!.click();
      });
      expect(load).toHaveBeenLastCalledWith({ limit: 6, offset: 6 });
      expect(view.container.querySelectorAll('.submission-late-card')).toHaveLength(6);
      await act(async () => {
        view.container.querySelector<HTMLButtonElement>('.servora-ant-pagination-next button')!.click();
      });
      expect(load).toHaveBeenLastCalledWith({ limit: 6, offset: 12 });
      expect(view.container.querySelectorAll('.submission-late-card')).toHaveLength(1);
      expect(view.container.textContent).toContain('Sayfa 3 / 3');
    } finally { await view.dispose(); }

    const one = await mountView(<OpenSubmissionLateSection load={vi.fn().mockResolvedValue({
      items: [item], total: 1, limit: 6, offset: 0,
    })} />);
    try { expect(one.container.querySelector('.servora-list-pagination')).toBeNull(); }
    finally { await one.dispose(); }
  });

  it('pages incident history without losing delay-type labels', async () => {
    const load = vi.fn(async (_jobId: string, { limit = 6, offset = 0 }: { limit?: number; offset?: number } = {}) => ({
      items: historyRows.slice(offset, offset + limit),
      total: historyRows.length,
      limit, offset,
    }));
    const view = await mountView(<OverdueIncidentHistorySection jobId="test-job" load={load} />);
    try {
      expect(load).toHaveBeenNthCalledWith(1, 'test-job', { limit: 6, offset: 0 });
      expect(view.container.querySelectorAll('[data-overdue-history-item]')).toHaveLength(6);
      expect(view.container.textContent).toContain('Planlanan bitiş');
      expect(view.container.textContent).toContain('Onay süresi sonu');
      await act(async () => {
        view.container.querySelector<HTMLButtonElement>('.servora-ant-pagination-next button')!.click();
      });
      expect(load).toHaveBeenLastCalledWith('test-job', { limit: 6, offset: 6 });
      expect(view.container.querySelectorAll('[data-overdue-history-item]')).toHaveLength(6);
    } finally { await view.dispose(); }
  });

  it('moves to the last valid page when the dataset shrinks', async () => {
    let count = 13;
    const load = vi.fn(async ({ limit = 6, offset = 0 }: { limit?: number; offset?: number } = {}) => ({
      items: openRows.slice(0, count).slice(offset, offset + limit),
      total: count, limit, offset,
    }));
    const view = await mountView(<OpenSubmissionLateSection load={load} />);
    try {
      await act(async () => {
        view.container.querySelector<HTMLButtonElement>('.servora-ant-pagination-next button')!.click();
      });
      count = 7;
      await act(async () => {
        view.container.querySelector<HTMLButtonElement>('.servora-ant-pagination-next button')!.click();
      });
      expect(load).toHaveBeenCalledWith({ limit: 6, offset: 12 });
      expect(load).toHaveBeenLastCalledWith({ limit: 6, offset: 6 });
      expect(view.container.querySelectorAll('.submission-late-card')).toHaveLength(1);
      expect(view.container.textContent).toContain('Sayfa 2 / 2');
    } finally { await view.dispose(); }
  });

  it('ignores obsolete in-flight results after a new source refresh', async () => {
    let resolveOld!: (value: { items: OpenSubmissionLateItem[]; total: number; limit: number; offset: number }) => void;
    const oldLoad = vi.fn(() => new Promise<{
      items: OpenSubmissionLateItem[]; total: number; limit: number; offset: number;
    }>(resolve => { resolveOld = resolve; }));
    const freshLoad = vi.fn().mockResolvedValue({ items: [openRows[1]], total: 1, limit: 6, offset: 0 });
    const view = await mountView(<OpenSubmissionLateSection load={oldLoad} />);
    try {
      await view.render(<OpenSubmissionLateSection load={freshLoad} />);
      expect(view.container.textContent).toContain('Geciken iş 2');
      await act(async () => {
        resolveOld({ items: [openRows[0]], total: 1, limit: 6, offset: 0 });
      });
      expect(view.container.textContent).toContain('Geciken iş 2');
      expect(view.container.textContent).not.toContain('Geciken iş 1');
    } finally { await view.dispose(); }
  });
});
