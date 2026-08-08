import type { SafeUser } from '../auth/types.js';
import { isTerminalJobStatus } from '../job-cards/policy.js';
import type { JobCardStatus } from '../job-cards/types.js';
import type { ConversationRecord } from './types.js';

/**
 * Contextual Messaging authorization policy (M3).
 *
 * Conversation membership and resource authorization are separate concepts.
 * JOB conversations require BOTH participant membership AND current access to
 * the underlying JobCard, using the authoritative JobCard access semantics
 * (actorCanReachJob in job-cards/policy.ts: non-STAFF actors reach org jobs,
 * STAFF actors reach only their assigned jobs).
 *
 * CUSTOMER and titled GENERAL conversations are authorization-free beyond
 * explicit participant membership (there is no authoritative Staff-to-Customer
 * ownership model yet).
 *
 * Legacy titleless GENERAL conversations are handled by the legacy pairwise
 * policy in MessagingService and never reach this module's membership path.
 */

export type JobAccessContext = Readonly<{
  organizationId: string;
  status: JobCardStatus;
  assignedTo: string;
}>;

export type MessagingAccessInput = Readonly<{
  actor: SafeUser;
  conversation: ConversationRecord;
  job: JobAccessContext | null;
  isParticipant: boolean;
}>;

export function isLegacyGeneralConversation(conversation: ConversationRecord): boolean {
  return conversation.contextType === 'GENERAL' && conversation.title === null;
}

export function canReadConversation(input: MessagingAccessInput): boolean {
  if (!input.isParticipant) return false;
  const { actor, conversation, job } = input;
  if (conversation.contextType !== 'JOB') return true;
  // JOB: membership alone is never sufficient — the JobCard must be reachable.
  if (!job) return false;
  return job.organizationId === actor.organizationId
    && (actor.role !== 'STAFF' || job.assignedTo === actor.id);
}

export function canSendMessage(input: MessagingAccessInput): boolean {
  if (!canReadConversation(input)) return false;
  const { conversation, job } = input;
  if (conversation.contextType === 'JOB') {
    // Terminal JobCards remain readable but operational coordination has ended.
    if (!job || isTerminalJobStatus(job.status)) return false;
  }
  return true;
}
