import { AppError } from '../../errors/index.js';
import { isoInstant, uuidString } from '../job-cards/validation.js';
import type { CalendarQuery } from './types.js';

const MAX_WINDOW_MS = 93 * 24 * 60 * 60 * 1000;

export function parseCalendarQuery(value: unknown): CalendarQuery {
  const query = (value ?? {}) as Record<string, unknown>;
  const from = isoInstant(query.from, 'from');
  const to = isoInstant(query.to, 'to');
  const duration = Date.parse(to) - Date.parse(from);
  if (duration <= 0 || duration > MAX_WINDOW_MS) {
    throw new AppError(
      'VALIDATION_ERROR',
      400,
      'Takvim aralığı 93 günü aşmamalıdır.',
    );
  }
  return {
    from,
    to,
    assignedTo: query.assignedTo === undefined
      ? null
      : uuidString(query.assignedTo, 'assignedTo'),
  };
}
