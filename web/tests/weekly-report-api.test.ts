import { describe, expect, it } from 'vitest';

import {
  MAX_BULK_TARGETS,
  parseWeeklyReportBulkResult,
  parseWeeklyReportCreateResult,
  parseWeeklyReportDetail,
  parseWeeklyReportReference,
  parseWeeklyReportSubmission,
  type WeeklyReportBulkRequestInput,
  type WeeklyReportCreateInput,
} from '../src/jobs/weekly-report-api';

/**
 * The ACTUAL server response shape, transcribed from the server DTO chain:
 * `WeeklyReportDetail = WeeklyReport & { job reference fields }` where
 * `WeeklyReport` is the mapped `weekly_reports` row. The field-test blocker
 * was the client allowlist omitting `organizationId`, `createdAt` and
 * `updatedAt`, which made the server's valid response fail closed with
 * `Yanıtta weeklyReport alanı geçersiz.`
 */
const serverDetail = {
  // WeeklyReport (mapped weekly_reports row)
  id: 'report-1',
  organizationId: 'org-1',
  jobCardId: 'job-1',
  staffUserId: 'staff-1',
  periodStart: '2026-08-03',
  periodEnd: '2026-08-09',
  draft: {
    summary: 'Özet.', blockers: null, nextWeekPlan: 'Plan.',
    highlights: null, fieldObservations: null, supportNeeded: null,
  },
  questions: [{ key: 'q1', prompt: 'Soru?' }],
  answers: [{ questionKey: 'q1', answer: 'Yanıt.' }],
  version: 2,
  createdAt: '2026-08-03T09:00:00.000Z',
  updatedAt: '2026-08-04T10:00:00.000Z',
  // JobCard lifecycle reference added by JobCardService.getWeeklyReport
  jobStatus: 'IN_PROGRESS',
  jobVersion: 2,
  dueDate: '2026-08-10',
  assignedTo: 'staff-1',
  instructions: 'Lütfen haftalık durumu ayrıntılı yazın.',
  liveSourceWork: [{
    jobCardId: 'job-9', type: 'GENERAL_TASK', title: 'Ziyaret',
    customerName: 'Klinik', staffCompletedAt: '2026-08-05T09:00:00.000Z',
    statusAtSnapshot: 'COMPLETED',
  }],
  submissionSummaries: [{ seqNo: 1, submittedAt: '2026-08-05T12:00:00.000Z', submittedBy: 'staff-1' }],
};

