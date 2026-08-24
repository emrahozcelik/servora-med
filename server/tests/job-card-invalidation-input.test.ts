import { describe, expect, it } from 'vitest';

import {
  jobCardInvalidationRequestHash,
  parseJobCardInvalidationInput,
} from '../src/modules/job-cards/invalidation-input.js';

describe('JobCard invalidation input', () => {
  it('normalizes a valid reason and optional note', () => {
    expect(parseJobCardInvalidationInput({
      clientActionId: 'action-1',
      expectedVersion: 12,
      reasonCode: 'DUPLICATE',
      note: '  Aynı kayıt tekrar oluşturulmuş.  ',
    })).toEqual({
      clientActionId: 'action-1',
      expectedVersion: 12,
      reasonCode: 'DUPLICATE',
      note: 'Aynı kayıt tekrar oluşturulmuş.',
    });
  });

  it('changes the semantic fingerprint when the invalidation request changes', () => {
    const first = parseJobCardInvalidationInput({
      clientActionId: 'action-1', expectedVersion: 12, reasonCode: 'DUPLICATE', note: null,
    });
    const second = { ...first, reasonCode: 'WRONG_CUSTOMER' as const };

    expect(jobCardInvalidationRequestHash('job-1', first))
      .not.toBe(jobCardInvalidationRequestHash('job-1', second));
  });

  it('requires a bounded note for OTHER and rejects unknown client fields', () => {
    expect(() => parseJobCardInvalidationInput({
      clientActionId: 'action-2', expectedVersion: 1, reasonCode: 'OTHER', note: null,
    })).toThrowError(expect.objectContaining({
      code: 'INVALIDATION_NOTE_REQUIRED', statusCode: 400,
    }));
    expect(() => parseJobCardInvalidationInput({
      clientActionId: 'action-3', expectedVersion: 1, reasonCode: 'DUPLICATE',
      actorId: 'not-client-owned',
    })).toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR', statusCode: 400 }));
    expect(() => parseJobCardInvalidationInput({
      clientActionId: 'action-4', expectedVersion: 1, reasonCode: 'DUPLICATE',
      note: 'x'.repeat(2_001),
    })).toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR', statusCode: 400 }));
  });
});
