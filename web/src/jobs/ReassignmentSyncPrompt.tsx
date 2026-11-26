import type { ReactNode, RefObject } from 'react';

import { ConfirmationAction } from '../ui/antd/ConfirmationAction';
import type { ReassignmentSyncState } from './useReassignmentConversationSync';
import './reassignment-sync.css';

export type ReassignmentSyncPromptProps = {
  state: ReassignmentSyncState;
  onConfirm: () => void;
  onDismiss: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
};

const DURABLE_MEMBERSHIP_HELPER =
  'Şimdi değil derseniz konuşmadaki mevcut katılımcılar değişmez. '
  + 'Önceki personel ileride bu işe tekrar atanırsa konuşmaya yeniden erişebilir.';

/**
 * M9 reassignment follow-up confirmation. Persistent readable helper text
 * communicates the durable-membership consequence (tooltip-only is never
 * acceptable; this text is part of the dialog body and survives mobile/touch
 * and accessibility use).
 */
export function ReassignmentSyncPrompt({
  state,
  onConfirm,
  onDismiss,
  returnFocusRef,
}: ReassignmentSyncPromptProps): ReactNode {
  if (
    state.kind !== 'offer'
    && state.kind !== 'syncing'
    && state.kind !== 'failure'
    && state.kind !== 'stale'
  ) {
    return null;
  }
  const offer = state.offer;
  const hasNew = offer.newAssignee.id !== null;
  const hasOld = offer.oldAssignee.id !== null;
  const oldName = offer.oldAssignee.name ?? 'Önceki personel';
  const newName = offer.newAssignee.name ?? 'Yeni personel';

  let title: string;
  let body: string;
  let confirmLabel: string;
  if (offer.source === 'hint') {
    title = 'Konuşma katılımcısı güncel değil';
    body = `İşin yeni sorumlusu ${newName} bu iş konuşmasının katılımcısı değil.`;
    confirmLabel = hasOld ? `${oldName} yerine ${newName} ekle` : `${newName} ekle`;
  } else if (hasNew && hasOld) {
    title = 'Atanan personel değişti';
    body = 'Konuşmadaki personeli de güncellemek ister misiniz?';
    confirmLabel = `${oldName} yerine ${newName} ekle`;
  } else if (hasNew) {
    title = 'Konuşmaya personel eklenecek';
    body = 'Yeni atanan personeli konuşmaya eklemek ister misiniz?';
    confirmLabel = `${newName} ekle`;
  } else {
    title = 'İş artık atanmamış';
    body = 'Önceki personeli konuşmadan çıkarmak ister misiniz?';
    confirmLabel = 'Konuşmadan çıkar';
  }

  return (
    <ConfirmationAction
      open
      title={title}
      description={
        <>
          <span className="reassignment-sync-body">{body}</span>
          <span className="reassignment-sync-helper">
            {DURABLE_MEMBERSHIP_HELPER}
          </span>
          {state.kind === 'failure' && (
            <span className="form-error reassignment-sync-error" role="alert">
              {state.message}
            </span>
          )}
          {state.kind === 'stale' && (
            <span className="form-error reassignment-sync-error" role="alert">
              Atama yeniden değişti. Konuşma katılımcıları güncellenmedi.
            </span>
          )}
        </>
      }
      confirmLabel={confirmLabel}
      cancelLabel="Şimdi değil"
      pending={state.kind === 'syncing'}
      pendingLabel="Güncelleniyor…"
      onConfirm={onConfirm}
      onCancel={onDismiss}
      returnFocusRef={returnFocusRef}
    />
  );
}
