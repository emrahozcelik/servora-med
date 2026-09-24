import { describe, expect, it } from 'vitest';

import {
  parseWeeklyReportCreateResult,
  parseWeeklyReportDetail,
  parseWeeklyReportSubmission,
} from '../src/jobs/weekly-report-api';

const detail = {
  id: 'report-1',
  staffUserId: 'staff-1',
  jobCardId: 'job-1',
  periodStart: '2026-08-03',
  periodEnd: '2026-08-09',
  draft: {
    summary: 'Özet.', blockers: null, nextWeekPlan: 'Plan.',
    highlights: null, fieldObservations: null, supportNeeded: null,
  },
  questions: [{ key: 'q1', prompt: 'Soru?' }],
  answers: [{ questionKey: 'q1', answer: 'Yanıt.' }],
  version: 2,
  jobStatus: 'IN_PROGRESS',
  jobVersion: 2,
  dueDate: '2026-08-10',
  assignedTo: 'staff-1',
  liveSourceWork: [{
    jobCardId: 'job-9', type: 'GENERAL_TASK', title: 'Ziyaret',
    customerName: 'Klinik', staffCompletedAt: '2026-08-05T09:00:00.000Z',
    statusAtSnapshot: 'COMPLETED',
  }],
  submissionSummaries: [{ seqNo: 1, submittedAt: '2026-08-05T12:00:00.000Z', submittedBy: 'staff-1' }],
};

describe('weekly report api parsers', () => {
  it('parses the report detail exactly', () => {
    expect(parseWeeklyReportDetail(detail)).toEqual(detail);
  });

  it('rejects unknown detail keys and bad periods', () => {
    expect(() => parseWeeklyReportDetail({ ...detail, bogus: 1 })).toThrow();
    expect(() => parseWeeklyReportDetail({ ...detail, periodStart: '2026-08-04' })).not.toThrow();
    expect(() => parseWeeklyReportDetail({ ...detail, periodStart: 'not-a-date' })).toThrow();
    expect(() => parseWeeklyReportDetail({ ...detail, jobStatus: 'BOGUS' })).toThrow();
  });

  it('parses a frozen submission exactly', () => {
    const submission = {
      id: 'sub-1', weeklyReportId: 'report-1', jobCardId: 'job-1', seqNo: 1,
      submittedBy: 'staff-1', submittedAt: '2026-08-05T12:00:00.000Z',
      periodStart: '2026-08-03', periodEnd: '2026-08-09',
      body: {
        summary: 'Özet.', blockers: null, nextWeekPlan: 'Plan.',
        highlights: null, fieldObservations: null, supportNeeded: null,
      },
      questions: [{ key: 'q1', prompt: 'Soru?' }],
      answers: [{ questionKey: 'q1', answer: 'Yanıt.' }],
      sourceWork: [],
      jobVersion: 3,
      sourceActivityId: 'act-1',
    };
    expect(parseWeeklyReportSubmission(submission)).toEqual(submission);
    expect(() => parseWeeklyReportSubmission({ ...submission, sourceWork: [{
      jobCardId: 'x', type: 'GENERAL_TASK', title: 'T', customerName: null,
      staffCompletedAt: '2026-08-05T09:00:00.000Z', statusAtSnapshot: 'NEW',
    }] })).toThrow();
  });

  it('parses the create result exactly', () => {
    const created = {
      jobCardId: 'job-1', reportId: 'report-1', staffUserId: 'staff-1',
      periodStart: '2026-08-03', periodEnd: '2026-08-09',
      status: 'ACCEPTED', dueDate: '2026-08-10',
    };
    expect(parseWeeklyReportCreateResult(created)).toEqual(created);
  });
});
