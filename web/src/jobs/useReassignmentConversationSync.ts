import { useCallback, useRef, useState } from 'react';

import { ApiError } from '../services/api';
import {
  getJobConversation,
  jobAssigneeSync,
  type AssigneeSyncHint,
} from '../services/messaging-api';

export type ReassignmentOfferSource = 'patch' | 'hint';

export type ReassignmentOffer = Readonly<{
  transitionId: string;
  conversationId: string;
  oldAssignee: { id: string | null; name: string | null };
  newAssignee: { id: string | null; name: string | null };
  source?: ReassignmentOfferSource;
}>;

export type ReassignmentSyncState =
  | { kind: 'idle' }
  | { kind: 'offer'; offer: ReassignmentOffer }
  | { kind: 'syncing'; offer: ReassignmentOffer }
  | { kind: 'failure'; offer: ReassignmentOffer; message: string }
  | { kind: 'stale'; offer: ReassignmentOffer }
  | { kind: 'done' };

export type ReassignmentSyncOptions = {
  onSynced?: () => void;
};

export type ReassignmentSyncController = {
  state: ReassignmentSyncState;
  offerSync: (params: Omit<ReassignmentOffer, 'conversationId'>) => Promise<void>;
  offerFromHint: (conversationId: string, hint: AssigneeSyncHint) => void;
  confirm: () => Promise<void>;
  dismiss: () => void;
};

/**
 * M9 / MSG-002: explicit JOB assignee conversation sync orchestration.
 *
 * Job reassignment itself is always independent. After a successful assignment
 * PATCH (`offerSync`), the caller auto-opens the prompt; when Job Detail's
 * inline notice is clicked (`offerFromHint`), the caller opens confirmation
 * for that hint without re-fetching. Succeeding triggers `onSynced` so Job
 * Detail can refetch the lookup. The immutable JOB_ASSIGNED activity ID is the
 * only security identity the server relies on.
 */
export function useReassignmentConversationSync(
  jobId: string,
  options?: ReassignmentSyncOptions,
): ReassignmentSyncController {
  const [state, setState] = useState<ReassignmentSyncState>({ kind: 'idle' });
  const stateRef = useRef(state);
  stateRef.current = state;
  const clientActionIdRef = useRef<string | null>(null);
  const patchOfferPendingRef = useRef(0);
  const onSyncedRef = useRef(options?.onSynced);
  onSyncedRef.current = options?.onSynced;

  const offerSync = useCallback(async (params: Omit<ReassignmentOffer, 'conversationId'>) => {
    patchOfferPendingRef.current += 1;
    let conversationId: string | null = null;
    try {
      conversationId = (await getJobConversation(jobId))?.id ?? null;
    } catch {
      conversationId = null;
    } finally {
      patchOfferPendingRef.current -= 1;
    }
    if (!conversationId) return;
    clientActionIdRef.current = crypto.randomUUID();
    setState({ kind: 'offer', offer: { ...params, conversationId, source: 'patch' } });
  }, [jobId]);

  const offerFromHint = useCallback((conversationId: string, hint: AssigneeSyncHint) => {
    if (patchOfferPendingRef.current > 0) return;
    const current = stateRef.current;
    if (current.kind !== 'idle' && current.kind !== 'done') return;
    clientActionIdRef.current = crypto.randomUUID();
    setState({
      kind: 'offer',
      offer: {
        transitionId: hint.transitionId,
        conversationId,
        oldAssignee: hint.previousAssignee ?? { id: null, name: null },
        newAssignee: hint.newAssignee,
        source: 'hint',
      },
    });
  }, []);

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
      clientActionIdRef.current = null;
      setState({ kind: 'done' });
      onSyncedRef.current?.();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setState({ kind: 'stale', offer });
      } else {
        setState({
          kind: 'failure',
          offer,
          message: offer.source === 'hint'
            ? 'Konuşma katılımcıları güncellenemedi.'
            : 'Atama güncellendi. Konuşma katılımcıları güncellenemedi.',
        });
      }
    }
  }, []);

  const dismiss = useCallback(() => {
    clientActionIdRef.current = null;
    setState({ kind: 'idle' });
  }, []);

  return { state, offerSync, offerFromHint, confirm, dismiss };
}
