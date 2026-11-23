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
      endedAt: null, endedBy: null, endReason: null, endNote: null,
      endedByScheduleRevisionNo: null, endedDurationSeconds: null,
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

  it('shows a deadline-extension ending instead of a recovery or ongoing wording', () => {
    const endedAt = '2026-11-21T08:30:00.000Z';
    const ended = {
      id: 'i-ended', delayType: 'LATE_SUBMISSION', episodeNo: 2, scheduleRevisionNo: 3,
      deadlineAt: '2026-11-20T09:00:00.000Z', breachedAt: '2026-11-20T10:00:00.000Z',
      accountableRole: 'STAFF', accountableSource: 'ASSIGNMENT_AT_BREACH', accountableUser: null,
      source: 'MUTATION', recordedAt: '2026-11-20T10:00:01.000Z',
      recoveredAt: null, recoveryActor: null,
      endedAt, endedBy: { id: 'm1', name: 'Dr. Mert Yönetici' },
      endReason: 'DEADLINE_EXTENDED' as const, endNote: 'Müşteri yeni tarihi onayladı',
      endedByScheduleRevisionNo: 4, endedDurationSeconds: 90_061,
      totalDelaySeconds: null, manualReminderSentAt: null, manualReminderCount: 1,
      postReminderDelaySeconds: null,
    };
    const detail = historyDetail(ended);
    expect(detail).toContain(`Tarih uzatılmasıyla sonlandırıldı: ${
      new Intl.DateTimeFormat('tr-TR', { dateStyle: 'medium', timeStyle: 'short' })
        .format(new Date(endedAt))
    }`);
    expect(detail).toContain('Sonlandıran: Dr. Mert Yönetici');
    expect(detail).toContain('Gerekçe: Müşteri yeni tarihi onayladı');
    expect(detail).toContain('Sonlandırılana kadar: 1 gün 1 saat');
    expect(detail).not.toContain('Devam eden gecikme');
    expect(detail).not.toContain('Gecikme bitişi');
    expect(detail).not.toContain('Toplam gecikme');
    expect(historyDetail({ ...ended, endedBy: null })).toContain('Sonlandıran: Belirtilmedi');
  });

  it('labels a card-invalidated ending distinctly and keeps the actual ended duration', () => {
    const endedAt = '2026-11-21T08:30:00.000Z';
    const invalidated = {
      id: 'i-invalidated', delayType: 'LATE_SUBMISSION', episodeNo: 1, scheduleRevisionNo: 2,
      deadlineAt: '2026-11-20T09:00:00.000Z', breachedAt: '2026-11-20T10:00:00.000Z',
      accountableRole: 'STAFF', accountableSource: 'ASSIGNMENT_AT_BREACH', accountableUser: null,
      source: 'SCANNER', recordedAt: '2026-11-20T10:00:01.000Z',
      recoveredAt: null, recoveryActor: null,
      endedAt, endedBy: { id: 'a1', name: 'Sistem Yöneticisi' },
      endReason: 'CARD_INVALIDATED' as const, endNote: null,
      endedByScheduleRevisionNo: null, endedDurationSeconds: 90_061,
      totalDelaySeconds: null, manualReminderSentAt: null, manualReminderCount: 0,
      postReminderDelaySeconds: null,
    };
    const detail = historyDetail(invalidated);
    expect(detail).toContain(`Geçersiz kılındı: ${
      new Intl.DateTimeFormat('tr-TR', { dateStyle: 'medium', timeStyle: 'short' })
        .format(new Date(endedAt))
    }`);
    expect(detail).not.toContain('Tarih uzatılmasıyla sonlandırıldı');
    expect(detail).toContain('Sonlandıran: Sistem Yöneticisi');
    expect(detail).toContain('Sonlandırılana kadar: 1 gün 1 saat');
    expect(detail).not.toContain('Gecikme bitişi');
    expect(detail).not.toContain('Toplam gecikme');
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
  endedAt: null,
  endedBy: null,
  endReason: null,
  endNote: null,
  endedByScheduleRevisionNo: null,
  endedDurationSeconds: null,
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

describe('OVR-4 keyboard focus with deferred page responses', () => {
  it('restores open-late paging focus after a delayed page load', async () => {
    let completeNext!: (page: { items: OpenSubmissionLateItem[]; total: number; limit: number; offset: number }) => void;
    const load = vi.fn(({ limit = 6, offset = 0 }: { limit?: number; offset?: number } = {}) => (
      offset === 0
        ? Promise.resolve({ items: openRows.slice(0, limit), total: 13, limit, offset })
        : new Promise<{ items: OpenSubmissionLateItem[]; total: number; limit: number; offset: number }>(
          resolve => { completeNext = resolve; },
        )
    ));
    const view = await mountView(<OpenSubmissionLateSection load={load} />);
    try {
      const next = view.container.querySelector<HTMLElement>('.servora-ant-pagination-next')!;
      await act(async () => {
        next.focus();
        next.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
      });
      expect(load).toHaveBeenLastCalledWith({ limit: 6, offset: 6 });
      expect(view.container.querySelector('.servora-list-pagination')).toBeNull();
      await act(async () => {
        completeNext({ items: openRows.slice(6, 12), total: 13, limit: 6, offset: 6 });
      });
      expect(view.container.textContent).toContain('Sayfa 2 / 3');
      expect(document.activeElement).toBe(view.container.querySelector('.servora-list-pagination'));
    } finally { await view.dispose(); }
  });

  it('restores incident-history paging focus after a delayed page load', async () => {
    let completeNext!: (page: { items: OverdueIncidentHistoryItem[]; total: number; limit: number; offset: number }) => void;
    const load = vi.fn((_jobId: string, { limit = 6, offset = 0 }: { limit?: number; offset?: number } = {}) => (
      offset === 0
        ? Promise.resolve({ items: historyRows.slice(0, limit), total: 13, limit, offset })
        : new Promise<{ items: OverdueIncidentHistoryItem[]; total: number; limit: number; offset: number }>(
          resolve => { completeNext = resolve; },
        )
    ));
    const view = await mountView(<OverdueIncidentHistorySection jobId="test-job" load={load} />);
    try {
      const next = view.container.querySelector<HTMLElement>('.servora-ant-pagination-next')!;
      await act(async () => {
        next.focus();
        next.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
      });
      expect(load).toHaveBeenLastCalledWith('test-job', { limit: 6, offset: 6 });
      expect(view.container.querySelector('.servora-list-pagination')).toBeNull();
      await act(async () => {
        completeNext({ items: historyRows.slice(6, 12), total: 13, limit: 6, offset: 6 });
      });
      expect(view.container.textContent).toContain('Sayfa 2 / 3');
      expect(document.activeElement).toBe(view.container.querySelector('.servora-list-pagination'));
    } finally { await view.dispose(); }
  });
});

describe('OVR-4 keyboard focus after a shrinking total', () => {
  it.each(['open', 'history'] as const)('restores %s focus to the clamped page after a deferred response', async (kind) => {
    let total = 13;
    let completeNext!: () => void;
    type PageQuery = Partial<{ limit: number; offset: number }>;
    function loadPage<T>(items: T[], { limit = 6, offset = 0 }: PageQuery = {}) {
      const page = () => ({ items: items.slice(0, total).slice(offset, offset + limit), total, limit, offset });
      if (offset === 12) {
        return new Promise<ReturnType<typeof page>>((resolve) => {
          completeNext = () => resolve(page());
        });
      }
      return Promise.resolve(page());
    }
    const loadOpen = vi.fn((page: PageQuery = {}) => loadPage(openRows, page));
    const loadHistory = vi.fn((_jobId: string, page: PageQuery = {}) => loadPage(historyRows, page));
    const view = await mountView(kind === 'open'
      ? <OpenSubmissionLateSection load={loadOpen} />
      : <OverdueIncidentHistorySection jobId="test-job" load={loadHistory} />);
    try {
      await act(async () => {
        view.container.querySelector<HTMLButtonElement>('.servora-ant-pagination-next button')!.click();
      });
      expect(view.container.textContent).toContain('Sayfa 2 / 3');
      total = 7;
      const next = view.container.querySelector<HTMLElement>('.servora-ant-pagination-next')!;
      await act(async () => {
        next.focus();
        next.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
      });
      expect(view.container.querySelector('.servora-list-pagination')).toBeNull();
      await act(async () => { completeNext(); });
      expect(view.container.textContent).toContain('Sayfa 2 / 2');
      const itemSelector = kind === 'open' ? '.submission-late-card' : '[data-overdue-history-item]';
      expect(view.container.querySelectorAll(itemSelector)).toHaveLength(1);
      expect(document.activeElement).toBe(view.container.querySelector('.servora-list-pagination'));
    } finally { await view.dispose(); }
  });
});

describe('OVR-4 collapsible history disclosure (UI-005)', () => {
  type HistoryPage = { items: OverdueIncidentHistoryItem[]; total: number; limit: number; offset: number };

  function deferredSecondPage() {
    let completeNext!: (page: HistoryPage) => void;
    const load = vi.fn((_jobId: string, { limit = 6, offset = 0 }: { limit?: number; offset?: number } = {}) => (
      offset === 0
        ? Promise.resolve({ items: historyRows.slice(0, limit), total: 13, limit, offset })
        : new Promise<HistoryPage>((resolve) => { completeNext = resolve; })
    ));
    return { load, complete: (page: HistoryPage) => completeNext(page) };
  }

  function disclosure(container: HTMLElement) {
    return container.querySelector<HTMLDetailsElement>('details[data-overdue-history-disclosure="true"]');
  }

  async function openDisclosure(container: HTMLElement) {
    const details = disclosure(container);
    expect(details).not.toBeNull();
    expect(details!.open).toBe(false);
    await act(async () => {
      details!.querySelector('summary')!.click();
    });
    expect(details!.open).toBe(true);
    return details!;
  }

  it('keeps the disclosure open and the pager focused across a deferred page load', async () => {
    const { load, complete } = deferredSecondPage();
    const view = await mountView(<OverdueIncidentHistorySection jobId="test-job" load={load} collapsible />);
    try {
      const details = await openDisclosure(view.container);
      const pager = view.container.querySelector('.servora-list-pagination');
      expect(pager).not.toBeNull();

      const next = view.container.querySelector<HTMLElement>('.servora-ant-pagination-next')!;
      await act(async () => {
        next.focus();
        next.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
      });
      expect(load).toHaveBeenLastCalledWith('test-job', { limit: 6, offset: 6 });

      // Loading renders inside the same, still-open disclosure: the panel must not
      // unmount, collapse, or drop the pager's focus ticket.
      expect(disclosure(view.container)).toBe(details);
      expect(details.open).toBe(true);
      expect(view.container.querySelector('[data-overdue-history-busy="true"]')).not.toBeNull();
      expect(view.container.querySelector('.servora-list-pagination')).toBe(pager);

      await act(async () => {
        complete({ items: historyRows.slice(6, 12), total: 13, limit: 6, offset: 6 });
      });
      expect(disclosure(view.container)).toBe(details);
      expect(details.open).toBe(true);
      expect(view.container.textContent).toContain('Sayfa 2 / 3');
      expect(view.container.querySelector('[data-overdue-history-busy="false"]')).not.toBeNull();
      expect(document.activeElement).toBe(view.container.querySelector('.servora-list-pagination'));
    } finally { await view.dispose(); }
  });

  it('stays open and busy through a realtime-style refresh', async () => {
    const initial = vi.fn().mockResolvedValue({
      items: historyRows.slice(0, 6), total: 13, limit: 6, offset: 0,
    });
    let completeRefresh!: (page: HistoryPage) => void;
    const refresh = vi.fn((_jobId: string, { limit = 6, offset = 0 }: { limit?: number; offset?: number } = {}) => (
      new Promise<HistoryPage>((resolve) => { completeRefresh = resolve; })
        .then((page) => ({ ...page, limit, offset }))
    ));
    const view = await mountView(<OverdueIncidentHistorySection jobId="test-job" load={initial} collapsible />);
    try {
      const details = await openDisclosure(view.container);
      await view.render(<OverdueIncidentHistorySection jobId="test-job" load={refresh} collapsible />);
      expect(details.open).toBe(true);
      expect(view.container.querySelector('[data-overdue-history-busy="true"]')).not.toBeNull();
      // The last good page stays visible while the refresh is in flight.
      expect(view.container.querySelectorAll('[data-overdue-history-item]')).toHaveLength(6);

      await act(async () => {
        completeRefresh({ items: historyRows.slice(0, 6), total: 13, limit: 6, offset: 0 });
      });
      expect(details.open).toBe(true);
      expect(view.container.querySelector('[data-overdue-history-busy="false"]')).not.toBeNull();
      expect(view.container.querySelectorAll('[data-overdue-history-item]')).toHaveLength(6);
    } finally { await view.dispose(); }
  });

  it('renders no disclosure before the first page or for an empty history', async () => {
    let completeFirst!: (page: HistoryPage) => void;
    const load = vi.fn((_jobId: string, _page: { limit?: number; offset?: number } = {}) => (
      new Promise<HistoryPage>((resolve) => { completeFirst = resolve; })
    ));
    const view = await mountView(<OverdueIncidentHistorySection jobId="test-job" load={load} collapsible />);
    try {
      expect(disclosure(view.container)).toBeNull();
      await act(async () => {
        completeFirst({ items: [], total: 0, limit: 6, offset: 0 });
      });
      expect(disclosure(view.container)).toBeNull();
    } finally { await view.dispose(); }
  });
});
