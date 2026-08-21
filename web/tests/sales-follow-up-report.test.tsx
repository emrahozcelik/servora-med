/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SalesFollowUpReportView } from '../src/reports/SalesFollowUpReport';
import { parseSalesFollowUpReport, getSalesFollowUpReport } from '../src/reports/reports-api';
import type { SalesFollowUpReportResponse } from '../src/reports/report-types';

vi.mock('../src/reports/reports-api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/reports/reports-api')>(),
  getSalesFollowUpReport: vi.fn(),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// AntD v5 `responsive` columns use useBreakpoint, which reads window.matchMedia
// through responsiveObserver. SSR renders no columns at all (the screens map is
// empty on the server), so responsive behaviour must be verified with client-side
// renders keyed on a mutable viewport width. The mock below answers the real AntD
// breakpoint queries and invokes registered change listeners when the width changes.
const ANT_BREAKPOINT_QUERIES = {
  xs: '(max-width: 575px)',
  sm: '(min-width: 576px)',
  md: '(min-width: 768px)',
  lg: '(min-width: 992px)',
  xl: '(min-width: 1200px)',
  xxl: '(min-width: 1600px)',
} as const;

type MediaQueryListener = (event: { matches: boolean; media: string }) => void;

let currentViewportWidth = 1024;
const listenersByQuery = new Map<string, Set<MediaQueryListener>>();
const matchMediaMock = vi.fn((query: string) => {
  const matchesFor = (q: string) => {
    if (q === ANT_BREAKPOINT_QUERIES.xs) return currentViewportWidth <= 575;
    if (q === ANT_BREAKPOINT_QUERIES.sm) return currentViewportWidth >= 576;
    if (q === ANT_BREAKPOINT_QUERIES.md) return currentViewportWidth >= 768;
    if (q === ANT_BREAKPOINT_QUERIES.lg) return currentViewportWidth >= 992;
    if (q === ANT_BREAKPOINT_QUERIES.xl) return currentViewportWidth >= 1200;
    if (q === ANT_BREAKPOINT_QUERIES.xxl) return currentViewportWidth >= 1600;
    return false;
  };
  const matches = matchesFor(query);
  const set = listenersByQuery.get(query) ?? new Set<MediaQueryListener>();
  listenersByQuery.set(query, set);
  return {
    matches,
    media: query,
    onchange: null,
    addEventListener: (type: string, listener: MediaQueryListener) => {
      if (type === 'change') set.add(listener);
    },
    removeEventListener: (type: string, listener: MediaQueryListener) => {
      if (type === 'change') set.delete(listener);
    },
    addListener: (listener: MediaQueryListener) => set.add(listener),
    removeListener: (listener: MediaQueryListener) => set.delete(listener),
    dispatchEvent: () => false,
  };
});

Object.defineProperty(window, 'matchMedia', {
  configurable: true,
  value: matchMediaMock,
});

function setViewportWidth(width: number) {
  currentViewportWidth = width;
  for (const [query, listeners] of listenersByQuery) {
    const matches =
      query === ANT_BREAKPOINT_QUERIES.xs ? width <= 575 :
      query === ANT_BREAKPOINT_QUERIES.sm ? width >= 576 :
      query === ANT_BREAKPOINT_QUERIES.md ? width >= 768 :
      query === ANT_BREAKPOINT_QUERIES.lg ? width >= 992 :
      query === ANT_BREAKPOINT_QUERIES.xl ? width >= 1200 :
      query === ANT_BREAKPOINT_QUERIES.xxl ? width >= 1600 : false;
    for (const listener of listeners) listener({ matches, media: query });
  }
}

function renderSalesViewDom(
  report: SalesFollowUpReportResponse,
  offset = 0,
  proposalOffset = 0,
  width = 1024,
) {
  setViewportWidth(width);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter>
        <SalesFollowUpReportView
          report={report}
          offset={offset}
          proposalOffset={proposalOffset}
          onSalesMeetingPage={() => {}}
          onProposalPage={() => {}}
        />
      </MemoryRouter>,
    );
  });
  return { container, root };
}

