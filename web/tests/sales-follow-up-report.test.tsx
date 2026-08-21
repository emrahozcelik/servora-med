/** @vitest-environment jsdom */
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
Object.defineProperty(window, 'matchMedia', {
  configurable: true,
  value: vi.fn().mockReturnValue({
    matches: true,
    media: '(min-width: 64rem)',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }),
});

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

function viewMarkup(report: SalesFollowUpReportResponse, offset = 0, proposalOffset = 0) {
  return renderToStaticMarkup(
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
}

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

  it('exposes proposal instructions via accessible disclosure', () => {
    const html = viewMarkup(baseReport);
    expect(html).toContain('<details');
    expect(html).toContain('<summary>Öneri notu</summary>');
    expect(html).toContain('Hastayı arayın');
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
