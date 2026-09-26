/**
 * OVR-4: the single owner of the LATE_SUBMISSION reminder/escalation policy.
 *
 * This module adds no new overdue condition. It answers exactly one question,
 * purely: *given an already-materialized open incident, at which instant does
 * each reminder kind become due, and is it due at this request time?* Breach
 * discovery, deadline arithmetic, episode identity and recovery stay owned by
 * `overdue-incidents.ts`, `overdue-breach-producer.ts` and the lifecycle
 * service — this policy only reads the incident's immutable `breached_at`.
 *
 * Why a policy object and not module constants: the thresholds are an
 * operational knob (how long a company tolerates an unsubmitted job before it
 * nudges the employee and then the manager). Keeping them in one factory means
 * the numbers never scatter into the worker, the service or the web client,
 * and a single validation point rejects a nonsensical configuration instead of
 * producing a silently inverted escalation order.
 *
 * Clock discipline: `breached_at` is an immutable persisted fact and
 * `requestTime` is the injected clock. Nothing here calls `new Date()` or reads
 * the database clock.
 */

import type { NotificationKind } from '../notifications/types.js';
import type { RealtimeEventType } from '../realtime/types.js';

/**
 * Reminder kinds. Two, and deliberately only two: a nudge to the accountable
 * employee, then an escalation to management. A new *overdue delay type* must
 * not be invented to express "the same LATE_SUBMISSION, but later" — that is a
 * threshold on the existing incident, not a new kind of lateness.
 */
export const OVERDUE_REMINDER_KINDS = [
  'STAFF_SUBMISSION_REMINDER',
  'MANAGEMENT_ESCALATION',
] as const;
export type OverdueReminderKind = (typeof OVERDUE_REMINDER_KINDS)[number];

/** The only delay type this policy projects reminders for. */
export const OVERDUE_REMINDER_DELAY_TYPE = 'LATE_SUBMISSION' as const;

/** Product defaults. Overridable per deployment through configuration. */
export const DEFAULT_STAFF_REMINDER_MINUTES = 15;
export const DEFAULT_MANAGEMENT_ESCALATION_MINUTES = 60;

export type OverdueReminderThresholds = Readonly<{
  staffReminderMinutes: number;
  managementEscalationMinutes: number;
}>;

export type OverdueReminderPolicy = Readonly<{
  thresholds: OverdueReminderThresholds;
  /** Minutes after `breached_at` at which `kind` becomes due. */
  thresholdMinutes(kind: OverdueReminderKind): number;
  /** The first instant `kind` is due for an incident breached at `breachedAt`. */
  dueAt(breachedAt: Date, kind: OverdueReminderKind): Date;
  /** `requestTime >= dueAt(breachedAt, kind)`. */
  isDue(kind: OverdueReminderKind, breachedAt: Date, requestTime: Date): boolean;
  /**
   * Every kind due at `requestTime`, in escalation order. Used by the tests and
   * by any caller that needs to reason about the whole schedule at once; the
   * worker claims per kind so each kind keeps its own delivery identity.
   */
  dueKinds(breachedAt: Date, requestTime: Date): readonly OverdueReminderKind[];
}>;

function positiveMinutes(value: number, field: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer number of minutes`);
  }
  return value;
}

/**
 * Build the reminder policy. Fails loudly on an invalid configuration rather
 * than defaulting: an escalation that fires before its own staff reminder (or a
 * zero/negative threshold) is an operator error, and silently clamping it would
 * hide the misconfiguration behind plausible-looking behaviour.
 */
export function createOverdueReminderPolicy(
  input: Partial<OverdueReminderThresholds> = {},
): OverdueReminderPolicy {
  const thresholds: OverdueReminderThresholds = {
    staffReminderMinutes: positiveMinutes(
      input.staffReminderMinutes ?? DEFAULT_STAFF_REMINDER_MINUTES,
      'staffReminderMinutes',
    ),
    managementEscalationMinutes: positiveMinutes(
      input.managementEscalationMinutes ?? DEFAULT_MANAGEMENT_ESCALATION_MINUTES,
      'managementEscalationMinutes',
    ),
  };
  if (thresholds.managementEscalationMinutes < thresholds.staffReminderMinutes) {
    throw new Error(
      'managementEscalationMinutes must be greater than or equal to staffReminderMinutes',
    );
  }

  const thresholdMinutes = (kind: OverdueReminderKind): number =>
    kind === 'STAFF_SUBMISSION_REMINDER'
      ? thresholds.staffReminderMinutes
      : thresholds.managementEscalationMinutes;

  const dueAt = (breachedAt: Date, kind: OverdueReminderKind): Date =>
    new Date(breachedAt.getTime() + thresholdMinutes(kind) * 60_000);

  return {
    thresholds,
    thresholdMinutes,
    dueAt,
    isDue: (kind, breachedAt, requestTime) =>
      requestTime.getTime() >= dueAt(breachedAt, kind).getTime(),
    dueKinds: (breachedAt, requestTime) =>
      OVERDUE_REMINDER_KINDS.filter((kind) => dueAt(breachedAt, kind).getTime() <= requestTime.getTime()),
  };
}

/** Default policy instance; deployments may build their own from config. */
export const DEFAULT_OVERDUE_REMINDER_POLICY = createOverdueReminderPolicy();

/**
 * How each reminder kind surfaces. Declared here, next to the kind, so a new
 * kind cannot be added without deciding its notification and realtime
 * projection — the compiler enforces both records stay exhaustive.
 */
export const OVERDUE_REMINDER_NOTIFICATION_KIND: Readonly<
  Record<OverdueReminderKind, NotificationKind>
> = {
  STAFF_SUBMISSION_REMINDER: 'job.submission_reminder',
  MANAGEMENT_ESCALATION: 'job.submission_escalation',
};

export const OVERDUE_REMINDER_REALTIME_TYPE: Readonly<
  Record<OverdueReminderKind, RealtimeEventType>
> = {
  STAFF_SUBMISSION_REMINDER: 'job.submission_reminder_due',
  MANAGEMENT_ESCALATION: 'job.submission_escalation_due',
};
