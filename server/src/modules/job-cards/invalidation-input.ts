import { createHash } from 'node:crypto';

import {
  JOB_CARD_INVALIDATION_REASON_CODES,
  type JobCardInvalidationInput,
} from './types.js';
import { AppError } from '../../errors/index.js';
import {
  optionalLifecycleNote,
  requireActionId,
  validation,
} from './validation.js';

const INVALIDATION_FIELDS = [
  'clientActionId', 'expectedVersion', 'reasonCode', 'note',
] as const;

export const JOB_CARD_INVALIDATION_OPERATION_VERSION = 'JOB_CARD_INVALIDATE:v1';

export function parseJobCardInvalidationInput(value: unknown): JobCardInvalidationInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw validation('body');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !INVALIDATION_FIELDS.includes(key as never))) {
    throw validation('body');
  }
  const clientActionId = requireActionId(record.clientActionId);
  if (!Number.isInteger(record.expectedVersion) || (record.expectedVersion as number) < 1) {
    throw validation('expectedVersion');
  }
  if (!JOB_CARD_INVALIDATION_REASON_CODES.includes(record.reasonCode as never)) {
    throw validation('reasonCode');
  }
  const note = record.note === undefined || record.note === null
    ? null
    : optionalLifecycleNote(record.note);
  if (record.reasonCode === 'OTHER' && note === null) {
    throw new AppError(
      'INVALIDATION_NOTE_REQUIRED',
      400,
      'Diğer geçersizleştirme nedeni için açıklama zorunludur.',
    );
  }
  return {
    clientActionId,
    expectedVersion: record.expectedVersion as number,
    reasonCode: record.reasonCode as JobCardInvalidationInput['reasonCode'],
    note,
  };
}

export function jobCardInvalidationRequestHash(
  jobCardId: string,
  input: JobCardInvalidationInput,
): string {
  return createHash('sha256')
    .update(JSON.stringify({
      operation: JOB_CARD_INVALIDATION_OPERATION_VERSION,
      jobCardId,
      expectedVersion: input.expectedVersion,
      reasonCode: input.reasonCode,
      note: input.note,
    }))
    .digest('hex');
}
