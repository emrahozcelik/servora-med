/**
 * OVR-5 correction-deadline presentation helpers. The server owns every
 * deadline rule (bounds, materialized default, effective max); these helpers
 * only decide whether the revision picker applies and how a server instant is
 * displayed in the organization timezone.
 */

import type { JobCard } from './jobs-api';

type DeadlineShape = Pick<JobCard, 'type' | 'scheduledAt' | 'scheduledEndsAt' | 'dueDate'>;

/**
 * The original effective submission deadline exists when the job has an end of
 * the planned interval, a planned start except for SALES_MEETING (whose
 * deadline is the interval end), or a due date.
 */
export function hasOriginalSubmissionDeadline(job: DeadlineShape): boolean {
  if (job.scheduledEndsAt) return true;
  if (job.scheduledAt && job.type !== 'SALES_MEETING') return true;
  return job.dueDate !== null && job.dueDate !== '';
}

/** Format a server instant in the organization timezone (device timezone fallback). */
export function formatCorrectionDueAt(value: string, timeZone?: string | null): string {
  return new Intl.DateTimeFormat('tr-TR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(value));
}
