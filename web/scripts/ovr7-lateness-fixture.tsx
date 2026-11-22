import { createRoot } from 'react-dom/client';
import { useRef } from 'react';
import { MemoryRouter } from 'react-router-dom';

import { ReportsDashboardView } from '../src/reports/ReportsDashboard';
import { LatenessSummaryCard } from '../src/reports/LatenessSummaryCard';
import { ReportDateRangeForm, ReportShell } from '../src/reports/report-shell';
import { StaffOperationalReport } from '../src/reports/StaffOperationalReport';
import type {
  DashboardReportResponse,
  OrganizationLatenessSummary,
  StaffLatenessIncidentItem,
  StaffLatenessIncidentListResponse,
  StaffReportResponse,
} from '../src/reports/report-types';
import { ServoraAntProvider } from '../src/ui/antd';
import { PageHeader } from '../src/ui/PageHeader';
import '../src/styles.css';

const range = { from: '2026-09-01', to: '2026-10-31', timezone: 'Europe/Istanbul' };
const STAFF_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ONE = '33333333-3333-4333-8333-333333333333';

const density = (value: number, count: number) => ({
  count,
  medianSeconds: count === 0 ? null : value,
  maxSeconds: count === 0 ? null : value + 600,
});
const openDensity = (value: number, count: number) => ({
  count,
  maxElapsedSeconds: count === 0 ? null : value,
});

const staffLateness: StaffReportResponse['lateness'] = {
  trackingStartedOn: '2026-09-21',
  generatedAt: '2026-11-02T09:15:00.000Z',
  staffResponsibility: {
    delayedJobCount: 5,
    incidentCount: 7,
    byType: [
      {
        delayType: 'LATE_START',
        incidentCount: 4,
        recovered: density(8_100, 2),
        extended: density(90_000, 1),
        open: openDensity(11_400, 1),
      },
      {
        delayType: 'LATE_SUBMISSION',
        incidentCount: 3,
        recovered: density(3_300, 1),
        extended: density(0, 0),
        open: openDensity(46_800, 2),
      },
    ],
  },
  operational: {
    delayedJobCount: 2,
    incidentCount: 3,
    byReason: [
      { reasonCode: 'CUSTOMER_ABSENT', incidentCount: 2 },
      { reasonCode: 'MISSING_STOCK_OR_EQUIPMENT', incidentCount: 1 },
    ],
  },
};

const emptyStaffLateness: StaffReportResponse['lateness'] = {
  ...staffLateness,
  staffResponsibility: {
    delayedJobCount: 0,
    incidentCount: 0,
    byType: [{
      delayType: 'LATE_START', incidentCount: 0,
      recovered: density(0, 0), extended: density(0, 0), open: openDensity(0, 0),
    }, {
      delayType: 'LATE_SUBMISSION', incidentCount: 0,
      recovered: density(0, 0), extended: density(0, 0), open: openDensity(0, 0),
    }],
  },
  operational: { delayedJobCount: 0, incidentCount: 0, byReason: [] },
};

export const staffReport: StaffReportResponse = {
  staff: { userId: STAFF_ID, name: 'Emrah Demir', isActive: true },
  range,
  priorRange: { from: '2026-07-01', to: '2026-08-31', timezone: range.timezone },
  performance: {
    completedJobs: 12, completionDays: 9, jobsPerCompletionDay: 12 / 9,
    correctionRequestEvents: 2, authoredOperationalNotes: 7,
  },
  priorPerformance: { available: false, performance: null },
  staffExecution: {
    staffCompletedJobs: 12, staffCompletionDays: 9, jobsPerStaffCompletionDay: 12 / 9,
    missingStaffCompletionTimestamp: 0,
  },
  staffSubmissionAttribution: { recordedSubmissionCount: 14, recordedSubmissionDays: 10 },
  onTime: {
    eligibleScheduledCompletedJobs: 10, onTimeCompletedJobs: 7, lateCompletedJobs: 3,
    ineligibleOrNoDeadlineCompletedJobs: 2, onTimeRate: 0.7,
  },
  completionWorkTypes: [
    { type: 'PRODUCT_DELIVERY', count: 4 },
    { type: 'GENERAL_TASK', count: 3 },
    { type: 'SALES_MEETING', count: 5 },
    { type: 'SALE', count: 0 },
  ],
  currentWorkloadByType: [
    { type: 'PRODUCT_DELIVERY', count: 2 },
    { type: 'GENERAL_TASK', count: 1 },
    { type: 'SALES_MEETING', count: 3 },
    { type: 'SALE', count: 0 },
  ],
  completedTrend: Array.from({ length: 61 }, (_, index) => {
    const day = new Date(Date.UTC(2026, 8, 1 + index)).toISOString().slice(0, 10);
    return { date: day, count: index % 7 === 0 ? 2 : 0 };
  }),
  deliveriesByPurpose: [{ purpose: 'SALE', unit: 'Kutu', quantity: '24.000' }],
  meetingsByOutcome: [
    { outcome: 'POSITIVE', count: 2 },
    { outcome: 'FOLLOW_UP_REQUIRED', count: 3 },
    { outcome: 'NO_DECISION', count: 0 },
    { outcome: 'NOT_INTERESTED', count: 0 },
  ],
  currentWorkload: { openJobCards: 6, overdueJobCards: 2, waitingApproval: 1, revisionRequested: 1 },
  lateness: staffLateness,
};