describe('weekly report api parsers', () => {
  it('accepts the ACTUAL server-shaped detail (organizationId/createdAt/updatedAt present)', () => {
    const parsed = parseWeeklyReportDetail(serverDetail);
    expect(parsed).toEqual(serverDetail);
    // The remediation fields are explicitly asserted, not incidental.
    expect(parsed.organizationId).toBe('org-1');
    expect(parsed.createdAt).toBe('2026-08-03T09:00:00.000Z');
    expect(parsed.updatedAt).toBe('2026-08-04T10:00:00.000Z');
  });

  it('rejects unknown detail keys and bad periods (fail-closed contract)', () => {
    expect(() => parseWeeklyReportDetail({ ...serverDetail, bogus: 1 })).toThrow();
    expect(() => parseWeeklyReportDetail({ ...serverDetail, periodStart: 'not-a-date' })).toThrow();
    expect(() => parseWeeklyReportDetail({ ...serverDetail, jobStatus: 'BOGUS' })).toThrow();
    expect(() => parseWeeklyReportDetail({ ...serverDetail, instructions: 7 })).toThrow();
  });

  it('parses the canonical organization reporting-week reference exactly', () => {
    const reference = {
      timezone: 'Europe/Istanbul',
      periodStart: '2026-08-03',
      periodEnd: '2026-08-09',
      dueDate: '2026-08-10',
    };
    expect(parseWeeklyReportReference(reference)).toEqual(reference);
    expect(() => parseWeeklyReportReference({ ...reference, bogus: 1 })).toThrow();
    expect(() => parseWeeklyReportReference({ ...reference, periodStart: 'nope' })).toThrow();
    expect(() => parseWeeklyReportReference({ ...reference, timezone: 3 })).toThrow();
  });

  it('accepts the ACTUAL server-shaped immutable submission (organizationId/createdAt present)', () => {
    const serverSubmission = {
      id: 'sub-1',
      organizationId: 'org-1',
      weeklyReportId: 'report-1',
      jobCardId: 'job-1',
      seqNo: 1,
      submittedBy: 'staff-1',
      submittedAt: '2026-08-05T12:00:00.000Z',
      periodStart: '2026-08-03',
      periodEnd: '2026-08-09',
      body: {
        summary: 'Özet.', blockers: null, nextWeekPlan: 'Plan.',
        highlights: null, fieldObservations: null, supportNeeded: null,
      },
      questions: [{ key: 'q1', prompt: 'Soru?' }],
      answers: [{ questionKey: 'q1', answer: 'Yanıt.' }],
      sourceWork: [],
      jobVersion: 3,
      sourceActivityId: 'act-1',
      createdAt: '2026-08-05T12:00:00.000Z',
    };
    const parsed = parseWeeklyReportSubmission(serverSubmission);
    expect(parsed).toEqual(serverSubmission);
    expect(parsed.organizationId).toBe('org-1');
    expect(parsed.createdAt).toBe('2026-08-05T12:00:00.000Z');
  });

  it('parses the create result exactly', () => {
    const created = {
      jobCardId: 'job-1', reportId: 'report-1', staffUserId: 'staff-1',
      periodStart: '2026-08-03', periodEnd: '2026-08-09',
      status: 'ACCEPTED', dueDate: '2026-08-10',
    };
    expect(parseWeeklyReportCreateResult(created)).toEqual(created);
  });

  it('parses the bulk result exactly, including mixed outcomes', () => {
    const bulk = {
      periodStart: '2026-08-03', periodEnd: '2026-08-09', dueDate: '2026-08-10',
      items: [
        { staffUserId: 'staff-1', jobCardId: 'job-1', reportId: 'report-1', outcome: 'created' },
        { staffUserId: 'staff-2', jobCardId: 'job-2', reportId: 'report-2', outcome: 'existing' },
      ],
    };
    expect(parseWeeklyReportBulkResult(bulk)).toEqual(bulk);
    expect(parseWeeklyReportBulkResult({ ...bulk, items: [] }).items).toEqual([]);
  });

  it('rejects unknown bulk keys, unknown outcomes and malformed items', () => {
    const bulk = {
      periodStart: '2026-08-03', periodEnd: '2026-08-09', dueDate: '2026-08-10',
      items: [
        { staffUserId: 'staff-1', jobCardId: 'job-1', reportId: 'report-1', outcome: 'created' },
      ],
    };
    expect(() => parseWeeklyReportBulkResult({ ...bulk, bogus: 1 })).toThrow();
    expect(() => parseWeeklyReportBulkResult({
      ...bulk, items: [{ ...bulk.items[0], outcome: 'maybe' }],
    })).toThrow();
    expect(() => parseWeeklyReportBulkResult({
      ...bulk, items: [{ ...bulk.items[0], extra: true }],
    })).toThrow();
    expect(() => parseWeeklyReportBulkResult({ ...bulk, dueDate: 'nope' })).toThrow();
  });

  it('mirrors the server bulk ceiling for the multi-select guard', () => {
    expect(MAX_BULK_TARGETS).toBe(50);
  });

  it('advertises no dueDate dimension on public request inputs (deadline is server-canonical)', () => {
    // The deadline is derived server-side (periodEnd + 1): the request shapes
    // carry no dueDate field, so the removed Termin capability cannot be
    // resurrected as an undocumented API parameter. (An object literal with a
    // dueDate key fails to compile against these annotated types.)
    const single: WeeklyReportCreateInput = {
      clientActionId: 'action-1', periodStart: '2026-08-03',
    };
    const bulk: WeeklyReportBulkRequestInput = {
      clientActionId: 'action-1', staffUserIds: ['staff-1'], periodStart: '2026-08-03',
    };
    expect(single).not.toHaveProperty('dueDate');
    expect(bulk).not.toHaveProperty('dueDate');
  });
});
