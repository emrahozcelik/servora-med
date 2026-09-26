import type { JobCardAssignee } from './types.js';

/**
 * The universal staff-user lock contract.
 *
 * Every writer that can create, assign or otherwise change a user's work
 * acquires `users` rows through `getAssigneeForUpdate` FIRST, before JobCard,
 * Customer or Calendar rows, and always in one deterministic order: the ids
 * are de-duplicated and sorted as text. Two concurrent commands that touch
 * overlapping staff therefore serialize on the same lock sequence regardless
 * of the order the caller supplied them in, which is what makes "exactly one
 * canonical WeeklyReport per staff/week" hold across the single create, the
 * manager bulk request, the STAFF self-create and the recurrence worker.
 *
 * Extracted from `JobCardService.lockUsersInOrder` (verbatim semantics) so the
 * WeeklyReport recurrence service can participate in the SAME contract without
 * reaching into the JobCard service. The `transaction` argument is structural:
 * anything exposing `getAssigneeForUpdate` qualifies, including the JobCard
 * transaction and the recurrence worker's own transaction.
 */
export type AssigneeLockReader = {
  getAssigneeForUpdate(
    organizationId: string,
    userId: string,
  ): Promise<JobCardAssignee | null>;
};

export async function lockAssigneesInOrder(
  transaction: AssigneeLockReader,
  organizationId: string,
  userIds: readonly (string | null | undefined)[],
): Promise<Map<string, JobCardAssignee>> {
  const assignees = new Map<string, JobCardAssignee>();
  const orderedIds = [...new Set(userIds.filter(
    (userId): userId is string => typeof userId === 'string' && userId.length > 0,
  ))].sort();
  for (const userId of orderedIds) {
    const assignee = await transaction.getAssigneeForUpdate(organizationId, userId);
    if (assignee) assignees.set(userId, assignee);
  }
  return assignees;
}