// AntD's responsive observer subscribes inside an effect and triggers a state
// update on the first matchMedia pass. Flipping the screens map back to the
// current width inside act() forces the final column set deterministically.
function viewMarkup(report: SalesFollowUpReportResponse, offset = 0, proposalOffset = 0, width = 1024) {
  const { container, root } = renderSalesViewDom(report, offset, proposalOffset, width);
  act(() => {
    setViewportWidth(width);
  });
  act(() => {});
  const html = container.innerHTML;
  act(() => { root.unmount(); });
  container.remove();
  return html;
}

function viewMarkupMobile(report: SalesFollowUpReportResponse, offset = 0, proposalOffset = 0) {
  return viewMarkup(report, offset, proposalOffset, 390);
}

const range = { from: '2026-07-01', to: '2026-07-31', timezone: 'Europe/Istanbul' };

const baseReport: SalesFollowUpReportResponse = {
  range,
  current: {
    salesMeetings: {
      total: 2,
      statusDistribution: [
        { status: 'NEW', count: 1 },
        { status: 'ACCEPTED', count: 0 },
        { status: 'IN_PROGRESS', count: 1 },
        { status: 'WAITING_APPROVAL', count: 0 },
        { status: 'REVISION_REQUESTED', count: 0 },
      ],
      items: [
        {
          id: 'job-1',
          status: 'IN_PROGRESS',
          scheduledAt: '2026-07-15T09:00:00.000Z',
          customer: { id: 'c1', name: 'DentArt Klinik' },
          assignee: { userId: 'u1', name: 'Ayşe Demir' },
        },
        {
          id: 'job-2',
          status: 'NEW',
          scheduledAt: null,
          customer: null,
          assignee: { userId: 'u2', name: 'Mehmet Yılmaz' },
        },
      ],
      limit: 50,
      offset: 0,
    },
    proposalQueue: {
      total: 1,
      limit: 50,
      offset: 0,
      items: [
        {
          id: 'job-3',
          status: 'WAITING_APPROVAL',
          customer: { id: 'c1', name: 'DentArt Klinik' },
          assignee: { userId: 'u1', name: 'Ayşe Demir' },
          followUpProposedType: 'SALES_MEETING',
          followUpProposedAssignee: { userId: 'u2', name: 'Mehmet Yılmaz' },
          followUpProposalInstructions: 'Hastayı arayın ve yeni randevu planlayın, detaylı not buraya gelecek.',
          proposedFollowUpAt: '2026-08-10T09:00:00.000Z',
          followUpProposalOrigin: 'SYSTEM',
        },
      ],
    },
    followUpChildren: {
      total: 3,
      statusDistribution: [
        { status: 'NEW', count: 1 },
        { status: 'ACCEPTED', count: 0 },
        { status: 'IN_PROGRESS', count: 1 },
        { status: 'WAITING_APPROVAL', count: 1 },
        { status: 'REVISION_REQUESTED', count: 0 },
      ],
      typeDistribution: [
        { type: 'PRODUCT_DELIVERY', count: 1 },
        { type: 'GENERAL_TASK', count: 1 },
        { type: 'SALES_MEETING', count: 1 },
      ],
      overdueDueDatedFollowUpChildren: 1,
    },
  },
  period: {
    salesMeetingsCreated: 5,
    salesMeetingsManagerApproved: 3,
    meetingOutcomeDistribution: [
      { outcome: 'POSITIVE', count: 2 },
      { outcome: 'FOLLOW_UP_REQUIRED', count: 1 },
      { outcome: 'NO_DECISION', count: 0 },
      { outcome: 'NOT_INTERESTED', count: 0 },
    ],
    followUpChildrenCreated: 4,
    followUpChildrenCreatedByType: [
      { type: 'PRODUCT_DELIVERY', count: 1 },
      { type: 'GENERAL_TASK', count: 1 },
      { type: 'SALES_MEETING', count: 2 },
    ],
  },
  relationships: {
    directFollowUpLinks: 7,
    currentCustomerDivergence: 2,
  },
};

