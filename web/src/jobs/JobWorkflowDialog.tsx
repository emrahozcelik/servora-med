import type { ReactNode, RefObject } from 'react';

import { ConfirmationAction, ReasonDialog } from '../ui/antd';
import type {
  RecordEditPresentation,
  TransitionPresentation,
} from './job-workflow-presentation';

export type JobWorkflowDialogKind =
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
}): ReactNode {
  const { dialog, pending, onClose, onConfirm, returnFocusRef } = props;

  if (dialog.kind === 'approve' || dialog.kind === 'withdraw-edit') {
    const title = dialog.presentation.confirmation?.title ?? dialog.presentation.label;
    const details = dialog.presentation.confirmation?.details ?? [];
    const confirmLabel = dialog.kind === 'approve'
      ? (dialog.presentation.confirmation?.confirmLabel ?? 'İşi tamamla')
      : (dialog.presentation.confirmation?.confirmLabel ?? 'Kontrolden çıkar ve düzenle');
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

  const title = dialog.presentation.label;
  const description = dialog.kind === 'revision'
    ? 'Personelin neyi düzeltmesi gerektiğini açıklayın.'
    : 'Bu işlem terminaldir; iptal edilen iş yeniden açılamaz. İptal nedenini iş geçmişine ekleyin.';
  const reasonLabel = dialog.kind === 'revision' ? 'Düzeltme nedeni' : 'İptal nedeni';
  const confirmLabel = dialog.kind === 'revision'
    ? 'Düzeltme için geri gönder'
    : 'İşi iptal et';

  return (
    <ReasonDialog
      open
      title={title}
      description={description}
      reasonLabel={reasonLabel}
      confirmLabel={confirmLabel}
      maxLength={2000}
      required
      pending={pending}
      destructive={dialog.kind === 'cancel'}
      returnFocusRef={returnFocusRef}
      onCancel={onClose}
      onConfirm={onConfirm}
    />
  );
}
