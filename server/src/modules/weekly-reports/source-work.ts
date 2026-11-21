import { JOB_CARD_TYPES } from '../job-cards/types.js';
import { AppError } from '../../errors/index.js';
import { addCalendarDaysToDateKey, instantFromLocal } from '../job-cards/local-calendar.js';
import type {
  SourceWorkSnapshotItem,
  WeeklySourceWorkRow,
} from './types.js';

/**
 * Organization-local period window for a report: `periodStart` 00:00
 * (inclusive) → `periodEnd + 1 day` 00:00 (exclusive), resolved with the
 * local-calendar authority so DST transitions cannot shift the boundary.
 * Workweek reports (`periodEnd = periodStart + 4`) yield Monday → Saturday
 * 00:00; legacy 7-day reports (`periodEnd = periodStart + 6`) keep Monday →
 * next Monday 00:00.
 */
export function weekInstants(
  periodStart: string,
  periodEnd: string,
  timezone: string,
): { weekStart: Date; weekEnd: Date } {
  return {
    weekStart: instantFromLocal(periodStart, 0, 0, timezone),
    weekEnd: instantFromLocal(addCalendarDaysToDateKey(periodEnd, 1), 0, 0, timezone),
  };
}

function weeklySourceWorkValidation(field: string): AppError {
  const message = `${field} geçersizdir.`;
  return new AppError('VALIDATION_ERROR', 400, message, {
    fieldErrors: { [field]: message },
  });
}

/**
 * Map one bounded source-work candidate row to the frozen snapshot shape.
 * Fails closed on unexpected status/type rather than persisting a corrupt
 * snapshot; the service additionally runs the full shape validator.
 */
export function mapSourceWorkRow(row: WeeklySourceWorkRow): SourceWorkSnapshotItem {
  if (row.status !== 'WAITING_APPROVAL' && row.status !== 'COMPLETED') {
    throw weeklySourceWorkValidation('sourceWork.statusAtSnapshot');
  }
  if (!(JOB_CARD_TYPES as readonly string[]).includes(row.type) || row.type === 'WEEKLY_REPORT') {
    throw weeklySourceWorkValidation('sourceWork.type');
  }
  return {
    jobCardId: row.jobCardId,
    type: row.type,
    title: row.title,
    customerName: row.customerName,
    staffCompletedAt: row.staffCompletedAt.toISOString(),
    statusAtSnapshot: row.status,
  } as SourceWorkSnapshotItem;
}
