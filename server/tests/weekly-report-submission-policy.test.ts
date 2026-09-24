import { describe, expect, it } from 'vitest';

import type {
  SubmissionReader,
} from '../src/modules/job-cards/repository.js';
import {
  assertSubmissionReady,
  evaluateSubmission,
} from '../src/modules/job-cards/submission-policy.js';
import type {
  JobCard,
  JobCardActor,
  JobCardAssignee,
} from '../src/modules/job-cards/types.js';
import type { WeeklyReportRow } from '../src/modules/weekly-reports/repository.js';

const staff: JobCardActor = { id: 'staff-1', organizationId: 'org-1', role: 'STAFF' };
const manager: JobCardActor = { id: 'manager-1', organizationId: 'org-1', role: 'MANAGER' };
const assignee: JobCardAssignee = {
  id: 'staff-1', organizationId: 'org-1', role: 'STAFF', isActive: true,
};
const now = new Date('2026-08-05T12:00:00.000Z');

const weeklyJob: JobCard = {
  id: 'job-1', organizationId: 'org-1', type: 'WEEKLY_REPORT', status: 'IN_PROGRESS',
  version: 2, title: 'Haftalık Rapor (2026-08-03 – 2026-08-09)', description: null,
  customerId: null, contactId: null, assignedTo: 'staff-1', createdBy: 'manager-1',
  priority: 'normal', dueDate: '2026-08-10',
};

function reportRow(overrides: Partial<WeeklyReportRow> = {}): WeeklyReportRow {
  return {
    id: 'report-1',
    organization_id: 'org-1',
    job_card_id: 'job-1',
    staff_user_id: 'staff-1',
    period_start: new Date('2026-08-03T00:00:00.000Z'),
    period_end: new Date('2026-08-09T00:00:00.000Z'),
    draft_summary: 'Özet.',
    draft_blockers: null,
    draft_next_week_plan: 'Plan.',
    draft_highlights: null,
    draft_field_observations: null,
    draft_support_needed: null,
    manager_questions: [{ key: 'q1', prompt: 'Soru?' }],
    manager_answers: [{ questionKey: 'q1', answer: 'Yanıt.' }],
    version: 1,
    created_at: new Date('2026-08-03T09:00:00.000Z'),
    updated_at: new Date('2026-08-03T09:00:00.000Z'),
    ...overrides,
  };
}

function reader(overrides: {
  assignee?: JobCardAssignee | null;
  report?: WeeklyReportRow | null;
  sourceWorkFails?: boolean;
} = {}): SubmissionReader {
  return {
    getAssignee: async () => overrides.assignee ?? assignee,
    getSubmissionCustomer: async () => null,
    getSubmissionMeetingDetails: async () => null,
    getSubmissionDeliveryItems: async () => [],
    getOrganizationTimezone: async () => 'Europe/Istanbul',
    getWeeklyReportByJobId: async () => 'report' in overrides ? overrides.report! : reportRow(),
    listWeeklySourceWorkSnapshot: async () => {
      if (overrides.sourceWorkFails) throw new Error('snapshot unavailable');
      return [];
    },
  };
}

describe('weekly report submission readiness', () => {
  it('passes a complete staff-owned report with empty blockers and empty source work', async () => {
    const evaluation = await evaluateSubmission(reader(), staff, weeklyJob, now);
    expect(evaluation.readiness).toEqual({
      evaluatedAt: now.toISOString(),
      ready: true,
      items: [
        { code: 'WEEKLY_REPORT_FOUND', state: 'met', field: 'weeklyReport' },
        { code: 'ASSIGNEE_ELIGIBLE', state: 'met', field: 'assignedTo' },
        { code: 'WEEKLY_DRAFT_VALID', state: 'met', field: 'draft' },
        { code: 'WEEKLY_ANSWERS_COMPLETE', state: 'met', field: 'managerAnswers' },
        { code: 'WEEKLY_SOURCE_WORK_READY', state: 'met', field: 'sourceWork' },
      ],
    });
    expect(() => assertSubmissionReady(evaluation)).not.toThrow();
  });

  it('never falls into meeting requirements (no customer/details needed)', async () => {
    const evaluation = await evaluateSubmission(reader(), staff, weeklyJob, now);
    expect(evaluation.failure).toBeNull();
    expect(evaluation.readiness.items.map((item) => item.code)).not.toContain('MEETING_TIME_VALID');
  });

  it('forbids manager submit on behalf of staff', async () => {
    const evaluation = await evaluateSubmission(reader(), manager, weeklyJob, now);
    expect(evaluation.failure).toMatchObject({ code: 'FORBIDDEN' });
    expect(() => assertSubmissionReady(evaluation)).toThrowError(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
  });

  it('fails closed without a report row', async () => {
    const evaluation = await evaluateSubmission(
      reader({ report: null }), staff, weeklyJob, now,
    );
    expect(evaluation.failure).toMatchObject({ code: 'WEEKLY_REPORT_NOT_FOUND' });
    expect(evaluation.readiness.ready).toBe(false);
  });

  it('requires summary and next-week plan but not blockers', async () => {
    const missingSummary = await evaluateSubmission(
      reader({ report: reportRow({ draft_summary: null }) }), staff, weeklyJob, now,
    );
    expect(missingSummary.failure).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(missingSummary.readiness.items).toContainEqual(
      { code: 'WEEKLY_DRAFT_VALID', state: 'missing', field: 'draft' },
    );
    const missingPlan = await evaluateSubmission(
      reader({ report: reportRow({ draft_next_week_plan: '   ' }) }), staff, weeklyJob, now,
    );
    expect(missingPlan.failure).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('requires every frozen question answered exactly once', async () => {
    const missing = await evaluateSubmission(
      reader({ report: reportRow({ manager_answers: [] }) }), staff, weeklyJob, now,
    );
    expect(missing.failure).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(missing.readiness.items).toContainEqual(
      { code: 'WEEKLY_ANSWERS_COMPLETE', state: 'missing', field: 'managerAnswers' },
    );
    const extra = await evaluateSubmission(
      reader({
        report: reportRow({
          manager_answers: [
            { questionKey: 'q1', answer: 'Yanıt.' },
            { questionKey: 'nope', answer: 'Sızıntı?' },
          ],
        }),
      }),
      staff, weeklyJob, now,
    );
    expect(extra.failure).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('passes zero-question reports', async () => {
    const evaluation = await evaluateSubmission(
      reader({
        report: reportRow({ manager_questions: [], manager_answers: [] }),
      }),
      staff, weeklyJob, now,
    );
    expect(evaluation.failure).toBeNull();
    expect(evaluation.readiness.ready).toBe(true);
  });

  it('rejects an ineligible assignee', async () => {
    const evaluation = await evaluateSubmission(
      reader({ assignee: { ...assignee, isActive: false } }), staff, weeklyJob, now,
    );
    expect(evaluation.failure).toMatchObject({ code: 'ASSIGNEE_NOT_ELIGIBLE' });
  });
});