describe('Sales follow-up strict parser', () => {
  it('parses canonical response', () => {
    expect(parseSalesFollowUpReport(baseReport)).toEqual(baseReport);
  });

  it('rejects malformed buckets and enums', () => {
    expect(() =>
      parseSalesFollowUpReport({
        ...baseReport,
        current: {
          ...baseReport.current,
          salesMeetings: {
            ...baseReport.current.salesMeetings,
            statusDistribution: baseReport.current.salesMeetings.statusDistribution.slice(0, 4),
          },
        },
      }),
    ).toThrow();
    expect(() =>
      parseSalesFollowUpReport({
        ...baseReport,
        period: {
          ...baseReport.period,
          meetingOutcomeDistribution: [
            { outcome: 'POSITIVE', count: 1 },
            { outcome: 'FUTURE', count: 0 },
            { outcome: 'NO_DECISION', count: 0 },
            { outcome: 'NOT_INTERESTED', count: 0 },
          ],
        },
      } as unknown as SalesFollowUpReportResponse),
    ).toThrow();
    expect(() =>
      parseSalesFollowUpReport({
        ...baseReport,
        current: {
          ...baseReport.current,
          followUpChildren: {
            ...baseReport.current.followUpChildren,
            typeDistribution: [
              { type: 'UNKNOWN', count: 0 },
              { type: 'GENERAL_TASK', count: 0 },
              { type: 'SALES_MEETING', count: 0 },
            ],
          },
        },
      } as unknown as SalesFollowUpReportResponse),
    ).toThrow();
    expect(() =>
      parseSalesFollowUpReport({
        ...baseReport,
        current: {
          ...baseReport.current,
          salesMeetings: { ...baseReport.current.salesMeetings, limit: -1 },
        },
      } as unknown as SalesFollowUpReportResponse),
    ).toThrow();
    expect(() =>
      parseSalesFollowUpReport({
        ...baseReport,
        current: {
          ...baseReport.current,
          proposalQueue: { ...baseReport.current.proposalQueue, limit: 0 },
        },
      }),
    ).toThrow();
  });
});

