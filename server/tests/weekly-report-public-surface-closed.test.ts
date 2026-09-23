import { describe, expect, it } from 'vitest';

import { AppError } from '../src/errors/index.js';
import {
  parseCustomerSchedulePreviewInput,
  parseFollowUpCreateInput,
  parseJobCardCreateInput,
} from '../src/modules/job-cards/create-input.js';
import { defaultFollowUpType } from '../src/modules/job-cards/follow-up-policy.js';
import { JOB_CARD_TYPES } from '../src/modules/job-cards/types.js';

function rejectsWeeklyReport(parse: (value: unknown) => unknown, body: Record<string, unknown>) {
  try {
    parse({ ...body, type: 'WEEKLY_REPORT' });
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('VALIDATION_ERROR');
    return;
  }
  throw new Error('expected WEEKLY_REPORT to be rejected but it was accepted');
}

/**
 * Slice 1 keeps the public creation workflow closed: the DB literal and the
 * TS union exist (schema support), but no public parser may admit a
 * WEEKLY_REPORT intent that would create an incomplete report JobCard.
 */
describe('weekly report public creation stays closed in Slice 1', () => {
  it('declares WEEKLY_REPORT at the schema/type level', () => {
    expect(JOB_CARD_TYPES).toContain('WEEKLY_REPORT');
    expect(JOB_CARD_TYPES).toContain('PRODUCT_DELIVERY');
    expect(JOB_CARD_TYPES).toContain('GENERAL_TASK');
    expect(JOB_CARD_TYPES).toContain('SALES_MEETING');
  });

  it('rejects WEEKLY_REPORT in the generic create parser', () => {
    rejectsWeeklyReport(parseJobCardCreateInput, {
      clientActionId: '11111111-1111-4111-8111-111111111111',
      title: 'Haftalık Rapor',
      assignedTo: '22222222-2222-4222-8222-222222222222',
    });
    // Existing types keep parsing (exact-object contract intact).
    expect(parseJobCardCreateInput({
      clientActionId: '11111111-1111-4111-8111-111111111111',
      type: 'GENERAL_TASK',
      title: 'Görev',
      assignedTo: '22222222-2222-4222-8222-222222222222',
    }).type).toBe('GENERAL_TASK');
  });

  it('rejects WEEKLY_REPORT in the follow-up create parser', () => {
    rejectsWeeklyReport(parseFollowUpCreateInput, {
      clientActionId: '11111111-1111-4111-8111-111111111111',
      title: 'Takip',
      followUpInstructions: 'Talimat.',
      assignedTo: '22222222-2222-4222-8222-222222222222',
    });
  });

  it('rejects WEEKLY_REPORT in the customer-schedule preview parser', () => {
    rejectsWeeklyReport(parseCustomerSchedulePreviewInput, {
      scheduledAt: '2026-08-05T07:00:00.000Z',
    });
  });

  it('maps WEEKLY_REPORT to the neutral open-ended follow-up default', () => {
    // Exhaustive map stays total without granting weekly follow-up semantics.
    expect(defaultFollowUpType('WEEKLY_REPORT')).toBe('GENERAL_TASK');
  });
});
