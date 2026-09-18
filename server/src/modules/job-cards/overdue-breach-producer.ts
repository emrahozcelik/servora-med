/**
 * OVR-2 / OVR-3 shared overdue-breach producer.
 *
 * Every producer of a `job_card_overdue_incidents` row — request-driven
 * lifecycle transitions (`TRANSITION`), request-driven reassignment and
 * schedule-revision edits (`MUTATION`) and the OVR-3 clock-only scanner
 * (`SCANNER`) — evaluates eligibility through these functions. The scanner is
 * deliberately NOT allowed to reimplement breach boundaries, revision or
 * episode identity, activation, accountability or timezone/due-date handling:
 * a second implementation would be free to drift from the accepted OVR-2
 * contract.
 *
 * Each delay type is split in two:
 *
 *   plan…Breach()       pure evaluation against durable state; produces the
 *                       exact first eligible breach instant and the incident
 *                       row that would be written (nothing is written yet);
 *   materialize…IfBreached()  plan + insert, the request-driven contract.
 *
 * The split exists because the clock-only scanner needs the instant of a
 * *planned* breach before deciding whether a lifecycle request accepted before
 * that instant is still in flight, and it must use the producer's own result —
 * never a second copy of the +1ms / 24h / due-date-local-midnight rules.
 *
 * Clock discipline is inherited from `overdue-incidents.ts`: every instant is
 * either a persisted fact or derived from the caller's injected `requestTime`.
 */

import { AppError } from '../../errors/index.js';
import {
  approvalWaitBreachAt,
  approvalWaitDeadlineAt,
  effectiveSubmissionDeadlineAt,
  isInstantBreached,
  lateStartBreachAt,
  lateStartDeadlineAt,
  submissionBreachAt,
  submissionBreachInstant,
  type OverdueIncidentIdentity,
  type OverdueIncidentSource,
} from './overdue-incidents.js';
import type {
  InsertOverdueIncidentInput,
  JobCardTransaction,
  JobLifecycleInstants,
} from './repository.js';
import type { JobCard } from './types.js';

/** The governing schedule revision of a JobCard. */
export type GoverningRevision = {
  revisionNo: number;
  createdAt: Date;
};

/**
 * Why a delay type could not be evaluated from durable evidence. Callers
 * decide the fail mode; the scanner counts these as skipped candidates and
 * never fabricates the missing fact.
 */
export type OverdueBreachUnprovableReason =
  | 'REVISION_MISSING'
  | 'EPISODE_ACTIVATION_UNPROVABLE'
  | 'SUBMITTED_FACT_MISSING';

/**
 * The producer's decision. `breachAt` is the actual first instant at which
 * the episode is both late and eligible (the shared `breachedAt` value). A
 * lifecycle request reserved before this instant is still authoritative over
 * clock-only discovery, even when a later eligibility bound (for example a
 * retroactive schedule revision) falls after the nominal deadline.
 */
export type OverdueBreachPlan =
  | {
      kind: 'breached';
      breachAt: Date;
      incident: InsertOverdueIncidentInput;
    }
  | { kind: 'not-breached' }
  | { kind: 'unprovable'; reason: OverdueBreachUnprovableReason };

export type OverdueBreachEvaluation =
  | { kind: 'breached'; identity: OverdueIncidentIdentity; created: boolean }
  | { kind: 'not-breached' }
  | { kind: 'unprovable'; reason: OverdueBreachUnprovableReason };

/** The request-driven producers' fail mode for a missing governing revision. */
export function overdueRevisionMissingError(): AppError {
  return new AppError(
    'OVERDUE_INCIDENT_REVISION_MISSING', 500, 'İş zaman planı kaydı bulunamadı.',
  );
}

/**
 * Highest `revision_no` of the JobCard plus its domain-effective instant, or
 * null when the job has no schedule revision at all. Never synthesizes a
 * revision and never falls back to another clock.
 */
export async function resolveGoverningRevision(
  tx: JobCardTransaction,
  organizationId: string,
  jobCardId: string,
): Promise<GoverningRevision | null> {
  const revisionNo = await tx.getCurrentScheduleRevisionNo(organizationId, jobCardId);
  if (revisionNo === null) return null;
  const revision = await tx.getScheduleRevision(organizationId, jobCardId, revisionNo);
  if (revision === null) return null;
  return { revisionNo: revision.revisionNo, createdAt: revision.createdAt };
}