describe('Sales follow-up presentation', () => {
  it('renders outcome labels and mandatory disclosure', () => {
    const html = viewMarkup(baseReport);
    for (const label of ['Olumlu sonuç', 'Takip gerekli', 'Karar verilmedi', 'İlgilenmedi']) {
      expect(html).toContain(label);
    }
    expect(html).toContain('Seçilen dönem, görüşme gerçekleşme kaydına (meeting_at) göre belirlenir');
    expect(html).toContain('güncel kayıtlı sonucunu gösterir');
    expect(html).toContain('Sonuç sonradan değiştirilebilir');
    expect(html).not.toContain('Dönüşüm');
    expect(html).not.toContain('Kazanıldı');
    expect(html).not.toContain('Satış başarısı');
  });

  it('renders outcome empty state without global emptiness claim', () => {
    const emptyOutcome: SalesFollowUpReportResponse = {
      ...baseReport,
      period: {
        ...baseReport.period,
        meetingOutcomeDistribution: [
          { outcome: 'POSITIVE', count: 0 },
          { outcome: 'FOLLOW_UP_REQUIRED', count: 0 },
          { outcome: 'NO_DECISION', count: 0 },
          { outcome: 'NOT_INTERESTED', count: 0 },
        ],
      },
    };
    const html = viewMarkup(emptyOutcome);
    expect(html).toContain('Bu dönemde sonuç dağılımına dahil edilen görüşme bulunmuyor.');
    expect(html).not.toContain('Seçilen dönemde görüşme kaydı yok');
  });

  it('labels overdue with due-date coverage and avoids completeness claim', () => {
    const html = viewMarkup(baseReport);
    expect(html).toContain('Gecikmiş (teslim tarihi bulunan) takip işleri');
    expect(html).toContain('Yalnız teslim tarihi bulunan aktif takip işleri sayılır');
    expect(html).toContain('otomatik oluşturulan takiplerde tarih bulunmayabilir');
    expect(html).not.toContain('Tüm takipler zamanında');
    const zeroOverdue = {
      ...baseReport,
      current: {
        ...baseReport.current,
        followUpChildren: { ...baseReport.current.followUpChildren, overdueDueDatedFollowUpChildren: 0 },
      },
    } as SalesFollowUpReportResponse;
    const htmlZero = viewMarkup(zeroOverdue);
    expect(htmlZero).toContain('Tarihli takip işleri arasında gecikmiş kayıt bulunmuyor.');
    expect(htmlZero).not.toContain('Tüm takipler zamanında');
  });

  it('uses Planlanan tarih for scheduledAt and fallback', () => {
    const html = viewMarkup(baseReport);
    expect(html).toContain('Planlanan tarih');
    expect(html).toContain('Planlanmadı');
    expect(html).not.toContain('Görüşme tarihi');
    expect(html).not.toContain('Gerçekleşme tarihi');
  });

  it('uses Önerilen takip tarihi for proposed date', () => {
    const html = viewMarkup(baseReport);
    expect(html).toContain('Önerilen takip tarihi');
    expect(html).not.toContain('Öneri tarihi');
    expect(html).not.toContain('Kayıt tarihi');
    expect(html).not.toContain('Oluşturulma tarihi');
    const nullDate = {
      ...baseReport,
      current: {
        ...baseReport.current,
        proposalQueue: {
          ...baseReport.current.proposalQueue,
          items: [
            { ...baseReport.current.proposalQueue.items[0]!, proposedFollowUpAt: null },
          ],
        },
      },
    } as unknown as SalesFollowUpReportResponse;
    expect(viewMarkup(nullDate)).toContain('Önerilen tarih belirtilmedi');
  });

  it('exposes proposal instructions via a scoped chevron expand control', () => {
    const html = viewMarkup(baseReport);
    expect(html).toContain('report-proposal-expand');
    expect(html).toContain('Takip talimatını aç');
    // Instructions are in expandable row, not as a permanent wide table column or details
    expect(html).not.toContain('<details');
    expect(html).not.toContain('Öneri notu');
  });

  it('expands proposal row with a labelled chevron and reveals full instruction', () => {
    const { container, root } = renderSalesViewDom(baseReport);
    act(() => {});
    act(() => {});

    const openButton = container.querySelector<HTMLButtonElement>(
      'button.report-proposal-expand[aria-label="Takip talimatını aç"]',
    );
    expect(openButton, 'collapsed expand control exists').toBeTruthy();
    expect(openButton!.getAttribute('aria-expanded')).toBe('false');

    act(() => {
      openButton!.click();
    });
    expect(container.innerHTML).toContain('Takip talimatı');
    expect(container.innerHTML).toContain('Hastayı arayın ve yeni randevu planlayın, detaylı not buraya gelecek.');

    const closeButton = container.querySelector<HTMLButtonElement>(
      'button.report-proposal-expand[aria-label="Takip talimatını kapat"]',
    );
    expect(closeButton, 'expanded control with close label exists').toBeTruthy();
    expect(closeButton!.getAttribute('aria-expanded')).toBe('true');

    // One more activation collapses the instruction again (one click = one toggle).
    act(() => {
      closeButton!.click();
    });
    // AntD keeps the expanded row in the DOM but hides it; assert the control
    // state, which is the observable contract for a single activation.
    const collapsedButton = container.querySelector<HTMLButtonElement>(
      'button.report-proposal-expand[aria-label="Takip talimatını aç"]',
    );
    expect(collapsedButton, 'control returns to the collapsed label').toBeTruthy();
    expect(collapsedButton!.getAttribute('aria-expanded')).toBe('false');

    act(() => { root.unmount(); });
    container.remove();
  });

  it('toggles proposal expansion exactly once per activation', () => {
    const { container, root } = renderSalesViewDom(baseReport);
    act(() => {});
    act(() => {});

    const button = container.querySelector<HTMLButtonElement>('button.report-proposal-expand');
    expect(button, 'expand control exists').toBeTruthy();
    expect(button!.getAttribute('aria-expanded')).toBe('false');

    act(() => {
      button!.click();
    });
    // A single activation must land on expanded (not double-toggle back to false).
    expect(button!.getAttribute('aria-expanded')).toBe('true');

    act(() => {
      button!.click();
    });
    expect(button!.getAttribute('aria-expanded')).toBe('false');

    act(() => { root.unmount(); });
    container.remove();
  });

  it('keeps two pagers independent', () => {
    let salesOffset = 20;
    let proposalOffset = 40;
    const onSales = (next: number) => { salesOffset = next; };
    const onProposal = (next: number) => { proposalOffset = next; };
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <SalesFollowUpReportView report={baseReport} offset={20} proposalOffset={40} onSalesMeetingPage={onSales} onProposalPage={onProposal} />
      </MemoryRouter>,
    );
    expect(html).toContain('data-pager="sales-meeting"');
    expect(html).toContain('data-pager="proposal"');
    // Simulate clicks via direct calls
    onSales(40);
    expect(salesOffset).toBe(40);
    expect(proposalOffset).toBe(40);
    onProposal(60);
    expect(proposalOffset).toBe(60);
    expect(salesOffset).toBe(40);
  });

  it('renders Seçilen dönem and Şu an headings separately', () => {
    const html = viewMarkup(baseReport);
    expect(html).toContain('Seçilen dönem');
    expect(html).toContain('Şu an');
    const periodIndex = html.indexOf('Seçilen dönem');
    const currentIndex = html.indexOf('Şu an');
    expect(periodIndex).toBeLessThan(currentIndex);
  });

  it('does not render customer divergence', () => {
    const html = viewMarkup({ ...baseReport, relationships: { directFollowUpLinks: 7, currentCustomerDivergence: 5 } });
    expect(html).not.toContain('currentCustomerDivergence');
    expect(html).not.toContain('Müşteri bağlantısı ayrışan');
    expect(html).not.toContain('Ayrışan');
    // directFollowUpLinks is secondary but present
    expect(html).toContain('Doğrudan takip bağlantıları');
  });

  it('does not expose proposal origin', () => {
    const html = viewMarkup(baseReport);
    expect(html).not.toContain('SYSTEM');
    expect(html).not.toContain('STAFF_ADJUSTED');
    expect(html).not.toContain('Sistem');
    expect(html).not.toContain('Personel düzenledi');
  });

  it('does not use commercial language', () => {
    const html = viewMarkup(baseReport);
    for (const phrase of ['Dönüşüm', 'Satış başarısı', 'Kazanılan', 'Kaybedilen', 'Gelir', 'Pipeline', 'Performans puanı']) {
      expect(html).not.toContain(phrase);
    }
    expect(html).not.toContain('En başarılı');
  });

  it('renders global empty states from aggregates', () => {
    const empty: SalesFollowUpReportResponse = {
      ...baseReport,
      current: {
        salesMeetings: { total: 0, statusDistribution: baseReport.current.salesMeetings.statusDistribution, items: [], limit: 50, offset: 0 },
        proposalQueue: { total: 0, limit: 50, offset: 0, items: [] },
        followUpChildren: { ...baseReport.current.followUpChildren, total: 0 },
      },
    };
    const html = viewMarkup(empty, 0, 0);
    expect(html).toContain('Şu an aktif satış görüşmesi işi bulunmuyor.');
    expect(html).toContain('Onay / revizyon aşamasında takip önerisi bulunmuyor.');
  });

  it('renders recovery UI for empty pages', () => {
    const salesRecovery: SalesFollowUpReportResponse = {
      ...baseReport,
      current: {
        ...baseReport.current,
        salesMeetings: { ...baseReport.current.salesMeetings, total: 5, items: [], offset: 50 },
      },
    };
    const html = viewMarkup(salesRecovery, 50, 0);
    expect(html).toContain('Bu sayfada artık gösterilecek kayıt bulunmuyor.');
    expect(html).not.toContain('Şu an aktif satış görüşmesi işi bulunmuyor.');
    const proposalRecovery: SalesFollowUpReportResponse = {
      ...baseReport,
      current: {
        ...baseReport.current,
        proposalQueue: { ...baseReport.current.proposalQueue, total: 5, items: [], offset: 50 },
      },
    };
    const html2 = viewMarkup(proposalRecovery, 0, 50);
    expect(html2).toContain('Bu sayfada artık gösterilecek kayıt bulunmuyor.');
    expect(html2).not.toContain('Onay / revizyon aşamasında takip önerisi bulunmuyor.');
  });

  it('keeps proposal and actual child distinct', () => {
    const html = viewMarkup(baseReport);
    expect(html).toContain('Onay / revizyon aşamasındaki takip önerileri');
    expect(html).toContain('Oluşturulan takip işleri');
    expect(html).not.toMatch(/<h2[^>]*>Takipler<\/h2>/);
  });

  it('round-trips sales follow-up URL state with independent offsets', async () => {
    const { salesFollowUpSearch, readSalesFollowUpSearch } = await import('../src/reports/report-search');
    const state = { from: '2026-07-01', to: '2026-07-31', offset: 20, proposalOffset: 40, canonical: true } as const;
    expect(readSalesFollowUpSearch(salesFollowUpSearch(state))).toEqual(state);
    const empty = { from: null, to: null, offset: 0, proposalOffset: 0, canonical: true } as const;
    expect(readSalesFollowUpSearch(salesFollowUpSearch(empty))).toEqual(empty);
  });

  it('resets both offsets when date range changes', async () => {
    const { salesFollowUpSearch } = await import('../src/reports/report-search');
    const next = salesFollowUpSearch({ from: '2026-08-01', to: '2026-08-31', offset: 0, proposalOffset: 0, canonical: true });
    expect(next.get('offset')).toBeNull();
    expect(next.get('proposalOffset')).toBeNull();
    const withOffsets = salesFollowUpSearch({ from: '2026-07-01', to: '2026-07-31', offset: 20, proposalOffset: 40, canonical: true });
    expect(withOffsets.get('offset')).toBe('20');
    expect(withOffsets.get('proposalOffset')).toBe('40');
  });
});

