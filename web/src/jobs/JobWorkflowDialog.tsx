import { useRef, type ReactNode, type RefObject } from 'react';

import { ConfirmationAction, ReasonDialog } from '../ui/antd';
import {
  saleDeliveryApproveCopy,
  type RecordEditPresentation,
  type TransitionPresentation,
} from './job-workflow-presentation';
import {
  FollowUpCancelContinuitySection,
  type FollowUpCancelContinuitySectionProps,
} from './FollowUpCancelContinuitySection';
import {
  AssignmentReasonSection,
  type AssignmentReasonDraft,
} from './AssignmentOffer';
import {
  FollowUpProposalSection,
  type FollowUpDraft,
  type FollowUpProposalSectionProps,
} from './FollowUpProposalSection';
import {
  SaleApprovalDeliverySection,
  type SaleApprovalDeliverySectionProps,
} from './SaleApprovalDeliverySection';
import {
  RevisionCorrectionDueField,
  type RevisionCorrectionDraft,
} from './RevisionCorrectionDueField';

export type JobWorkflowDialogKind =
  | { kind: 'submit'; presentation: TransitionPresentation }
  | { kind: 'approve'; presentation: TransitionPresentation }
  | { kind: 'revision'; presentation: TransitionPresentation }
  | { kind: 'withdraw-edit'; presentation: RecordEditPresentation }
  | { kind: 'cancel'; presentation: TransitionPresentation }
  | { kind: 'decline'; presentation: TransitionPresentation }
  | { kind: 'release'; presentation: TransitionPresentation };

/**
 * Job workflow overlay router: confirmation vs reason capture.
 * Domain command selection stays in JobDetail; adapters own focus/draft.
 */
