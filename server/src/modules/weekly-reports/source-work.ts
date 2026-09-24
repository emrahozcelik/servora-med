import { AppError } from '../../errors/index.js';
import { addCalendarDaysToDateKey, instantFromLocal } from '../job-cards/local-calendar.js';
import type {
  SourceWorkSnapshotItem,
  WeeklySourceWorkRow,
} from './types.js';

/**
 * Organization-local week window for a report period: Monday 00:00
 * (inclusive) → next Monday 00:00 (exclusive), resolved with the
 * local-calendar authority so DST transitions cannot shift the boundary.
 */
export function weekInstants(
  periodStart: string,
  timezone: string,
): { weekStart: Date; weekEnd: Date } {
  return {
    weekStart: instantFromLocal(periodStart, 0, 0, timezone),
    weekEnd: instantFromLocal(addCalendarDaysToDateKey(periodStart, 7), 0, 0, timezone),
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
  if (row.type === 'WEEKLY_REPORT') {
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
