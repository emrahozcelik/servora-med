import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { ApprovalReportView } from '../src/reports/ApprovalReport';
import type { ApprovalReportResponse } from '../src/reports/report-types';

const report: ApprovalReportResponse = {
  summary: { pendingCount: 2, oldestWaitingMinutes: 1500, averageWaitingMinutes: 190,
    under2Hours: 0, between2And8Hours: 1, between8And24Hours: 0, over24Hours: 1 },
  items: [{ id: 'job-1', type: 'GENERAL_TASK', status: 'WAITING_APPROVAL', version: 3,
    title: 'Klinik ziyareti', priority: 'normal', dueDate: '2026-07-20',
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
