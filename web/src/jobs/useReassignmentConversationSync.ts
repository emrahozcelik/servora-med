import { useCallback, useRef, useState } from 'react';

import { ApiError } from '../services/api';
import { getJobConversation, jobAssigneeSync } from '../services/messaging-api';

export type ReassignmentOffer = Readonly<{
  transitionId: string;
  conversationId: string;
  oldAssignee: { id: string | null; name: string | null };
  newAssignee: { id: string | null; name: string | null };
}>;

export type ReassignmentSyncState =
  | { kind: 'idle' }
  | { kind: 'offer'; offer: ReassignmentOffer }
  | { kind: 'syncing'; offer: ReassignmentOffer }
  | { kind: 'failure'; offer: ReassignmentOffer; message: string }
  | { kind: 'stale'; offer: ReassignmentOffer }
  | { kind: 'done' };

export type ReassignmentSyncController = {
  state: ReassignmentSyncState;
  offerSync: (params: Omit<ReassignmentOffer, 'conversationId'>) => Promise<void>;
  confirm: () => Promise<void>;
  dismiss: () => void;
};

/**
 * M9: explicit JOB assignee conversation sync orchestration.
 *
 * Job reassignment itself is always independent. After a successful assignment
 * PATCH the caller offers a sync; the conversation is located through the
 * opaque M5 lookup, so nonparticipant managers and absent conversations never
 * produce a prompt. The immutable JOB_ASSIGNED activity ID is the only
 * security identity the server relies on.
 */
export function useReassignmentConversationSync(jobId: string): ReassignmentSyncController {
  const [state, setState] = useState<ReassignmentSyncState>({ kind: 'idle' });
  const stateRef = useRef(state);
  stateRef.current = state;
  const clientActionIdRef = useRef<string | null>(null);

  const offerSync = useCallback(async (params: Omit<ReassignmentOffer, 'conversationId'>) => {
    let conversationId: string | null = null;
    try {
      conversationId = (await getJobConversation(jobId))?.id ?? null;
    } catch {
      conversationId = null;
    }
    if (!conversationId) return;
    clientActionIdRef.current = crypto.randomUUID();
    setState({ kind: 'offer', offer: { ...params, conversationId } });
  }, [jobId]);

  const confirm = useCallback(async () => {
    const current = stateRef.current;
    if (current.kind !== 'offer' && current.kind !== 'failure') return;
    const offer = current.offer;
    const clientActionId = clientActionIdRef.current ?? crypto.randomUUID();
    clientActionIdRef.current = clientActionId;
    setState({ kind: 'syncing', offer });
    try {
      await jobAssigneeSync(offer.conversationId, {
        clientActionId,
        assignmentTransitionId: offer.transitionId,
      });
      setState({ kind: 'done' });
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setState({ kind: 'stale', offer });
      } else {
        setState({
          kind: 'failure',
          offer,
          message: 'Atama güncellendi. Konuşma katılımcıları güncellenemedi.',
        });
      }
    }
  }, []);

  const dismiss = useCallback(() => {
    clientActionIdRef.current = null;
    setState({ kind: 'idle' });
  }, []);

  return { state, offerSync, confirm, dismiss };
}
