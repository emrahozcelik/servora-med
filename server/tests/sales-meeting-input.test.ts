import { describe, expect, it } from 'vitest';

import {
  parseMeetingDetailsPatch,
  parseMeetingJobCardId,
  validateMeetingDetailsCandidate,
} from '../src/modules/job-cards/meeting-details-input.js';

const JOB_ID = '44444444-4444-4444-8444-444444444444';
const validationError = expect.objectContaining({ code: 'VALIDATION_ERROR', statusCode: 400 });

describe('Sales Meeting detail input', () => {
  it('normalizes the exact PATCH body and canonicalizes instants', () => {
    expect(parseMeetingDetailsPatch({
      clientActionId: '  meeting-save-1  ',
      expectedVersion: 2,
      meetingAt: '2026-07-15T14:30:00+03:00',
      outcome: 'FOLLOW_UP_REQUIRED',
      meetingSummary: '  Sonraki görüşme konuşuldu.  ',
      nextFollowUpAt: '2026-07-20T09:00:00+03:00',
    })).toEqual({
      clientActionId: 'meeting-save-1',
      expectedVersion: 2,
      meetingAt: '2026-07-15T11:30:00.000Z',
      outcome: 'FOLLOW_UP_REQUIRED',
      meetingSummary: 'Sonraki görüşme konuşuldu.',
      nextFollowUpAt: '2026-07-20T06:00:00.000Z',
    });
  });

  it('normalizes empty summary and explicit clears to null', () => {
    expect(parseMeetingDetailsPatch({
      clientActionId: 'save-2', expectedVersion: 3,
      meetingAt: null, outcome: null, meetingSummary: '\u00a0\u2028', nextFollowUpAt: null,
    })).toEqual({
      clientActionId: 'save-2', expectedVersion: 3,
      meetingAt: null, outcome: null, meetingSummary: null, nextFollowUpAt: null,
    });
  });

  it.each([
    {},
    { clientActionId: 'save-1', expectedVersion: 1 },
    { clientActionId: 'save-1', expectedVersion: 0, outcome: 'POSITIVE' },
    { clientActionId: 'save-1', expectedVersion: 1, outcome: 'UNKNOWN' },
    { clientActionId: 'save-1', expectedVersion: 1, unknown: 'field' },
    { clientActionId: 'save-1', expectedVersion: 1, meetingSummary: 'x'.repeat(4_001) },
  ])('rejects invalid PATCH body %#', (input) => {
    expect(() => parseMeetingDetailsPatch(input)).toThrowError(validationError);
  });

  it.each([
    '2026-07-15 10:00',
    '2026-07-15T10:00:00',
    '15/07/2026',
    '2026-02-30T10:00:00Z',
  ])('rejects non-instant meetingAt %s', (meetingAt) => {
    expect(() => parseMeetingDetailsPatch({
      clientActionId: 'save-1', expectedVersion: 1, meetingAt,
    })).toThrowError(validationError);
  });

  it('maps malformed path UUID to concealed not-found', () => {
    expect(() => parseMeetingJobCardId('not-a-uuid')).toThrowError(expect.objectContaining({
      code: 'JOB_CARD_NOT_FOUND', statusCode: 404,
    }));
    expect(parseMeetingJobCardId(JOB_ID)).toBe(JOB_ID);
  });

  it('validates chronology against the merged candidate', () => {
    expect(() => validateMeetingDetailsCandidate({
      meetingAt: null, outcome: null, meetingSummary: null,
      nextFollowUpAt: '2026-07-20T06:00:00.000Z',
    })).toThrowError(validationError);
    expect(() => validateMeetingDetailsCandidate({
      meetingAt: '2026-07-20T06:00:00.000Z', outcome: null, meetingSummary: null,
      nextFollowUpAt: '2026-07-20T06:00:00.000Z',
    })).toThrowError(validationError);
    expect(validateMeetingDetailsCandidate({
      meetingAt: '2026-07-20T06:00:00.000Z', outcome: null, meetingSummary: null,
      nextFollowUpAt: '2026-07-20T06:00:01.000Z',
    })).toBeUndefined();
  });
});
