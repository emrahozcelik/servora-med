import { useEffect, useId, useRef, useState, type FormEvent } from 'react';

import { ApiError, type CurrentUser } from '../services/api';
import { listStaff, type StaffProfile } from '../services/people-api';
import { ProgressiveCounter } from '../ui/ProgressiveCounter';
import { PriorityChip } from '../ui/PriorityChip';
import { StatusChip } from '../ui/StatusChip';
import { ReasonDialog } from '../ui/antd/ReasonDialog';
import { ResponsiveFormDrawer } from '../ui/antd/ResponsiveFormDrawer';
import { counterState } from '../ui/counter-policy';
import { SignalGlyph } from '../ui/signal-icons';
import { WheelDateTimeField } from '../ui/WheelDateTimeField';
import { formatWheelDisplay } from '../ui/wheel-datetime';
import { apiFieldError } from './api-field-error';
import { assignmentWindowErrorMessage } from './assignment-window-errors';
import {
  buildPatchCommitReceipt,
  filterEligibleTransferStaff,
  formatProposedInterval,
  formatRecoveryInstant,
  hasManagementRecoveryOffer,
  plannedIntervalDurationMinutes,
  proposalAcceptErrorMessage,
  recoveryOfferHeadline,
} from './assignment-transfer-helpers';
import { AvailableSlotsNotice } from './AvailableSlotsNotice';
import { CustomerSearchSelect } from './CustomerSearchSelect';
import {
  EMPTY_FOLLOW_UP_CANCEL_CONTINUITY,
  FollowUpCancelContinuitySection,
  type FollowUpCancelContinuityDraft,
} from './FollowUpCancelContinuitySection';
import {
  assignmentOfferCloseReasonLabel,
  assignmentOfferUrgentReasonLabel,
  assignmentSuggestedSolutionLabel,
  changeRequestReasonLabel,
  JOB_CARD_ENGAGEMENT_LABELS,
} from './job-labels';
import {
  deriveJobWorkflowPresentation,
  isFollowUpVisit,
} from './job-workflow-presentation';
import {
  acceptAssignmentProposal,
  cancelJobCard,
  JOB_CARD_ENGAGEMENT_KINDS,
  pastStartAcknowledgementPayload,
  patchJobCard,
  reofferAssignment,
  resolveChangeRequest,
  type FollowUpCancelContinuity,
  type JobCard,
  type JobCardEngagementKind,
  type JobCardPriority,
  type MeetingDetails,
  type PastStartAcknowledgement,
  type PatchJobCardInput,
} from './jobs-api';
import {
  buildManagerRecoveryPlan,
  buildManagerRecoveryPreview,
  evaluateCorrectClosureEligibility,
  type ManagerRecoveryDecisionId,
} from './manager-recovery-policy';
import { isAmbiguousMutationError, isDefinitiveMutationError } from './mutation-attempt-error';
import {
  isPastStartAcknowledgementRequired,
  PastStartAcknowledgementDrawer,
} from './PastStartAcknowledgementDrawer';
import { ScheduleQuickControls } from './ScheduleQuickControls';
import {
  defaultScheduledLocalValue,
  isoInstantToLocalDateTime,
  localDateTimeToIso,
} from './scheduling';
import { useAvailableSlotSearch } from './useAvailableSlotSearch';

type DrawerPanel =
  | 'closed'
  | 'recovery'
  | 'reason'
  | 'acknowledgement'
  | 'cancel-confirm'
  | 'correct-resolve';
type StaffLoadState = { kind: 'loading' | 'error' } | { kind: 'ready'; staff: StaffProfile[] };

type FieldErrors = Partial<{
  decision: string;
  staff: string;
  scheduledAt: string;
  dueDate: string;
  deadlineExtensionReason: string;
  title: string;
  engagementKind: string;
  customerId: string;
  rejectNote: string;
  acknowledgeNote: string;
  general: string;
}>;

const NOTE_MAX_LENGTH = 2000;
const REASON_REQUIRED_MESSAGE = 'Gecikmeyi sonlandıran tarih değişikliği için gerekçe yazın.';
const STALE_MESSAGE =
  'İş başka bir işlemle güncellendi. Devam etmek için güncel bilgileri inceleyip formu yeniden açın.';

function formatContextSchedule(job: JobCard): string {
  if (!job.scheduledAt) return 'Planlanmadı';
  const startDisplay = formatWheelDisplay('datetime', isoInstantToLocalDateTime(job.scheduledAt));
  if (!job.scheduledEndsAt) return startDisplay;
  const start = new Date(job.scheduledAt);
  const end = new Date(job.scheduledEndsAt);
  const sameDay =
    start.getFullYear() === end.getFullYear()
    && start.getMonth() === end.getMonth()
    && start.getDate() === end.getDate();
  const endDisplay = sameDay
    ? new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit' }).format(end)
    : formatWheelDisplay('datetime', isoInstantToLocalDateTime(job.scheduledEndsAt));
  const minutes = Math.round((end.valueOf() - start.valueOf()) / 60_000);
  return minutes > 0
    ? `${startDisplay}–${endDisplay} (${minutes} dk)`
    : `${startDisplay}–${endDisplay}`;
}

function resolveFollowUpCancelContinuity(
  draft: FollowUpCancelContinuityDraft,
  now: Date = new Date(),
): { continuity: FollowUpCancelContinuity } | { error: string } {
  if (draft.decision === null) {
    return { error: 'Yeniden planlamayı ya da döngüyü sonlandırmayı seçin.' };
  }
  if (draft.decision === 'END_CYCLE') {
    if (draft.endReason === '') return { error: 'Sonlandırma nedenini seçin.' };
    return { continuity: { decision: 'END_CYCLE', endReason: draft.endReason } };
  }
  if (!draft.scheduledLocal.trim()) return { error: 'Yeni ziyaret tarihi ve saatini seçin.' };
  let scheduledAt: string;
  try {
    scheduledAt = localDateTimeToIso(draft.scheduledLocal);
  } catch {
    return { error: 'Yeni ziyaret tarihi ve saatini seçin.' };
  }
  if (Date.parse(scheduledAt) <= now.valueOf()) {
    return { error: 'Yeni ziyaret zamanı gelecekte olmalıdır.' };
  }
  return { continuity: { decision: 'RESCHEDULE', scheduledAt } };
}

function submitButtonLabel(
  decision: ManagerRecoveryDecisionId | null,
  correctWithClosure = false,
): string {
  switch (decision) {
    case 'ACCEPT_PROPOSED_TIME':
      return 'Önerilen zamanı onayla';
    case 'RESCHEDULE':
      return 'Planlanan zamanı kaydet';
    case 'REASSIGN_KEEP_TIME':
      return 'Personeli değiştir';
    case 'REASSIGN_AND_RESCHEDULE':
      return 'Devret ve planla';
    case 'REOFFER':
      return 'Yeniden teklif gönder';
    case 'CORRECT':
      return correctWithClosure ? 'Not ekleyip kaydet' : 'Değişiklikleri kaydet';
    case 'CANCEL':
      return 'İptal adımına geç';
    case 'REJECT_CHANGE_REQUEST':
      return 'Talebi reddet';
    case 'ACKNOWLEDGED_ONLY':
      return 'Kayda al ve kapat';
    case null:
      return 'Kararı uygula';
  }
}

