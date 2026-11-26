import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError, type CurrentUser } from '../services/api';
import {
  createOrGetConversation,
  getJobConversation,
  type AssigneeSyncHint,
} from '../services/messaging-api';
import { useRealtimeInvalidation } from '../realtime/RealtimeProvider';
import type { JobCard } from './jobs-api';
import './reassignment-sync.css';

const TERMINAL_STATUSES = new Set(['COMPLETED', 'CANCELLED', 'INVALIDATED']);

type Resolution =
  | { kind: 'resolving' }
  | { kind: 'open'; conversationId: string; assigneeSync: AssigneeSyncHint | null }
  | { kind: 'start' }
  | { kind: 'none' };

/**
 * Restrained Job Detail entry into the canonical JOB conversation (M5 / MSG-002).
 *
 * - Authorized persisted participant: "Konuşmayı aç" → deep link.
 * - Admin/Manager with no authorized conversation on an eligible active Job:
 *   "Konuşma başlat" → reuses the frozen M4 create-or-get contract; the server
 *   stays the authority. Organization-wide MANAGER RBAC: a same-org accessible
 *   Job resolves its canonical thread even without persisted membership
 *   (non-participants are never inserted; membership stays immutable).
 * - Admin/Manager when the canonical lookup reports `assigneeSync`: renders a
 *   calm inline notice with a secondary "Konuşmaya ekle" action that opens the
 *   explicit confirmation dialog without auto-interrupting page load.
 * - Staff / terminal / no-assignee without an authorized conversation: no action.
 */
export function JobConversationAction({
  job,
  user,
  onOpenMessaging,
  onVisibilityChange,
  onRequestAssigneeSync,
  refreshKey = 0,
  disabled = false,
}: {
  job: JobCard;
  user: CurrentUser;
  onOpenMessaging: (conversationId: string) => void;
  onVisibilityChange?: (visible: boolean) => void;
  onRequestAssigneeSync?: (conversationId: string, hint: AssigneeSyncHint) => void;
  refreshKey?: number;
  disabled?: boolean;
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
        setResolution({
          kind: 'open',
          conversationId: conversation.id,
          assigneeSync: conversation.assigneeSync,
        });
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
  }, [job.id, canCreate, refreshKey]);

  useEffect(() => {
    setResolution({ kind: 'resolving' });
  }, [job.id]);

  useEffect(() => {
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
    if (busy || disabled) return;
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
  const pendingHint = effective.kind === 'open' && canManage && onRequestAssigneeSync
    ? effective.assigneeSync
    : null;

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
        disabled={busy || disabled}
        aria-busy={busy}
      >
        {busy ? 'Açılıyor…' : label}
      </button>
      {error && <p className="field-error" role="alert">{error}</p>}
      {pendingHint && effective.kind === 'open' && (
        <section
          className="job-assignee-sync-notice"
          aria-label="Konuşma katılımcısı güncellemesi"
          data-job-assignee-sync-notice="true"
        >
          <p>
            {`İşin yeni sorumlusu ${pendingHint.newAssignee.name} bu iş konuşmasının katılımcısı değil.`}
          </p>
          <button
            className="secondary-button"
            type="button"
            disabled={disabled}
            onClick={() => {
              onRequestAssigneeSync?.(effective.conversationId, pendingHint);
            }}
          >
            Konuşmaya ekle
          </button>
        </section>
      )}
    </div>
  );
}
