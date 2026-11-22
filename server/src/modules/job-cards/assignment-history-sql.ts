/**
 * The single server-side authority for "who was the assignee at an instant".
 *
 * Historical accountability and historical assignment are never reconstructed
 * from `job_cards.assigned_to`: whoever owns the job when a fact is read must
 * not leak into who owned it when the fact happened. The immutable
 * `job_card_assignment_history` row with the latest `changed_at` at or before
 * the instant is the only proof, and `id DESC` breaks a same-instant tie.
 *
 * Rendered as a scalar subquery so the OVR-2 incident producers and the OVR-7
 * lateness reads share one rule instead of copying it.
 */

export type AssigneeAtInstantSqlRefs = {
  /** SQL expression for the organization id (uuid-compatible). */
  organizationId: string;
  /** SQL expression for the job card id (uuid-compatible). */
  jobCardId: string;
  /** SQL expression for the instant, typed `timestamptz`. */
  instant: string;
};

/** Scalar subquery: the historical assignee, or NULL when unprovable. */
export function assigneeAtInstantSql(refs: AssigneeAtInstantSqlRefs): string {
  return `(SELECT h.to_user_id FROM job_card_assignment_history h
        WHERE h.organization_id = ${refs.organizationId}
          AND h.job_card_id = ${refs.jobCardId}
          AND h.changed_at <= ${refs.instant}
        ORDER BY h.changed_at DESC, h.id DESC
        LIMIT 1)`;
}