function incident(index: number): StaffLatenessIncidentItem {
  const day = String(14 + (index % 12)).padStart(2, '0');
  const lateSubmission = index % 3 === 2;
  const outcome = index % 4 === 3 ? 'OPEN' : index % 5 === 4 ? 'EXTENDED' : 'RECOVERED';
  return {
    incidentId: `incident-${index}`,
    delayType: lateSubmission ? 'LATE_SUBMISSION' : 'LATE_START',
    episodeNo: index % 4 === 0 ? 2 : 1,
    scheduleRevisionNo: index % 6 === 0 ? 3 : 1,
    deadlineAt: `2026-10-${day}T06:00:00.000Z`,
    breachedAt: `2026-10-${day}T06:20:00.000Z`,
    outcome,
    closedAt: outcome === 'OPEN' ? null : `2026-10-${day}T09:05:00.000Z`,
    durationSeconds: 9_900 + index * 600,
    operationalReason: index % 5 === 1
      ? {
        reasonCode: index % 2 === 0 ? 'CUSTOMER_ABSENT' : 'MISSING_STOCK_OR_EQUIPMENT',
        resolution: index % 3 === 0 ? 'RESCHEDULED' : 'CORRECTED',
        resolvedAt: `2026-10-${day}T10:00:00.000Z`,
      }
      : null,
    job: index % 7 === 4
      ? null
      : {
        id: JOB_ONE,
        title: index % 2 === 0 ? 'Gebze Ağız ve Diş Sağlığı Polikliniği ziyareti' : 'Numune teslimi',
        type: index % 2 === 0 ? 'SALES_MEETING' : 'PRODUCT_DELIVERY',
        jobPath: `/jobs/${JOB_ONE}`,
      },
  };
}

const incidentPages: StaffLatenessIncidentListResponse[] = [
  { range, items: Array.from({ length: 20 }, (_, index) => incident(index)), total: 25, limit: 20, offset: 0 },
  { range, items: Array.from({ length: 5 }, (_, index) => incident(20 + index)), total: 25, limit: 20, offset: 20 },
];

const dashboard: DashboardReportResponse = {
  range,
  counters: {
    activeJobCards: 24, overdueJobCards: 3, waitingApproval: 5, revisionRequested: 2,
    completedInPeriod: 201, cancelledInPeriod: 2,
  },
  completedTrend: Array.from({ length: 61 }, (_, index) => ({
    date: new Date(Date.UTC(2026, 8, 1 + index)).toISOString().slice(0, 10),
    count: index % 3,
  })),
  dailyCreatedTrend: Array.from({ length: 61 }, (_, index) => ({
    date: new Date(Date.UTC(2026, 8, 1 + index)).toISOString().slice(0, 10),
    count: (index + 1) % 4,
  })),
  activeStatusDistribution: [
    { status: 'NEW', count: 4 },
    { status: 'ACCEPTED', count: 5 },
    { status: 'IN_PROGRESS', count: 8 },
    { status: 'WAITING_APPROVAL', count: 5 },
    { status: 'REVISION_REQUESTED', count: 2 },
  ],
  createdWorkTypeDistribution: [
    { type: 'PRODUCT_DELIVERY', count: 24 },
    { type: 'GENERAL_TASK', count: 18 },
    { type: 'SALES_MEETING', count: 150 },
    { type: 'SALE', count: 32 },
  ],
};