/**
 * Provable activation of a submission episode, or null when it cannot be
 * proven (then nothing is materialized — never a guess).
 *
 * A modern episode 1 starts at START (`started_at`, first-wins, requestTime)
 * while the job is still in its initial `IN_PROGRESS` state.
 * A legacy factless WAITING_APPROVAL row may re-arm tracked episode 1 at an
 * exact REQUEST_REVISION or WITHDRAW_FROM_APPROVAL time. A later episode
 * starts exactly at the REQUEST_REVISION or WITHDRAW_FROM_APPROVAL that
 * re-armed it, persisted as a durable activation row in the same critical
 * transaction. Deliberately NOT derived from the previous SUBMITTED fact
 * (that lower bound backdates breaches before the new obligation existed),
 * mutable `updated_at` (polluted by delivery edits), or DB-clock activity
 * logs.
 */
export async function resolveSubmissionEpisodeActivation(
  tx: JobCardTransaction,
  organizationId: string,
  jobCardId: string,
  episodeNo: number,
  allowStartedAtFallback: boolean,
): Promise<Date | null> {
  const activation = await tx.getSubmissionEpisodeActivation(
    organizationId, jobCardId, episodeNo,
  );
  if (activation) return activation.activatedAt;
  // A missing activation on a reopened `REVISION_REQUESTED` episode is
  // ambiguous legacy history. `started_at` proves only the ordinary initial
  // episode; callers must opt into that fallback from the current lifecycle
  // state rather than treating it as universal evidence for episode 1.
  if (allowStartedAtFallback && episodeNo === 1) {
    return (await tx.getJobLifecycleInstants(organizationId, jobCardId)).startedAt;
  }
  return null;
}

function identityOf(incident: InsertOverdueIncidentInput): OverdueIncidentIdentity {
  return {
    organizationId: incident.organizationId,
    jobCardId: incident.jobCardId,
    delayType: incident.delayType,
    scheduleRevisionNo: incident.scheduleRevisionNo,
    episodeNo: incident.episodeNo,
  };
}

/** Insert the planned incident (idempotent via the UNIQUE identity). */
export async function commitOverdueBreachPlan(
  tx: JobCardTransaction,
  plan: OverdueBreachPlan,
): Promise<OverdueBreachEvaluation> {
  if (plan.kind !== 'breached') return plan;
  const inserted = await tx.insertOverdueIncident(plan.incident);
  return {
    kind: 'breached',
    created: inserted.created,
    identity: identityOf(plan.incident),
  };
}

/**
 * LATE_START: the job has an ACCEPTED commitment whose `scheduled_ends_at`
 * first-late boundary (the column itself; equality is late) has passed, and
 * the episode is eligible no earlier than acceptance and the governing
 * revision. Accountability is the assignee proven at `breached_at` from
 * immutable history; unprovable history stays UNKNOWN.
 */