export function JobWorkflowDialog(props: {
  dialog: JobWorkflowDialogKind;
  pending: boolean;
  pendingLabel?: string;
  uncertain?: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
  followUp?: FollowUpProposalSectionProps;
  loadingFollowUp?: boolean;
  followUpLoadError?: string | null;
  /** Locks the confirm while another dependency (the visit pair) is still loading. */
  confirmBlocked?: boolean;
  validatePrelude?: () => string | null;
  /**
   * SALE-002 §8.1: pair summary rendered above the preludes for the visit
   * submit / approve / revision dialogs, and appended to the withdraw
   * confirmation details. Presentation only; the server owns coordination.
   */
  pairNote?: ReactNode;
  pairDetails?: readonly string[];
  /**
   * SALE-002 §8.2: the "Teslim işi aç" section, offered only on an approve
   * dialog that completes a sale (visit pair or independent sale). It renders
   * after the follow-up proposal prelude.
   */
  saleDelivery?: SaleApprovalDeliverySectionProps;
  /** JOB-009: present only when cancelling a follow-up visit. */
  cancelContinuity?: FollowUpCancelContinuitySectionProps;
  /** JOB-010 release 2b: present only for decline / release of an assignment. */
  assignmentReason?: {
    draft: AssignmentReasonDraft;
    inlineError: string | null;
    /** JOB-012: inline error of the proposed-time field. */
    scheduleError: string | null;
    onChange: (patch: Partial<AssignmentReasonDraft>) => void;
  };
  /**
   * OVR-5 §3.9: present only for a revision when the job has an original
   * submission deadline; a job without one never offers or sends the picker.
   */
  revisionCorrection?: {
    draft: RevisionCorrectionDraft;
    onChange: (next: RevisionCorrectionDraft) => void;
  };
  returnFocusRef?: RefObject<HTMLElement | null>;
  restoreFocusEnabledRef?: RefObject<boolean>;
}): ReactNode {
  const {
    dialog, pending, pendingLabel, uncertain = false, onClose, onConfirm, followUp, cancelContinuity,
    assignmentReason, revisionCorrection, returnFocusRef, restoreFocusEnabledRef,
    pairNote, pairDetails = [], saleDelivery,
    loadingFollowUp = false, followUpLoadError = null, confirmBlocked = false, validatePrelude,
  } = props;
  const continuity = dialog.kind === 'cancel' ? cancelContinuity : undefined;
  const followUpInitialFocusRef = useRef<HTMLElement>(null);

  if (dialog.kind === 'withdraw-edit') {
    const title = dialog.presentation.confirmation?.title ?? dialog.presentation.label;
    const details = [...(dialog.presentation.confirmation?.details ?? []), ...pairDetails];
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

  const title = dialog.kind === 'approve' || dialog.kind === 'submit'
    ? (dialog.presentation.confirmation?.title ?? dialog.presentation.label)
    : dialog.presentation.label;
  const deliveryCopy = dialog.kind === 'approve' && saleDelivery?.draft.enabled
    ? saleDeliveryApproveCopy(followUp !== undefined)
    : undefined;
  const dialogDetails = dialog.kind === 'approve' || dialog.kind === 'submit'
    ? [
        ...(dialog.presentation.confirmation?.details ?? []),
        ...(deliveryCopy ? [deliveryCopy.detail] : []),
      ]
    : [];
  const description = dialog.kind === 'submit'
    ? dialog.presentation.consequence
    : dialog.kind === 'approve'
      ? dialog.presentation.consequence
      : dialog.kind === 'revision'
        ? 'Personelin neyi düzeltmesi gerektiğini açıklayın.'
        : dialog.kind === 'decline' || dialog.kind === 'release'
          ? `${dialog.presentation.consequence}\nSeçtiğiniz neden ve açıklama yöneticiye iletilir.`
          : continuity?.draft.decision === 'RESCHEDULE'
            ? 'İptal edilen iş yeniden açılamaz; seçtiğiniz zamana yeni bir takip ziyareti oluşturulur. İptal nedenini iş geçmişine ekleyin.'
            : 'İptal edilen iş yeniden açılamaz.\nİptal nedenini iş geçmişine ekleyin.';
  const reasonLabel = dialog.kind === 'submit'
    ? 'Tamamlanma sonucu'
    : dialog.kind === 'approve'
      ? 'Onay notu'
      : dialog.kind === 'revision'
        ? 'Düzeltme nedeni'
        : dialog.kind === 'decline' || dialog.kind === 'release'
          ? 'Açıklama'
          : 'İptal nedeni';
  const confirmLabel = dialog.kind === 'submit'
    ? (dialog.presentation.confirmation?.confirmLabel ?? dialog.presentation.label)
    : dialog.kind === 'approve'
      ? (deliveryCopy?.confirmLabel ?? dialog.presentation.confirmation?.confirmLabel ?? 'İşi tamamla')
      : dialog.kind === 'revision'
        ? 'Düzeltme için geri gönder'
        : dialog.kind === 'decline'
          ? 'Görevi reddet'
          : dialog.kind === 'release'
            ? 'Görevi geri bırak'
            : continuity?.draft.decision === 'RESCHEDULE'
              ? 'İptal et ve yeniden planla'
              : continuity?.draft.decision === 'END_CYCLE'
                ? 'İptal et ve döngüyü sonlandır'
                : 'İşi iptal et';

  const preludeContent = (dialog.kind === 'submit' || dialog.kind === 'approve') && followUp
    ? <fieldset disabled={pending || uncertain}><FollowUpProposalSection {...followUp} initialFocusRef={followUpInitialFocusRef} /></fieldset>
    : continuity
      ? <fieldset disabled={pending || uncertain}><FollowUpCancelContinuitySection {...continuity} initialFocusRef={followUpInitialFocusRef} /></fieldset>
      : (dialog.kind === 'decline' || dialog.kind === 'release') && assignmentReason
        ? <fieldset disabled={pending || uncertain}>
            <AssignmentReasonSection
              draft={assignmentReason.draft}
              inlineError={assignmentReason.inlineError}
              scheduleError={assignmentReason.scheduleError}
              onChange={assignmentReason.onChange}
              initialFocusRef={followUpInitialFocusRef}
            />
          </fieldset>
        : dialog.kind === 'revision' && revisionCorrection
          ? <fieldset disabled={pending || uncertain}>
              <RevisionCorrectionDueField
                draft={revisionCorrection.draft}
                onChange={revisionCorrection.onChange}
              />
            </fieldset>
          : undefined;
  const followUpStatusContent = (dialog.kind === 'submit' || dialog.kind === 'approve')
    && (loadingFollowUp || followUpLoadError)
    ? (
        <>
          {loadingFollowUp && (
            <p className="field-status" role="status">Takip önerisi yükleniyor…</p>
          )}
          {followUpLoadError && (
            <p className="form-error" role="alert">{followUpLoadError}</p>
          )}
        </>
      )
    : undefined;
  // The pair summary is informational, so it sits above the (optionally
  // disabled) prelude and never becomes the initial focus target.
  const deliveryContent = dialog.kind === 'approve' && saleDelivery
    ? <SaleApprovalDeliverySection {...saleDelivery} />
    : undefined;
  const prelude = pairNote || followUpStatusContent || preludeContent || deliveryContent
    ? <>{pairNote}{followUpStatusContent}{preludeContent}{deliveryContent}</>
    : undefined;
  const hasPreludeFocus = followUp !== undefined
    || continuity !== undefined
    || assignmentReason !== undefined;

  return (
    <ReasonDialog
      open
      title={title}
      description={uncertain ? 'İşlemin sonucu henüz doğrulanamadı. Alanlar kilitli; tekrar deneme özgün isteği gönderir.' : description}
      details={dialogDetails}
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
      pendingLabel={pendingLabel}
      confirmDisabled={loadingFollowUp || confirmBlocked}
      inputsDisabled={uncertain}
      destructive={dialog.kind === 'cancel' || dialog.kind === 'decline' || dialog.kind === 'release'}
      prelude={prelude}
      validatePrelude={validatePrelude}
      initialFocusRef={hasPreludeFocus ? followUpInitialFocusRef : undefined}
      initialFocusReady={hasPreludeFocus}
      returnFocusRef={returnFocusRef}
      restoreFocusEnabledRef={restoreFocusEnabledRef}
      onCancel={onClose}
      onConfirm={onConfirm}
    />
  );
}
