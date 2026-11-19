import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { SalesFollowUpReportView } from '../src/reports/SalesFollowUpReport';
import type {
  SalesFollowUpProposalQueueItem,
  SalesFollowUpQueueItem,
  SalesFollowUpReportResponse,
} from '../src/reports/report-types';
import { ReportDateRangeForm, ReportShell } from '../src/reports/report-shell';
import { ServoraAntProvider } from '../src/ui/antd';
import '../src/styles.css';

// Rendered-evidence fixture for UI audit F-10 on /reports/sales-follow-up.
// Both queues page on the server at ten records per page; this harness keeps
// the offsets in local state and slices a fixed synthetic dataset, so the real
// SalesFollowUpReportView, its tables and its owned pager render unmodified.
// Data is fictional medical/dental B2B work and never leaves the browser.

const PAGE_SIZE = 10;
const range = { from: '2026-11-02', to: '2026-11-15', timezone: 'Europe/Istanbul' };

const STATUSES = ['NEW', 'ACCEPTED', 'IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED'] as const;
const TYPES = ['SALES_MEETING', 'PRODUCT_DELIVERY', 'GENERAL_TASK', 'SALE'] as const;
const OUTCOMES = ['POSITIVE', 'FOLLOW_UP_REQUIRED', 'NO_DECISION', 'NOT_INTERESTED'] as const;

const CUSTOMERS = [
  'DentArt Klinik',
  'Marmara Ağız Sağlığı Poliklinik',
  'Ege Dental Merkez',
  'Akdeniz Diş Kliniği',
  'Başkent Oral Care',
  'Bursa Protez Laboratuvarı',
  'Konya Ağız ve Diş Sağlığı',
  'Trakya Dental Grup',
  'İzmir Smile Clinic',
  'Anadolu Dental Sistemleri',
];
const STAFF = [
  { userId: 'u1', name: 'Ayşe Demir' },
  { userId: 'u2', name: 'Mehmet Yılmaz' },
  { userId: 'u3', name: 'Zeynep Kaya' },
];

const SALES_TOTAL = 25;
const PROPOSAL_TOTAL = 13;

function customerAt(index: number) {
  if (index === 7) return null;
  const name = CUSTOMERS[index % CUSTOMERS.length]!;
  return { id: `c${(index % CUSTOMERS.length) + 1}`, name };
}

const salesMeetings: SalesFollowUpQueueItem[] = Array.from({ length: SALES_TOTAL }, (_, index) => ({
  id: `sales-job-${index + 1}`,
  status: STATUSES[index % STATUSES.length]!,
  scheduledAt: index % 6 === 5 ? null : `2026-11-${String(2 + (index % 13)).padStart(2, '0')}T09:30:00.000Z`,
  customer: customerAt(index),
  assignee: STAFF[index % STAFF.length]!,
}));

const proposals: SalesFollowUpProposalQueueItem[] = Array.from({ length: PROPOSAL_TOTAL }, (_, index) => ({
  id: `proposal-job-${index + 1}`,
  status: index % 3 === 0 ? 'REVISION_REQUESTED' : 'WAITING_APPROVAL',
  customer: customerAt(index + 2),
  assignee: STAFF[index % STAFF.length]!,
  followUpProposedType: TYPES[index % TYPES.length]!,
  followUpProposedAssignee: index % 5 === 4 ? null : STAFF[(index + 1) % STAFF.length]!,
  followUpProposalInstructions: index % 4 === 3
    ? null
    : `Klinikle telefonda görüşülüp yeni randevu planlanacak; ${index + 1}. kayıt için ürün numuneleri de bırakılacak.`,
  proposedFollowUpAt: `2026-11-${String(16 + (index % 12)).padStart(2, '0')}T11:00:00.000Z`,
  followUpProposalOrigin: index % 2 === 0 ? 'SYSTEM' : 'STAFF_ADJUSTED',
}));

function buildReport(offset: number, proposalOffset: number): SalesFollowUpReportResponse {
  return {
    range,
    current: {
      salesMeetings: {
        total: SALES_TOTAL,
        statusDistribution: STATUSES.map((status, index) => ({ status, count: index === 0 ? 6 : 4 + index })),
        items: salesMeetings.slice(offset, offset + PAGE_SIZE),
        limit: PAGE_SIZE,
        offset,
      },
      proposalQueue: {
        total: PROPOSAL_TOTAL,
        limit: PAGE_SIZE,
        offset: proposalOffset,
        items: proposals.slice(proposalOffset, proposalOffset + PAGE_SIZE),
      },
      followUpChildren: {
        total: 18,
        statusDistribution: STATUSES.map((status, index) => ({ status, count: index === 0 ? 5 : 3 })),
        typeDistribution: TYPES.map((type, index) => ({ type, count: index === 3 ? 1 : 5 })),
        overdueDueDatedFollowUpChildren: 3,
      },
    },
    period: {
      salesMeetingsCreated: 21,
      salesMeetingsManagerApproved: 14,
      meetingOutcomeDistribution: OUTCOMES.map((outcome, index) => ({ outcome, count: index === 0 ? 9 : 4 })),
      followUpChildrenCreated: 11,
      followUpChildrenCreatedByType: TYPES.map((type, index) => ({ type, count: [4, 3, 3, 1][index]! })),
    },
    relationships: { directFollowUpLinks: 16, currentCustomerDivergence: 2 },
  };
}

function Fixture() {
  const [offset, setOffset] = useState(0);
  const [proposalOffset, setProposalOffset] = useState(0);
  const errorRef = useRef<HTMLDivElement>(null);
  const report = buildReport(offset, proposalOffset);
  return (
    <MemoryRouter>
      <ServoraAntProvider>
        <div className={`authenticated-shell authenticated-shell--${innerWidth >= 1024 ? 'desktop' : 'mobile'}`}>
          {innerWidth >= 1024 ? (
            <aside className="shell-sidebar">
              <div className="brand-lockup">
                <a className="dunya-dental-brand dunya-dental-brand--full" href="/" aria-label="Dünya Dental">
                  <img alt="" src="/branding/dunya-dental-sidebar.png" />
                </a>
              </div>
              <nav className="shell-nav" aria-label="Ana navigasyon">
                <a href="/jobs">İşler</a>
                <a href="/customers">Müşteriler</a>
                <a href="/products">Ürünler</a>
                <a href="/" aria-current="page">Raporlar</a>
                <a href="/staff">Personel</a>
              </nav>
            </aside>
          ) : (
            <header className="compact-shell-header mobile-top-bar">
              <div className="mobile-top-bar-start"><p className="mobile-shell-title">Raporlar</p></div>
              <div className="mobile-top-bar-actions"><button type="button" className="shell-menu-button">Menü</button></div>
            </header>
          )}
          <div className="shell-content">
            <ReportShell
              title="Satış ve Takip Operasyon Analizi"
              description="Örnek veriler · Tasarım doğrulaması"
              current="salesFollowUp"
              refreshLabel="17 Kas 2026 10:00"
              range={range}
            >
              <ReportDateRangeForm
                formKey="fixture"
                from={range.from}
                to={range.to}
                filterError=""
                errorRef={errorRef}
                onSubmit={(event) => event.preventDefault()}
                selectedPreset={null}
                customPresetActive
              />
              <SalesFollowUpReportView
                report={report}
                offset={offset}
                proposalOffset={proposalOffset}
                onSalesMeetingPage={setOffset}
                onProposalPage={setProposalOffset}
              />
            </ReportShell>
          </div>
        </div>
      </ServoraAntProvider>
    </MemoryRouter>
  );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
