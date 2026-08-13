import type { SafeUser } from '../auth/types.js';
import { isTerminalJobStatus } from '../job-cards/policy.js';
import type { JobCardStatus } from '../job-cards/types.js';
import type { ConversationRecord } from './types.js';

/**
 * Contextual Messaging authorization policy (M3, organization-wide MANAGER RBAC).
 *
 * Conversation membership and resource authorization are separate concepts.
 *
 * MANAGER and ADMIN hold organization-wide operational Messaging authority:
 * same-org conversations are reachable without persisted membership, and JOB
 * conversations additionally require current access to the underlying JobCard
 * (actorCanReachJob in job-cards/policy.ts: non-STAFF actors reach org jobs).
 *
 * STAFF remains self/resource scoped: persisted membership is required, and
 * JOB conversations additionally require the JobCard to be currently assigned
 * to the actor.
 *
 * CUSTOMER and titled GENERAL conversations are authorization-free beyond
 * explicit participant membership for STAFF (there is no authoritative
 * Staff-to-Customer ownership model yet).
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
  const { actor, conversation, job } = input;
  if (actor.role !== 'STAFF') {
    // MANAGER/ADMIN: organization-wide operational authority. Persisted
    // membership is not an authorization gate; the hard boundary is same-org.
    if (conversation.organizationId !== actor.organizationId) return false;
    // JOB: membership alone is never sufficient — the JobCard must be reachable.
    if (conversation.contextType !== 'JOB') return true;
    if (!job) return false;
    return job.organizationId === actor.organizationId;
  }
  // STAFF: persisted membership remains required.
  if (!input.isParticipant) return false;
  if (conversation.contextType !== 'JOB') return true;
  // JOB: membership alone is never sufficient — the JobCard must be reachable.
  if (!job) return false;
  return job.organizationId === actor.organizationId
    && job.assignedTo === actor.id;
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