export function ManagerRecoveryDrawer({
  open,
  job,
  user,
  meetingDetails = null,
  disabled = false,
  triggerRef,
  onClose,
  onCommitted,
  onActionStart,
  onRefresh,
  onUnknownOutcome,
  onReassigned,
  onChanged,
  onBusyChange,
  loadStaffFn = listStaff,
}: {
  open: boolean;
  job: JobCard;
  user: CurrentUser;
  meetingDetails?: MeetingDetails | null;
  disabled?: boolean;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onCommitted: (receipt: string, tone?: 'confirmed' | 'info') => Promise<void>;
  onActionStart: () => void;
  onRefresh: () => Promise<boolean>;
  onUnknownOutcome: (message: string) => void;
  onReassigned: (previous: JobCard, patched: JobCard & { assignmentTransitionId: string | null }) => void;
  onChanged: () => void;
  onBusyChange?: (busy: boolean) => void;
  loadStaffFn?: typeof listStaff;
}) {
  const [panel, setPanel] = useState<DrawerPanel>('closed');
  const [reviewedJob, setReviewedJob] = useState<JobCard>(job);
  const [selectedDecision, setSelectedDecision] = useState<ManagerRecoveryDecisionId | null>(null);

  // Shared staff list
  const [staffLoad, setStaffLoad] = useState<StaffLoadState>({ kind: 'loading' });
  const [staffReloadKey, setStaffReloadKey] = useState(0);

  // Conditional drafts (preserved across decision switches within the open session)
  const [rescheduleLocal, setRescheduleLocal] = useState('');
  const [rescheduleDueDate, setRescheduleDueDate] = useState('');
  const [rescheduleReason, setRescheduleReason] = useState('');
  const [rescheduleReasonRequired, setRescheduleReasonRequired] = useState(false);
  const [rescheduleResolveCr, setRescheduleResolveCr] = useState(false);

  const [reassignKeepStaffId, setReassignKeepStaffId] = useState('');

  const [transferStaffId, setTransferStaffId] = useState('');
  const [transferLocal, setTransferLocal] = useState('');
  const [transferReason, setTransferReason] = useState('');
  const [transferReasonRequired, setTransferReasonRequired] = useState(false);
  const [transferResolveCr, setTransferResolveCr] = useState(false);

  const [correctTitle, setCorrectTitle] = useState('');
  const [correctDescription, setCorrectDescription] = useState('');
  const [correctEngagementKind, setCorrectEngagementKind] = useState<JobCardEngagementKind>('SALES_MEETING');
  const [correctCustomerId, setCorrectCustomerId] = useState('');
  const [correctCustomerReady, setCorrectCustomerReady] = useState(true);
  const [correctPriority, setCorrectPriority] = useState<JobCardPriority>('normal');
  const [correctResolveCr, setCorrectResolveCr] = useState(false);

  const [rejectNote, setRejectNote] = useState('');
  const [acknowledgeNote, setAcknowledgeNote] = useState('');

  const [cancelContinuity, setCancelContinuity] = useState<{
    draft: FollowUpCancelContinuityDraft;
    inlineError: string | null;
  } | null>(null);
  const [acknowledgement, setAcknowledgement] = useState<PastStartAcknowledgement | undefined>(undefined);
  const [ackOriginDecision, setAckOriginDecision] = useState<
    'RESCHEDULE' | 'REASSIGN_KEEP_TIME' | 'REASSIGN_AND_RESCHEDULE' | 'REOFFER' | null
  >(null);

  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState('');
  const [validationFocusTick, setValidationFocusTick] = useState(0);
  const [refreshRequired, setRefreshRequired] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    onBusyChange?.(pending);
  }, [pending, onBusyChange]);

  useEffect(() => () => {
    onBusyChange?.(false);
  }, [onBusyChange]);

  const intentActionIdRef = useRef<string | null>(null);

  const idPrefix = useId();
  const decisionErrorId = `${idPrefix}-decision-error`;
  const rescheduleTimeId = `${idPrefix}-reschedule-time`;
  const rescheduleDueDateId = `${idPrefix}-reschedule-due-date`;
  const rescheduleReasonId = `${idPrefix}-reschedule-reason`;
  const rescheduleCloseCrId = `${idPrefix}-reschedule-close-cr`;
  const reassignKeepStaffDomId = `${idPrefix}-reassign-keep-staff`;
  const transferStaffDomId = `${idPrefix}-transfer-staff`;
  const transferTimeId = `${idPrefix}-transfer-time`;
  const transferCloseCrId = `${idPrefix}-transfer-close-cr`;
  const correctTitleId = `${idPrefix}-correct-title`;
  const correctDescId = `${idPrefix}-correct-desc`;
  const correctEngagementId = `${idPrefix}-correct-engagement`;
  const correctCustomerIdDom = `${idPrefix}-correct-customer`;
  const correctPriorityId = `${idPrefix}-correct-priority`;
  const correctCloseCrId = `${idPrefix}-correct-close-cr`;
  const rejectNoteId = `${idPrefix}-reject-note`;
  const ackNoteId = `${idPrefix}-ack-note`;

  const errorSummaryRef = useRef<HTMLDivElement>(null);
  const rescheduleTimeRef = useRef<HTMLElement | null>(null);
  const rescheduleDueDateRef = useRef<HTMLElement | null>(null);
  const rescheduleReasonRef = useRef<HTMLTextAreaElement>(null);
  const reassignKeepStaffRef = useRef<HTMLSelectElement>(null);
  const transferStaffRef = useRef<HTMLSelectElement>(null);
  const transferTimeRef = useRef<HTMLElement | null>(null);
  const correctTitleRef = useRef<HTMLInputElement>(null);
  const correctEngagementRef = useRef<HTMLSelectElement>(null);
  const rejectNoteRef = useRef<HTMLTextAreaElement>(null);
  const ackNoteRef = useRef<HTMLTextAreaElement>(null);

  // Initialize snapshot and drafts each time the drawer opens.
  useEffect(() => {
    if (!open) {
      setPanel('closed');
      return;
    }
    const presentation = deriveJobWorkflowPresentation({
      job,
      user,
      workflowContext: job.workflowContext,
      deliveryItems: [],
      meetingDetails: job.type === 'SALES_MEETING' ? meetingDetails : null,
    });
    const nextPlan = buildManagerRecoveryPlan({ job, presentation });
    const startLocal = job.scheduledAt ? isoInstantToLocalDateTime(job.scheduledAt) : '';

    setReviewedJob(job);
    setSelectedDecision(nextPlan.defaultSelectedId);
    setStaffLoad({ kind: 'loading' });

    setRescheduleLocal(startLocal);
    setRescheduleDueDate(job.dueDate ?? '');
    setRescheduleReason('');
    setRescheduleReasonRequired(job.hasOpenOverdueIncident === true);
    setRescheduleResolveCr(false);

    setReassignKeepStaffId('');

    setTransferStaffId('');
    setTransferLocal(startLocal);
    setTransferReason('');
    setTransferReasonRequired(false);
    setTransferResolveCr(false);

    setCorrectTitle(job.title);
    setCorrectDescription(job.description ?? '');
    setCorrectEngagementKind(job.engagementKind ?? 'SALES_MEETING');
    setCorrectCustomerId(job.customerId ?? '');
    setCorrectCustomerReady(job.type !== 'SALES_MEETING' || job.followUpContext !== null);
    setCorrectPriority(job.priority);
    setCorrectResolveCr(false);

    setRejectNote('');
    setAcknowledgeNote('');
    setCancelContinuity(
      isFollowUpVisit(job)
        ? { draft: EMPTY_FOLLOW_UP_CANCEL_CONTINUITY, inlineError: null }
        : null,
    );
    setAcknowledgement(undefined);
    setAckOriginDecision(null);
    setErrors({});
    setSubmitError('');
    setRefreshRequired(false);
    intentActionIdRef.current = null;
    setPanel('recovery');
    // Only re-initialize when opening transitions from false -> true.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const active = open && panel !== 'closed';
  const formOpen = open && panel === 'recovery';

  const presentation = deriveJobWorkflowPresentation({
    job: reviewedJob,
    user,
    workflowContext: reviewedJob.workflowContext,
    deliveryItems: [],
    meetingDetails: reviewedJob.type === 'SALES_MEETING' ? meetingDetails : null,
  });
  const plan = buildManagerRecoveryPlan({ job: reviewedJob, presentation });

  const stale =
    job.id !== reviewedJob.id
    || job.version !== reviewedJob.version
    || (job.changeRequest?.id ?? null) !== (reviewedJob.changeRequest?.id ?? null)
    || (job.assignmentOffer?.id ?? null) !== (reviewedJob.assignmentOffer?.id ?? null);
  const blocked = stale || refreshRequired;

  // Load active staff when needed (for reassign options).
  const needsStaffList =
    selectedDecision === 'REASSIGN_KEEP_TIME' || selectedDecision === 'REASSIGN_AND_RESCHEDULE';
  useEffect(() => {
    if (!active || !needsStaffList) return;
    let live = true;
    setStaffLoad((current) => (current.kind === 'ready' ? current : { kind: 'loading' }));
    void loadStaffFn('active')
      .then((profiles) => {
        if (!live) return;
        setStaffLoad({
          kind: 'ready',
          staff: filterEligibleTransferStaff(profiles, reviewedJob.assignedTo),
        });
      })
      .catch(() => {
        if (live) setStaffLoad({ kind: 'error' });
      });
    return () => {
      live = false;
    };
  }, [active, needsStaffList, reviewedJob.assignedTo, staffReloadKey, loadStaffFn]);

  useEffect(() => {
    if (!formOpen || (!submitError && !stale && validationFocusTick === 0)) return;
    if (stale) {
      errorSummaryRef.current?.focus();
      return;
    }
    focusFirstInvalid(errors);
    // Focus runs after validation/submit failures settle in the DOM, never on field typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formOpen, stale, submitError, validationFocusTick]);

  const intervalType =
    reviewedJob.type === 'SALES_MEETING' || reviewedJob.type === 'PRODUCT_DELIVERY'
      ? reviewedJob.type
      : null;
  const durationMinutes = plannedIntervalDurationMinutes(reviewedJob);
  const currentStartLocal = reviewedJob.scheduledAt
    ? isoInstantToLocalDateTime(reviewedJob.scheduledAt)
    : '';

  const rescheduleSlotSearch = useAvailableSlotSearch({
    type: intervalType ?? 'SALES_MEETING',
    customerId: reviewedJob.customerId,
    assignedTo: reviewedJob.assignedTo,
    scheduledStartLocal: rescheduleLocal,
    jobCardId: reviewedJob.id,
    enabled:
      formOpen
      && selectedDecision === 'RESCHEDULE'
      && intervalType !== null
      && rescheduleLocal !== ''
      && !blocked,
  });

  const reassignKeepSlotSearch = useAvailableSlotSearch({
    type: intervalType ?? 'SALES_MEETING',
    customerId: reviewedJob.customerId,
    assignedTo: reassignKeepStaffId || null,
    scheduledStartLocal: currentStartLocal,
    jobCardId: reviewedJob.id,
    enabled:
      formOpen
      && selectedDecision === 'REASSIGN_KEEP_TIME'
      && intervalType !== null
      && reassignKeepStaffId !== ''
      && currentStartLocal !== ''
      && !blocked,
  });

  const transferSlotSearch = useAvailableSlotSearch({
    type: intervalType ?? 'SALES_MEETING',
    customerId: reviewedJob.customerId,
    assignedTo: transferStaffId || null,
    scheduledStartLocal: transferLocal,
    jobCardId: reviewedJob.id,
    enabled:
      formOpen
      && selectedDecision === 'REASSIGN_AND_RESCHEDULE'
      && intervalType !== null
      && transferStaffId !== ''
      && transferLocal !== ''
      && !blocked,
  });

  const eligibleStaff = staffLoad.kind === 'ready' ? staffLoad.staff : [];
  const isFollowUp = reviewedJob.followUpContext !== null;

  const correctEligibility = evaluateCorrectClosureEligibility(reviewedJob, {
    title: correctTitle,
    description: correctDescription,
    priority: correctPriority,
    engagementKind: correctEngagementKind,
    customerId: correctCustomerId,
  });
  const hasCorrectionChanges = correctEligibility.hasAnyEdit;
  const canOptInCorrectClosure = correctEligibility.canOptInClosure;
  const customerChanged =
    reviewedJob.type === 'SALES_MEETING'
    && !isFollowUp
    && correctCustomerId !== (reviewedJob.customerId ?? '');

  // Clear stale opt-in when qualifying fields or request eligibility disappear,
  // or return to the main recovery form if the record turns stale while in dialog.
  useEffect(() => {
    if (!canOptInCorrectClosure) {
      setCorrectResolveCr(false);
      setPanel((current) => (current === 'correct-resolve' ? 'recovery' : current));
    }
  }, [canOptInCorrectClosure]);

  useEffect(() => {
    if (stale && panel === 'correct-resolve') {
      setPanel('recovery');
    }
  }, [stale, panel]);

  const rescheduleDeadlineChanged =
    rescheduleLocal.trim() !== currentStartLocal
    || (reviewedJob.type === 'GENERAL_TASK' && rescheduleDueDate !== (reviewedJob.dueDate ?? ''));
  const rescheduleReasonVisible =
    (reviewedJob.hasOpenOverdueIncident === true || rescheduleReasonRequired)
    && rescheduleDeadlineChanged;

  const offer = reviewedJob.assignmentOffer ?? null;
  const changeRequest = plan.hasOpenChangeRequest ? reviewedJob.changeRequest : null;
  const urgentReasonLabel = assignmentOfferUrgentReasonLabel(offer?.urgentReason);

  const selectedTransferStaffName =
    selectedDecision === 'REASSIGN_KEEP_TIME'
      ? eligibleStaff.find((s) => s.user.id === reassignKeepStaffId)?.user.name ?? null
      : selectedDecision === 'REASSIGN_AND_RESCHEDULE'
        ? eligibleStaff.find((s) => s.user.id === transferStaffId)?.user.name ?? null
        : null;

  const activeTimeLabel = (() => {
    const localVal =
      selectedDecision === 'RESCHEDULE'
        ? rescheduleLocal
        : selectedDecision === 'REASSIGN_AND_RESCHEDULE'
          ? transferLocal
          : '';
    if (!localVal) return null;
    try {
      return formatWheelDisplay('datetime', localVal);
    } catch {
      return localVal;
    }
  })();

  const proposedTimeLabel =
    offer?.proposedScheduledAt
      ? formatProposedInterval(offer.proposedScheduledAt, offer.proposedScheduledEndsAt)
      : null;

  const preview = buildManagerRecoveryPreview({
    job: reviewedJob,
    selectedDecisionId: selectedDecision,
    hasRecoveryOffer: plan.hasRecoveryOffer,
    hasOpenChangeRequest: plan.hasOpenChangeRequest,
    selectedStaffName: selectedTransferStaffName,
    proposedTimeLabel,
    scheduledTimeLabel: activeTimeLabel,
    resolveChangeRequest:
      selectedDecision === 'RESCHEDULE'
        ? rescheduleResolveCr
        : selectedDecision === 'REASSIGN_AND_RESCHEDULE'
          ? transferResolveCr
          : selectedDecision === 'CORRECT'
            ? canOptInCorrectClosure && correctResolveCr
            : false,
    hasCorrectionChanges,
    correctClosureEligibility: correctEligibility,
    followUpCancelDecision: cancelContinuity?.draft.decision ?? null,
  });

  function clearIntentKey() {
    intentActionIdRef.current = null;
  }

  function currentIntentKey(): string {
    if (!intentActionIdRef.current) {
      intentActionIdRef.current = crypto.randomUUID();
    }
    return intentActionIdRef.current;
  }

  function selectDecision(nextId: ManagerRecoveryDecisionId) {
    if (pending || blocked) return;
    setSelectedDecision(nextId);
    setErrors({});
    setSubmitError('');
    clearIntentKey();
  }

  function dismissDrawer() {
    if (pending || refreshing) return;
    setPanel('closed');
    onClose();
  }

  async function refreshFromConflict() {
    setRefreshing(true);
    try {
      if (await onRefresh()) {
        setRefreshRequired(false);
        setPanel('closed');
        onClose();
      }
    } finally {
      setRefreshing(false);
    }
  }

  function focusFirstInvalid(nextErrors: FieldErrors) {
    if (nextErrors.staff) {
      (reassignKeepStaffRef.current ?? transferStaffRef.current)?.focus();
      return;
    }
    if (nextErrors.scheduledAt) {
      (rescheduleTimeRef.current ?? transferTimeRef.current)?.focus();
      return;
    }
    if (nextErrors.dueDate) {
      rescheduleDueDateRef.current?.focus();
      return;
    }
    if (nextErrors.deadlineExtensionReason) {
      rescheduleReasonRef.current?.focus();
      return;
    }
    if (nextErrors.title) {
      correctTitleRef.current?.focus();
      return;
    }
    if (nextErrors.engagementKind) {
      correctEngagementRef.current?.focus();
      return;
    }
    if (nextErrors.customerId) {
      document.getElementById(correctCustomerIdDom)?.focus();
      return;
    }
    if (nextErrors.rejectNote) {
      rejectNoteRef.current?.focus();
      return;
    }
    if (nextErrors.acknowledgeNote) {
      ackNoteRef.current?.focus();
      return;
    }
    errorSummaryRef.current?.focus();
  }

  function handleMutationError(
    caught: unknown,
    fallbackMessage: string,
    opts?: {
      onConflict?: () => void;
      onPastStart?: () => void;
      onDeadlineReason?: (msg: string) => void;
      mapMessage?: (err: unknown) => string;
      keepDialogOnError?: (err: unknown) => boolean;
    },
  ) {
    if (isAmbiguousMutationError(caught)) {
      // Never auto-retry ambiguous mutations; lock conflicting controls until canonical review.
      setPanel('closed');
      onClose();
      onUnknownOutcome(`${fallbackMessage} İşlemin sonucu doğrulanamadı.`);
      return;
    }
    clearIntentKey();
    if (caught instanceof ApiError && caught.code === 'PAST_START_ACKNOWLEDGEMENT_REQUIRED' && opts?.onPastStart) {
      opts.onPastStart();
      return;
    }
    if (caught instanceof ApiError && caught.code === 'DEADLINE_EXTENSION_REASON_REQUIRED' && opts?.onDeadlineReason) {
      opts.onDeadlineReason(apiFieldError(caught, 'deadlineExtensionReason', REASON_REQUIRED_MESSAGE));
      return;
    }
    if (
      caught instanceof ApiError
      && (caught.code === 'VERSION_CONFLICT'
        || caught.code === 'CHANGE_REQUEST_NOT_OPEN'
        || caught.code === 'ASSIGNMENT_PROPOSAL_NOT_AVAILABLE'
        || caught.code === 'ASSIGNMENT_PROPOSAL_EXPIRED')
    ) {
      setRefreshRequired(true);
      setSubmitError(
        caught.code === 'CHANGE_REQUEST_NOT_OPEN'
          ? 'Bu öneri zaten sonuçlandırılmış. En güncel bilgileri yükleyin.'
          : caught.code === 'ASSIGNMENT_PROPOSAL_EXPIRED' || caught.code === 'ASSIGNMENT_PROPOSAL_NOT_AVAILABLE'
            ? proposalAcceptErrorMessage(caught)
            : STALE_MESSAGE,
      );
      setPanel('recovery');
      opts?.onConflict?.();
      return;
    }
    const message = opts?.mapMessage
      ? opts.mapMessage(caught)
      : assignmentWindowErrorMessage(caught, fallbackMessage);
    setSubmitError(message);
    if (panel === 'reason' || (panel === 'correct-resolve' && !opts?.keepDialogOnError?.(caught))) {
      setPanel('recovery');
    }
  }

  async function runAcceptProposedTime() {
    if (!offer || offer.proposedScheduledAt === null) return;
    onActionStart();
    setPending(true);
    setSubmitError('');
    try {
      await acceptAssignmentProposal(reviewedJob.id, {
        clientActionId: currentIntentKey(),
        expectedVersion: reviewedJob.version,
        offerId: offer.id,
      });
      setPanel('closed');
      onClose();
      await onCommitted(`Önerilen zaman onaylandı; iş ${offer.assignee.name} için kabul edildi.`);
      onChanged();
    } catch (caught) {
      handleMutationError(caught, 'Önerilen zaman onaylanamadı.', {
        mapMessage: proposalAcceptErrorMessage,
      });
    } finally {
      setPending(false);
    }
  }

  async function runReschedule(nextAck?: PastStartAcknowledgement) {
    const input: PatchJobCardInput = {
      expectedVersion: reviewedJob.version,
      ...pastStartAcknowledgementPayload(nextAck),
    };
    const startChanged = rescheduleLocal.trim() !== currentStartLocal;
    const dueChanged =
      reviewedJob.type === 'GENERAL_TASK' && rescheduleDueDate !== (reviewedJob.dueDate ?? '');
    if (startChanged || reviewedJob.type !== 'GENERAL_TASK') {
      input.scheduledAt = rescheduleLocal.trim() ? localDateTimeToIso(rescheduleLocal) : null;
    }
    if (dueChanged) {
      input.dueDate = rescheduleDueDate.trim() ? rescheduleDueDate : null;
    }
    if (rescheduleReasonVisible && rescheduleReason.trim()) {
      input.deadlineExtensionReason = rescheduleReason.trim();
    }
    if (rescheduleResolveCr && changeRequest) {
      input.changeRequestResolution = {
        changeRequestId: changeRequest.id,
        resolution: 'RESCHEDULED',
      };
    }

    onActionStart();
    setPending(true);
    setSubmitError('');
    try {
      const patched = await patchJobCard(reviewedJob.id, input);
      setPanel('closed');
      onClose();
      await onCommitted(
        buildPatchCommitReceipt(patched, {
          kind: 'RESCHEDULE',
          resolvedChangeRequest: input.changeRequestResolution?.resolution ?? null,
        }),
      );
      onChanged();
    } catch (caught) {
      handleMutationError(caught, 'Planlanan zaman kaydedilemedi.', {
        onPastStart:
          nextAck === undefined
            ? () => {
                setAckOriginDecision('RESCHEDULE');
                setPanel('acknowledgement');
              }
            : undefined,
        onDeadlineReason: (msg) => {
          setRescheduleReasonRequired(true);
          setErrors((prev) => ({ ...prev, deadlineExtensionReason: msg }));
          setSubmitError(msg);
          requestAnimationFrame(() => rescheduleReasonRef.current?.focus());
        },
      });
    } finally {
      setPending(false);
    }
  }

  async function runReassignKeepTime(nextAck?: PastStartAcknowledgement) {
    const input: PatchJobCardInput = {
      expectedVersion: reviewedJob.version,
      assignedTo: reassignKeepStaffId,
      ...pastStartAcknowledgementPayload(nextAck),
    };
    onActionStart();
    setPending(true);
    setSubmitError('');
    try {
      const patched = await patchJobCard(reviewedJob.id, input);
      setPanel('closed');
      onClose();
      await onCommitted(
        buildPatchCommitReceipt(patched, { kind: 'REASSIGN_KEEP_TIME' }),
      );
      onChanged();
      onReassigned(reviewedJob, patched);
    } catch (caught) {
      handleMutationError(caught, 'Sorumlu personel güncellenemedi.', {
        onPastStart:
          nextAck === undefined
            ? () => {
                setAckOriginDecision('REASSIGN_KEEP_TIME');
                setPanel('acknowledgement');
              }
            : undefined,
      });
    } finally {
      setPending(false);
    }
  }

  async function runTransfer(nextReason = transferReason, nextAck?: PastStartAcknowledgement) {
    const input: PatchJobCardInput = {
      expectedVersion: reviewedJob.version,
      assignedTo: transferStaffId,
      scheduledAt: localDateTimeToIso(transferLocal),
      ...pastStartAcknowledgementPayload(nextAck),
    };
    if (nextReason.trim()) input.deadlineExtensionReason = nextReason.trim();
    if (transferResolveCr && changeRequest) {
      input.changeRequestResolution = {
        changeRequestId: changeRequest.id,
        resolution: 'RESCHEDULED',
      };
    }
    setTransferReason(nextReason);
    onActionStart();
    setPending(true);
    setSubmitError('');
    try {
      const patched = await patchJobCard(reviewedJob.id, input);
      setPanel('closed');
      onClose();
      await onCommitted(
        buildPatchCommitReceipt(patched, {
          kind: 'REASSIGN_AND_RESCHEDULE',
          resolvedChangeRequest: input.changeRequestResolution?.resolution ?? null,
        }),
      );
      onChanged();
      onReassigned(reviewedJob, patched);
    } catch (caught) {
      handleMutationError(caught, 'Personel ve plan değişikliği kaydedilemedi.', {
        onPastStart:
          nextAck === undefined
            ? () => {
                setAckOriginDecision('REASSIGN_AND_RESCHEDULE');
                setPanel('acknowledgement');
              }
            : undefined,
        onDeadlineReason: (msg) => {
          setTransferReasonRequired(true);
          setSubmitError(msg);
          setPanel('reason');
        },
      });
    } finally {
      setPending(false);
    }
  }

  async function runReoffer(nextAck?: PastStartAcknowledgement) {
    onActionStart();
    setPending(true);
    setSubmitError('');
    try {
      await reofferAssignment(reviewedJob.id, {
        clientActionId: currentIntentKey(),
        expectedVersion: reviewedJob.version,
        ...pastStartAcknowledgementPayload(nextAck),
      });
      setPanel('closed');
      onClose();
      await onCommitted('Yeni atama teklifi açıldı; personelin yanıtı bekleniyor.');
      onChanged();
    } catch (caught) {
      handleMutationError(caught, 'Yeniden atama teklifi açılamadı.', {
        onPastStart:
          nextAck === undefined
            ? () => {
                setAckOriginDecision('REOFFER');
                setPanel('acknowledgement');
              }
            : undefined,
      });
    } finally {
      setPending(false);
    }
  }

  function validateCorrectDraft(): FieldErrors {
    const next: FieldErrors = {};
    const normalizedTitle = correctTitle.trim();
    if (!normalizedTitle || Array.from(normalizedTitle).length > 255) {
      next.title = 'Başlık 1 ile 255 karakter arasında olmalıdır.';
    }
    if (reviewedJob.type === 'SALES_MEETING') {
      if (!correctEngagementKind) {
        next.engagementKind = 'Görüşme veya ziyaret türünü seçin.';
      }
      if (!correctCustomerId && !isFollowUp) {
        next.customerId = 'Aktif bir müşteri seçin.';
      }
    }
    if (Object.keys(next).length === 0 && !hasCorrectionChanges) {
      next.general = 'Kaydetmek için en az bir iş bilgisini değiştirin.';
    }
    return next;
  }

  async function runCorrect(resolutionNote?: string) {
    const isConfirmedClosure = resolutionNote !== undefined;
    if (pending || disabled) return;
    if (blocked) {
      if (isConfirmedClosure) {
        setPanel('recovery');
      }
      return;
    }
    if (selectedDecision !== 'CORRECT') {
      if (isConfirmedClosure) {
        setSubmitError('Seçili karar değiştiği için düzeltme kapatma işlemi uygulanmadı.');
      }
      return;
    }

    const draftErrors = validateCorrectDraft();
    const customerNotReady =
      customerChanged && !isFollowUp && !correctCustomerReady;
    if (Object.keys(draftErrors).length > 0 || customerNotReady) {
      setErrors(draftErrors);
      setSubmitError(
        customerNotReady
          ? 'Müşteri bilgisi hazır olmadan değişiklik kaydedilemez.'
          : (draftErrors.general ?? 'Devam etmeden önce işaretli alanları düzeltin.'),
      );
      if (!isConfirmedClosure) {
        setValidationFocusTick((t) => t + 1);
      }
      return;
    }

    let trimmedNote = '';
    if (isConfirmedClosure) {
      if (
        !canOptInCorrectClosure
        || !correctResolveCr
        || changeRequest === null
        || changeRequest.reasonCode !== 'OTHER'
      ) {
        setSubmitError('Nitelikli düzenleme veya talep kapatma onayı geçerli olmadığı için talep kapatılmadı.');
        return;
      }
      trimmedNote = resolutionNote.trim();
      if (trimmedNote.length === 0) {
        setSubmitError('Talebi “Düzeltildi” olarak kapatmak için açıklama notu zorunludur.');
        return;
      }
      if (Array.from(trimmedNote).length > NOTE_MAX_LENGTH) {
        setSubmitError(`Düzeltme açıklaması en fazla ${NOTE_MAX_LENGTH.toLocaleString('tr-TR')} karakter olmalıdır.`);
        return;
      }
    }

    const normalizedTitle = correctTitle.trim();
    const input: PatchJobCardInput = {
      expectedVersion: reviewedJob.version,
      title: normalizedTitle,
      description: correctDescription.trim() || null,
      priority: correctPriority,
      ...(reviewedJob.type === 'SALES_MEETING'
        ? {
            engagementKind: correctEngagementKind,
            ...(customerChanged && !isFollowUp ? { customerId: correctCustomerId } : {}),
          }
        : {}),
      ...(isConfirmedClosure
        ? {
            changeRequestResolution: {
              changeRequestId: changeRequest!.id,
              resolution: 'CORRECTED',
              note: trimmedNote,
            },
          }
        : {}),
    };
    onActionStart();
    setPending(true);
    setSubmitError('');
    try {
      const patched = await patchJobCard(reviewedJob.id, input);
      setPanel('closed');
      onClose();
      await onCommitted(
        buildPatchCommitReceipt(patched, {
          kind: 'CORRECT',
          resolvedChangeRequest: input.changeRequestResolution?.resolution ?? null,
        }),
      );
      onChanged();
    } catch (caught) {
      handleMutationError(caught, 'İş bilgileri güncellenemedi.', {
        keepDialogOnError: () => isConfirmedClosure,
      });
    } finally {
      setPending(false);
    }
  }

  async function runResolveRequest(
    resolution: 'REJECTED' | 'ACKNOWLEDGED_ONLY',
    extra: { note: string },
  ) {
    if (!changeRequest) return;
    onActionStart();
    setPending(true);
    setSubmitError('');
    try {
      await resolveChangeRequest(reviewedJob.id, changeRequest.id, {
        clientActionId: currentIntentKey(),
        resolution,
        ...extra,
      });
      setPanel('closed');
      onClose();
      const receipt =
        resolution === 'REJECTED'
          ? 'Öneri reddedildi. İş bilgileri değişmedi.'
          : 'Öneri kayda alındı ve kapatıldı. İş bilgileri, planlanan zaman ve gecikme kaydı değişmedi.';
      await onCommitted(receipt, 'info');
      onChanged();
    } catch (caught) {
      handleMutationError(caught, 'Öneri karara bağlanamadı.');
    } finally {
      setPending(false);
    }
  }

  async function runCancel(cancelReason: string) {
    let continuity: FollowUpCancelContinuity | undefined;
    if (cancelContinuity) {
      const resolved = resolveFollowUpCancelContinuity(cancelContinuity.draft);
      if ('error' in resolved) {
        setCancelContinuity({ ...cancelContinuity, inlineError: resolved.error });
        return;
      }
      continuity = resolved.continuity;
    }

    onActionStart();
    setPending(true);
    setSubmitError('');
    try {
      await cancelJobCard(reviewedJob.id, {
        clientActionId: currentIntentKey(),
        expectedVersion: reviewedJob.version,
        cancelReason,
        ...(continuity ? { followUpContinuity: continuity } : {}),
      });
      setPanel('closed');
      onClose();
      let receipt = 'İş iptal edildi.';
      if (continuity?.decision === 'RESCHEDULE') {
        receipt = `İş iptal edildi. Yeni takip ziyareti ${formatRecoveryInstant(continuity.scheduledAt)} için planlandı.`;
      } else if (continuity?.decision === 'END_CYCLE') {
        receipt = 'İş iptal edildi ve takip döngüsü sonlandırıldı.';
      }
      await onCommitted(receipt, 'info');
      onChanged();
    } catch (caught) {
      handleMutationError(caught, 'İş iptal edilemedi.');
    } finally {
      setPending(false);
    }
  }

  function submitMainForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || blocked || disabled) return;

    if (selectedDecision === null) {
      const next: FieldErrors = { decision: 'Devam etmek için bir karar seçin.' };
      setErrors(next);
      setSubmitError(next.decision!);
      setValidationFocusTick((t) => t + 1);
      return;
    }

    const next: FieldErrors = {};
    switch (selectedDecision) {
      case 'ACCEPT_PROPOSED_TIME':
        break;
      case 'RESCHEDULE':
        if (reviewedJob.type !== 'GENERAL_TASK') {
          if (!rescheduleLocal.trim()) next.scheduledAt = 'Yeni planlanan zamanı seçin.';
          else if (rescheduleLocal.trim() === currentStartLocal) {
            next.scheduledAt = 'Planlanan zamanı değiştirin.';
          }
        } else if (!rescheduleDeadlineChanged) {
          next.scheduledAt = 'Planlanan zamanı veya son tarihi değiştirin.';
        }
        if (rescheduleReasonVisible && !rescheduleReason.trim()) {
          next.deadlineExtensionReason = REASON_REQUIRED_MESSAGE;
        }
        break;
      case 'REASSIGN_KEEP_TIME':
        if (!eligibleStaff.some((p) => p.user.id === reassignKeepStaffId)) {
          next.staff = 'Yeni sorumlu personel seçin.';
        }
        break;
      case 'REASSIGN_AND_RESCHEDULE':
        if (!eligibleStaff.some((p) => p.user.id === transferStaffId)) {
          next.staff = 'Yeni sorumlu personel seçin.';
        }
        if (!transferLocal.trim()) {
          next.scheduledAt = 'Yeni planlanan zamanı seçin.';
        } else if (transferLocal.trim() === currentStartLocal) {
          next.scheduledAt = 'Planlanan zamanı değiştirin.';
        }
        break;
      case 'REOFFER':
        break;
      case 'CORRECT': {
        Object.assign(next, validateCorrectDraft());
        break;
      }
      case 'CANCEL':
        setErrors({});
        setSubmitError('');
        setPanel('cancel-confirm');
        return;
      case 'REJECT_CHANGE_REQUEST': {
        const normalized = rejectNote.trim();
        if (normalized.length === 0) {
          next.rejectNote = 'Reddetmek için açıklama zorunludur.';
        } else if (Array.from(normalized).length > NOTE_MAX_LENGTH) {
          next.rejectNote = `Açıklama ${NOTE_MAX_LENGTH.toLocaleString('tr-TR')} karakteri geçemez.`;
        }
        break;
      }
      case 'ACKNOWLEDGED_ONLY': {
        const normalized = acknowledgeNote.trim();
        if (normalized.length === 0) {
          next.acknowledgeNote = 'Kayda almak için not yazmanız zorunludur.';
        } else if (Array.from(normalized).length > NOTE_MAX_LENGTH) {
          next.acknowledgeNote = `Not ${NOTE_MAX_LENGTH.toLocaleString('tr-TR')} karakteri geçemez.`;
        }
        break;
      }
    }

    setErrors(next);
    if (Object.keys(next).length > 0) {
      setSubmitError(
        next.general ?? 'Devam etmeden önce işaretli alanları düzeltin.',
      );
      setValidationFocusTick((t) => t + 1);
      return;
    }

    setSubmitError('');
    switch (selectedDecision) {
      case 'ACCEPT_PROPOSED_TIME':
        void runAcceptProposedTime();
        break;
      case 'RESCHEDULE':
        void runReschedule();
        break;
      case 'REASSIGN_KEEP_TIME':
        void runReassignKeepTime();
        break;
      case 'REASSIGN_AND_RESCHEDULE':
        if (transferReasonRequired && !transferReason.trim()) {
          setPanel('reason');
        } else {
          void runTransfer();
        }
        break;
      case 'REOFFER':
        void runReoffer();
        break;
      case 'CORRECT':
        if (canOptInCorrectClosure && correctResolveCr) {
          setSubmitError('');
          setPanel('correct-resolve');
          return;
        }
        void runCorrect();
        break;
      case 'REJECT_CHANGE_REQUEST':
        void runResolveRequest('REJECTED', { note: rejectNote.trim() });
        break;
      case 'ACKNOWLEDGED_ONLY':
        void runResolveRequest('ACKNOWLEDGED_ONLY', { note: acknowledgeNote.trim() });
        break;
    }
  }

  function handlePastStartConfirm(nextAck: PastStartAcknowledgement) {
    setAcknowledgement(nextAck);
    if (ackOriginDecision === 'RESCHEDULE') void runReschedule(nextAck);
    else if (ackOriginDecision === 'REASSIGN_KEEP_TIME') void runReassignKeepTime(nextAck);
    else if (ackOriginDecision === 'REASSIGN_AND_RESCHEDULE') void runTransfer(transferReason, nextAck);
    else if (ackOriginDecision === 'REOFFER') void runReoffer(nextAck);
  }

  const submitBlockedByLookup =
    (needsStaffList && (staffLoad.kind !== 'ready' || eligibleStaff.length === 0))
    || (selectedDecision === 'CORRECT' && reviewedJob.type === 'SALES_MEETING' && !isFollowUp && !correctCustomerReady);

  if (!open) return null;

  return (
    <>
      <ResponsiveFormDrawer
        open={formOpen}
        rootClassName="manager-recovery-drawer-root"
        title="Görevi çözüme ulaştır"
        onDismiss={dismissDrawer}
        returnFocusRef={triggerRef}
        dismissDisabled={pending || refreshing}
      >
        <form
          className="manager-recovery-form"
          data-manager-recovery-form="true"
          onSubmit={submitMainForm}
          noValidate
        >
          <div className="manager-recovery-grid">
            <aside className="manager-recovery-context" aria-label="İş ve durum özeti">
              <div className="manager-recovery-context-head">
                <h3>{reviewedJob.title}</h3>
                <div className="manager-recovery-context-chips">
                  <StatusChip status={reviewedJob.status} />
                  <PriorityChip priority={reviewedJob.priority} />
                </div>
              </div>
              <dl className="job-row-facts manager-recovery-facts">
                <div>
                  <dt>Müşteri</dt>
                  <dd>{reviewedJob.customer?.name ?? 'Belirtilmedi'}</dd>
                </div>
                <div>
                  <dt>Sorumlu</dt>
                  <dd>{reviewedJob.assignee.name}</dd>
                </div>
                {reviewedJob.type !== 'SALE' && (
                  <div>
                    <dt>Planlanan zaman</dt>
                    <dd>{formatContextSchedule(reviewedJob)}</dd>
                  </div>
                )}
                {reviewedJob.hasOpenOverdueIncident && (
                  <div>
                    <dt>Gecikme durumu</dt>
                    <dd data-recovery-overdue="open">Açık gecikme kaydı var</dd>
                  </div>
                )}
              </dl>

              {plan.hasRecoveryOffer && offer && (
                <div className="manager-recovery-source" data-recovery-source="offer">
                  <h4>{recoveryOfferHeadline(offer)}</h4>
                  {urgentReasonLabel !== null && (
                    <p className="assignment-offer-urgent" data-assignment-offer-urgent={offer.urgentReason}>
                      <strong>{urgentReasonLabel}</strong>
                      {' '}— müşteri zamanı risk altında.
                    </p>
                  )}
                  <dl className="job-row-facts">
                    {assignmentOfferCloseReasonLabel(offer.closeReason) !== null && (
                      <div>
                        <dt>Neden</dt>
                        <dd data-assignment-offer-close-reason={offer.closeReason}>
                          {assignmentOfferCloseReasonLabel(offer.closeReason)}
                        </dd>
                      </div>
                    )}
                    {offer.closeText && offer.closeText.trim().length > 0 && (
                      <div>
                        <dt>Personelin açıklaması</dt>
                        <dd>“{offer.closeText.trim()}”</dd>
                      </div>
                    )}
                    {offer.suggestedSolution != null && (
                      <div>
                        <dt>Personelin önerisi</dt>
                        <dd data-assignment-offer-suggested-solution={offer.suggestedSolution}>
                          {assignmentSuggestedSolutionLabel(offer.suggestedSolution)}
                        </dd>
                      </div>
                    )}
                    {proposedTimeLabel && offer.proposedScheduledAt && (
                      <div>
                        <dt>Önerilen zaman</dt>
                        <dd
                          data-assignment-offer-proposal={
                            plan.proposalStatus === 'EXPIRED' ? 'EXPIRED' : 'PENDING'
                          }
                        >
                          <time dateTime={offer.proposedScheduledAt}>{proposedTimeLabel}</time>
                        </dd>
                      </div>
                    )}
                    {offer.closedAt && (
                      <div>
                        <dt>Karar zamanı</dt>
                        <dd>
                          <time dateTime={offer.closedAt}>{formatRecoveryInstant(offer.closedAt)}</time>
                        </dd>
                      </div>
                    )}
                  </dl>
                </div>
              )}

              {changeRequest && (
                <div className="manager-recovery-source" data-recovery-source="change-request">
                  <h4>{changeRequest.requestedBy.name} bu iş için değişiklik istiyor</h4>
                  <dl className="job-row-facts">
                    <div>
                      <dt>Neden</dt>
                      <dd>{changeRequestReasonLabel(changeRequest.reasonCode)}</dd>
                    </div>
                    <div>
                      <dt>Personelin açıklaması</dt>
                      <dd data-change-request-reason-text="true">{changeRequest.reasonText}</dd>
                    </div>
                    <div>
                      <dt>Gönderim</dt>
                      <dd>
                        <time dateTime={changeRequest.requestedAt}>
                          {formatRecoveryInstant(changeRequest.requestedAt)}
                        </time>
                      </dd>
                    </div>
                  </dl>
                  {changeRequest.requestedBy.id !== reviewedJob.assignedTo && (
                    <p className="form-help" data-change-request-reassigned="true">
                      Sorumlu personel değişti; öneriyi kapatmayı unutmayın.
                    </p>
                  )}
                </div>
              )}
            </aside>

            <div className="manager-recovery-main">
              <fieldset
                className="manager-recovery-decisions"
                disabled={pending || blocked}
                aria-invalid={errors.decision ? true : undefined}
                aria-describedby={errors.decision ? decisionErrorId : undefined}
              >
                <legend>Kararınız</legend>
                <p className="form-help manager-recovery-advisory-note" data-recovery-advisory-note="true">
                  {plan.advisoryNote}
                </p>
                <div className="manager-recovery-decision-list">
                  {plan.options.map((option) => {
                    const radioId = `${idPrefix}-decision-${option.id}`;
                    const checked = selectedDecision === option.id;
                    return (
                      <label
                        key={option.id}
                        htmlFor={radioId}
                        className={`manager-recovery-decision-row${checked ? ' manager-recovery-decision-row--selected' : ''}${option.destructive ? ' manager-recovery-decision-row--destructive' : ''}`}
                        data-recovery-decision={option.id}
                      >
                        <input
                          id={radioId}
                          type="radio"
                          name="manager-recovery-decision"
                          value={option.id}
                          checked={checked}
                          onChange={() => selectDecision(option.id)}
                        />
                        <span className="manager-recovery-decision-body">
                          <span className="manager-recovery-decision-title-line">
                            <span className="manager-recovery-decision-title">{option.label}</span>
                            {option.recommended && (
                              <span className="manager-recovery-tag manager-recovery-tag--recommended">
                                Önerilen
                              </span>
                            )}
                            {option.suggestedByStaff && (
                              <span className="manager-recovery-tag manager-recovery-tag--staff">
                                Personel önerisi
                              </span>
                            )}
                          </span>
                          <span className="manager-recovery-decision-desc">{option.description}</span>
                        </span>
                      </label>
                    );
                  })}
                </div>
                {errors.decision && (
                  <p id={decisionErrorId} className="field-error" role="alert">
                    {errors.decision}
                  </p>
                )}
              </fieldset>

              {plan.unavailableNotes.length > 0 && (
                <div className="manager-recovery-unavailable" data-recovery-unavailable="true">
                  {plan.unavailableNotes.map((note) => (
                    <p key={note} className="form-help">{note}</p>
                  ))}
                </div>
              )}

              {selectedDecision !== null && (
                <div className="manager-recovery-fields" data-recovery-fields={selectedDecision}>
                  {selectedDecision === 'ACCEPT_PROPOSED_TIME' && offer && (
                    <dl className="job-row-facts">
                      <div>
                        <dt>Personel</dt>
                        <dd>{offer.assignee.name}</dd>
                      </div>
                      <div>
                        <dt>Onaylanacak aralık</dt>
                        <dd>{proposedTimeLabel ?? 'Belirtilmedi'}</dd>
                      </div>
                    </dl>
                  )}

                  {selectedDecision === 'RESCHEDULE' && (
                    <fieldset className="manager-recovery-fieldset" disabled={pending || blocked}>
                      <div className="field-group">
                        <WheelDateTimeField
                          mode="datetime"
                          id={rescheduleTimeId}
                          name="scheduledAt"
                          value={rescheduleLocal}
                          onChange={(val) => {
                            setRescheduleLocal(val);
                            setErrors((prev) => ({ ...prev, scheduledAt: undefined }));
                            setSubmitError('');
                            clearIntentKey();
                          }}
                          required={reviewedJob.type !== 'GENERAL_TASK'}
                          disabled={pending || blocked}
                          invalid={Boolean(errors.scheduledAt)}
                          controlRef={rescheduleTimeRef}
                          aria-describedby={errors.scheduledAt ? `${rescheduleTimeId}-error` : undefined}
                          label={
                            reviewedJob.type === 'GENERAL_TASK'
                              ? 'Yeni planlanan zaman (isteğe bağlı)'
                              : 'Yeni planlanan zaman'
                          }
                        />
                        <ScheduleQuickControls
                          value={rescheduleLocal}
                          durationMinutes={durationMinutes}
                          disabled={pending || blocked}
                          onSelect={(val) => {
                            setRescheduleLocal(val);
                            setErrors((prev) => ({ ...prev, scheduledAt: undefined }));
                            setSubmitError('');
                            clearIntentKey();
                          }}
                        />
                        {errors.scheduledAt && (
                          <p id={`${rescheduleTimeId}-error`} className="field-error" role="alert">
                            {errors.scheduledAt}
                          </p>
                        )}
                      </div>

                      {reviewedJob.type === 'GENERAL_TASK' && (
                        <div className="field-group">
                          <WheelDateTimeField
                            mode="date"
                            id={rescheduleDueDateId}
                            name="dueDate"
                            value={rescheduleDueDate}
                            onChange={(val) => {
                              setRescheduleDueDate(val);
                              setErrors((prev) => ({ ...prev, scheduledAt: undefined, dueDate: undefined }));
                              setSubmitError('');
                              clearIntentKey();
                            }}
                            disabled={pending || blocked}
                            invalid={Boolean(errors.dueDate)}
                            controlRef={rescheduleDueDateRef}
                            label="Son tarih (isteğe bağlı)"
                          />
                        </div>
                      )}

                      {intervalType !== null && (
                        <AvailableSlotsNotice
                          {...rescheduleSlotSearch}
                          selectedStartLocal={rescheduleLocal}
                          onSelect={(slot) => {
                            setRescheduleLocal(isoInstantToLocalDateTime(slot.startsAt));
                            setErrors((prev) => ({ ...prev, scheduledAt: undefined }));
                            setSubmitError('');
                            clearIntentKey();
                          }}
                          disabled={pending || blocked}
                        />
                      )}

                      {rescheduleReasonVisible && (
                        <div className="field-group">
                          <label htmlFor={rescheduleReasonId}>Tarih değişikliği gerekçesi</label>
                          <textarea
                            ref={rescheduleReasonRef}
                            id={rescheduleReasonId}
                            name="deadlineExtensionReason"
                            rows={2}
                            maxLength={500}
                            value={rescheduleReason}
                            required
                            aria-invalid={errors.deadlineExtensionReason ? true : undefined}
                            aria-describedby={[
                              `${rescheduleReasonId}-help`,
                              errors.deadlineExtensionReason ? `${rescheduleReasonId}-error` : null,
                            ].filter(Boolean).join(' ')}
                            onChange={(event) => {
                              setRescheduleReason(event.target.value);
                              setErrors((prev) => ({ ...prev, deadlineExtensionReason: undefined }));
                              setSubmitError('');
                            }}
                          />
                          <span className="form-help" id={`${rescheduleReasonId}-help`}>
                            Açık gecikmeyi sonlandıran tarih değişikliği için gerekçe yazın (en fazla 500 karakter).
                          </span>
                          {errors.deadlineExtensionReason && (
                            <p id={`${rescheduleReasonId}-error`} className="field-error" role="alert">
                              {errors.deadlineExtensionReason}
                            </p>
                          )}
                        </div>
                      )}

                      {changeRequest && (
                        <div className="form-checkbox-row">
                          <input
                            id={rescheduleCloseCrId}
                            name="resolveChangeRequest"
                            type="checkbox"
                            checked={rescheduleResolveCr}
                            onChange={(event) => setRescheduleResolveCr(event.target.checked)}
                          />
                          <label htmlFor={rescheduleCloseCrId}>
                            Personel önerisini 'Yeniden planlandı' olarak kapat
                          </label>
                        </div>
                      )}
                    </fieldset>
                  )}

                  {selectedDecision === 'REASSIGN_KEEP_TIME' && (
                    <fieldset className="manager-recovery-fieldset" disabled={pending || blocked}>
                      <div className="field-group">
                        <label htmlFor={reassignKeepStaffDomId}>Yeni sorumlu personel</label>
                        {staffLoad.kind === 'loading' && (
                          <p className="field-status" role="status">Aktif personel yükleniyor…</p>
                        )}
                        {staffLoad.kind === 'error' && (
                          <>
                            <p className="field-error" role="alert">Personel listesi yüklenemedi.</p>
                            <button
                              className="secondary-button compact-button"
                              type="button"
                              onClick={() => {
                                setStaffLoad({ kind: 'loading' });
                                setStaffReloadKey((v) => v + 1);
                              }}
                            >
                              Tekrar dene
                            </button>
                          </>
                        )}
                        {staffLoad.kind === 'ready' && (
                          <>
                            <select
                              ref={reassignKeepStaffRef}
                              id={reassignKeepStaffDomId}
                              name="assignedTo"
                              value={reassignKeepStaffId}
                              required
                              aria-invalid={errors.staff ? true : undefined}
                              aria-describedby={errors.staff ? `${reassignKeepStaffDomId}-error` : undefined}
                              onChange={(event) => {
                                setReassignKeepStaffId(event.target.value);
                                setErrors((prev) => ({ ...prev, staff: undefined }));
                                setSubmitError('');
                                clearIntentKey();
                              }}
                            >
                              <option value="">Personel seçin</option>
                              {eligibleStaff.map((profile) => (
                                <option key={profile.user.id} value={profile.user.id}>
                                  {profile.user.name}
                                </option>
                              ))}
                            </select>
                            {eligibleStaff.length === 0 && (
                              <p className="form-help">Aktif başka personel bulunmuyor.</p>
                            )}
                            {errors.staff && (
                              <p id={`${reassignKeepStaffDomId}-error`} className="field-error" role="alert">
                                {errors.staff}
                              </p>
                            )}
                          </>
                        )}
                      </div>
                      <dl className="job-row-facts">
                        <div>
                          <dt>Korunan planlanan zaman</dt>
                          <dd>{formatContextSchedule(reviewedJob)}</dd>
                        </div>
                      </dl>
                      {intervalType !== null && reassignKeepStaffId !== '' && currentStartLocal !== '' && (
                        <AvailableSlotsNotice
                          {...reassignKeepSlotSearch}
                          selectedStartLocal={currentStartLocal}
                          onSelect={() => {}}
                          disabled
                        />
                      )}
                    </fieldset>
                  )}

                  {selectedDecision === 'REASSIGN_AND_RESCHEDULE' && (
                    <fieldset className="manager-recovery-fieldset" disabled={pending || blocked}>
                      <div className="field-group">
                        <label htmlFor={transferStaffDomId}>Yeni sorumlu personel</label>
                        {staffLoad.kind === 'loading' && (
                          <p className="field-status" role="status">Aktif personel yükleniyor…</p>
                        )}
                        {staffLoad.kind === 'error' && (
                          <>
                            <p className="field-error" role="alert">Personel listesi yüklenemedi.</p>
                            <button
                              className="secondary-button compact-button"
                              type="button"
                              onClick={() => {
                                setStaffLoad({ kind: 'loading' });
                                setStaffReloadKey((v) => v + 1);
                              }}
                            >
                              Tekrar dene
                            </button>
                          </>
                        )}
                        {staffLoad.kind === 'ready' && (
                          <>
                            <select
                              ref={transferStaffRef}
                              id={transferStaffDomId}
                              name="assignedTo"
                              value={transferStaffId}
                              required
                              aria-invalid={errors.staff ? true : undefined}
                              aria-describedby={errors.staff ? `${transferStaffDomId}-error` : undefined}
                              onChange={(event) => {
                                setTransferStaffId(event.target.value);
                                setErrors((prev) => ({ ...prev, staff: undefined }));
                                setSubmitError('');
                                clearIntentKey();
                              }}
                            >
                              <option value="">Personel seçin</option>
                              {eligibleStaff.map((profile) => (
                                <option key={profile.user.id} value={profile.user.id}>
                                  {profile.user.name}
                                </option>
                              ))}
                            </select>
                            {eligibleStaff.length === 0 && (
                              <p className="form-help">Aktif başka personel bulunmuyor.</p>
                            )}
                            {errors.staff && (
                              <p id={`${transferStaffDomId}-error`} className="field-error" role="alert">
                                {errors.staff}
                              </p>
                            )}
                          </>
                        )}
                      </div>
                      <div className="field-group">
                        <WheelDateTimeField
                          mode="datetime"
                          id={transferTimeId}
                          name="scheduledAt"
                          value={transferLocal}
                          onChange={(val) => {
                            setTransferLocal(val);
                            setAcknowledgement(undefined);
                            setTransferReason('');
                            setTransferReasonRequired(false);
                            setErrors((prev) => ({ ...prev, scheduledAt: undefined }));
                            setSubmitError('');
                            clearIntentKey();
                          }}
                          required
                          disabled={pending || blocked}
                          invalid={Boolean(errors.scheduledAt)}
                          controlRef={transferTimeRef}
                          aria-describedby={
                            errors.scheduledAt
                              ? `${transferTimeId}-help ${transferTimeId}-error`
                              : `${transferTimeId}-help`
                          }
                          label="Yeni planlanan zaman"
                        />
                        <p className="form-help" id={`${transferTimeId}-help`}>
                          Planlanan işin süresi korunur.
                        </p>
                        <ScheduleQuickControls
                          value={transferLocal}
                          durationMinutes={durationMinutes}
                          disabled={pending || blocked}
                          onSelect={(val) => {
                            setTransferLocal(val);
                            setAcknowledgement(undefined);
                            setTransferReason('');
                            setTransferReasonRequired(false);
                            setErrors((prev) => ({ ...prev, scheduledAt: undefined }));
                            setSubmitError('');
                            clearIntentKey();
                          }}
                        />
                        {errors.scheduledAt && (
                          <p id={`${transferTimeId}-error`} className="field-error" role="alert">
                            {errors.scheduledAt}
                          </p>
                        )}
                      </div>
                      <AvailableSlotsNotice
                        {...transferSlotSearch}
                        selectedStartLocal={transferLocal}
                        onSelect={(slot) => {
                          setTransferLocal(isoInstantToLocalDateTime(slot.startsAt));
                          setAcknowledgement(undefined);
                          setTransferReason('');
                          setTransferReasonRequired(false);
                          setErrors((prev) => ({ ...prev, scheduledAt: undefined }));
                          setSubmitError('');
                          clearIntentKey();
                        }}
                        disabled={pending || blocked}
                      />
                      {changeRequest && (
                        <div className="form-checkbox-row">
                          <input
                            id={transferCloseCrId}
                            name="resolveChangeRequest"
                            type="checkbox"
                            checked={transferResolveCr}
                            onChange={(event) => setTransferResolveCr(event.target.checked)}
                          />
                          <label htmlFor={transferCloseCrId}>
                            Personel önerisini 'Yeniden planlandı' olarak kapat
                          </label>
                        </div>
                      )}
                    </fieldset>
                  )}

                  {selectedDecision === 'REOFFER' && (
                    <dl className="job-row-facts">
                      <div>
                        <dt>Sorumlu personel</dt>
                        <dd>{reviewedJob.assignee.name}</dd>
                      </div>
                      <div>
                        <dt>Planlanan zaman</dt>
                        <dd>{formatContextSchedule(reviewedJob)}</dd>
                      </div>
                    </dl>
                  )}

                  {selectedDecision === 'CORRECT' && (
                    <fieldset className="manager-recovery-fieldset" disabled={pending || blocked}>
                      <div className="field-group">
                        <label htmlFor={correctTitleId}>Başlık</label>
                        <input
                          ref={correctTitleRef}
                          id={correctTitleId}
                          name="title"
                          value={correctTitle}
                          maxLength={255}
                          required
                          aria-invalid={errors.title ? true : undefined}
                          aria-describedby={errors.title ? `${correctTitleId}-error` : undefined}
                          onChange={(event) => {
                            setCorrectTitle(event.target.value);
                            setErrors((prev) => ({ ...prev, title: undefined, general: undefined }));
                            setSubmitError('');
                          }}
                        />
                        {errors.title && (
                          <p id={`${correctTitleId}-error`} className="field-error" role="alert">
                            {errors.title}
                          </p>
                        )}
                      </div>

                      <div className="field-group">
                        <label htmlFor={correctDescId}>Açıklama</label>
                        <textarea
                          id={correctDescId}
                          name="description"
                          rows={3}
                          value={correctDescription}
                          onChange={(event) => {
                            setCorrectDescription(event.target.value);
                            setErrors((prev) => ({ ...prev, general: undefined }));
                            setSubmitError('');
                          }}
                        />
                      </div>

                      {reviewedJob.type === 'SALES_MEETING' && (
                        <>
                          <div className="field-group">
                            <label htmlFor={correctEngagementId}>Görüşme / ziyaret türü</label>
                            <select
                              ref={correctEngagementRef}
                              id={correctEngagementId}
                              name="engagementKind"
                              value={correctEngagementKind}
                              aria-invalid={errors.engagementKind ? true : undefined}
                              aria-describedby={
                                errors.engagementKind ? `${correctEngagementId}-error` : undefined
                              }
                              onChange={(event) => {
                                setCorrectEngagementKind(event.target.value as JobCardEngagementKind);
                                setErrors((prev) => ({
                                  ...prev,
                                  engagementKind: undefined,
                                  general: undefined,
                                }));
                                setSubmitError('');
                              }}
                            >
                              {JOB_CARD_ENGAGEMENT_KINDS.map((kind) => (
                                <option key={kind} value={kind}>
                                  {JOB_CARD_ENGAGEMENT_LABELS[kind]}
                                </option>
                              ))}
                            </select>
                            {errors.engagementKind && (
                              <p id={`${correctEngagementId}-error`} className="field-error" role="alert">
                                {errors.engagementKind}
                              </p>
                            )}
                          </div>

                          <div className="field-group">
                            <label htmlFor={correctCustomerIdDom}>Müşteri</label>
                            <CustomerSearchSelect
                              id={correctCustomerIdDom}
                              value={correctCustomerId}
                              onChange={(val) => {
                                setCorrectCustomerId(val);
                                setErrors((prev) => ({
                                  ...prev,
                                  customerId: undefined,
                                  general: undefined,
                                }));
                                setSubmitError('');
                              }}
                              onReadyChange={setCorrectCustomerReady}
                              invalid={errors.customerId ? true : undefined}
                              describedBy={[
                                errors.customerId ? `${correctCustomerIdDom}-error` : null,
                                isFollowUp ? `${correctCustomerIdDom}-help` : null,
                              ].filter(Boolean).join(' ') || undefined}
                              allowClear
                              disabled={isFollowUp}
                            />
                            {isFollowUp && (
                              <p id={`${correctCustomerIdDom}-help`} className="form-help">
                                Takip işi kaynak görüşmenin müşterisini korur; müşteri değiştirilemez.
                              </p>
                            )}
                            {errors.customerId && (
                              <p id={`${correctCustomerIdDom}-error`} className="field-error" role="alert">
                                {errors.customerId}
                              </p>
                            )}
                          </div>
                        </>
                      )}

                      <div className="field-group">
                        <label htmlFor={correctPriorityId}>Öncelik</label>
                        <select
                          id={correctPriorityId}
                          name="priority"
                          value={correctPriority}
                          onChange={(event) => {
                            setCorrectPriority(event.target.value as JobCardPriority);
                            setErrors((prev) => ({ ...prev, general: undefined }));
                            setSubmitError('');
                          }}
                        >
                          <option value="low">Düşük</option>
                          <option value="normal">Normal</option>
                          <option value="high">Yüksek</option>
                          <option value="urgent">Acil</option>
                        </select>
                      </div>

                      {changeRequest && changeRequest.reasonCode !== 'OTHER' && (
                        <p className="form-help" data-correct-closure-ineligible="unsupported-reason">
                          “{changeRequestReasonLabel(changeRequest.reasonCode)}” nedenli talep bu düzenleme ile kapatılmaz; iş bilgilerini bağımsız olarak kaydedebilirsiniz (talep açık kalır) veya ayrı olarak “Talebi kayda al ve kapat” kararını kullanabilirsiniz.
                        </p>
                      )}

                      {changeRequest && changeRequest.reasonCode === 'OTHER' && !correctEligibility.hasQualifyingChange && (
                        <p className="form-help" data-correct-closure-ineligible="qualifying-field-required">
                          {reviewedJob.type === 'SALES_MEETING'
                            ? isFollowUp
                              ? 'Açık “Diğer” talebini kapatmak için açıklama veya görüşme / ziyaret türü alanlarından en az birini güncelleyin; yalnızca başlık veya öncelik değişikliği talebi kapatmaz.'
                              : 'Açık “Diğer” talebini kapatmak için açıklama, görüşme / ziyaret türü veya müşteri alanlarından en az birini güncelleyin; yalnızca başlık veya öncelik değişikliği talebi kapatmaz.'
                            : 'Açık “Diğer” talebini kapatmak için açıklama alanını güncelleyin; yalnızca başlık veya öncelik değişikliği talebi kapatmaz.'}
                        </p>
                      )}

                      {canOptInCorrectClosure && (
                        <div className="field-group" data-correct-closure-optin="true">
                          <div className="form-checkbox-row">
                            <input
                              id={correctCloseCrId}
                              name="resolveChangeRequest"
                              type="checkbox"
                              checked={correctResolveCr}
                              disabled={pending || blocked}
                              onChange={(event) => {
                                setCorrectResolveCr(event.target.checked);
                                clearIntentKey();
                              }}
                            />
                            <label htmlFor={correctCloseCrId}>
                              Bu düzenlemenin personel talebini karşıladığını onaylıyor ve talebi “Düzeltildi” olarak kapatmak istiyorum
                            </label>
                          </div>
                          <p className="form-help">
                            İşaretlerseniz kaydetmeden önce bu düzenlemenin talebi nasıl karşıladığını açıklayan 1–2.000 karakterlik kapanış notu istenir. İşaretlemezseniz yalnızca iş bilgileri güncellenir ve talep açık kalır.
                          </p>
                        </div>
                      )}
                    </fieldset>
                  )}

                  {selectedDecision === 'CANCEL' && (
                    <p className="form-help" data-recovery-cancel-note="true">
                      “İptal adımına geç” seçildiğinde kalıcı iptal onay penceresi açılır
                      {isFollowUpVisit(reviewedJob)
                        ? ' ve takip döngüsü sürekliliği (yeniden planlama veya döngüyü sonlandırma) istenir.'
                        : ' ve iptal nedeni istenir.'}
                    </p>
                  )}

                  {selectedDecision === 'REJECT_CHANGE_REQUEST' && (
                    <fieldset className="manager-recovery-fieldset" disabled={pending || blocked}>
                      <div className="field-group">
                        <label htmlFor={rejectNoteId}>Reddetme açıklaması</label>
                        <textarea
                          ref={rejectNoteRef}
                          id={rejectNoteId}
                          name="rejectNote"
                          rows={4}
                          value={rejectNote}
                          required
                          aria-invalid={errors.rejectNote ? true : undefined}
                          aria-describedby={[
                            `${rejectNoteId}-help`,
                            errors.rejectNote ? `${rejectNoteId}-error` : null,
                          ].filter(Boolean).join(' ')}
                          onChange={(event) => {
                            setRejectNote(event.target.value);
                            setErrors((prev) => ({ ...prev, rejectNote: undefined }));
                            setSubmitError('');
                            clearIntentKey();
                          }}
                        />
                        <span className="form-help" id={`${rejectNoteId}-help`}>
                          Personelin önerisinin neden reddedildiğini açıklayın. En fazla
                          {' '}{NOTE_MAX_LENGTH.toLocaleString('tr-TR')} karakter.
                        </span>
                        <ProgressiveCounter
                          remaining={NOTE_MAX_LENGTH - Array.from(rejectNote.trim()).length}
                          dataCounter="reject-note"
                        >
                          {Math.max(0, NOTE_MAX_LENGTH - Array.from(rejectNote.trim()).length).toLocaleString('tr-TR')} karakter kaldı
                        </ProgressiveCounter>
                        {errors.rejectNote && (
                          <p id={`${rejectNoteId}-error`} className="field-error" role="alert">
                            {errors.rejectNote}
                          </p>
                        )}
                      </div>
                    </fieldset>
                  )}

                  {selectedDecision === 'ACKNOWLEDGED_ONLY' && (
                    <fieldset className="manager-recovery-fieldset" disabled={pending || blocked}>
                      <div className="field-group">
                        <label htmlFor={ackNoteId}>Kapanış notu</label>
                        <textarea
                          ref={ackNoteRef}
                          id={ackNoteId}
                          name="acknowledgeNote"
                          rows={4}
                          value={acknowledgeNote}
                          required
                          aria-invalid={errors.acknowledgeNote ? true : undefined}
                          aria-describedby={[
                            `${ackNoteId}-help`,
                            errors.acknowledgeNote ? `${ackNoteId}-error` : null,
                          ].filter(Boolean).join(' ')}
                          onChange={(event) => {
                            setAcknowledgeNote(event.target.value);
                            setErrors((prev) => ({ ...prev, acknowledgeNote: undefined }));
                            setSubmitError('');
                            clearIntentKey();
                          }}
                        />
                        <span className="form-help" id={`${ackNoteId}-help`}>
                          Bu seçenek iş bilgilerini, planlanan zamanı, teslim son tarihini, atama teklifini ve mevcut gecikme sorumluluğunu değiştirmez; yalnızca talebi notunuzla birlikte kayda alıp kapatır. En fazla
                          {' '}{NOTE_MAX_LENGTH.toLocaleString('tr-TR')} karakter.
                        </span>
                        {counterState(NOTE_MAX_LENGTH - Array.from(acknowledgeNote.trim()).length) !== 'hidden' && (
                          <ProgressiveCounter
                            remaining={NOTE_MAX_LENGTH - Array.from(acknowledgeNote.trim()).length}
                            dataCounter="ack-note"
                          >
                            {Math.max(0, NOTE_MAX_LENGTH - Array.from(acknowledgeNote.trim()).length).toLocaleString('tr-TR')} karakter kaldı
                          </ProgressiveCounter>
                        )}
                        {errors.acknowledgeNote && (
                          <p id={`${ackNoteId}-error`} className="field-error" role="alert">
                            {errors.acknowledgeNote}
                          </p>
                        )}
                      </div>
                    </fieldset>
                  )}
                </div>
              )}

              <section
                className={`manager-recovery-preview manager-recovery-preview--${preview.tone}`}
                aria-label="İşlem sonucu önizlemesi"
                data-recovery-preview={selectedDecision ?? 'NONE'}
              >
                <h3>İşlem sonucu</h3>
                <p className="manager-recovery-preview-summary">{preview.summary}</p>
                {preview.effects.length > 0 && (
                  <ul className="manager-recovery-preview-list">
                    {preview.effects.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                )}
                {preview.nonEffects.length > 0 && (
                  <div className="manager-recovery-preview-unchanged">
                    <strong>Değişmeyenler</strong>
                    <ul className="manager-recovery-preview-list">
                      {preview.nonEffects.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {preview.offerOutcome && (
                  <p className="form-help">
                    <strong>Atama teklifi:</strong> {preview.offerOutcome}
                  </p>
                )}
                {preview.requestDisposition && (
                  <p className="form-help">
                    <strong>Personel talebi:</strong> {preview.requestDisposition}
                  </p>
                )}
              </section>

              {(submitError || stale) && (
                <div
                  ref={errorSummaryRef}
                  className="field-error manager-recovery-error-summary"
                  role="alert"
                  tabIndex={-1}
                  data-recovery-submit-error="true"
                >
                  <SignalGlyph name="exclamation" className="detail-feedback-icon" size={16} />
                  <span>{stale ? STALE_MESSAGE : submitError}</span>
                </div>
              )}
            </div>
          </div>

          <div className="manager-recovery-footer review-buttons">
            <button
              className="secondary-button"
              type="button"
              disabled={pending || refreshing}
              onClick={dismissDrawer}
            >
              Vazgeç
            </button>
            {blocked ? (
              <button
                className="primary-button compact-button"
                type="button"
                disabled={refreshing}
                onClick={() => void refreshFromConflict()}
              >
                {refreshing ? 'Yükleniyor…' : 'En güncel bilgileri yükle'}
              </button>
            ) : (
              <button
                className={
                  selectedDecision === 'CANCEL'
                    ? 'destructive-button compact-button'
                    : 'primary-button compact-button'
                }
                type="submit"
                disabled={pending || disabled || submitBlockedByLookup}
                data-recovery-submit="true"
              >
                {pending && <SignalGlyph name="clock" className="detail-feedback-icon" size={16} />}
                {pending
                  ? 'Kaydediliyor…'
                  : submitButtonLabel(selectedDecision, canOptInCorrectClosure && correctResolveCr)}
              </button>
            )}
          </div>
        </form>
      </ResponsiveFormDrawer>

      <ReasonDialog
        open={panel === 'correct-resolve'}
        title="Talebi “Düzeltildi” olarak kapat"
        description="Düzenlenen iş bilgileri kaydedilecek ve personelin “Diğer” talebi yazdığınız açıklama ile “Düzeltildi” olarak kapatılacak."
        details={[
          `Nitelikli değişiklik: ${correctEligibility.qualifyingFields.join(', ')}`,
          'Yönetici onayı: Bu düzenlemenin personelin talebini karşıladığını onaylıyorsunuz.',
        ]}
        reasonLabel="Düzeltme açıklaması"
        helperText="Bu düzenlemenin personelin talebini nasıl karşıladığını açıklayın (1–2.000 karakter)."
        requiredMessage="Talebi “Düzeltildi” olarak kapatmak için açıklama notu zorunludur."
        confirmLabel="Kaydet ve talebi kapat"
        cancelLabel="Düzenlemeye dön"
        maxLength={NOTE_MAX_LENGTH}
        required
        pending={pending}
        pendingLabel="Kaydediliyor…"
        confirmDisabled={blocked || disabled}
        externalError={panel === 'correct-resolve' ? submitError : null}
        onReasonChange={() => setSubmitError('')}
        returnFocusRef={triggerRef}
        onCancel={() => {
          setSubmitError('');
          setPanel('recovery');
        }}
        onConfirm={(note) => {
          void runCorrect(note);
        }}
      />

      <ReasonDialog
        open={panel === 'reason'}
        title="Tarih değişikliği gerekçesi"
        description="Yeni plan açık gecikmeyi sonlandırıyor. Kayda eklenecek gerekçeyi yazın."
        reasonLabel="Gerekçe"
        requiredMessage={REASON_REQUIRED_MESSAGE}
        confirmLabel="Devret ve planla"
        cancelLabel="Plana dön"
        maxLength={500}
        required
        pending={pending}
        pendingLabel="Kaydediliyor…"
        externalError={submitError}
        returnFocusRef={triggerRef}
        onCancel={() => {
          setSubmitError('');
          setPanel('recovery');
        }}
        onConfirm={(nextReason) => {
          void runTransfer(nextReason, acknowledgement);
        }}
      />

      <PastStartAcknowledgementDrawer
        open={panel === 'acknowledgement'}
        description={
          ackOriginDecision === 'REOFFER'
            ? 'Planlanan başlangıç saati geçti. Yeni teklifi açmadan önce müşterinin güncel durumunu onaylayın.'
            : 'Planlanan başlangıç saati geçti. Değişikliği kaydetmek için müşterinin güncel durumunu onaylayın.'
        }
        pending={pending}
        error={submitError}
        onShiftToFuture={
          ackOriginDecision === 'RESCHEDULE' || ackOriginDecision === 'REASSIGN_AND_RESCHEDULE'
            ? () => {
                const futureVal = defaultScheduledLocalValue(new Date());
                if (ackOriginDecision === 'RESCHEDULE') {
                  setRescheduleLocal(futureVal);
                } else {
                  setTransferLocal(futureVal);
                }
                setAcknowledgement(undefined);
                setSubmitError('');
                setPanel('recovery');
              }
            : undefined
        }
        shiftToFutureLabel="Saati şimdiye / geleceğe al"
        returnFocusRef={triggerRef}
        onDismiss={() => {
          setAcknowledgement(undefined);
          setSubmitError('');
          setPanel('recovery');
        }}
        onConfirm={handlePastStartConfirm}
      />

      <ReasonDialog
        open={panel === 'cancel-confirm'}
        title="İşi iptal et"
        description={
          cancelContinuity?.draft.decision === 'RESCHEDULE'
            ? 'İptal edilen iş yeniden açılamaz; seçtiğiniz zamana yeni bir takip ziyareti oluşturulur. İptal nedenini iş geçmişine ekleyin.'
            : 'İptal edilen iş yeniden açılamaz.\nİptal nedenini iş geçmişine ekleyin.'
        }
        reasonLabel="İptal nedeni"
        confirmLabel={
          cancelContinuity?.draft.decision === 'RESCHEDULE'
            ? 'İptal et ve yeniden planla'
            : cancelContinuity?.draft.decision === 'END_CYCLE'
              ? 'İptal et ve döngüyü sonlandır'
              : 'İşi iptal et'
        }
        maxLength={2000}
        required
        destructive
        pending={pending}
        pendingLabel="Kaydediliyor…"
        prelude={
          cancelContinuity ? (
            <fieldset disabled={pending}>
              <FollowUpCancelContinuitySection
                draft={cancelContinuity.draft}
                inlineError={cancelContinuity.inlineError}
                onChange={(patch) =>
                  setCancelContinuity((current) =>
                    current
                      ? { draft: { ...current.draft, ...patch }, inlineError: null }
                      : current,
                  )
                }
              />
            </fieldset>
          ) : undefined
        }
        validatePrelude={
          cancelContinuity
            ? () => {
                const resolved = resolveFollowUpCancelContinuity(cancelContinuity.draft);
                if ('error' in resolved) {
                  setCancelContinuity({ ...cancelContinuity, inlineError: resolved.error });
                  return resolved.error;
                }
                return null;
              }
            : undefined
        }
        externalError={panel === 'cancel-confirm' ? submitError : null}
        returnFocusRef={triggerRef}
        onCancel={() => {
          setSubmitError('');
          setPanel('recovery');
        }}
        onConfirm={(cancelReason) => {
          void runCancel(cancelReason);
        }}
      />
    </>
  );
}
