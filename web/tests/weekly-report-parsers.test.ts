import { describe, expect, it } from 'vitest';

import {
  JOB_CARD_TYPES,
  PRODUCTIVE_JOB_CARD_TYPES,
  SUBMISSION_REQUIREMENT_CODES,
  parseJobCardListItem,
  parsePersistedJobCardListItem,
} from '../src/jobs/jobs-api';
import { jobTypeLabels } from '../src/jobs/job-labels';
import { parseJobSearch } from '../src/jobs/job-search';
import {
  defaultFollowUpType,
} from '../src/jobs/follow-up-presentation';
import {
  requirementLabels,
  scheduleFieldLabel,
} from '../src/jobs/job-workflow-presentation';
import { cardScheduleFact } from '../src/jobs/scheduling';

const weeklyRow = {
  id: '11111111-1111-4111-8111-111111111111',
  type: 'WEEKLY_REPORT',
  status: 'IN_PROGRESS',
  version: 2,
  title: 'Haftalık Rapor (2026-08-03 – 2026-08-09)',
  priority: 'normal',
  dueDate: '2026-08-10',
  scheduledAt: null,
  engagementKind: null,
  createdAt: '2026-08-03T09:00:00.000Z',
  updatedAt: '2026-08-03T09:00:00.000Z',
  staffCompletedAt: null,
  customer: null,
  contact: null,
  assignee: { id: 'staff-1', name: 'Ayşe Personel' },
  deliveryItemCount: 0,
  allowedCommands: ['SUBMIT_FOR_APPROVAL', 'CANCEL'],
};

describe('weekly report web parser safety', () => {
  it('parses a WEEKLY_REPORT job row without crashing', () => {
    const persisted = parsePersistedJobCardListItem(weeklyRow);
    expect(persisted.type).toBe('WEEKLY_REPORT');
    const item = parseJobCardListItem(weeklyRow);
    expect(item.type).toBe('WEEKLY_REPORT');
    expect(item.title).toBe('Haftalık Rapor (2026-08-03 – 2026-08-09)');
  });

  it('keeps the full union for jobs and the productive list for buckets', () => {
    expect([...JOB_CARD_TYPES]).toEqual([
      'PRODUCT_DELIVERY', 'GENERAL_TASK', 'SALES_MEETING', 'WEEKLY_REPORT',
    ]);
    expect([...PRODUCTIVE_JOB_CARD_TYPES]).toEqual([
      'PRODUCT_DELIVERY', 'GENERAL_TASK', 'SALES_MEETING',
    ]);
    expect(jobTypeLabels.WEEKLY_REPORT).toBe('Haftalık Rapor');
  });

  it('accepts WEEKLY_REPORT in list filters and search params', () => {
    const params = new URLSearchParams({ type: 'WEEKLY_REPORT' });
    expect(parseJobSearch(params).type).toBe('WEEKLY_REPORT');
  });

  it('renders a due-date schedule fact for dateless weekly rows', () => {
    const fact = cardScheduleFact({
      type: 'WEEKLY_REPORT', scheduledAt: null, dueDate: '2026-08-10',
    });
    expect(fact.text).toContain('10');
  });

  it('maps weekly sources to the neutral follow-up default', () => {
    expect(defaultFollowUpType('WEEKLY_REPORT')).toBe('GENERAL_TASK');
  });

  it('labels weekly submission readiness codes', () => {
    for (const code of [
      'WEEKLY_REPORT_FOUND', 'WEEKLY_DRAFT_VALID', 'WEEKLY_ANSWERS_COMPLETE',
      'WEEKLY_SOURCE_WORK_READY',
    ] as const) {
      expect(SUBMISSION_REQUIREMENT_CODES).toContain(code);
      expect(requirementLabels[code]).toBeTruthy();
    }
    expect(scheduleFieldLabel('WEEKLY_REPORT')).toBe('Planlanan zaman');
  });
});