export async function planLateStartBreach(
  tx: JobCardTransaction,
  input: {
    organizationId: string;
    jobCardId: string;
    scheduledEndsAt: string | null;
    /**
     * The acceptance about to be written by the enclosing ACCEPT_ASSIGNMENT
     * (not yet persisted, so it cannot be read back). Omitted everywhere
     * else: eligibility is read from the locked job row.
     */
    acceptedAtOverride?: Date;
    scheduleRevisionNo: number | null;
    revisionEffectiveAt: Date | null;
    /**
     * Pre-mutation lifecycle instants. The patch path updates the job row
     * BEFORE materializing (so assignment/schedule history still resolves
     * pre-move), which would void a management-cleared acceptance before
     * it is read — pass the pre-write read there. Lifecycle paths omit
     * this: they materialize before their transition runs.
     */
    instants?: JobLifecycleInstants;
    source: OverdueIncidentSource;
    requestTime: Date;
  },
): Promise<OverdueBreachPlan> {
  const deadlineAt = lateStartDeadlineAt(input.scheduledEndsAt);
  if (deadlineAt === null || !isInstantBreached(deadlineAt, input.requestTime)) {
    return { kind: 'not-breached' };
  }
  // No accepted commitment (NEW, or acceptance voided) => no LATE_START
  // on any path. A missing end is likewise unattributable (Decision 2).
  const acceptedAt = input.acceptedAtOverride
    ?? (input.instants ?? await tx.getJobLifecycleInstants(input.organizationId, input.jobCardId))
      .acceptedAt;
  if (acceptedAt === null) return { kind: 'not-breached' };
  let revisionNo = input.scheduleRevisionNo;
  let revisionEffectiveAt = input.revisionEffectiveAt;
  if (revisionNo === null || revisionEffectiveAt === null) {
    const current = await resolveGoverningRevision(
      tx, input.organizationId, input.jobCardId,
    );
    if (current === null) return { kind: 'unprovable', reason: 'REVISION_MISSING' };
    revisionNo = current.revisionNo;
    revisionEffectiveAt = current.createdAt;
  }
  const breachedAt = lateStartBreachAt({
    deadlineAt,
    acceptedAt,
    revisionEffectiveAt,
  });
  if (!isInstantBreached(breachedAt, input.requestTime)) return { kind: 'not-breached' };
  const assigneeAtBreach = await tx.getAssigneeAtInstant(
    input.organizationId, input.jobCardId, breachedAt,
  );
  return {
    kind: 'breached',
    breachAt: breachedAt,
    incident: {
      organizationId: input.organizationId,
      jobCardId: input.jobCardId,
      delayType: 'LATE_START',
      episodeNo: 1,
      scheduleRevisionNo: revisionNo,
      deadlineAt,
      breachedAt,
      accountableUserId: assigneeAtBreach,
      accountableRole: 'STAFF',
      accountableSource: assigneeAtBreach === null ? 'UNKNOWN' : 'ASSIGNMENT_AT_BREACH',
      source: input.source,
    },
  };
}

/**
 * LATE_SUBMISSION: the first-late boundary is the effective deadline + 1ms
 * (equality at the effective deadline is on time), and the episode must be
 * provably activated under an effective revision. A missing activation stays
 * unprovable instead of being backdated.
 *
 * Effective deadline priority is the shipped report contract:
 * `scheduled_ends_at`, else `scheduled_at` for non-SALES_MEETING, else the
 * organization-local due-date midnight.
 */
export async function planLateSubmissionBreach(
  tx: JobCardTransaction,
  input: {
    organizationId: string;
    jobCardId: string;
    scheduledEndsAt: string | null;
    scheduledAt: string | null;
    type: JobCard['type'];
    dueDate: string | null;
    episodeNo: number;
    allowStartedAtFallback: boolean;
    scheduleRevisionNo: number | null;
    revisionEffectiveAt: Date | null;
    source: OverdueIncidentSource;
    requestTime: Date;
  },
): Promise<OverdueBreachPlan> {
  const episodeActivationAt = await resolveSubmissionEpisodeActivation(
    tx, input.organizationId, input.jobCardId, input.episodeNo,
    input.allowStartedAtFallback,
  );
  if (episodeActivationAt === null) {
    return { kind: 'unprovable', reason: 'EPISODE_ACTIVATION_UNPROVABLE' };
  }
  // The phase deadline needs the org timezone only for the due_date
  // fallback; resolve it lazily so phase-deadline jobs never pay for it.
  const phaseDeadline = input.scheduledEndsAt
    ?? (input.type === 'SALES_MEETING' ? null : input.scheduledAt);
  let effective: Date | null = phaseDeadline === null ? null : new Date(phaseDeadline);
  if (effective === null) {
    if (input.dueDate === null) return { kind: 'not-breached' };
    const timezone = await tx.getOrganizationTimezone(input.organizationId);
    effective = effectiveSubmissionDeadlineAt({
      scheduledEndsAt: input.scheduledEndsAt,
      scheduledAt: input.scheduledAt,
      type: input.type,
      dueDate: input.dueDate,
      timezone,
    });
    if (effective === null) return { kind: 'not-breached' };
  }
  const deadlineAt = submissionBreachInstant(effective);
  if (!isInstantBreached(deadlineAt, input.requestTime)) return { kind: 'not-breached' };
  let revisionNo = input.scheduleRevisionNo;
  let revisionEffectiveAt = input.revisionEffectiveAt;
  if (revisionNo === null || revisionEffectiveAt === null) {
    const current = await resolveGoverningRevision(
      tx, input.organizationId, input.jobCardId,
    );
    if (current === null) return { kind: 'unprovable', reason: 'REVISION_MISSING' };
    revisionNo = current.revisionNo;
    revisionEffectiveAt = current.createdAt;
  }
  const breachedAt = submissionBreachAt({
    nominalFirstLateAt: deadlineAt,
    episodeActivationAt,
    revisionEffectiveAt,
  });
  if (!isInstantBreached(breachedAt, input.requestTime)) return { kind: 'not-breached' };
  const assigneeAtBreach = await tx.getAssigneeAtInstant(
    input.organizationId, input.jobCardId, breachedAt,
  );
  return {
    kind: 'breached',
    breachAt: breachedAt,
    incident: {
      organizationId: input.organizationId,
      jobCardId: input.jobCardId,
      delayType: 'LATE_SUBMISSION',
      episodeNo: input.episodeNo,
      scheduleRevisionNo: revisionNo,
      deadlineAt,
      breachedAt,
      accountableUserId: assigneeAtBreach,
      accountableRole: 'STAFF',
      accountableSource: assigneeAtBreach === null ? 'UNKNOWN' : 'ASSIGNMENT_AT_BREACH',
      source: input.source,
    },
  };
}

