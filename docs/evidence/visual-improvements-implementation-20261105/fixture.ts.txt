import type { JobCardListItem } from '../src/jobs/jobs-api';
import type { StaffReportResponse } from '../src/reports/report-types';
import type { CurrentUser } from '../src/services/api';
import type { CustomerDetail, CustomerOperationalSummary, JobHistoryItem } from '../src/services/crm-api';
import type { StaffProfile, WeeklyReportHistoryItem } from '../src/services/people-api';
import type { Product } from '../src/services/products-api';

export const now = '2026-11-05T06:00:00.000Z';
const stamp = '2026-11-04T09:00:00.000Z';
const org = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const staffId = '11111111-1111-4111-8111-111111111111';
const managerId = '22222222-2222-4222-8222-222222222222';
export const customerId = '33333333-3333-4333-8333-333333333333';
export const user: CurrentUser = {
  id: managerId, organizationId: org, name: 'Deniz Örnek', email: 'deniz@example.test',
  role: 'MANAGER', mustChangePassword: false, isActive: true, version: 1,
  capabilities: { overviewDashboard: false, calendar: false, messaging: false },
  support: { displayLabel: 'Örnek destek', email: null, helpUrl: null },
};
export const profile: StaffProfile = {
  id: '44444444-4444-4444-8444-444444444444',
  user: { ...user, id: staffId, role: 'STAFF', name: 'Ayşe Örnek', email: 'ayse@example.test',
    lastLoginAt: stamp, createdAt: stamp, updatedAt: stamp },
  title: 'Saha temsilcisi', phone: '+905551110000', region: 'İstanbul',
  managerUserId: managerId, managerName: user.name, version: 1,
  counters: { open: 2, waitingApproval: 1, revisionRequested: 1, completedThisMonth: 1, overdue: 1 },
};
export const customer: CustomerDetail = {
  id: customerId, organizationId: org, name: 'Merkez Ağız ve Diş Sağlığı Kliniği',
  customerType: 'clinic', taxNumber: null, phone: '+905551110000', email: 'klinik@example.test',
  city: 'İstanbul', district: 'Ataşehir', address: 'Örnek Mahallesi, Klinik Sokak No: 10',
  assignedStaffUserId: staffId, assignedStaffName: profile.user.name,
  status: 'active', version: 1, hasOperationHistory: true, openJobCount: 4, completedJobCount: 1,
  primaryContact: { id: 'contact-1', name: 'Dr. Ece Örnek', title: 'Klinik sorumlusu' },
  contacts: [{ id: 'contact-1', organizationId: org, customerId, name: 'Dr. Ece Örnek',
    title: 'Klinik sorumlusu', phone: '+905551110000', email: 'ece@example.test',
    isPrimary: true, isActive: true, version: 1, hasOperationHistory: true }],
};
export const products: Product[] = [
  { id: 'product-1', organizationId: org, name: 'ProSeal Kollajen Membran 20 × 30 mm',
    sku: 'MED-1001', brand: 'ProSeal', category: 'Cerrahi ürünler', model: 'Standart',
    unit: 'adet', referencePrice: null, isActive: true, version: 1, createdAt: stamp, updatedAt: stamp },
  { id: 'product-2', organizationId: org, name: 'Steril Cerrahi Örtü Seti',
    sku: 'MED-1002', brand: 'DentalCare', category: 'Sarf malzemesi', model: null,
    unit: 'paket', referencePrice: null, isActive: true, version: 1, createdAt: stamp, updatedAt: stamp },
];
export const jobs: JobCardListItem[] = [
  ['visit', 'Müşteri ihtiyaç görüşmesi', 'SALES_MEETING', 'ACCEPTED', 'CUSTOMER_VISIT'],
  ['task', 'Klinik eğitim materyallerini hazırla', 'GENERAL_TASK', 'IN_PROGRESS', null],
  ['delivery', 'Merkez Klinik ürün teslimi', 'PRODUCT_DELIVERY', 'WAITING_APPROVAL', null],
  ['follow-up', 'Ürün teklifini değerlendirmek için takip', 'SALES_MEETING', 'REVISION_REQUESTED', 'FOLLOW_UP'],
  ['completed', 'Ürün tanıtımı ve ihtiyaç görüşmesi', 'SALES_MEETING', 'COMPLETED', 'CUSTOMER_VISIT'],
].map(([id, title, type, status, engagementKind]) => ({
  id: id!, title: title!, type: type as JobCardListItem['type'], status: status as JobCardListItem['status'],
  engagementKind: engagementKind as JobCardListItem['engagementKind'],
  version: 3, priority: id === 'delivery' ? 'high' : 'normal', dueDate: null,
  scheduledAt: id === 'task' ? '2026-11-03T09:00:00.000Z' : '2026-11-06T09:00:00.000Z',
  scheduledEndsAt: id === 'task' ? '2026-11-03T10:00:00.000Z' : '2026-11-06T10:00:00.000Z',
  createdAt: stamp, updatedAt: stamp, staffCompletedAt: id === 'completed' || id === 'delivery' ? stamp : null,
  customer: { id: customerId, name: customer.name }, contact: { id: 'contact-1', name: 'Dr. Ece Örnek' },
  assignee: { id: staffId, name: profile.user.name }, deliveryItemCount: id === 'delivery' ? 2 : 0,
  allowedCommands: [],
}));
export const history: JobHistoryItem[] = jobs.map(job => ({
  ...job, completedAt: job.status === 'COMPLETED' ? stamp : null,
  followUp: job.id === 'follow-up' ? { sourceJobCardId: 'completed' } : null, childCount: job.id === 'completed' ? 1 : 0,
}));
export const summary: CustomerOperationalSummary = {
  latestInteraction: { jobCardId: 'completed', title: jobs[4].title, type: 'SALES_MEETING',
    completedAt: stamp, assignee: jobs[4].assignee },
  nextPlannedWork: { jobCardId: 'visit', title: jobs[0].title, type: 'SALES_MEETING',
    status: 'ACCEPTED', scheduledAt: jobs[0].scheduledAt!, assignee: jobs[0].assignee },
  pendingReview: { waitingApprovalCount: 1, revisionRequestedCount: 1 },
  latestMeetingOutcome: { jobCardId: 'completed', meetingAt: stamp, outcome: 'FOLLOW_UP_REQUIRED',
    unsuccessfulReason: null, meetingSummary: 'Ürün bilgisi paylaşıldı. Teklif için takip işi açıldı.', nextFollowUpAt: null },
  followUp: { jobCardId: 'follow-up', kind: 'FOLLOW_UP_JOB' },
};
export const report: StaffReportResponse = {
  staff: { userId: staffId, name: profile.user.name, isActive: true },
  range: { from: '2026-11-01', to: '2026-11-30', timezone: 'Europe/Istanbul' },
  priorRange: { from: '2026-10-01', to: '2026-10-31', timezone: 'Europe/Istanbul' },
  performance: { completedJobs: 1, completionDays: 1, jobsPerCompletionDay: 1,
    correctionRequestEvents: 1, authoredOperationalNotes: 2 },
  priorPerformance: { available: false, performance: null },
  staffExecution: { staffCompletedJobs: 2, staffCompletionDays: 1, jobsPerStaffCompletionDay: 2, missingStaffCompletionTimestamp: 0 },
  staffSubmissionAttribution: { recordedSubmissionCount: 2, recordedSubmissionDays: 1 },
  onTime: { eligibleScheduledCompletedJobs: 1, onTimeCompletedJobs: 1, lateCompletedJobs: 0,
    ineligibleOrNoDeadlineCompletedJobs: 0, onTimeRate: 1 },
  completionWorkTypes: [{ type: 'PRODUCT_DELIVERY', count: 0 }, { type: 'GENERAL_TASK', count: 0 },
    { type: 'SALES_MEETING', count: 1 }, { type: 'SALE', count: 0 }],
  currentWorkloadByType: [{ type: 'PRODUCT_DELIVERY', count: 1 }, { type: 'GENERAL_TASK', count: 1 },
    { type: 'SALES_MEETING', count: 2 }, { type: 'SALE', count: 0 }],
  currentWorkload: { openJobCards: 2, waitingApproval: 1, revisionRequested: 1, overdueJobCards: 1 },
  completedTrend: Array.from({ length: 30 }, (_, i) => ({ date: `2026-11-${String(i + 1).padStart(2, '0')}`, count: i === 3 ? 1 : 0 })),
  deliveriesByPurpose: [],
  meetingsByOutcome: [{ outcome: 'POSITIVE', count: 0 }, { outcome: 'FOLLOW_UP_REQUIRED', count: 1 },
    { outcome: 'NO_DECISION', count: 0 }, { outcome: 'NOT_INTERESTED', count: 0 }],
};
export const weekly: WeeklyReportHistoryItem[] = [{
  reportId: 'weekly-1', jobCardId: 'weekly-job', staffUserId: staffId,
  periodStart: '2026-10-26', periodEnd: '2026-11-01', status: 'WAITING_APPROVAL', dueDate: '2026-11-02',
  submissionCount: 1, latestSubmissionSeqNo: 1, latestSubmittedAt: stamp, createdAt: stamp, completedAt: null,
}];