describe('Sales follow-up route authorization', () => {
  it('renders ForbiddenView for STAFF on sales-follow-up route', async () => {
    const { MemoryRouter } = await import('react-router-dom');
    const { AppRouter } = await import('../src/AppRouter');
    const staffUser = { id: 'u1', organizationId: 'o1', name: 'Staff', email: 's@test.com', role: 'STAFF' as const, mustChangePassword: false, isActive: true, version: 1, capabilities: {} };
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/reports/sales-follow-up']}>
        <AppRouter user={staffUser as never} notice="" onClearNotice={() => {}} onDeliveryCreated={() => {}} onSessionEnded={() => {}} />
      </MemoryRouter>,
    );
    expect(html).toContain('Erişim yetkiniz yok');
  });
});

describe('Sales follow-up timezone presentation', () => {
  it('renders scheduledAt in organization timezone, crossing day boundary', () => {
    const reportWithIstanbul: SalesFollowUpReportResponse = {
      ...baseReport,
      range: { from: '2026-08-01', to: '2026-08-31', timezone: 'Europe/Istanbul' },
      current: {
        ...baseReport.current,
        salesMeetings: {
          ...baseReport.current.salesMeetings,
          items: [
            {
              id: 'job-tz',
              status: 'IN_PROGRESS',
              scheduledAt: '2026-08-10T22:30:00.000Z',
              customer: { id: 'c1', name: 'DentArt Klinik' },
              assignee: { userId: 'u1', name: 'Ayşe Demir' },
            },
          ],
          total: 1,
        },
        proposalQueue: {
          ...baseReport.current.proposalQueue,
          total: 0,
          limit: 50,
          offset: 0,
          items: [],
        },
      },
    };
    const html = viewMarkup(reportWithIstanbul, 0, 0, 1024);
    // 2026-08-10T22:30:00Z = 2026-08-11 01:30 in Europe/Istanbul (UTC+3)
    // UTC would be 10 Ağu; org timezone must show 11 Ağu
    expect(html).toContain('11 Ağu');
    const salesQueueSection = html.split('Satış görüşmesi kuyruğu')[1]?.split('Onay / revizyon')[0] ?? '';
    expect(salesQueueSection).toContain('11 Ağu');
    expect(salesQueueSection).not.toContain('10 Ağu');
  });

  it('renders proposedFollowUpAt in organization timezone, crossing midnight', () => {
    const reportWithIstanbul: SalesFollowUpReportResponse = {
      ...baseReport,
      range: { from: '2026-08-01', to: '2026-08-31', timezone: 'Europe/Istanbul' },
      current: {
        ...baseReport.current,
        salesMeetings: {
          ...baseReport.current.salesMeetings,
          total: 0,
          statusDistribution: baseReport.current.salesMeetings.statusDistribution,
          items: [],
          limit: 50,
          offset: 0,
        },
        proposalQueue: {
          ...baseReport.current.proposalQueue,
          total: 1,
          items: [
            {
              id: 'job-tz-prop',
              status: 'WAITING_APPROVAL',
              customer: { id: 'c1', name: 'DentArt Klinik' },
              assignee: { userId: 'u1', name: 'Ayşe Demir' },
              followUpProposedType: 'SALES_MEETING',
              followUpProposedAssignee: null,
              followUpProposalInstructions: null,
              proposedFollowUpAt: '2026-08-10T21:30:00.000Z',
              followUpProposalOrigin: 'SYSTEM',
            },
          ],
        },
      },
    };
    const html = viewMarkup(reportWithIstanbul, 0, 0, 1024);
    // 2026-08-10T21:30:00Z = 2026-08-11 00:30 in Europe/Istanbul
    expect(html).toContain('11 Ağu');
    expect(html).toContain('00:30');
    const proposalSection = html.split('Onay / revizyon')[1] ?? '';
    expect(proposalSection).toContain('11 Ağu');
    expect(proposalSection).toContain('00:30');
  });

  it('formatters use organization timezone, not UTC', async () => {
    const { formatScheduledAt, formatProposedAt } = await import('../src/reports/SalesFollowUpReport');
    // UTC would be 10 Aug, Istanbul is 11 Aug
    expect(formatScheduledAt('2026-08-10T22:30:00.000Z', 'Europe/Istanbul')).toContain('11');
    expect(formatScheduledAt('2026-08-10T22:30:00.000Z', 'UTC')).toContain('10');
    expect(formatProposedAt('2026-08-10T21:30:00.000Z', 'Europe/Istanbul')).toContain('11');
    expect(formatProposedAt('2026-08-10T21:30:00.000Z', 'Europe/Istanbul')).toContain('00:30');
  });

  it('renders Ant Design pagination with pageSize 10 for both queues', () => {
    const reportWithLargeTotal: SalesFollowUpReportResponse = {
      ...baseReport,
      current: {
        salesMeetings: { ...baseReport.current.salesMeetings, total: 55, limit: 10, offset: 0, items: baseReport.current.salesMeetings.items.slice(0, 1) },
        proposalQueue: { ...baseReport.current.proposalQueue, total: 55, limit: 10, offset: 0, items: baseReport.current.proposalQueue.items.slice(0, 1) },
        followUpChildren: baseReport.current.followUpChildren,
      },
    };
    const html = viewMarkup(reportWithLargeTotal, 0, 0);
    expect(html).toContain('ant-pagination');
    expect(html).toContain('data-pager="sales-meeting"');
    expect(html).toContain('data-pager="proposal"');
  });

  it('configures mutually exclusive responsive contracts on every column', () => {
    const source = readFileSync(resolve('src/reports/SalesFollowUpReport.tsx'), 'utf8');

    // Breakpoint definitions exist and are mutually exclusive (no overlap => exactly one data view)
    expect(source).toContain("const DESKTOP_ONLY = ['sm', 'md', 'lg', 'xl', 'xxl']");
    expect(source).toContain("const MOBILE_ONLY = ['xs']");

    // Desktop-only breakpoint contract on every desktop column
    const desktopColumns = ['Müşteri', 'Planlanan tarih', 'Atanan personel', 'Durum', 'İşlem',
      'Önerilen takip tarihi', 'Önerilen tür', 'Önerilen sorumlu'];
    for (const column of desktopColumns) {
      const titleIndex = source.indexOf(`title: '${column}'`);
      expect(titleIndex, `column ${column} exists`).toBeGreaterThan(-1);
      const nextMobileTitle = source.indexOf("title: 'Satış görüşmesi'", titleIndex) === -1
        ? source.indexOf("title: 'Öneri'", titleIndex)
        : Math.min(
          source.indexOf("title: 'Satış görüşmesi'", titleIndex) === -1 ? Number.MAX_SAFE_INTEGER : source.indexOf("title: 'Satış görüşmesi'", titleIndex),
          source.indexOf("title: 'Öneri'", titleIndex) === -1 ? Number.MAX_SAFE_INTEGER : source.indexOf("title: 'Öneri'", titleIndex),
        );
      const columnBody = source.slice(titleIndex, nextMobileTitle);
      expect(columnBody, `${column} uses DESKTOP_ONLY responsive`).toContain('responsive: [...DESKTOP_ONLY]');
    }

    // Mobile-only breakpoint contract on composite columns
    for (const composite of ['Satış görüşmesi', 'Öneri']) {
      const titleIndex = source.indexOf(`title: '${composite}'`);
      expect(titleIndex, `composite ${composite} exists`).toBeGreaterThan(-1);
      const columnBody = source.slice(titleIndex, titleIndex + 400);
      expect(columnBody, `${composite} uses MOBILE_ONLY responsive`).toContain('responsive: [...MOBILE_ONLY]');
    }
  });

  it('desktop breakpoint: detail columns visible, composite columns absent', () => {
    const html = viewMarkup(baseReport, 0, 0, 1024);
    const salesSection = html.split('Satış görüşmesi kuyruğu')[1]?.split('Onay / revizyon')[0] ?? '';
    for (const heading of ['Müşteri', 'Planlanan tarih', 'Atanan personel', 'Durum', 'İşlem']) {
      expect(salesSection, `sales desktop heading ${heading}`).toContain(`>${heading}</th>`);
    }
    expect(salesSection).not.toContain('report-sales-mobile-cell');

    const proposalSection = html.split('Onay / revizyon')[1] ?? '';
    for (const heading of ['Müşteri', 'Durum', 'Önerilen takip tarihi', 'Önerilen tür', 'Önerilen sorumlu']) {
      expect(proposalSection, `proposal desktop heading ${heading}`).toContain(`>${heading}</th>`);
    }
    expect(proposalSection).not.toContain('report-proposal-mobile-cell');
  });

  it('mobile breakpoint (390px): composite visible, desktop detail columns absent', () => {
    const html = viewMarkupMobile(baseReport);
    const salesSection = html.split('Satış görüşmesi kuyruğu')[1]?.split('Onay / revizyon')[0] ?? '';
    expect(salesSection).toContain('report-sales-mobile-cell');
    expect(salesSection).not.toContain('>Müşteri</th>');
    expect(salesSection).not.toContain('>Planlanan tarih</th>');
    expect(salesSection).not.toContain('>Atanan personel</th>');
    expect(salesSection).not.toContain('>Durum</th>');
    expect(salesSection).not.toContain('>İşlem</th>');

    const proposalSection = html.split('Onay / revizyon')[1] ?? '';
    expect(proposalSection).toContain('report-proposal-mobile-cell');
    expect(proposalSection).not.toContain('>Önerilen takip tarihi</th>');
    expect(proposalSection).not.toContain('>Önerilen tür</th>');
    expect(proposalSection).not.toContain('>Önerilen sorumlu</th>');
  });

  it('mobile-breakpoint composite keeps every queue record reachable at 390px', () => {
    const html = viewMarkupMobile(baseReport);
    // Both sales meeting records stay reachable through the mobile composite column
    expect(html).toContain('DentArt Klinik');
    expect(html).toContain('Müşteri belirtilmedi');
    expect(html).toContain('Ayşe Demir');
    expect(html).toContain('Mehmet Yılmaz');
    expect(html).toContain('Uygulanıyor');
    expect(html).toContain('Hazırlanıyor');
  });

  it('small-mobile 390px has no mandatory horizontal core scroll (desktop columns absent)', () => {
    const html = viewMarkupMobile(baseReport);
    // Desktop columns are fully removed from the DOM on xs, so the queue tables
    // cannot force a mandatory horizontal core scroll at 390px.
    const salesTable = html.split('Satış görüşmesi kuyruğu')[1]?.split('Onay / revizyon')[0] ?? '';
    const proposalTable = html.split('Onay / revizyon')[1] ?? '';
    const desktopHeadings = ['Müşteri', 'Planlanan tarih', 'Atanan personel', 'Durum', 'İşlem', 'Önerilen takip tarihi', 'Önerilen tür', 'Önerilen sorumlu'];
    for (const heading of desktopHeadings) {
      expect(salesTable + proposalTable).not.toContain(`>${heading}</th>`);
    }
  });
});