/**
 * APPROVAL_WAIT: boundary is the proven SUBMITTED fact + 24h (equality is
 * late) and the incident binds to the revision that fact belongs to.
 * Accountability is MANAGEMENT / ROLE_POLICY with no fabricated user. A
 * missing SUBMITTED fact (legacy pre-fact WAITING_APPROVAL) stays unprovable;
 * mutable `staff_completed_at` is never substituted.
 */
export async function planApprovalWaitBreach(
  tx: JobCardTransaction,
  input: {
    organizationId: string;
    jobCardId: string;
    source: OverdueIncidentSource;
    requestTime: Date;
  },
): Promise<OverdueBreachPlan> {
  const fact = await tx.getLatestSubmittedFact(input.organizationId, input.jobCardId);
  if (fact === null) return { kind: 'unprovable', reason: 'SUBMITTED_FACT_MISSING' };
  const deadlineAt = approvalWaitDeadlineAt(fact.occurredAt);
  if (!isInstantBreached(deadlineAt, input.requestTime)) return { kind: 'not-breached' };
  const revision = await tx.getScheduleRevision(
    input.organizationId, input.jobCardId, fact.scheduleRevisionNo,
  );
  if (revision === null) return { kind: 'unprovable', reason: 'REVISION_MISSING' };
  const breachedAt = approvalWaitBreachAt({
    deadlineAt,
    submittedAt: fact.occurredAt,
    revisionEffectiveAt: revision.createdAt,
  });
  if (!isInstantBreached(breachedAt, input.requestTime)) return { kind: 'not-breached' };
  return {
    kind: 'breached',
    breachAt: breachedAt,
    incident: {
      organizationId: input.organizationId,
      jobCardId: input.jobCardId,
      delayType: 'APPROVAL_WAIT',
      episodeNo: fact.seqNo,
      scheduleRevisionNo: fact.scheduleRevisionNo,
      deadlineAt,
      breachedAt,
      accountableUserId: null,
      accountableRole: 'MANAGEMENT',
      accountableSource: 'ROLE_POLICY',
      source: input.source,
    },
  };
}

/** LATE_START plan + insert (the request-driven contract). */
export async function materializeLateStartIfBreached(
  tx: JobCardTransaction,
  input: Parameters<typeof planLateStartBreach>[1],
): Promise<OverdueBreachEvaluation> {
  return commitOverdueBreachPlan(tx, await planLateStartBreach(tx, input));
}

/** LATE_SUBMISSION plan + insert (the request-driven contract). */
export async function materializeLateSubmissionIfBreached(
  tx: JobCardTransaction,
  input: Parameters<typeof planLateSubmissionBreach>[1],
): Promise<OverdueBreachEvaluation> {
  return commitOverdueBreachPlan(tx, await planLateSubmissionBreach(tx, input));
}

/** APPROVAL_WAIT plan + insert (the request-driven contract). */
export async function materializeApprovalWaitIfBreached(
  tx: JobCardTransaction,
  input: Parameters<typeof planApprovalWaitBreach>[1],
): Promise<OverdueBreachEvaluation> {
  return commitOverdueBreachPlan(tx, await planApprovalWaitBreach(tx, input));
}
