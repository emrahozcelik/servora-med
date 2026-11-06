import type { BusinessTrendReportResponse, DashboardReportResponse, SalesFollowUpReportResponse, StaffPerformanceResponse } from '../src/reports/report-types';
import { customer, report } from './visual-improvements-fixture.ts';

export { customer, profile, report, user, staffId } from './visual-improvements-fixture.ts';

export const customers = Array.from({ length: 12 }, (_, index) => ({
  ...customer,
  id: `33333333-3333-4333-8333-${String(index + 1).padStart(12, '0')}`,
  name: `Örnek Dental Klinik ${String(index + 1).padStart(2, '0')}`,
  status: index % 2 === 0 ? 'active' as const : 'prospect' as const,
}));

export const staffPerformance: StaffPerformanceResponse = {
  range: report.range,
  priorRange: { ...report.priorRange, from: '2026-10-02' },
  items: [{
    staff: report.staff, performance: report.performance, priorPerformance: report.priorPerformance,
    staffExecution: report.staffExecution, staffSubmissionAttribution: report.staffSubmissionAttribution,
    onTime: report.onTime, completionWorkTypes: report.completionWorkTypes,
    currentWorkloadByType: report.currentWorkloadByType, currentWorkload: report.currentWorkload,
  }],
};

export const business: BusinessTrendReportResponse = {
  range: { from: '2026-11-01', to: '2026-11-06', timezone: 'Europe/Istanbul' },
  asOf: '2026-11-06T10:00:00.000Z', observedThrough: '2026-11-06', partialDay: true,
  totals: { visits: 2, followUps: 1, sales: 1 }, comparison: null,
  points: Array.from({ length: 6 }, (_, i) => ({ date: `2026-11-0${i + 1}`, visits: i === 3 ? 2 : 0, followUps: i === 3 ? 1 : 0, sales: i === 3 ? 1 : 0 })),
  relationships: { visitsWithFollowUp: 1, visitsWithSale: 1, followUpsWithSale: 1 },
};

const statuses = [
  { status: 'NEW' as const, count: 0 }, { status: 'ACCEPTED' as const, count: 0 },
  { status: 'IN_PROGRESS' as const, count: 0 }, { status: 'WAITING_APPROVAL' as const, count: 0 },
  { status: 'REVISION_REQUESTED' as const, count: 0 },
];
const types = report.completionWorkTypes.map(item => ({ ...item, count: 0 }));
export const salesFollowUp: SalesFollowUpReportResponse = {
  range: business.range,
  current: {
    salesMeetings: { total: 0, statusDistribution: statuses, items: [], limit: 50, offset: 0 },
    proposalQueue: { total: 0, items: [], limit: 50, offset: 0 },
    followUpChildren: { total: 0, statusDistribution: statuses, typeDistribution: types, overdueDueDatedFollowUpChildren: 0 },
  },
  period: { salesMeetingsCreated: 0, salesMeetingsManagerApproved: 0,
    meetingOutcomeDistribution: report.meetingsByOutcome.map(item => ({ ...item, count: 0 })),
    followUpChildrenCreated: 0, followUpChildrenCreatedByType: types },
  relationships: { directFollowUpLinks: 0, currentCustomerDivergence: 0 },
};

export const dashboard: DashboardReportResponse = {
  range: business.range,
  counters: { activeJobCards: 4, overdueJobCards: 1, waitingApproval: 1, revisionRequested: 1, completedInPeriod: 1, cancelledInPeriod: 0 },
  completedTrend: business.points.map(p => ({ date: p.date, count: p.date === '2026-11-04' ? 1 : 0 })),
  dailyCreatedTrend: business.points.map(p => ({ date: p.date, count: p.date === '2026-11-04' ? 5 : 0 })),
  activeStatusDistribution: statuses.map(item => ({ ...item, count: item.status === 'ACCEPTED' || item.status === 'IN_PROGRESS' || item.status === 'WAITING_APPROVAL' || item.status === 'REVISION_REQUESTED' ? 1 : 0 })),
  createdWorkTypeDistribution: report.currentWorkloadByType.map(item => ({ ...item, count: item.count + (item.type === 'SALES_MEETING' ? 1 : 0) })),
};
