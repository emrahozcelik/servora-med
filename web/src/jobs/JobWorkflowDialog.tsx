import type { ReactNode, RefObject } from 'react';

import { ConfirmationAction, ReasonDialog } from '../ui/antd';
import type {
  RecordEditPresentation,
  TransitionPresentation,
} from './job-workflow-presentation';

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
  onClose: () => void;
  onConfirm: (reason: string) => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
  restoreFocusEnabledRef?: RefObject<boolean>;
}): ReactNode {
  const {
    dialog, pending, onClose, onConfirm, returnFocusRef, restoreFocusEnabledRef,
  } = props;

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
        confirmLabel={confirmLabel}
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
        : 'İşi iptal et';

  return (
    <ReasonDialog
      open
      title={title}
      description={description}
      reasonLabel={reasonLabel}
      helperText={dialog.kind === 'submit'
        ? 'Bu açıklama, yönetici kontrolüne gönderilen iş kaydında saklanır.'
        : undefined}
      requiredMessage={dialog.kind === 'submit'
        ? 'Tamamlanma sonucu zorunludur.'
        : undefined}
      confirmLabel={confirmLabel}
      maxLength={2000}
      required={dialog.kind !== 'approve'}
      pending={pending}
      destructive={dialog.kind === 'cancel'}
      returnFocusRef={returnFocusRef}
      restoreFocusEnabledRef={restoreFocusEnabledRef}
      onCancel={onClose}
      onConfirm={onConfirm}
    />
  );
}
