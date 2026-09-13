import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CustomerDetailView } from '../src/CustomerDetail';
import type { CurrentUser } from '../src/services/api';
import {
  getCustomerOperationalSummary,
  type CustomerDetail,
  type CustomerOperationalSummary,
} from '../src/services/crm-api';

afterEach(() => vi.unstubAllGlobals());

const manager: CurrentUser = { id: 'manager-1', organizationId: 'org-1', name: 'Murat', email: 'murat@example.com', role: 'MANAGER', mustChangePassword: false, isActive: true, version: 1 };
const staff: CurrentUser = { ...manager, id: 'staff-1', role: 'STAFF' };

const customer: CustomerDetail = {
  id: 'customer-1', organizationId: 'org-1', name: 'Demo Dental Klinik', customerType: 'clinic', taxNumber: null,
  phone: null, email: null, city: null, district: null, address: null,
  assignedStaffUserId: 'staff-1', assignedStaffName: 'Ayşe Personel', status: 'active', version: 3,
  primaryContact: null, contacts: [], hasOperationHistory: true,
  openJobCount: 2, completedJobCount: 3,
};

const summary: CustomerOperationalSummary = {
  latestInteraction: { jobCardId: 'job-latest', title: 'Teslimat 1', type: 'PRODUCT_DELIVERY',
    completedAt: '2026-08-01T09:00:00.000Z', assignee: { id: 'staff-1', name: 'Ayşe Personel' } },
  nextPlannedWork: { jobCardId: 'job-next', title: 'Revizyonlu İş', type: 'GENERAL_TASK',
    status: 'REVISION_REQUESTED', scheduledAt: '2026-08-05T09:00:00.000Z',
    assignee: { id: 'staff-1', name: 'Ayşe Personel' } },
  pendingReview: { waitingApprovalCount: 1, revisionRequestedCount: 2 },
  latestMeetingOutcome: { jobCardId: 'job-meeting', meetingAt: '2026-08-02T10:00:00.000Z',
    outcome: 'POSITIVE', unsuccessfulReason: null, meetingSummary: 'Olumlu geçti', nextFollowUpAt: null },
  followUp: { jobCardId: 'job-follow', kind: 'FOLLOW_UP_JOB' },
};

const emptySummary: CustomerOperationalSummary = {
  latestInteraction: null, nextPlannedWork: null,
  pendingReview: { waitingApprovalCount: 0, revisionRequestedCount: 0 },
  latestMeetingOutcome: null, followUp: null,
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function render(user: CurrentUser, props: {
  summary?: CustomerOperationalSummary | null; summaryLoading?: boolean; summaryError?: string;
} = { summary }) {
  return renderToStaticMarkup(<MemoryRouter><CustomerDetailView customer={customer}
    user={user} staff={[]} pending={false} error="" notice=""
    onBack={() => {}} onSave={() => {}} onCreateContact={() => {}}
    historyStatus="all" historyPage={{ items: [], total: 0, limit: 20, offset: 0 }}
    historyLoading={false} historyError="" onHistoryStatusChange={() => {}} onHistoryPageChange={() => {}}
    summary={props.summary ?? null} summaryLoading={props.summaryLoading ?? false}
    summaryError={props.summaryError ?? ''} /></MemoryRouter>);
}

describe('Customer operational summary transport', () => {
  it('fetches the dedicated endpoint and validates the summary DTO', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(summary));
    vi.stubGlobal('fetch', fetchMock);
    await expect(getCustomerOperationalSummary('customer-1')).resolves.toEqual(summary);
    expect(fetchMock).toHaveBeenCalledWith('/api/customers/customer-1/operational-summary', expect.objectContaining({}));
  });

  it('rejects a summary payload with invalid pending counts', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ...summary, pendingReview: { waitingApprovalCount: 'x' } })));
    await expect(getCustomerOperationalSummary('customer-1')).rejects.toThrow();
  });
});

describe('Customer operational summary section', () => {
  it('renders all five concepts with JobCard navigation links', () => {
    const html = render(manager);
    for (const text of ['Operasyonel özet', 'Son etkileşim', 'Teslimat 1', 'Sonraki planlı iş', 'Revizyonlu İş',
      'Onay durumu', 'Onay bekleyen iş (1)', 'Revizyon bekleyen iş (2)', 'Son görüşme sonucu', 'Olumlu',
      'Takip bağlantısı', 'Takip işini aç']) expect(html).toContain(text);
    for (const id of ['job-latest', 'job-next', 'job-meeting', 'job-follow']) {
      expect(html).toContain(`/jobs/${id}`);
    }
  });

  it('renders the empty summary without fabricated placeholders', () => {
    const html = render(manager, { summary: emptySummary });
    for (const text of ['Tamamlanmış etkileşim yok', 'Planlı iş yok', 'Onay bekleyen iş yok',
      'Revizyon bekleyen iş yok', 'Tamamlanmış görüşme sonucu yok', 'Aktif takip bağlantısı yok']) {
      expect(html).toContain(text);
    }
    expect(html).not.toContain('/jobs/');
  });

  it('renders source-kind follow-up links distinctly', () => {
    const html = render(manager, { summary: { ...summary, followUp: { jobCardId: 'job-source', kind: 'SOURCE_JOB' } } });
    expect(html).toContain('Kaynak işi aç');
    expect(html).toContain('/jobs/job-source');
  });

  it('keeps section-local loading and error states', () => {
    expect(render(manager, { summary: null, summaryLoading: true })).toContain('Operasyonel özet yükleniyor');
    const errorHtml = render(manager, { summary: null, summaryError: 'Özet yüklenemedi.' });
    expect(errorHtml).toContain('Özet yüklenemedi.');
    expect(errorHtml).toContain('Demo Dental Klinik');
    expect(errorHtml).toContain('İş geçmişi');
  });

  it('renders the server projection as-is for STAFF without reconstructing hidden data', () => {
    const html = render(staff, { summary: emptySummary });
    expect(html).toContain('Demo Dental Klinik');
    expect(html).toContain('Aktif takip bağlantısı yok');
    expect(html).not.toContain('Bilgileri kaydet');
  });
});
