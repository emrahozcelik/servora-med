import { useRef, type ReactNode, type RefObject } from 'react';

import { ConfirmationAction, ReasonDialog } from '../ui/antd';
import type {
  RecordEditPresentation,
  TransitionPresentation,
} from './job-workflow-presentation';
import {
  FollowUpCancelContinuitySection,
  type FollowUpCancelContinuitySectionProps,
} from './FollowUpCancelContinuitySection';
import {
  FollowUpProposalSection,
  type FollowUpDraft,
  type FollowUpProposalSectionProps,
} from './FollowUpProposalSection';

export type JobWorkflowDialogKind =
  | { kind: 'submit'; presentation: TransitionPresentation }
  | { kind: 'approve'; presentation: TransitionPresentation }
  | { kind: 'revision'; presentation: TransitionPresentation }
  | { kind: 'withdraw-edit'; presentation: RecordEditPresentation }
  | { kind: 'cancel'; presentation: TransitionPresentation };

/**
 * Job workflow overlay router: confirmation vs reason capture.
 * Domain command selection stays in JobDetail; adapters own focus/draft.
 */
export function JobWorkflowDialog(props: {
  dialog: JobWorkflowDialogKind;
  pending: boolean;
  uncertain?: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
  followUp?: FollowUpProposalSectionProps;
  /** JOB-009: present only when cancelling a follow-up visit. */
  cancelContinuity?: FollowUpCancelContinuitySectionProps;
  returnFocusRef?: RefObject<HTMLElement | null>;
  restoreFocusEnabledRef?: RefObject<boolean>;
}): ReactNode {
  const {
    dialog, pending, uncertain = false, onClose, onConfirm, followUp, cancelContinuity,
    returnFocusRef, restoreFocusEnabledRef,
  } = props;
  const continuity = dialog.kind === 'cancel' ? cancelContinuity : undefined;
  const followUpInitialFocusRef = useRef<HTMLElement>(null);

  if (dialog.kind === 'withdraw-edit') {
    const title = dialog.presentation.confirmation?.title ?? dialog.presentation.label;
    const details = dialog.presentation.confirmation?.details ?? [];
    const confirmLabel = dialog.presentation.confirmation?.confirmLabel
      ?? 'Kontrolden çıkar ve düzenle';
    return (
      <ConfirmationAction
        open
        title={title}
        description={dialog.presentation.consequence}
        details={details}
        confirmLabel={uncertain ? 'Özgün isteği tekrar dene' : confirmLabel}
        pending={pending}
        returnFocusRef={returnFocusRef}
        onCancel={onClose}
        onConfirm={() => onConfirm('')}
      />
    );
  }

  const title = dialog.kind === 'approve'
    ? (dialog.presentation.confirmation?.title ?? dialog.presentation.label)
    : dialog.presentation.label;
  const description = dialog.kind === 'submit'
    ? dialog.presentation.consequence
    : dialog.kind === 'approve'
      ? [
          dialog.presentation.consequence,
          ...(dialog.presentation.confirmation?.details ?? []),
        ].join(' ')
      : dialog.kind === 'revision'
        ? 'Personelin neyi düzeltmesi gerektiğini açıklayın.'
        : continuity?.draft.decision === 'RESCHEDULE'
          ? 'İptal edilen iş yeniden açılamaz; seçtiğiniz zamana yeni bir takip ziyareti oluşturulur. İptal nedenini iş geçmişine ekleyin.'
          : 'Bu işlem terminaldir; iptal edilen iş yeniden açılamaz. İptal nedenini iş geçmişine ekleyin.';
  const reasonLabel = dialog.kind === 'submit'
    ? 'Tamamlanma sonucu'
    : dialog.kind === 'approve'
      ? 'Onay notu'
      : dialog.kind === 'revision'
        ? 'Düzeltme nedeni'
        : 'İptal nedeni';
  const confirmLabel = dialog.kind === 'submit'
    ? (dialog.presentation.confirmation?.confirmLabel ?? dialog.presentation.label)
    : dialog.kind === 'approve'
      ? (dialog.presentation.confirmation?.confirmLabel ?? 'İşi tamamla')
      : dialog.kind === 'revision'
        ? 'Düzeltme için geri gönder'
        : continuity?.draft.decision === 'RESCHEDULE'
          ? 'İptal et ve yeniden planla'
          : continuity?.draft.decision === 'END_CYCLE'
            ? 'İptal et ve döngüyü sonlandır'
            : 'İşi iptal et';

  const prelude = (dialog.kind === 'submit' || dialog.kind === 'approve') && followUp
    ? <fieldset disabled={pending || uncertain}><FollowUpProposalSection {...followUp} initialFocusRef={followUpInitialFocusRef} /></fieldset>
    : continuity
      ? <fieldset disabled={pending || uncertain}><FollowUpCancelContinuitySection {...continuity} initialFocusRef={followUpInitialFocusRef} /></fieldset>
      : undefined;
  const hasPreludeFocus = followUp !== undefined || continuity !== undefined;

  return (
    <ReasonDialog
      open
      title={title}
      description={uncertain ? 'İşlemin sonucu henüz doğrulanamadı. Alanlar kilitli; tekrar deneme özgün isteği gönderir.' : description}
      reasonLabel={reasonLabel}
      helperText={dialog.kind === 'submit'
        ? 'Bu açıklama, yönetici kontrolüne gönderilen iş kaydında saklanır.'
        : undefined}
      requiredMessage={dialog.kind === 'submit'
        ? 'Tamamlanma sonucu zorunludur.'
        : undefined}
      confirmLabel={uncertain ? 'Özgün isteği tekrar dene' : confirmLabel}
      maxLength={2000}
      required={dialog.kind !== 'approve'}
      pending={pending}
      inputsDisabled={uncertain}
      destructive={dialog.kind === 'cancel'}
      prelude={prelude}
      initialFocusRef={hasPreludeFocus ? followUpInitialFocusRef : undefined}
      initialFocusReady={hasPreludeFocus}
      returnFocusRef={returnFocusRef}
      restoreFocusEnabledRef={restoreFocusEnabledRef}
      onCancel={onClose}
      onConfirm={onConfirm}
    />
  );
}
