import type { ManagerQuestion } from './types.js';

/**
 * Weekly Report recurrence (V1 Slice 5, final slice).
 *
 * A recurrence is a durable manager authorization: "for this STAFF member,
 * request a new WeeklyReport every week using this template". It is
 * configuration, not a report: the reports it produces are ordinary
 * manager-requested WeeklyReport JobCards, indistinguishable from the ones
 * created through the single or bulk request endpoints.
 *
 * V1 is deliberately narrow — one rule per staff member, frequency fixed to
 * WEEKLY, no arbitrary cron, no due-date override, no delete (pause is the
 * reversible lifecycle). See `052_weekly_report_recurrence.sql` for the
 * persistence contract.
 */

/** Public lifecycle state. Lease/retry state stays internal. */
export const RECURRENCE_DISABLED_REASONS = ['MANUAL', 'STAFF_INELIGIBLE'] as const;
export type RecurrenceDisabledReason = (typeof RECURRENCE_DISABLED_REASONS)[number];

export const RECURRENCE_OUTCOMES = ['created', 'existing'] as const;
export type RecurrenceOutcome = (typeof RECURRENCE_OUTCOMES)[number];

/**
 * Persisted recurrence row. `next_period_start` and
 * `last_processed_period_start` are organization-local Mondays carried as
 * `YYYY-MM-DD` text (never a UTC instant), so the domain identity of a period
 * survives any server or browser timezone.
 */
export type WeeklyReportRecurrenceRow = {
  id: string;
  organization_id: string;
  staff_user_id: string;
  requested_by_user_id: string;
  enabled: boolean;
  disabled_reason: string | null;
  next_period_start: string;
  manager_questions: ManagerQuestion[];
  instructions: string | null;
  version: number;
  lease_token: string | null;
  lease_until: Date | null;
  next_attempt_at: Date;
  failure_count: number;
  last_error_code: string | null;
  last_processed_period_start: string | null;
  last_outcome: string | null;
  created_at: Date;
  updated_at: Date;
};

/**
 * Public read model. Deliberately omits `lease_token`, `lease_until`,
 * `next_attempt_at` and `failure_count`: retry/lease state is operational
 * internals, not a client contract.
 */
export type WeeklyReportRecurrenceDto = {
  id: string;
  staffUserId: string;
  staffName: string;
  enabled: boolean;
  disabledReason: RecurrenceDisabledReason | null;
  nextPeriodStart: string;
  questions: ManagerQuestion[];
  instructions: string | null;
  version: number;
  lastProcessedPeriodStart: string | null;
  lastOutcome: RecurrenceOutcome | null;
  lastErrorCode: string | null;
  updatedAt: string;
};

/** Bulk create response: one item per normalized requested staff id. */
export type WeeklyReportRecurrenceBulkCreateResult = {
  startPeriodStart: string;
  items: Array<{
    recurrenceId: string;
    staffUserId: string;
    outcome: 'created' | 'existing';
    enabled: boolean;
    nextPeriodStart: string;
    version: number;
  }>;
};

export type WeeklyReportRecurrenceTemplateResult = {
  recurrenceId: string;
  version: number;
  questions: ManagerQuestion[];
  instructions: string | null;
  nextPeriodStart: string;
};

export type WeeklyReportRecurrencePauseResult = {
  recurrenceId: string;
  enabled: false;
  disabledReason: RecurrenceDisabledReason;
  nextPeriodStart: string;
  version: number;
};

export type WeeklyReportRecurrenceResumeResult = {
  recurrenceId: string;
  enabled: true;
  nextPeriodStart: string;
  version: number;
};

/** Worker claim: the minimum needed to process exactly one occurrence. */
export type WeeklyReportRecurrenceClaim = Readonly<{
  id: string;
  organizationId: string;
  staffUserId: string;
  requestedByUserId: string;
  nextPeriodStart: string;
  managerQuestions: ManagerQuestion[];
  instructions: string | null;
  failureCount: number;
  leaseToken: string;
}>;

/**
 * Outcome of one worker occurrence attempt.
 *
 * - `created`   — a new WeeklyReport JobCard was created for the period.
 * - `existing`  — a canonical report already existed; the rule converged and
 *                 advanced without emitting a fake creation.
 * - `autoPaused`— the target is no longer an active STAFF member; the rule was
 *                 disabled with `STAFF_INELIGIBLE` and no report was created.
 * - `skipped`   — the claim was void (paused by a manager, or the lease was
 *                 lost). No report, no advancement.
 */
export type WeeklyReportRecurrenceOccurrenceResult = Readonly<{
  outcome: 'created' | 'existing' | 'autoPaused' | 'skipped';
  recurrenceId: string;
  processedPeriodStart: string | null;
}>;