export const organizationLateness: OrganizationLatenessSummary = {
  range,
  trackingStartedOn: '2026-09-21',
  generatedAt: '2026-11-02T09:15:00.000Z',
  totalIncidentCount: 15,
  staffResponsibility: { delayedJobCount: 8, incidentCount: 10 },
  operational: { delayedJobCount: 3, incidentCount: 3 },
  unknownAccountability: { delayedJobCount: 1, incidentCount: 1 },
  managementApprovalWait: {
    delayedJobCount: 1,
    incidentCount: 1,
    recovered: density(5_400, 1),
    open: openDensity(172_800, 1),
  },
};

const emptyOrganizationLateness: OrganizationLatenessSummary = {
  ...organizationLateness,
  totalIncidentCount: 0,
  staffResponsibility: { delayedJobCount: 0, incidentCount: 0 },
  operational: { delayedJobCount: 0, incidentCount: 0 },
  unknownAccountability: { delayedJobCount: 0, incidentCount: 0 },
  managementApprovalWait: {
    delayedJobCount: 0,
    incidentCount: 0,
    recovered: density(0, 0),
    open: openDensity(0, 0),
  },
};

const summaryByCase: Record<string, OrganizationLatenessSummary> = {
  data: organizationLateness,
  empty: emptyOrganizationLateness,
  error: organizationLateness,
};

function StaffFixture({ scenario }: { scenario: string }) {
  const attempts = useRef(0);
  const report = scenario === 'empty'
    ? { ...staffReport, lateness: emptyStaffLateness }
    : staffReport;
  const loadIncidents = async ({ offset }: { limit: number; offset: number }) => {
    attempts.current += 1;
    if (scenario === 'list-error' && attempts.current === 1) {
      throw new Error('Gecikme kayıtları alınamadı. Bağlantıyı kontrol edip tekrar deneyin.');
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
    return incidentPages[offset === 0 ? 0 : 1];
  };
  return <main className="workspace staff-report-screen">
    <PageHeader fallbackTitle="Personel raporu" />
    <header className="staff-report-identity">
      <h2>{report.staff.name}</h2>
      <span className="status-label">Aktif personel</span>
    </header>
    <StaffOperationalReport
      report={report}
      loadLatenessIncidents={loadIncidents}
      onRefresh={() => {}}
    />
  </main>;
}

function ManagementFixture({ scenario }: { scenario: string }) {
  const errorRef = useRef<HTMLDivElement>(null);
  return <ReportShell
    title="Raporlar"
    current="summary"
    range={range}
    description="Örnek veriler · Tasarım doğrulaması"
  >
    <ReportDateRangeForm
      formKey="fixture"
      from={range.from}
      to={range.to}
      filterError=""
      errorRef={errorRef}
      onSubmit={(event) => event.preventDefault()}
    />
    <ReportsDashboardView
      report={dashboard}
      latenessSummary={<LatenessSummaryCard key={scenario} range={range} />}
    />
  </ReportShell>;
}

function Fixture() {
  const params = new URLSearchParams(location.search);
  const view = params.get('view') === 'staff' ? 'staff' : 'management';
  const scenario = params.get('case') ?? 'data';
  return <MemoryRouter>
    <ServoraAntProvider>
      <div className={`authenticated-shell authenticated-shell--${innerWidth >= 1024 ? 'desktop' : 'mobile'}`}>
        <aside
          className="shell-sidebar"
          style={{ display: innerWidth >= 1024 ? undefined : 'none' }}
        >
          <nav className="shell-nav" aria-label="Ana navigasyon">
            <a href="/jobs">İşler</a>
            <a href="/customers">Müşteriler</a>
            <a href="/products">Ürünler</a>
            <a href="/" aria-current="page">Raporlar</a>
            <a href="/staff">Personel</a>
          </nav>
        </aside>
        {innerWidth < 1024 && <header className="compact-shell-header mobile-top-bar">
          <div className="mobile-top-bar-start">
            <p className="mobile-shell-title">{view === 'staff' ? 'Personel raporu' : 'Raporlar'}</p>
          </div>
        </header>}
        <div className="shell-content">
          {view === 'staff'
            ? <StaffFixture scenario={scenario} />
            : <ManagementFixture scenario={scenario} />}
        </div>
      </div>
    </ServoraAntProvider>
  </MemoryRouter>;
}

export const latenessFixtures = {
  range,
  staffReport,
  emptyStaffLateness,
  organizationLateness: summaryByCase.data,
  emptyOrganizationLateness: summaryByCase.empty,
  incidentPages,
};

Object.assign(globalThis, { __ovr7LatenessFixtures: latenessFixtures });

createRoot(document.getElementById('root')!).render(<Fixture />);
