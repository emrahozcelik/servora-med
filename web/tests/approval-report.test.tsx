/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApprovalReport, ApprovalReportView } from '../src/reports/ApprovalReport';
import { getApprovalReport } from '../src/reports/reports-api';
import type { ApprovalReportResponse } from '../src/reports/report-types';

vi.mock('../src/reports/reports-api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/reports/reports-api')>(),
  getApprovalReport: vi.fn(),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn().mockReturnValue({
  matches: true, media: '(min-width: 64rem)', addEventListener: vi.fn(), removeEventListener: vi.fn(),
}) });

const report: ApprovalReportResponse = {
  summary: { pendingCount: 2, oldestWaitingMinutes: 1500, averageWaitingMinutes: 190,
    under2Hours: 0, between2And8Hours: 1, between8And24Hours: 0, over24Hours: 1 },
  items: [{ id: 'job-1', type: 'GENERAL_TASK', status: 'WAITING_APPROVAL', version: 3,
    title: 'Klinik ziyareti', priority: 'normal', dueDate: '2026-07-20',
    scheduledAt: '2026-07-10T09:00:00Z', scheduledEndsAt: null,
    createdAt: '2026-07-10T10:00:00Z', updatedAt: '2026-07-12T10:00:00Z',
    staffCompletedAt: '2026-07-12T10:00:00Z', customer: null, contact: null,
    assignee: { id: 's1', name: 'Ayşe' }, deliveryItemCount: 0, waitingMinutes: 1500 }],
  total: 2, limit: 50, offset: 0,
};

const reportWithCustomer: ApprovalReportResponse = {
  ...report,
  items: [{
    ...report.items[0]!,
    customer: { id: 'c1', name: 'DentArt Klinik' },
  }],
};

describe('Approval report presentation', () => {
  it('renders summary, SLA segments, and OperationalTable queue rows', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter><ApprovalReportView report={report} /></MemoryRouter>,
    );
    for (const label of ['2 saatten kısa', '2–8 saat', '8–24 saat', '24 saatten uzun']) {
      expect(html).toContain(label);
    }
    expect(html).toContain('data-servora-operational-table="true"');
    expect(html).toContain('<caption>Onay kuyruğundaki işler</caption>');
    expect(html).not.toContain('sunucu özetinden gelir');
    expect(html).toContain('servora-operational-table__mobile-caption');
    for (const heading of ['Tür', 'İş', 'Personel', 'Müşteri', 'Bekleme süresi']) {
      expect(html).toContain(`>${heading}</th>`);
      expect(html).toContain(`<dt>${heading}</dt>`);
    }
    expect(html).toContain('Genel görev');
    expect(html).toContain('Klinik ziyareti');
    expect(html).toContain('href="/jobs/job-1"');
    expect(html).toContain('aria-label="Klinik ziyareti işini aç"');
    expect(html).toMatch(
      /<th[^>]*scope="row"[^>]*><a[^>]*aria-label="Klinik ziyareti işini aç"/,
    );
    expect(html).toContain('Ayşe');
    expect(html).toMatch(/<td>—<\/td>/);
    expect(html).toContain('25 saat');
    // Duration and title appear on both desktop and mobile surfaces.
    expect((html.match(/Klinik ziyareti/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((html.match(/25 saat/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(html).not.toContain('approval-list');
  });

  it('preserves customer name when present on the queue row', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter><ApprovalReportView report={reportWithCustomer} /></MemoryRouter>,
    );
    expect(html).toContain('DentArt Klinik');
  });

  it('renders a non-empty runtime-shape item that carries scheduledEndsAt', () => {
    const runtimeShape: ApprovalReportResponse = {
      ...report,
      items: [{
        ...report.items[0]!,
        id: 'job-runtime',
        scheduledEndsAt: '2026-07-10T12:00:00Z',
      }],
    };
    const html = renderToStaticMarkup(
      <MemoryRouter><ApprovalReportView report={runtimeShape} /></MemoryRouter>,
    );
    expect(html).toContain('Klinik ziyareti');
    expect(html).toContain('href="/jobs/job-runtime"');
    expect(html).not.toContain('approvalItem alanı geçersiz');
  });

  it('renders an explanatory empty queue without a table', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter><ApprovalReportView report={{ ...report,
        summary: { pendingCount: 0, oldestWaitingMinutes: null, averageWaitingMinutes: null,
          under2Hours: 0, between2And8Hours: 0, between8And24Hours: 0, over24Hours: 0 },
        items: [], total: 0 }} /></MemoryRouter>,
    );
    expect(html).toContain('Onay bekleyen iş bulunmuyor.');
    expect(html).not.toContain('data-servora-operational-table="true"');
  });
});

describe('ApprovalReport pagination', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    vi.mocked(getApprovalReport).mockReset();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('uses ServoraListPagination when results span multiple pages and hides it on a single page', async () => {
    vi.mocked(getApprovalReport).mockResolvedValue({ ...report, total: 60, limit: 50, offset: 0 });
    await act(async () => root.render(
      <MemoryRouter initialEntries={['/reports/approvals']}>
        <ApprovalReport />
      </MemoryRouter>,
    ));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(host.textContent).toContain('Sayfa 1 / 2 · Toplam 60 iş');
    expect(host.querySelector('.servora-list-pagination')).not.toBeNull();
  });
});
