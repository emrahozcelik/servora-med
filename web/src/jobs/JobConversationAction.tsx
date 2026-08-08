import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError, type CurrentUser } from '../services/api';
import {
  createOrGetConversation,
  getJobConversation,
} from '../services/messaging-api';
import { useRealtimeInvalidation } from '../realtime/RealtimeProvider';
import type { JobCard } from './jobs-api';

const TERMINAL_STATUSES = new Set(['COMPLETED', 'CANCELLED']);

type Resolution =
  | { kind: 'resolving' }
  | { kind: 'open'; conversationId: string }
  | { kind: 'start' }
  | { kind: 'none' };

/**
 * Restrained Job Detail entry into the canonical JOB conversation (M5).
 *
 * - Authorized persisted participant: "Konuşmayı aç" → deep link.
 * - Admin/Manager with no authorized conversation on an eligible active Job:
 *   "Konuşma başlat" → reuses the frozen M4 create-or-get contract; the server
 *   stays the authority (existing canonical is returned, non-participants are
 *   denied 403 with no metadata and are never added).
 * - Staff / terminal / no-assignee without an authorized conversation: no action.
 */
export function JobConversationAction({
  job,
  user,
  onOpenMessaging,
  onVisibilityChange,
}: {
  job: JobCard;
  user: CurrentUser;
  onOpenMessaging: (conversationId: string) => void;
  onVisibilityChange?: (visible: boolean) => void;
}) {
  const [resolution, setResolution] = useState<Resolution>({ kind: 'resolving' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lookupSeqRef = useRef(0);

  const canManage = user.role === 'ADMIN' || user.role === 'MANAGER';
  const canCreate = canManage
    && !TERMINAL_STATUSES.has(job.status)
    && Boolean(job.assignedTo);

  const resolve = useCallback(async () => {
    const jobId = job.id;
    const seq = ++lookupSeqRef.current;
    setError('');
    try {
      const conversation = await getJobConversation(jobId);
      if (seq !== lookupSeqRef.current) return;
      if (conversation) {
        setResolution({ kind: 'open', conversationId: conversation.id });
      } else {
        setResolution({ kind: canCreate ? 'start' : 'none' });
      }
    } catch {
      if (seq !== lookupSeqRef.current) return;
      // Transient lookup failure keeps the create path as the authoritative
      // decision-maker: a legitimate participant creating again gets the
      // existing canonical thread back, a non-participant is denied safely.
      setResolution({ kind: canCreate ? 'start' : 'none' });
    }
  }, [job.id, canCreate]);

  useEffect(() => {
    setResolution({ kind: 'resolving' });
    void resolve();
  }, [resolve]);

  useRealtimeInvalidation(['conversations', 'message-unread'], () => {
    void resolve();
  });

  const effective: Resolution = resolution.kind === 'start' && !canCreate
    ? { kind: 'none' }
    : resolution;

  useEffect(() => {
    onVisibilityChange?.(effective.kind !== 'none');
  }, [effective.kind, onVisibilityChange]);

  if (user.capabilities?.messaging !== true) return null;
  if (resolution.kind === 'resolving') return null;
  if (effective.kind === 'none') return null;

  async function handleClick() {
    if (busy) return;
    if (effective.kind === 'open') {
      onOpenMessaging(effective.conversationId);
      return;
    }
    if (effective.kind !== 'start') return;
    setBusy(true);
    setError('');
    try {
      const conversation = await createOrGetConversation({
        contextType: 'JOB',
        jobId: job.id,
        participantUserIds: [job.assignedTo],
      });
      onOpenMessaging(conversation.id);
    } catch (caught) {
      const retryable = caught instanceof ApiError && caught.status >= 500;
      setError(retryable
        ? 'Konuşma açılamadı. Lütfen tekrar deneyin.'
        : 'Konuşma açılamadı.');
    } finally {
      setBusy(false);
    }
  }

  const label = effective.kind === 'open' ? 'Konuşmayı aç' : 'Konuşma başlat';

  return (
    <div
      className="job-detail-workflow-messaging"
      data-job-detail-section="messaging"
      data-job-detail-messaging="true"
    >
      <button
        className="secondary-button"
        type="button"
        onClick={() => void handleClick()}
        disabled={busy}
        aria-busy={busy}
      >
        {busy ? 'Açılıyor…' : label}
      </button>
      {error && <p className="field-error" role="alert">{error}</p>}
    </div>
  );
}
