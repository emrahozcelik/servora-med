import { SaleCorrectionSection } from './jobs/SaleCorrection';
import { getSaleDetails, type SaleDetails } from './jobs/sale-api';
import { RelatedSalesSection, SaleDetailsSection } from './jobs/SaleDetails';
import {
  SalePairContextPanel,
  SalePairGuidanceNotice,
  VisitPairApproveNote,
  VisitPairLifecycleNote,
  VisitPairSubmitNote,
} from './jobs/SalePairPanels';
import { useVisitPairSale } from './jobs/useVisitPairSale';
import { DeliveryProvenanceLine, LinkedDeliveryPanel } from './jobs/SaleDeliveryLinks';
import {
  buildSaleDeliveryRequest,
  createSaleDeliveryDraft,
  hasSaleDeliveryErrors,
  mapSaleDeliveryServerError,
  type SaleDeliveryDraft,
  type SaleDeliveryErrors,
  type SaleDeliverySource,
} from './jobs/sale-approval-delivery';
import {
  approvalCompletesSale,
  coordinatedSaleVersion,
  lifecycleMovesSale,
  pairConflictGuidance,
  pairManagedSaleCommand,
  pairRedirectGuidance,
  pairSuccessSuffix,
  salePairRedirectFrom,
  salePairStateConflictFrom,
  type SalePairGuidance,
} from './jobs/sale-pair';
import {
  useEffect, useLayoutEffect, useRef, useState,
  type FormEvent, type ReactNode, type Ref,
} from 'react';

import { ApiError, type CurrentUser } from './services/api';
import { markNotificationsReadByEntity } from './services/notifications-api';
import {
  acceptJobCard, approveJobCard, cancelJobCard, declineAssignment, releaseAssignment,
  getFollowUpSuggestion, getJobCard,
  getMeetingDetails, listDeliveryItems,
  invalidateJobCard,
  patchDeliveryItem, patchJobCard, patchMeetingDetails,
  pastStartAcknowledgementPayload,
  requestJobCardRevision, resumeJobCard, startJobCard, submitJobCardForApproval,
  withdrawJobCardFromApproval,
  type ApproveDeliveryInput, type ApproveFollowUpInput, type AssignmentReasonCode, type CustomerScheduleEvaluation,
  type DeliveryItem, type FollowUpProposalInput,
  type FollowUpCancelContinuity,
  type FollowUpProposalOrigin, type JobCard, type LifecycleCommand, type MeetingDetails,
  type JobCardInvalidationInput,
  type PastStartAcknowledgement,
  type PatchJobCardInput, type PatchMeetingDetailsInput, type RelatedName,
  type StartJobCardInput,
  type AvailableSlot,
  buildStaffFollowUpProposalInput,
  isAutoSchedulableFollowUpType,
} from './jobs/jobs-api';
import { listCalendarAssignees } from './services/calendar-api';
import {
  captureActionLocation,
  type ActionLocationCapture,
  type StartLocationCapture,
} from './jobs/start-location-capture';
import {
  deriveJobWorkflowPresentation,
  isFollowUpVisit,
  requiresMandatoryFollowUpProposal,
  type JobWorkflowPresentation,
  type RecordEditPresentation,
  type ScheduleEditPresentation,
  type TransitionPresentation,
} from './jobs/job-workflow-presentation';
import {
  CANONICAL_DURATION_MINUTES,
  defaultCorrectionDueLocalValue,
  defaultDeliveredAtLocalValue,
  defaultScheduledLocalValue,
  isoInstantToLocalDateTime,
  localDateTimeToIso,
} from './jobs/scheduling';
import { ScheduleQuickControls } from './jobs/ScheduleQuickControls';
import { hasOriginalSubmissionDeadline, formatCorrectionDueAt } from './jobs/overdue-correction';
import { apiFieldError } from './jobs/api-field-error';
import type { RevisionCorrectionDraft } from './jobs/RevisionCorrectionDueField';
import { hasValidPlannedIntervalForStart, plannedIntervalShape } from './jobs/job-schedule-integrity';
import { ResultState } from './ui/antd/ResultState';
import { SignalGlyph } from './ui/signal-icons';
import { WheelDateTimeField } from './ui/WheelDateTimeField';
import { formatWheelDisplay } from './ui/wheel-datetime';
import { JobApprovalReviewPanel } from './jobs/JobApprovalReviewPanel';
import { JobDecisionPanel } from './jobs/JobDecisionPanel';
import {
  CurrentResponsibilityPanel,
  RequirementsChecklist,
  RevisionLoopPanel,
  TerminalJobBanner,
} from './jobs/JobWorkflowPanels';
import {
  JobWorkflowDialog,
  type JobWorkflowDialogKind,
} from './jobs/JobWorkflowDialog';
import {
  EMPTY_FOLLOW_UP_CANCEL_CONTINUITY,
  type FollowUpCancelContinuityDraft,
} from './jobs/FollowUpCancelContinuitySection';
import {
  type FollowUpDraft,
} from './jobs/FollowUpProposalSection';
import { MeetingDetailsSection } from './jobs/MeetingDetails';
import { CustomerCompletenessAction } from './jobs/CustomerCompletenessAction';
import { SalesMeetingEditForm } from './jobs/SalesMeetingEditForm';
import { DeliveryAssigneeEditForm } from './jobs/DeliveryAssigneeEditForm';
import { GeneralTaskEditForm, type GeneralTaskEditInput } from './jobs/GeneralTaskEditForm';
import { JobNotes } from './jobs/JobNotes';
import { JobTimeline } from './jobs/JobTimeline';
import { submitComparisonWarning } from './jobs/location-distance-format';
import {
  classifyDevice,
  readDeviceSignals,
  startLocationUnavailableAdvisory,
  submitLocationUnavailableGuidance,
} from './jobs/location-guidance';
import {
  OverdueIncidentHistorySection,
  SubmissionLatenessSection,
} from './jobs/SubmissionLateness';
import { EarlyStartAuthorizationSection } from './jobs/EarlyStartAuthorization';
import { ChangeRequestSection } from './jobs/ChangeRequests';
import {
  AssignmentOfferSection,
  EMPTY_ASSIGNMENT_REASON,
  SCHEDULE_EDITOR_OPEN_EVENT,
  type AssignmentReasonDraft,
} from './jobs/AssignmentOffer';
import { PastStartAcknowledgementDrawer, isPastStartAcknowledgementRequired } from './jobs/PastStartAcknowledgementDrawer';
import {
  assignmentWindowErrorMessage,
  isAssignmentWindowStaleError,
} from './jobs/assignment-window-errors';
import { WeeklyReportDetail } from './jobs/WeeklyReportDetail';
import { useRealtimeInvalidation } from './realtime/RealtimeProvider';
import { jobEngagementLabel, jobCardStatusLabel, jobTypeLabels } from './jobs/job-labels';
import { JobConversationAction } from './jobs/JobConversationAction';
import {
  JobInvalidationAction,
  type JobInvalidationAttempt,
  type JobInvalidationMutationState,
} from './jobs/JobInvalidationAction';
import { useReassignmentConversationSync } from './jobs/useReassignmentConversationSync';
import { ReassignmentSyncPrompt } from './jobs/ReassignmentSyncPrompt';
import { CustomerScheduleNotice } from './jobs/CustomerScheduleNotice';
import { AvailableSlotsNotice } from './jobs/AvailableSlotsNotice';
import { useCustomerSchedulePreview } from './jobs/useCustomerSchedulePreview';
import { useAvailableSlotSearch } from './jobs/useAvailableSlotSearch';
import { PriorityChip } from './ui/PriorityChip';
import { StatusChip } from './ui/StatusChip';
import { PageHeader } from './ui/PageHeader';
import { formatCalendarDay } from './ui/calendar-date';
import { useSetRouteRuntimeLabel } from './shell/resolved-identity';
import { LoadingSkeleton, RecordDescriptions, WorkflowSteps, type RecordDescriptionItem } from './ui/antd';
import {
  FollowUpBadge,
  FollowUpBreadcrumb,
  FollowUpChildrenPanel,
  FollowUpCreateAction,
  FollowUpRecommendation,
  FollowUpSourcePanel,
  StaffFollowUpProposalNotice,
  SystemSelectedFollowUpNotice,
} from './jobs/FollowUpContinuity';
import { isAmbiguousMutationError, isDefinitiveMutationError } from './jobs/mutation-attempt-error';

type StaffCommand = 'start' | 'submit';
type CommittedStaleNoticeState = { kind: 'committed' | 'unknown'; message: string };
type CommandDependencies = {
  start: typeof startJobCard;
  submit: typeof submitJobCardForApproval;
  refresh: typeof getJobCard;
  createActionId: () => string;
};
const commandDependencies: CommandDependencies = {
  start: startJobCard, submit: submitJobCardForApproval, refresh: getJobCard,
  createActionId: () => crypto.randomUUID(),
};

export async function runStaffJobCommand(
  job: JobCard,
  command: StaffCommand,
  dependencies: CommandDependencies = commandDependencies,
  note = '',
  followUpProposal?: FollowUpProposalInput,
  meetingDetails?: MeetingDetails | null,
) {
  const input = { clientActionId: dependencies.createActionId(), expectedVersion: job.version };
  try {
    const updated = command === 'start'
      ? await dependencies.start(job.id, input)
      : await dependencies.submit(job.id, {
          ...input,
          note: note.trim(),
          ...(requiresMandatoryFollowUpProposal(job, meetingDetails) && followUpProposal
            ? { followUpProposal }
            : {}),
        });
    return { kind: 'success' as const, job: updated };
  } catch (error) {
    if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') {
      return { kind: 'conflict' as const, job: await dependencies.refresh(job.id) };
    }
    throw error;
  }
}

type ManagerCommand = 'approve' | 'revise';
type ManagerCommandDependencies = {
  approve: typeof approveJobCard;
  revise: typeof requestJobCardRevision;
  refresh: typeof getJobCard;
  createActionId: () => string;
};
const managerCommandDependencies: ManagerCommandDependencies = {
  approve: approveJobCard, revise: requestJobCardRevision, refresh: getJobCard,
  createActionId: () => crypto.randomUUID(),
};

export async function runManagerJobCommand(job: JobCard, command: ManagerCommand, revisionReason: string, dependencies: ManagerCommandDependencies = managerCommandDependencies) {
  const base = { clientActionId: dependencies.createActionId(), expectedVersion: job.version };
  try {
    const updated = command === 'approve'
      ? await dependencies.approve(job.id, revisionReason.trim()
        ? { ...base, note: revisionReason.trim() }
        : base)
      : await dependencies.revise(job.id, { ...base, revisionReason: revisionReason.trim() });
    return { kind: 'success' as const, job: updated };
  } catch (error) {
    if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') {
      return { kind: 'conflict' as const, job: await dependencies.refresh(job.id) };
    }
    throw error;
  }
}

export async function prepareMeetingEdit(
  job: JobCard & { type: 'SALES_MEETING' },
  clientActionId: string,
  withdraw: typeof withdrawJobCardFromApproval = withdrawJobCardFromApproval,
  /**
   * SALE-002 §4.5: a coordinated pair's withdraw must carry the linked sale's
   * version; an undefined value omits the field entirely.
   */
  expectedSaleVersion?: number,
) {
  if (job.status !== 'WAITING_APPROVAL') return job;
  return withdraw(job.id, {
    clientActionId,
    expectedVersion: job.version,
    ...(expectedSaleVersion === undefined ? {} : { expectedSaleVersion }),
  });
}

const purposeLabels = {
  SALE: 'Satış', SAMPLE: 'Numune', CONSIGNMENT: 'Konsinye', RETURN: 'İade', OTHER: 'Diğer',
} as const;

const WITHDRAW_EDIT_SUCCESS_MESSAGE = 'İş yönetici kontrolünden çıkarıldı ve yeniden düzenlemeye açıldı. '
  + 'Değişikliklerden sonra işi tekrar kontrole göndermeniz gerekir.';

function formatScheduledAt(value: string | null): string {
  if (!value) return 'Belirtilmedi';
  return new Intl.DateTimeFormat('tr-TR', { dateStyle: 'medium', timeStyle: 'short' })
    .format(new Date(value));
}

function formatScheduledInterval(startIso: string, endIso: string): ReactNode {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const sameLocalDay = start.getFullYear() === end.getFullYear()
    && start.getMonth() === end.getMonth()
    && start.getDate() === end.getDate();
  const endTime = new Intl.DateTimeFormat('tr-TR', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(end);
  const minutes = Math.round((end.valueOf() - start.valueOf()) / 60_000);
  return (
    <span>
      <time dateTime={startIso}>{formatScheduledAt(startIso)}</time>
      {sameLocalDay ? `–${endTime}` : ` – ${formatScheduledAt(endIso)}`}
      {minutes > 0 ? ` (${minutes} dk)` : ''}
    </span>
  );
}

/** Compact planned-time summary: `Per 26 Kas · 13:00–13:30 (30 dk)`. */
function formatScheduleSummaryValue(job: JobCard): ReactNode {
  if (!job.scheduledAt) return 'Planlanmadı';
  const startDisplay = formatWheelDisplay(
    'datetime',
    isoInstantToLocalDateTime(job.scheduledAt),
  );
  if (!job.scheduledEndsAt) {
    return <time dateTime={job.scheduledAt}>{startDisplay}</time>;
  }
  const start = new Date(job.scheduledAt);
  const end = new Date(job.scheduledEndsAt);
  const sameLocalDay = start.getFullYear() === end.getFullYear()
    && start.getMonth() === end.getMonth()
    && start.getDate() === end.getDate();
  const endDisplay = sameLocalDay
    ? new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit' }).format(end)
    : formatWheelDisplay('datetime', isoInstantToLocalDateTime(job.scheduledEndsAt));
  const minutes = Math.round((end.valueOf() - start.valueOf()) / 60_000);
  return (
    <span>
      <time dateTime={job.scheduledAt}>{startDisplay}</time>
      {`–${endDisplay}`}
      {minutes > 0 && (
        <>{' '}<span className="job-schedule-summary-duration">({minutes} dk)</span></>
      )}
    </span>
  );
}

/**
 * Advisory SCHED-3 reason for the assigned STAFF viewer's START control.
 * Computed from raw canonical JobCard fields only. The backend remains
 * authoritative — a stale client can still receive SCHEDULED_INTERVAL_REQUIRED.
 */
function startScheduleBlockedReason(job: JobCard): string | null {
  if (hasValidPlannedIntervalForStart({
    type: job.type,
    scheduledAt: job.scheduledAt,
    scheduledEndsAt: job.scheduledEndsAt ?? null,
  })) return null;
  return 'İşi başlatmak için önce geçerli bir planlama yapın. '
    + 'Planlama bölümünden başlangıç saatini güncelleyin.';
}

function findTransition(
  presentation: JobWorkflowPresentation,
  command: LifecycleCommand,
): TransitionPresentation | undefined {
  if (presentation.primaryTransition?.command === command) {
    return presentation.primaryTransition;
  }
  return presentation.secondaryTransitions.find((entry) => entry.command === command);
}

function isManagementUser(user: CurrentUser): boolean {
  return user.role === 'MANAGER' || user.role === 'ADMIN';
}

/** Reads one server `fieldErrors` entry, falling back to the contract message. */
function deadlineFieldError(error: ApiError): string {
  return apiFieldError(
    error,
    'deadlineExtensionReason',
    'Gecikmeyi sonlandıran tarih değişikliği için gerekçe yazın.',
  );
}

/**
 * Narrow job-detail composition: the same 64rem gate as the shell. When the
 * environment has no `matchMedia` (server rendering, non-browser tests) this
 * falls back to the narrow composition, matching `useDesktopShell` in the
 * `WorkflowSteps` adapter.
 */
function useNarrowDetail(): boolean {
  const query = '(min-width: 64rem)';
  const [narrow, setNarrow] = useState(() => (
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? !window.matchMedia(query).matches
      : true
  ));

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(query);
    const onChange = (event: MediaQueryListEvent) => setNarrow(!event.matches);
    setNarrow(!media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  return narrow;
}

function formatDeliveredAt(value: string | null): string {
  if (!value) return 'Henüz kaydedilmedi';
  return new Intl.DateTimeFormat('tr-TR', { dateStyle: 'medium', timeStyle: 'short' })
    .format(new Date(value));
}

function formatOrganizationInstant(value: string, timeZone: string): string {
  return new Intl.DateTimeFormat('tr-TR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).format(new Date(value));
}

function DeliveryItemActualTimeForm({
  item,
  pending,
  onSave,
}: {
  item: DeliveryItem;
  pending: boolean;
  onSave: (itemId: string, deliveredAt: string) => Promise<void>;
}) {
  const [localValue, setLocalValue] = useState(() => (
    item.deliveredAt ? isoInstantToLocalDateTime(item.deliveredAt) : ''
  ));
  const [fieldError, setFieldError] = useState('');
  const [submitError, setSubmitError] = useState('');
  const canonicalKey = `${item.id}:${item.deliveredAt ?? ''}`;
  const lastKey = useRef(canonicalKey);

  useEffect(() => {
    if (lastKey.current === canonicalKey) return;
    lastKey.current = canonicalKey;
    setLocalValue(item.deliveredAt ? isoInstantToLocalDateTime(item.deliveredAt) : '');
    setFieldError('');
    setSubmitError('');
  }, [canonicalKey, item.deliveredAt]);

  function fillNow() {
    if (pending) return;
    setLocalValue(defaultDeliveredAtLocalValue());
    setFieldError('');
    setSubmitError('');
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setSubmitError('');
    if (!localValue.trim()) {
      setFieldError('Gerçekleşen teslim zamanını seçin.');
      return;
    }
    setFieldError('');
    try {
      await onSave(item.id, localDateTimeToIso(localValue));
    } catch (caught) {
      setSubmitError(
        caught instanceof Error ? caught.message : 'Gerçekleşen teslim zamanı kaydedilemedi.',
      );
    }
  }

  const fieldId = `delivery-actual-at-${item.id}`;
  return (
    <form className="delivery-actual-time-form" onSubmit={submit} noValidate>
      <p className="field-hint">
        {item.deliveredAt
          ? `Kaydedildi: ${formatDeliveredAt(item.deliveredAt)}`
          : 'Teslim zamanı kaydedilmedi'}
      </p>
      <div className="field-group">
        <WheelDateTimeField
          mode="datetime"
          id={fieldId}
          name="deliveredAt"
          value={localValue}
          onChange={(value) => {
            setLocalValue(value);
            setFieldError('');
            setSubmitError('');
          }}
          required
          disabled={pending}
          invalid={Boolean(fieldError)}
          aria-describedby={fieldError ? `${fieldId}-error` : undefined}
          label="Gerçekleşen teslim zamanı"
        />
        {fieldError && <span id={`${fieldId}-error`} className="field-error">{fieldError}</span>}
      </div>
      {submitError && <p className="field-error" role="alert">{submitError}</p>}
      <div className="review-buttons inline-form-actions">
        <button className="secondary-button" type="button" disabled={pending} onClick={fillNow}>
          Şimdi
        </button>
        <button className="secondary-button" type="submit" disabled={pending}>
          {pending ? 'Kaydediliyor…' : 'Gerçekleşen teslim zamanını kaydet'}
        </button>
      </div>
    </form>
  );
}

type DeadlineChangeOptions = {
  /** OVR-5 §4.5: management reason for a deadline change that may end lateness. */
  deadlineExtensionReason?: string;
  /** OVR-5 §4.11: resolve the job's open change request in the same patch. */
  changeRequestResolution?: { changeRequestId: string; resolution: 'RESCHEDULED' };
};

function JobScheduleEditForm({
  job,
  scheduleEdit,
  pending,
  user,
  deadlineExtensionError = null,
  scheduleShiftSignal,
  scheduleCommittedSignal = 0,
  onRequestChange,
  onSave,
}: {
  job: JobCard;
  scheduleEdit: ScheduleEditPresentation;
  pending: boolean;
  user: CurrentUser;
  /** OVR-5 §5.4: server field error after 400 DEADLINE_EXTENSION_REASON_REQUIRED. */
  deadlineExtensionError?: string | null;
  scheduleShiftSignal?: number;
  /** UI-FEEDBACK/A: increments when a schedule save committed but its re-read failed. */
  scheduleCommittedSignal?: number;
  onRequestChange?: () => void;
  onSave?: (
    scheduledAt: string | null,
    scheduledEndsAt?: string | null,
    overrideReason?: string | null,
    deadlineChange?: DeadlineChangeOptions,
  ) => Promise<void> | void;
}) {
  const intervalJob = job.type === 'SALES_MEETING' || job.type === 'PRODUCT_DELIVERY';
  const intervalJobType: 'SALES_MEETING' | 'PRODUCT_DELIVERY' = intervalJob
    ? job.type as 'SALES_MEETING' | 'PRODUCT_DELIVERY'
    : 'SALES_MEETING';
  const managementUser = user.role !== 'STAFF';
  const hasOpenOverdueIncident = job.hasOpenOverdueIncident === true;
  const customerTimeLocked = !managementUser
    && job.assignmentOffer != null
    && (job.status === 'NEW' || job.status === 'ACCEPTED');
  const overdueLocked = !managementUser && hasOpenOverdueIncident;
  const scheduleLocked = customerTimeLocked || overdueLocked;
  // JOB-010: saving a planned time in the acceptance window withdraws the
  // current offer and opens a new one for the same Staff member.
  const assignmentOfferHint = managementUser
    && job.assignmentOffer != null
    && job.status === 'NEW';
  const [localValue, setLocalValue] = useState(() => (
    job.scheduledAt ? isoInstantToLocalDateTime(job.scheduledAt) : ''
  ));
  const [editing, setEditing] = useState(false);
  /** Focus is restored only after the target branch has rendered. */
  const [focusTarget, setFocusTarget] = useState<'editor' | 'summary' | null>(null);
  const changeButtonRef = useRef<HTMLButtonElement>(null);
  const [fieldError, setFieldError] = useState('');
  const [submitError, setSubmitError] = useState('');
  // OVR-5 §5.4: the reason surface appears with open lateness, or after the
  // server answered DEADLINE_EXTENSION_REASON_REQUIRED (the scanner may not
  // have ticked when the page loaded). Entered values are kept on failure.
  const [reason, setReason] = useState('');
  const [reasonVisible, setReasonVisible] = useState(managementUser && hasOpenOverdueIncident);
  const [reasonError, setReasonError] = useState('');
  // OVR-5 §4.11: checked by default; only sent when a deadline field changed.
  const [resolveChangeRequest, setResolveChangeRequest] = useState(true);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const submitErrorRef = useRef<HTMLParagraphElement>(null);
  const canonicalKey = `${job.id}:${job.version}:${job.scheduledAt ?? ''}:${job.scheduledEndsAt ?? ''}:${job.changeRequest?.id ?? ''}`;
  const lastKey = useRef(canonicalKey);
  const lastShiftSignalRef = useRef(0);

  useEffect(() => {
    if (managementUser && hasOpenOverdueIncident) setReasonVisible(true);
  }, [hasOpenOverdueIncident, managementUser]);

  useEffect(() => {
    if (!deadlineExtensionError) return;
    setReasonVisible(true);
    setReasonError(deadlineExtensionError);
  }, [deadlineExtensionError]);

  // UI-FEEDBACK/A: a schedule save that committed but could not re-read
  // supersedes this form's previous inline failure (for example the past-start
  // acknowledgement request). Only a schedule commit clears this form's errors;
  // other forms' commits leave them untouched.
  const lastScheduleCommittedSignalRef = useRef(scheduleCommittedSignal);
  useEffect(() => {
    if (scheduleCommittedSignal === lastScheduleCommittedSignalRef.current) return;
    lastScheduleCommittedSignalRef.current = scheduleCommittedSignal;
    setFieldError('');
    setSubmitError('');
    setReasonError('');
  }, [scheduleCommittedSignal]);

  useEffect(() => {
    if (scheduleShiftSignal === undefined || scheduleShiftSignal <= 0) {
      lastShiftSignalRef.current = 0;
      return;
    }
    if (scheduleShiftSignal !== lastShiftSignalRef.current) {
      lastShiftSignalRef.current = scheduleShiftSignal;
      setEditing(true);
      setLocalValue(defaultScheduledLocalValue(new Date()));
      setFieldError('');
      setSubmitError('');
    }
  }, [scheduleShiftSignal]);

  // Change-request and assignment-offer "new time" guidance opens this editor
  // even while it is collapsed.
  useEffect(() => {
    const open = () => {
      setEditing(true);
      setFocusTarget('editor');
    };
    document.addEventListener(SCHEDULE_EDITOR_OPEN_EVENT, open);
    return () => document.removeEventListener(SCHEDULE_EDITOR_OPEN_EVENT, open);
  }, []);

  useEffect(() => {
    if (focusTarget === 'editor' && editing) {
      const target = document.getElementById('job-scheduled-at');
      const targetDisabled = target === null
        || target.matches(':disabled')
        || target.getAttribute('aria-disabled') === 'true';
      if (!targetDisabled) {
        target.scrollIntoView?.({ block: 'center' });
        target.focus({ preventScroll: true });
      } else {
        // A locked planned time cannot take focus. Land on the enabled
        // change-request action, or the editor heading when there is none.
        const requestChange = document.getElementById('job-schedule-request-change');
        const fallback = requestChange !== null && !requestChange.matches(':disabled')
          ? requestChange
          : document.getElementById('job-schedule-edit-title');
        fallback?.scrollIntoView?.({ block: 'center' });
        fallback?.focus({ preventScroll: true });
      }
      setFocusTarget(null);
      return;
    }
    if (focusTarget === 'summary' && !editing) {
      changeButtonRef.current?.focus();
      setFocusTarget(null);
    }
  }, [editing, focusTarget]);

  // OVR-5b visual review: while this form is open the invalid reason field owns
  // focus on its client or server error, then the inline patch error does; the
  // page feedback stays informational.
  useEffect(() => {
    if (reasonError) reasonRef.current?.focus();
    else if (submitError) submitErrorRef.current?.focus();
  }, [reasonError, submitError]);

  const { evaluation, previewing } = useCustomerSchedulePreview({
    engagementKind: job.engagementKind,
    type: job.type,
    customerId: job.customerId,
    scheduledLocal: localValue,
    jobCardId: job.id,
    // Staff receive the server's role-projected evaluation; only a locked
    // planned time has nothing to preview.
    enabled: !scheduleLocked && (job.type === 'SALES_MEETING' || job.type === 'PRODUCT_DELIVERY'),
  });
  const availableSlotSearch = useAvailableSlotSearch({
    type: intervalJobType,
    customerId: job.customerId,
    assignedTo: job.assignedTo,
    scheduledStartLocal: localValue,
    jobCardId: job.id,
    enabled: intervalJob,
  });

  function useAvailableSlot(slot: AvailableSlot) {
    // OVR-5 §5.4 / JOB-010: Staff cannot move a locked planned time; the
    // disabled input must not change through the slot list.
    if (scheduleLocked) return;
    setLocalValue(isoInstantToLocalDateTime(slot.startsAt));
    setFieldError('');
    setSubmitError('');
  }

  useEffect(() => {
    if (lastKey.current === canonicalKey) return;
    lastKey.current = canonicalKey;
    setLocalValue(job.scheduledAt ? isoInstantToLocalDateTime(job.scheduledAt) : '');
    setFieldError('');
    setSubmitError('');
    setReason('');
    setReasonError('');
    setResolveChangeRequest(true);
  }, [canonicalKey, job.scheduledAt, intervalJob]);

  const deadlineChanged = localValue.trim()
    !== (job.scheduledAt ? isoInstantToLocalDateTime(job.scheduledAt) : '');
  // OVR-5 §5.4: the reason only matters when the planned time actually moves
  // and the job carries open lateness (or the server demanded it on submit).
  const reasonFieldVisible = managementUser && reasonVisible && deadlineChanged;

  function deadlineChangeOptions(): DeadlineChangeOptions | undefined {
    const trimmedReason = reasonFieldVisible ? reason.trim() : '';
    const resolution = managementUser && resolveChangeRequest && deadlineChanged && job.changeRequest
      ? {
          changeRequestId: job.changeRequest.id,
          resolution: 'RESCHEDULED' as const,
        }
      : undefined;
    if (!trimmedReason && !resolution) return undefined;
    return {
      ...(trimmedReason ? { deadlineExtensionReason: trimmedReason } : {}),
      ...(resolution ? { changeRequestResolution: resolution } : {}),
    };
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !onSave || scheduleLocked) return;
    setSubmitError('');
    if (reasonFieldVisible && !reason.trim()) {
      setReasonError('Gecikmeyi sonlandıran tarih değişikliği için gerekçe yazın.');
      return;
    }
    setReasonError('');
    if (!localValue.trim()) {
      if (!scheduleEdit.optional) {
        setFieldError(`${scheduleEdit.label} seçin.`);
        return;
      }
      setFieldError('');
      try {
        const options = deadlineChangeOptions();
        if (options) await onSave(null, null, undefined, options);
        else await onSave(null, null, undefined);
      } catch (caught) {
        setSubmitError(caught instanceof Error ? caught.message : 'Planlanan zaman kaydedilemedi.');
      }
      return;
    }
    setFieldError('');
    try {
      const options = deadlineChangeOptions();
      if (options) await onSave(localDateTimeToIso(localValue), undefined, undefined, options);
      else await onSave(localDateTimeToIso(localValue), undefined, undefined);
    } catch (caught) {
      setSubmitError(caught instanceof Error ? caught.message : 'Planlanan zaman kaydedilemedi.');
    }
  }

  function cancelEdit() {
    setLocalValue(job.scheduledAt ? isoInstantToLocalDateTime(job.scheduledAt) : '');
    setFieldError('');
    setSubmitError('');
    setReason('');
    setReasonError('');
    setResolveChangeRequest(true);
    setEditing(false);
    setFocusTarget('summary');
  }

  if (!editing) {
    return (
      <section
        className="job-schedule-edit job-schedule-edit--summary surface-flat"
        aria-labelledby="job-schedule-summary-label"
        data-job-schedule-summary="true"
      >
        <div className="job-schedule-summary">
          <div className="job-schedule-summary-text">
            <h2 id="job-schedule-summary-label" className="job-schedule-summary-label">
              {scheduleEdit.label}
            </h2>
            <span className="job-schedule-summary-value">
              {formatScheduleSummaryValue(job)}
            </span>
          </div>
          <button
            ref={changeButtonRef}
            className="secondary-button job-schedule-summary-change"
            type="button"
            onClick={() => {
              setEditing(true);
              setFocusTarget('editor');
            }}
          >
            Değiştir
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="job-schedule-edit surface-flat" aria-labelledby="job-schedule-edit-title">
      <h2 id="job-schedule-edit-title" tabIndex={-1}>Planlanan zamanı düzenle</h2>
      <form onSubmit={submit} noValidate>
        <div className="field-group">
          <WheelDateTimeField
            mode="datetime"
            id="job-scheduled-at"
            name="scheduledAt"
            value={localValue}
            onChange={(value) => {
              setLocalValue(value);
              setFieldError('');
              setSubmitError('');
            }}
            required={!scheduleEdit.optional}
            disabled={pending || scheduleLocked}
            invalid={Boolean(fieldError)}
            aria-describedby={[
              fieldError ? 'job-scheduled-at-error' : null,
              customerTimeLocked
                ? 'job-scheduled-at-customer-time-hint'
                : overdueLocked
                  ? 'job-scheduled-at-lateness-hint'
                  : null,
              assignmentOfferHint ? 'job-scheduled-at-offer-hint' : null,
            ].filter(Boolean).join(' ') || undefined}
            label={`${scheduleEdit.label}${scheduleEdit.optional ? ' (isteğe bağlı)' : ''}`}
          />
          {fieldError && <span id="job-scheduled-at-error" className="field-error">{fieldError}</span>}
          {customerTimeLocked && (
            <span className="form-help" id="job-scheduled-at-customer-time-hint">
              Müşteri zamanı yalnızca yönetici tarafından değiştirilebilir. Plan değişikliği için yöneticiye öneri gönderin.
            </span>
          )}
          {!customerTimeLocked && overdueLocked && (
            <span className="form-help" id="job-scheduled-at-lateness-hint">
              Gecikmesi açık işin tarihini yalnızca yönetim değiştirebilir. Değişiklik talebi gönderin.
            </span>
          )}
          {assignmentOfferHint && (
            <span className="form-help" id="job-scheduled-at-offer-hint" data-schedule-offer-hint="true">
              Kaydettiğinizde {job.assignee.name} kişisine yeni atama teklifi gider.
            </span>
          )}
          <ScheduleQuickControls
            value={localValue}
            durationMinutes={(() => {
              if (job.scheduledAt && job.scheduledEndsAt) {
                const startMs = Date.parse(job.scheduledAt);
                const endMs = Date.parse(job.scheduledEndsAt);
                if (!Number.isNaN(startMs) && !Number.isNaN(endMs) && endMs > startMs) {
                  return Math.round((endMs - startMs) / 60_000);
                }
              }
              return CANONICAL_DURATION_MINUTES[job.type] ?? null;
            })()}
            disabled={pending || scheduleLocked}
            onSelect={(next) => {
              setLocalValue(next);
              setFieldError('');
              setSubmitError('');
            }}
          />
        </div>
        {reasonFieldVisible && (
          <div className="field-group">
            <label htmlFor="job-schedule-extension-reason">Tarih değişikliği gerekçesi</label>
            <textarea
              ref={reasonRef}
              id="job-schedule-extension-reason"
              name="deadlineExtensionReason"
              rows={2}
              value={reason}
              maxLength={500}
              disabled={pending}
              required
              aria-invalid={reasonError ? true : undefined}
              aria-describedby={['job-schedule-extension-reason-help',
                reasonError ? 'job-schedule-extension-reason-error' : null].filter(Boolean).join(' ')}
              onChange={(event) => {
                setReason(event.target.value);
                setReasonError('');
                setSubmitError('');
              }}
            />
            <span className="form-help" id="job-schedule-extension-reason-help">
              En fazla 500 karakter.
            </span>
            {reasonError && (
              <span id="job-schedule-extension-reason-error" className="field-error" role="alert">
                {reasonError}
              </span>
            )}
          </div>
        )}
        {managementUser && job.changeRequest && deadlineChanged && (
          <div className="form-checkbox-row">
            <input
              id="job-schedule-resolve-change-request"
              name="resolveChangeRequest"
              type="checkbox"
              checked={resolveChangeRequest}
              disabled={pending}
              onChange={(event) => setResolveChangeRequest(event.target.checked)}
            />
            <label htmlFor="job-schedule-resolve-change-request">
              Personel önerisini 'Yeniden planlandı' olarak kapat
            </label>
          </div>
        )}
        <CustomerScheduleNotice
          evaluation={evaluation}
          mode={user.role === 'STAFF' ? 'staff' : 'manager'}
        />
        {previewing && <p className="field-status" role="status">Müşteri planı kontrol ediliyor…</p>}
        <AvailableSlotsNotice
          {...availableSlotSearch}
          selectedStartLocal={localValue}
          onSelect={useAvailableSlot}
          disabled={scheduleLocked}
        />
        {submitError && <p ref={submitErrorRef} className="field-error" role="alert" tabIndex={-1}>{submitError}</p>}
        <div className="review-buttons">
          {scheduleLocked
            && job.workflowContext.allowedActions.includes('REQUEST_CHANGE')
            && job.changeRequest == null
            && onRequestChange && (
            <button
              id="job-schedule-request-change"
              className="secondary-button"
              type="button"
              disabled={pending}
              onClick={onRequestChange}
            >
              Değişiklik önerisi gönder
            </button>
          )}
          <button className="primary-button" type="submit"
            disabled={pending || !onSave || scheduleLocked}>
            {pending ? 'Kaydediliyor…' : 'Planlanan zamanı kaydet'}
          </button>
          <button className="secondary-button" type="button" disabled={pending} onClick={cancelEdit}>
            Vazgeç
          </button>
        </div>
      </form>
    </section>
  );
}

/**
 * UI-FEEDBACK/A (07-manager-action-feedback §2 "Committed, refresh failed"):
 * the server already accepted the mutation, but the follow-up canonical read
 * failed. The record on screen may be stale, so this notice never reports a
 * mutation failure and its only action reuses the serialized realtime reload.
 */
export function CommittedStaleNotice({ message, kind = 'committed', reloadPending, onReload, feedbackRef }: {
  message: string;
  /** "unknown": the mutation outcome itself is unverified, not only the read. */
  kind?: 'committed' | 'unknown';
  reloadPending: boolean;
  onReload: () => void;
  feedbackRef?: Ref<HTMLDivElement>;
}) {
  return (
    <div
      ref={feedbackRef}
      className="detail-feedback detail-feedback-stale"
      role="status"
      tabIndex={-1}
      data-job-detail-section="feedback"
      data-job-detail-committed-refresh="true"
    >
      <p className="detail-feedback-stale-heading">
        <SignalGlyph name="exclamation" className="detail-feedback-stale-icon" size={16} />
        <span>
          {kind === 'unknown'
            ? message
            : `${message ? `${message} ` : ''}Güncel kayıt henüz yüklenemedi.`}
        </span>
      </p>
      <p className="detail-feedback-stale-help">
        {kind === 'unknown'
          ? 'Kaydın son durumunu görmek ve sonucu kontrol etmek için yenileyin.'
          : 'Gösterilen bilgiler eski olabilir; son durumu görmek için yenileyin.'}
      </p>
      <button className="secondary-button" type="button" disabled={reloadPending} onClick={onReload}>
        {reloadPending ? 'Yükleniyor…' : 'Güncel durumu yenile'}
      </button>
    </div>
  );
}

export function JobDetailPanel({
  job, items, user, pending, message, messageIsError = false,
  feedbackRef, onCommand, onRecordEdit, onSaveSchedule, onSaveDeliveredAt,
  onSaveAllDeliveredAtNow, scheduleShiftSignal, scheduleCommittedSignal, onRequestChange,
  meetingDetails = null, records, realtimeStaleNotice, committedStaleNotice, notes, timeline, children,
  pendingLabel, pendingCommand, continuity, submissionLateness, earlyStart, changeRequest, assignmentOffer,
  overdueHistory, onCreateFollowUp, existingChildrenCount, messagingAction,
  messagingActionVisible = false, invalidationAction, mutationLocked = false,
  deadlineExtensionError = null, pairGuidance, pairManagedCommand = null,
}: {
  job: JobCard;
  items: DeliveryItem[];
  user: CurrentUser;
  pending: boolean;
  pendingLabel?: string;
  pendingCommand?: LifecycleCommand | null;
  message: string;
  messageIsError?: boolean;
  feedbackRef?: Ref<HTMLDivElement>;
  onCommand: (command: LifecycleCommand, trigger: HTMLButtonElement) => void;
  onRecordEdit?: (
    action: RecordEditPresentation['action'], trigger: HTMLButtonElement,
  ) => void;
  onSaveSchedule?: (
    scheduledAt: string | null,
    scheduledEndsAt?: string | null,
    overrideReason?: string | null,
    deadlineChange?: DeadlineChangeOptions,
  ) => Promise<void> | void;
  onSaveDeliveredAt?: (itemId: string, deliveredAt: string) => Promise<void>;
  onSaveAllDeliveredAtNow?: () => Promise<void> | void;
  scheduleShiftSignal?: number;
  scheduleCommittedSignal?: number;
  onRequestChange?: () => void;
  meetingDetails?: MeetingDetails | null;
  records?: ReactNode;
  realtimeStaleNotice?: ReactNode;
  /** UI-FEEDBACK/A: committed mutation whose canonical re-read failed. */
  committedStaleNotice?: ReactNode;
  notes?: ReactNode;
  timeline?: ReactNode;
  children?: ReactNode;
  continuity?: ReactNode;
  submissionLateness?: ReactNode;
  /** JOB-010 §1a early-start authorization action/status. */
  earlyStart?: ReactNode;
  /** JOB-010 release 2a Staff change/termination request and its decision path. */
  changeRequest?: ReactNode;
  /** JOB-010 release 2b server-owned assignment offer and management recovery. */
  assignmentOffer?: ReactNode;
  /** Manager-only lateness history: above the workflow on desktop, a collapsed
   *  disclosure below the record details on mobile (DECISIONS.md UI-005). */
  overdueHistory?: ReactNode;
  onCreateFollowUp?: () => void;
  existingChildrenCount?: number | null;
  messagingAction?: ReactNode;
  messagingActionVisible?: boolean;
  invalidationAction?: ReactNode;
  mutationLocked?: boolean;
  /** SALE-002 §4.2: server-named next action for a redirected pair command. */
  pairGuidance?: ReactNode;
  /** SALE-002 S2: sale command the live visit pair withholds from this card. */
  pairManagedCommand?: LifecycleCommand | null;
  /** OVR-5 §5.4: server field error after 400 DEADLINE_EXTENSION_REASON_REQUIRED. */
  deadlineExtensionError?: string | null;
}) {
  const presentation = deriveJobWorkflowPresentation({
    job,
    user,
    workflowContext: job.workflowContext,
    deliveryItems: job.type === 'PRODUCT_DELIVERY' ? items : [],
    meetingDetails: job.type === 'SALES_MEETING' ? meetingDetails : null,
    pairManagedCommand,
  });
  /** UI-FEEDBACK/A: the committed notice is the single visible/announced result. */
  const committedStale = committedStaleNotice !== undefined && committedStaleNotice !== null;
  const managementReview = job.status === 'WAITING_APPROVAL' && isManagementUser(user);
  const canEditDelivery = job.type === 'PRODUCT_DELIVERY'
    && job.workflowContext.allowedActions.includes('EDIT_DELIVERY_ACTUAL_TIME')
    && onSaveDeliveredAt !== undefined;
  const scheduleLabel = presentation.scheduleEdit?.label
    ?? (job.type === 'SALES_MEETING'
      ? 'Planlanan görüşme zamanı'
      : job.type === 'PRODUCT_DELIVERY'
        ? 'Planlanan teslim zamanı'
        : 'Planlanan zaman');
  const scheduleShape = plannedIntervalShape({
    type: job.type,
    scheduledAt: job.scheduledAt,
    scheduledEndsAt: job.scheduledEndsAt ?? null,
  });
  const scheduleFactContent = scheduleShape === 'MISSING'
    ? 'Planlanmadı'
    : scheduleShape === 'INCOMPLETE'
      ? <span>
          {job.scheduledAt
            ? <time dateTime={job.scheduledAt}>{formatScheduledAt(job.scheduledAt)}</time>
            : null} (bitiş saati eksik)
        </span>
      : scheduleShape === 'VALID' && job.scheduledAt && job.scheduledEndsAt
        ? formatScheduledInterval(job.scheduledAt, job.scheduledEndsAt)
        : job.scheduledAt
          ? <time dateTime={job.scheduledAt}>{formatScheduledAt(job.scheduledAt)}</time>
          : 'Belirtilmedi';
  const descriptionItems: RecordDescriptionItem[] = [
    { key: 'status', label: 'Durum', content: <StatusChip status={job.status} /> },
    { key: 'assignee', label: 'Sorumlu personel', content: job.assignee.name },
    { key: 'priority', label: 'Öncelik', content: <PriorityChip priority={job.priority} /> },
    ...(job.type === 'SALE' ? [] : [{
      key: 'schedule', label: scheduleLabel,
      content: scheduleFactContent,
    }]),
    ...(job.type === 'PRODUCT_DELIVERY' ? [{
      key: 'submitted-at',
      label: 'Kontrole gönderim zamanı',
      content: job.workflowContext.lifecycle.submittedAt === null
        ? 'Henüz kontrole gönderilmedi'
        : job.organizationTimezone
          ? <time dateTime={job.workflowContext.lifecycle.submittedAt}>
              {formatOrganizationInstant(
                job.workflowContext.lifecycle.submittedAt,
                job.organizationTimezone,
              )}
            </time>
          : 'Organizasyon saat dilimi bilgisi bulunamadı',
    }] : []),
    ...(job.type === 'SALES_MEETING' || job.type === 'SALE' ? [] : [{
      key: 'due-date', label: 'Son tarih',
      content: job.dueDate ? <time dateTime={job.dueDate}>{formatCalendarDay(job.dueDate)}</time> : 'Belirtilmedi',
    }]),
    ...(job.correctionDueAt ? [{
      key: 'correction-due-at',
      label: 'Düzeltme son tarihi',
      content: (
        <time dateTime={job.correctionDueAt}>
          {formatCorrectionDueAt(job.correctionDueAt, job.organizationTimezone)}
        </time>
      ),
    }] : []),
    { key: 'customer', label: 'Müşteri', content: job.customer?.name ?? 'Belirtilmedi' },
    ...(job.type === 'SALES_MEETING' ? [
      {
        key: 'engagement',
        label: 'Görüşme türü',
        content: jobEngagementLabel(job.engagementKind),
      },
      {
        key: 'contact',
        label: 'Görüşülecek kişi',
        content: job.contact?.name ?? 'Belirtilmedi',
      },
    ] : job.type === 'SALE' ? [] : [
      { key: 'contact', label: 'İlgili kişi', content: job.contact?.name ?? 'Belirtilmedi' },
    ]),
    { key: 'description', label: 'Açıklama', content: job.description ?? 'Belirtilmedi', wide: true },
  ];

  const typeLabel = job.type === 'SALES_MEETING'
    ? jobEngagementLabel(job.engagementKind)
    : jobTypeLabels[job.type];
  const showFollowUpRecommendation = isManagementUser(user)
    && job.status === 'COMPLETED'
    && job.type === 'SALES_MEETING'
    && meetingDetails?.outcome === 'FOLLOW_UP_REQUIRED'
    && onCreateFollowUp !== undefined;
  const showFollowUpCreateAction = job.type !== 'SALE' && job.type !== 'WEEKLY_REPORT' && isManagementUser(user)
    && job.status === 'COMPLETED'
    && onCreateFollowUp !== undefined
    && !showFollowUpRecommendation;
  const localMutationPending = pending || mutationLocked;
  const narrow = useNarrowDetail();
  const showRequirements = !managementReview
    && presentation.terminalState === null
    && presentation.requirements.length > 0;
  const hasDecision = Boolean(
    presentation.primaryTransition
    || presentation.secondaryTransitions.length > 0
    || presentation.recordEditAction,
  );
  const requirements = showRequirements
    ? <RequirementsChecklist
        requirements={presentation.requirements}
        submitted={job.status === 'WAITING_APPROVAL'}
      />
    : null;
  const decision = hasDecision ? (
    <JobDecisionPanel
      primary={presentation.primaryTransition}
      secondary={presentation.secondaryTransitions}
      recordEditAction={presentation.recordEditAction}
      pending={localMutationPending}
      pendingLabel={pendingLabel}
      pendingCommand={pendingCommand}
      startLocationCaptureEnabled={job.workflowContext.startLocationCaptureEnabled}
      submitLocationCaptureEnabled={job.workflowContext.submitLocationCaptureEnabled}
      startScheduleBlockedReason={startScheduleBlockedReason(job)}
      onCommand={onCommand}
      onRecordEdit={onRecordEdit}
    />
  ) : null;
  // Below 1024px the primary command belongs to the responsibility region and
  // renders above the compact lifecycle summary; desktop keeps it in the rail.
  const railDecision = narrow ? null : decision;
  const hasWorkflowMain = Boolean(requirements || railDecision);
  const hasRail = Boolean(
    managementReview || hasWorkflowMain || notes || messagingActionVisible || invalidationAction,
  );

  const lifecycleSection = (
    <div data-job-detail-section="lifecycle">
      <WorkflowSteps
        items={presentation.phaseItems.map((item) => ({
          key: item.phase, label: item.label, state: item.state,
        }))}
        currentKey={presentation.currentPhase}
      />
    </div>
  );

  const workflowContextSections = (
    <>
      <FollowUpSourcePanel job={job} />
      {showFollowUpRecommendation && onCreateFollowUp && (
        <FollowUpRecommendation
          job={job}
          details={meetingDetails}
          onCreate={onCreateFollowUp}
          disabled={localMutationPending}
        />
      )}
      {showFollowUpCreateAction && onCreateFollowUp && (
        <FollowUpCreateAction
          onCreate={onCreateFollowUp}
          existingChildrenCount={existingChildrenCount}
          disabled={localMutationPending}
        />
      )}
      {presentation.revisionLoop && (
        <div data-job-detail-section="revision">
          <RevisionLoopPanel
            loop={presentation.revisionLoop}
            resumed={job.status === 'IN_PROGRESS'}
            viewerIsAssignee={user.role === 'STAFF' && job.assignee.id === user.id}
          />
        </div>
      )}
      {presentation.terminalDetails && (
        <div data-job-detail-section="terminal">
          <TerminalJobBanner details={presentation.terminalDetails} />
        </div>
      )}
    </>
  );

  const responsibilitySection = presentation.terminalState === null ? (
    <div data-job-detail-section="responsibility">
      <CurrentResponsibilityPanel
        presentation={presentation}
        assigneeName={job.assignee.name}
        hideSubmission={managementReview}
      />
    </div>
  ) : null;

  const narrowDecisionSection = narrow && decision ? (
    <div data-job-detail-section="actions">{decision}</div>
  ) : null;

  return (
    <main
      className="job-detail"
      data-job-detail="true"
      data-job-detail-committed-stale={committedStale ? 'true' : undefined}
    >
      {/* DOM/keyboard (owner decision 2026-11-25): heading → lifecycle strip →
          feedback → lateness signal → change request/assignment offer → facts →
          schedule → early start → type content → management review → actions →
          notes → timeline. Narrow keeps the responsibility panel and its primary
          commands directly below the strip; desktop keeps them in the work rail
          (DECISIONS.md UI-005). */}
      <div data-job-detail-section="heading">
        <PageHeader eyebrow={typeLabel} fallbackTitle={job.title} />
        <div className="detail-heading-meta" data-job-detail-meta="true">
        <StatusChip status={job.status} />
        <PriorityChip priority={job.priority} longLabel />
        <FollowUpBadge visible={job.followUpContext !== null} />
        </div>
      </div>
      {lifecycleSection}
      {message && (
        <div
          ref={committedStaleNotice ? undefined : feedbackRef}
          className={`detail-feedback${messageIsError ? ' detail-feedback-error' : ''}`}
          role={messageIsError ? 'alert' : 'status'}
          tabIndex={-1}
          data-job-detail-section="feedback"
        >
          {message}
        </div>
      )}
      {committedStaleNotice}
      {pairGuidance && (
        <div
          ref={message || committedStaleNotice ? undefined : feedbackRef}
          tabIndex={-1}
          data-job-detail-section="feedback"
          data-job-detail-pair-guidance="true"
        >
          {pairGuidance}
        </div>
      )}
      {realtimeStaleNotice}
      {continuity}
      {submissionLateness}
      {changeRequest}
      {assignmentOffer}
      {!narrow && overdueHistory}
      {job.followUpProposal?.origin === 'SYSTEM' && job.status === 'WAITING_APPROVAL' && (
        <SystemSelectedFollowUpNotice proposal={job.followUpProposal} />
      )}
      {job.followUpProposal?.origin === 'STAFF_ADJUSTED' && job.status === 'WAITING_APPROVAL' && (
        <StaffFollowUpProposalNotice proposal={job.followUpProposal} />
      )}
      {/* The lifecycle strip sits directly below the heading on both viewports;
          narrow then leads with the responsibility panel and its primary
          commands, desktop keeps the revision/terminal context above the work
          rail (DECISIONS.md UI-005, owner decision 2026-11-25). */}
      {narrow ? (
        <>
          {responsibilitySection}
          {narrowDecisionSection}
          {workflowContextSections}
        </>
      ) : (
        <>
          {workflowContextSections}
          {responsibilitySection}
        </>
      )}
      <div className={hasRail ? 'job-detail-content job-detail-content--rail' : 'job-detail-content'}>
        <div className="job-detail-main">
          <section
            className="detail-summary surface-flat"
            data-job-detail-section="facts"
            data-job-detail-block="record-facts"
          >
            <RecordDescriptions
              ariaLabel="İş kayıt bilgileri"
              items={descriptionItems}
              maxColumns={hasRail ? 1 : 2}
            />
          </section>

          {presentation.scheduleEdit && (
            <JobScheduleEditForm
              job={job}
              scheduleEdit={presentation.scheduleEdit}
              pending={localMutationPending}
              user={user}
              deadlineExtensionError={deadlineExtensionError}
              scheduleShiftSignal={scheduleShiftSignal}
              scheduleCommittedSignal={scheduleCommittedSignal}
              onRequestChange={onRequestChange}
              onSave={onSaveSchedule}
            />
          )}

          {/* Early start is about the planned start time, so it follows the
              schedule section (or the record facts when no schedule edit is
              offered) instead of leading the page (owner decision 2026-11-25). */}
          {earlyStart}

          {job.type === 'PRODUCT_DELIVERY' && (
            <section
              className="delivery-lines"
              aria-labelledby="delivery-lines-title"
              data-job-detail-block="delivery"
            >
              <h2 id="delivery-lines-title">Teslim bilgileri</h2>
              {canEditDelivery && items.length > 1
                && items.some((entry) => entry.deliveredAt === null) && (
                <button
                  className="secondary-button compact-button delivery-bulk-action"
                  type="button"
                  disabled={localMutationPending || !onSaveAllDeliveredAtNow}
                  onClick={() => { void onSaveAllDeliveredAtNow?.(); }}
                >
                  {localMutationPending ? 'Kaydediliyor…' : 'Boş kalemlere şimdiki saati uygula'}
                </button>
              )}
              <ul className="delivery-lines-list">
                {items.map((entry) => (
                  <li key={entry.id} className="delivery-line-item">
                    <div className="delivery-line-product">
                      <strong>{entry.productNameSnapshot}</strong>
                      <span>{entry.productSkuSnapshot ?? 'Ürün kodu belirtilmedi'}</span>
                    </div>
                    <dl className="delivery-line-facts">
                      <div><dt>Amaç</dt><dd>{purposeLabels[entry.deliveryPurpose]}</dd></div>
                      <div>
                        <dt>Miktar</dt>
                        <dd>{entry.quantity}{entry.unit ? ` ${entry.unit}` : ''}</dd>
                      </div>
                      {!canEditDelivery && (
                        <div>
                          <dt>Gerçekleşen teslim zamanı</dt>
                          <dd>{formatDeliveredAt(entry.deliveredAt)}</dd>
                        </div>
                      )}
                    </dl>
                    {canEditDelivery && onSaveDeliveredAt && (
                      <DeliveryItemActualTimeForm
                        item={entry}
                        pending={localMutationPending}
                        onSave={onSaveDeliveredAt}
                      />
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {records && (
            <div className="job-detail-records" data-job-detail-block="records">
              {records}
            </div>
          )}
        </div>

        {hasRail && (
          <aside className="job-detail-work-rail" data-job-detail-rail="true">
            {managementReview && (
              <div
                className="job-detail-management-review"
                data-job-detail-section="management-review"
              >
                <JobApprovalReviewPanel
                  job={job}
                  lifecycle={job.workflowContext.lifecycle}
                  requirements={presentation.requirements}
                />
              </div>
            )}

            {hasWorkflowMain && (
              <div
                className="job-detail-workflow-layout"
                data-job-detail-section="actions"
              >
                <div className="job-detail-workflow-main">
                  <h2 className="job-detail-rail-heading">İşlemler</h2>
                  {requirements}
                  {railDecision}
                </div>
              </div>
            )}

            {messagingAction}

            {notes && (
              <div
                className="job-detail-workflow-notes"
                data-job-detail-section="notes"
                data-job-detail-block="notes"
              >
                {notes}
              </div>
            )}

            {invalidationAction}
          </aside>
        )}
      </div>

      {narrow && overdueHistory && (
        <div
          className="job-detail-lateness-history"
          data-job-detail-section="lateness-history"
        >
          {overdueHistory}
        </div>
      )}

      {timeline && (
        <div className="job-detail-timeline" data-job-detail-section="timeline">
          {timeline}
        </div>
      )}

      {children}
    </main>
  );
}

export type LoadedJobDetail =
  | { kind: 'SALE'; job: JobCard & { type: 'SALE' }; saleDetails: SaleDetails }
  | { kind: 'PRODUCT_DELIVERY'; job: JobCard & { type: 'PRODUCT_DELIVERY' }; deliveryItems: DeliveryItem[] }
  | { kind: 'GENERAL_TASK'; job: JobCard & { type: 'GENERAL_TASK' } }
  | { kind: 'WEEKLY_REPORT'; job: JobCard & { type: 'WEEKLY_REPORT' } }
  | { kind: 'SALES_MEETING'; job: JobCard & { type: 'SALES_MEETING' }; meetingDetails: MeetingDetails | null };
type DetailState = { kind: 'loading' } | { kind: 'ready'; detail: LoadedJobDetail }
  | { kind: 'error'; message: string; retryable: boolean };

async function loadJobDetailOnce(jobId: string): Promise<LoadedJobDetail> {
  const job = await getJobCard(jobId, { includeSubmitLocationCapability: true });
  if (job.type === 'PRODUCT_DELIVERY') {
    return {
      kind: job.type,
      job: { ...job, type: job.type },
      deliveryItems: await listDeliveryItems(jobId),
    };
  }
  if (job.type === 'GENERAL_TASK') {
    return { kind: 'GENERAL_TASK' as const, job: { ...job, type: 'GENERAL_TASK' as const } };
  }
  if (job.type === 'WEEKLY_REPORT') {
    return { kind: 'WEEKLY_REPORT' as const, job: { ...job, type: 'WEEKLY_REPORT' as const } };
  }
  if (job.type === 'SALE') {
    return { kind: 'SALE', job: { ...job, type: 'SALE' }, saleDetails: await getSaleDetails(jobId) };
  }
  const viewMeeting = job.workflowContext.allowedActions.includes('VIEW_MEETING_RESULT');
  return {
    kind: job.type,
    job: { ...job, type: job.type },
    meetingDetails: viewMeeting ? await getMeetingDetails(jobId) : null,
  };
}
async function loadJobDetail(jobId: string) {
  let detail = await loadJobDetailOnce(jobId);
  if (detail.kind === 'SALE') {
    if (detail.job.version === detail.saleDetails.jobCardVersion) return detail;
    const refreshed = await loadJobDetailOnce(jobId);
    if (refreshed.kind !== 'SALE' || refreshed.job.version !== refreshed.saleDetails.jobCardVersion) {
      throw new ApiError(409, 'VERSION_CONFLICT', 'İş ve satış bilgileri eşleşmedi. Tekrar deneyin.', true);
    }
    return refreshed;
  }
  if (detail.kind !== 'SALES_MEETING' || detail.meetingDetails === null
    || detail.job.version === detail.meetingDetails.jobCardVersion) return detail;
  detail = await loadJobDetailOnce(jobId);
  if (detail.kind !== 'SALES_MEETING' || detail.meetingDetails === null
    || detail.job.version !== detail.meetingDetails.jobCardVersion) {
    throw new ApiError(409, 'VERSION_CONFLICT', 'İş ve görüşme bilgileri eşleşmedi. Tekrar deneyin.', true);
  }
  return detail;
}

/**
 * JOB-009: turn the cancel continuity draft into the request field, or the
 * inline message that keeps the dialog open. The server re-validates.
 */
export function resolveCancelContinuity(
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

async function executeLifecycleCommand(
  jobId: string,
  command: LifecycleCommand,
  input: StartJobCardInput & {
    followUpProposal?: FollowUpProposalInput;
    followUpContinuity?: FollowUpCancelContinuity;
    followUp?: ApproveFollowUpInput;
    /** SALE-002 §5.1: the optional delivery an approval that completes a sale opens. */
    delivery?: ApproveDeliveryInput;
    assignmentReason?: { code: AssignmentReasonCode; text: string; proposedScheduledAt?: string };
    correctionDueAt?: string;
    /** SALE-002 §4.5: present only for a coordinated pair command. */
    expectedSaleVersion?: number;
  },
  reason: string,
): Promise<JobCard & { linkedSaleJobCardId: string | null; deliveryJobCardId?: string }> {
  const lifecycleInput = { clientActionId: input.clientActionId, expectedVersion: input.expectedVersion };
  switch (command) {
    case 'ACCEPT_ASSIGNMENT':
      return acceptJobCard(jobId, input);
    case 'DECLINE_ASSIGNMENT':
      return declineAssignment(jobId, {
        ...lifecycleInput,
        reasonCode: input.assignmentReason?.code ?? 'OTHER',
        reasonText: input.assignmentReason?.text ?? reason,
        ...(input.assignmentReason?.proposedScheduledAt !== undefined
          ? { proposedScheduledAt: input.assignmentReason.proposedScheduledAt }
          : {}),
      });
    case 'RELEASE_ASSIGNMENT':
      return releaseAssignment(jobId, {
        ...lifecycleInput,
        reasonCode: input.assignmentReason?.code ?? 'OTHER',
        reasonText: input.assignmentReason?.text ?? reason,
        ...(input.assignmentReason?.proposedScheduledAt !== undefined
          ? { proposedScheduledAt: input.assignmentReason.proposedScheduledAt }
          : {}),
      });
    case 'START':
      return startJobCard(jobId, input);
    case 'SUBMIT_FOR_APPROVAL':
      return submitJobCardForApproval(jobId, {
        ...input,
        note: reason.trim(),
        ...(input.followUpProposal ? { followUpProposal: input.followUpProposal } : {}),
      });
    case 'APPROVE': {
      const base = { ...input, ...(reason.trim() ? { note: reason.trim() } : {}) };
      return approveJobCard(jobId, input.followUp
        ? { ...base, followUp: input.followUp }
        : base);
    }
    case 'REQUEST_REVISION':
      return requestJobCardRevision(jobId, { ...input, revisionReason: reason });
    case 'WITHDRAW_FROM_APPROVAL':
      return withdrawJobCardFromApproval(jobId, input);
    case 'RESUME':
      return resumeJobCard(jobId, input);
    case 'CANCEL':
      // Cancel is never a pair command: the linked sale is not cancelled or
      // edited (SALE-002 §4.3), so the receipt never names it.
      return { ...(await cancelJobCard(jobId, { ...input, cancelReason: reason })), linkedSaleJobCardId: null };
    default: {
      const _exhaustive: never = command;
      throw new Error(`Unsupported lifecycle command: ${_exhaustive}`);
    }
  }
}

export function JobDetailScreen({ jobId, user, onChanged, onCreateFollowUp, onOpenMessaging }: JobDetailScreenProps) {
  return <JobDetailSessionScreen key={jobId} jobId={jobId} user={user} onChanged={onChanged} onCreateFollowUp={onCreateFollowUp} onOpenMessaging={onOpenMessaging} />;
}

type JobDetailScreenProps = {
  jobId: string;
  user: CurrentUser;
  onChanged: () => void;
  onCreateFollowUp?: () => void;
  onOpenMessaging?: (conversationId: string) => void;
};

let sessionTokenCounter = 0;

function nextSessionToken() {
  sessionTokenCounter += 1;
  return sessionTokenCounter;
}

function JobDetailSessionScreen({ jobId, user, onChanged, onCreateFollowUp, onOpenMessaging }: JobDetailScreenProps) {
  const [state, setState] = useState<DetailState>({ kind: 'loading' });
  // The lateness history is a collapsed disclosure below the workflow for
  // managers below the 64rem gate only (DECISIONS.md UI-005).
  const narrowDetail = useNarrowDetail();
  const setRouteRuntimeLabel = useSetRouteRuntimeLabel();
  useEffect(() => {
    setRouteRuntimeLabel(state.kind === 'ready' ? state.detail.job.title : undefined);
  }, [setRouteRuntimeLabel, state]);
  const reassignmentSync = useReassignmentConversationSync(jobId);
  const [pending, setPending] = useState(false);
  const [pendingCommand, setPendingCommand] = useState<LifecycleCommand | null>(null);
  const [startPendingPhase, setStartPendingPhase] = useState<'capturing' | 'submitting' | null>(null);
  const [submitPendingPhase, setSubmitPendingPhase] = useState<'capturing' | 'submitting' | null>(null);
  const [changeRequestSignal, setChangeRequestSignal] = useState(0);
  const [scheduleShiftSignal, setScheduleShiftSignal] = useState(0);
  const [scheduleCommittedSignal, setScheduleCommittedSignal] = useState(0);
  /** UI-FEEDBACK/A: the page notice shows the last meeting save's receipt. */
  const meetingReceiptOnPageRef = useRef(false);
  const [message, setMessage] = useState('');
  const [messageIsError, setMessageIsError] = useState(false);
  /** UI-FEEDBACK/A: a committed mutation whose canonical re-read failed. */
  const [committedStale, setCommittedStale] = useState<CommittedStaleNoticeState | null>(null);
  const committedStaleRef = useRef<CommittedStaleNoticeState | null>(null);
  const [meetingSubmissionError, setMeetingSubmissionError] = useState<ApiError | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [timelineKey, setTimelineKey] = useState(0);
  const [lifecycleNoteKey, setLifecycleNoteKey] = useState(0);
  const [notesRealtimeKey, setNotesRealtimeKey] = useState(0);
  const [messagingActionVisible, setMessagingActionVisible] = useState(false);
  const [followUpChildrenCount, setFollowUpChildrenCount] = useState<number | null>(null);
  const [invalidationMutation, setInvalidationMutation] = useState<JobInvalidationMutationState>({ kind: 'idle' });
  const [dialog, setDialog] = useState<JobWorkflowDialogKind | null>(null);
  /**
   * SALE-002 §4.2/§8.1: pair commands answered with a coded redirect or a
   * non-coordinated pair state. Rendered as the server-named next action so a
   * stale single-card view never becomes a dead end.
   */
  const [pairGuidance, setPairGuidance] = useState<SalePairGuidance | null>(null);
  /**
   * OVR-5 §3.9: correction deadline draft of the open revision dialog, present
   * only when the job has an original submission deadline.
   */
  const [revisionCorrection, setRevisionCorrection] = useState<RevisionCorrectionDraft | null>(null);
  /**
   * OVR-5 §5.4: server `fieldErrors.deadlineExtensionReason` after a 400
   * DEADLINE_EXTENSION_REASON_REQUIRED, so the reason field appears even when
   * the scanner had not ticked when the page loaded.
   */
  const [deadlineExtensionError, setDeadlineExtensionError] = useState<string | null>(null);
  /** JOB-009: continuity draft, present only while cancelling a follow-up visit. */
  const [cancelContinuity, setCancelContinuity] = useState<{
    draft: FollowUpCancelContinuityDraft;
    inlineError: string | null;
  } | null>(null);
  /** JOB-010 release 2b: reason draft, present only while declining/releasing. */
  const [assignmentReason, setAssignmentReason] = useState<{
    draft: AssignmentReasonDraft;
    inlineError: string | null;
    /** JOB-012: inline error of the proposed-time field (SCHEDULE_CONFLICT). */
    scheduleError: string | null;
  } | null>(null);
  /**
   * JOB-010 release 2b: a management create/edit answer that the server
   * rejected with PAST_START_ACKNOWLEDGEMENT_REQUIRED. The retry replays the
   * same values plus the acknowledgement the user fills in.
   */
  const [pastStartAck, setPastStartAck] = useState<{
    title: string;
    description: string;
    run: (acknowledgement: PastStartAcknowledgement) => Promise<{ ok: true } | { ok: false; error: string }>;
    onShiftToFuture?: () => void;
  } | null>(null);
  const [pastStartAckPending, setPastStartAckPending] = useState(false);
  const [pastStartAckError, setPastStartAckError] = useState('');
  const pastStartAckOpenerRef = useRef<HTMLElement | null>(null);
  /**
   * UI-FEEDBACK/A: the drawer's focus target. It normally returns to the
   * opener, but a committed-but-stale save must land on the page notice
   * instead of the old save control that is still on screen.
   */
  const pastStartAckReturnFocusRef = useRef<HTMLElement | null>(null);
  const lastSavePatchErrorRef = useRef('');
  const [followUp, setFollowUp] = useState<{
    draft: FollowUpDraft | null;
    origin: FollowUpProposalOrigin | null;
    evaluation: CustomerScheduleEvaluation | null;
    assigneeName: string;
    assignees: RelatedName[];
    inlineError: string | null;
    /**
     * Staff AUTO no-slot fallback. False in the normal automatic path (the
     * server selects the slot); true only when a successful suggestion
     * response explicitly reports scheduledAt === null.
     */
    explicitScheduleAllowed: boolean;
    /**
     * Suggestion load failure message. Set only when the suggestion request
     * itself failed; never synthesized into a no-slot decision.
     */
    loadError: string | null;
    /**
     * Forces the Staff instructions disclosure open after a
     * required-instructions validation failure.
     */
    expandInstructions: boolean;
  } | null>(null);
  const [followUpLoading, setFollowUpLoading] = useState(false);
  const [followUpLoadError, setFollowUpLoadError] = useState<string | null>(null);
  const followUpLoadTokenRef = useRef(0);
  const dialogTriggerRef = useRef<HTMLElement | null>(null);
  const dialogFocusRestoreEnabledRef = useRef(true);
  const mutationInFlight = useRef(false);
  /** UI-FEEDBACK/A: a post-commit drain is reconciling a known receipt. */
  const committedReceiptPendingRef = useRef(false);
  /** A terminal 403/404 ended the screen; no continuation may re-settle it. */
  const accessLostRef = useRef(false);
  const lifecycleAttempt = useRef<{
    command: LifecycleCommand;
    input: StartJobCardInput & {
      followUpProposal?: FollowUpProposalInput;
      followUp?: ApproveFollowUpInput;
      delivery?: ApproveDeliveryInput;
      followUpContinuity?: FollowUpCancelContinuity;
      assignmentReason?: { code: AssignmentReasonCode; text: string; proposedScheduledAt?: string };
      correctionDueAt?: string;
    };
    reason: string;
  } | null>(null);
  const withdrawEditAttempt = useRef<{
    job: JobCard & { type: 'SALES_MEETING' };
    clientActionId: string;
    expectedSaleVersion: number | null;
  } | null>(null);
  const [saleCorrectionLocked, setSaleCorrectionLocked] = useState(false);
  const saleCorrectionLockedRef = useRef(false);
  const [uncertain, setUncertain] = useState(false);
  const startCapture = useRef<{
    clientActionId: string;
    capture: StartLocationCapture;
  } | null>(null);
  // Slice 1: one-shot SUBMIT snapshot, retained per lifecycle attempt so
  // transport retry reuses the same capture and clientActionId.
  const submitCapture = useRef<{
    clientActionId: string;
    capture: ActionLocationCapture;
  } | null>(null);
  const feedbackRef = useRef<HTMLDivElement>(null);
  const [feedbackFocusRequest, setFeedbackFocusRequest] = useState(0);
  const [editing, setEditing] = useState(false);
  const [realtimeStale, setRealtimeStale] = useState(false);
  const [saleOriginPending, setSaleOriginPending] = useState(false);
  const [realtimeReloadPending, setRealtimeReloadPending] = useState(false);
  const sessionLifetime = useRef({
    jobId,
    token: nextSessionToken(),
    active: true,
  });
  /**
   * SALE-002 §4.1: the visit's linked sale, discovered from existing reads and
   * reloaded whenever the visit version or either card's realtime key moves.
   * Only a visit card can carry a pair, so other types stay idle.
   */
  const [pairState, reloadPair] = useVisitPairSale({
    visitId: jobId,
    visitType: state.kind === 'ready' ? state.detail.job.type : 'GENERAL_TASK',
    visitStatus: state.kind === 'ready' ? state.detail.job.status : 'NEW',
    visitAssignedTo: state.kind === 'ready' ? state.detail.job.assignedTo : '',
    visitVersion: state.kind === 'ready' ? state.detail.job.version : 0,
  });
  /**
   * SALE-002 §8.2: the optional "Teslim işi aç" draft of the open approve
   * dialog. It exists only while the approval completes a sale, either through
   * the visit pair (the coordinated sale is `WAITING_APPROVAL`) or because this
   * IS the independent sale's own approval.
   */
  const [saleDelivery, setSaleDelivery] = useState<{
    draft: SaleDeliveryDraft;
    errors: SaleDeliveryErrors | null;
  } | null>(null);
  const saleDeliveryFailureSeq = useRef(0);
  const approveDeliverySource: SaleDeliverySource | null = (() => {
    if (dialog?.kind !== 'approve' || state.kind !== 'ready') return null;
    const detail = state.detail;
    if (detail.kind === 'SALES_MEETING') {
      if (pairState.kind !== 'ready' || !pairState.coordinated
        || !approvalCompletesSale(pairState.sale)) return null;
      return {
        saleId: pairState.sale.id,
        title: pairState.sale.title,
        assignedTo: pairState.sale.assignedTo,
        customerName: detail.job.customer?.name ?? null,
        customerActive: true,
        items: pairState.sale.items,
        independent: false,
      };
    }
    if (detail.kind === 'SALE' && detail.job.status === 'WAITING_APPROVAL' && detail.job.customerId) {
      return {
        saleId: detail.job.id,
        title: detail.job.title,
        assignedTo: detail.job.assignedTo,
        customerName: detail.job.customer?.name ?? null,
        customerActive: true,
        items: detail.saleDetails.items,
        independent: true,
      };
    }
    return null;
  })();
  const approveDeliverySourceId = approveDeliverySource?.saleId ?? null;
  useEffect(() => {
    if (dialog?.kind !== 'approve') setSaleDelivery(null);
  }, [dialog?.kind]);
  useEffect(() => {
    if (approveDeliverySource === null) return;
    // Kept across a pair reload (the source briefly disappears while loading) so
    // the manager's edits are not lost; reset only when the dialog closes.
    setSaleDelivery((current) => current ?? {
      draft: createSaleDeliveryDraft(approveDeliverySource, new Date()),
      errors: null,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approveDeliverySourceId]);
  useLayoutEffect(() => {
    const lifetime = sessionLifetime.current;
    lifetime.active = true;
    return () => {
      lifetime.active = false;
    };
  }, []);
  const realtimeDrain = useRef<{
    sessionToken: number;
    drainToken: number;
    promise: Promise<boolean>;
  } | null>(null);
  const drainTokenCounter = useRef(0);
  const realtimeDrainRequested = useRef(false);
  const realtimeReloadRequested = useRef(false);
  const realtimeReloadOwner = useRef<{
    sessionToken: number;
    reloadToken: number;
    promise: Promise<void>;
  } | null>(null);
  const reloadTokenCounter = useRef(0);
  const realtimeInvalidationGeneration = useRef(0);
  const reconciledRealtimeGeneration = useRef(0);
  /** Counts fully reconciled canonical reads, so a caller can tell success. */
  const reconciledReadCount = useRef(0);
  /**
   * A 403/404 deferred because a newer mutation started; access must be
   * rechecked once that mutation ends unless a newer canonical read already
   * proved it.
   */
  const accessRecheckPending = useRef(false);
  const mutationEpoch = useRef(0);
  const mutationOwner = useRef<{ sessionToken: number; operationToken: number } | null>(null);
  const mutationOperationToken = useRef(0);
  const MAX_REALTIME_DRAIN_ROUNDS = 4;

  function isOperationCurrent(sessionToken: number, operationJobId: string) {
    return sessionLifetime.current.active
      && sessionLifetime.current.jobId === operationJobId
      && sessionLifetime.current.token === sessionToken
      && jobId === operationJobId;
  }

  /**
   * The notice is read by async continuations (not only by render), so the ref
   * mirrors the state synchronously; `markReconciledThrough` uses it to turn a
   * temporary committed notice into its ordinary success receipt.
   */
  function updateCommittedStale(next: CommittedStaleNoticeState | null) {
    committedStaleRef.current = next;
    setCommittedStale(next);
  }

  function hasPendingRealtimeInvalidation() {
    return realtimeInvalidationGeneration.current > reconciledRealtimeGeneration.current;
  }

  function markReconciledThrough(generationSnapshot: number) {
    if (generationSnapshot > reconciledRealtimeGeneration.current) {
      reconciledRealtimeGeneration.current = generationSnapshot;
    }
    if (realtimeInvalidationGeneration.current <= reconciledRealtimeGeneration.current) {
      reconciledReadCount.current += 1;
      accessRecheckPending.current = false;
      setRealtimeStale(false);
      // A notice raised while a drain was incomplete is temporary: the next
      // real reconcile turns the stored receipt back into its normal success
      // message. An "unknown" outcome is not a success and is only cleared.
      const settledNotice = committedStaleRef.current;
      if (settledNotice?.kind === 'committed') {
        setMessage(settledNotice.message);
        setMessageIsError(false);
      }
      updateCommittedStale(null);
      setSaleOriginPending(false);
    }
  }

  function startMutationOperation() {
    if (saleCorrectionLockedRef.current) return null;
    const sessionToken = sessionLifetime.current.token;
    if (!sessionLifetime.current.active) return null;
    if (mutationOwner.current?.sessionToken === sessionToken) return null;
    const owner = { sessionToken, operationToken: ++mutationOperationToken.current };
    mutationOwner.current = owner;
    mutationInFlight.current = true;
    // A previous access loss belongs to its own operation; a later realtime
    // read may have restored access, so every new mutation starts clean.
    accessLostRef.current = false;
    return owner;
  }

  function endMutationOperation(owner: { sessionToken: number; operationToken: number } | null) {
    if (owner && mutationOwner.current?.sessionToken === owner.sessionToken
      && mutationOwner.current?.operationToken === owner.operationToken) {
      mutationOwner.current = null;
      mutationInFlight.current = false;
      setPending(false);
      setPendingCommand(null);
      setStartPendingPhase(null);
      setSubmitPendingPhase(null);
      if (accessRecheckPending.current) {
        // The deferred access answer was never superseded by a newer canonical
        // read: recheck it through the existing serialized drain.
        accessRecheckPending.current = false;
        realtimeReloadRequested.current = true;
        void requestRealtimeDrain();
      }
    }
  }

  useEffect(() => {
    realtimeInvalidationGeneration.current = 0;
    reconciledRealtimeGeneration.current = 0;
    realtimeDrainRequested.current = false;
    realtimeReloadRequested.current = false;
    realtimeReloadOwner.current = null;
    realtimeDrain.current = null;
    mutationEpoch.current = 0;
    mutationOwner.current = null;
    mutationInFlight.current = false;
    committedReceiptPendingRef.current = false;
    accessLostRef.current = false;
    lifecycleAttempt.current = null;
    withdrawEditAttempt.current = null;
    setUncertain(false);
    saleCorrectionLockedRef.current = false;
    setSaleCorrectionLocked(false);
    startCapture.current = null;
    submitCapture.current = null;
    dialogTriggerRef.current = null;
    dialogFocusRestoreEnabledRef.current = true;
    setRealtimeStale(false);
    updateCommittedStale(null);
    setSaleOriginPending(false);
    setRealtimeReloadPending(false);
    setEditing(false);
    setPending(false);
    setPendingCommand(null);
    setMessage('');
    setMessageIsError(false);
    setMeetingSubmissionError(null);
    setInvalidationMutation({ kind: 'idle' });
    setDialog(null);
    followUpLoadTokenRef.current += 1;
    setFollowUp(null);
    setFollowUpLoading(false);
    setFollowUpLoadError(null);
    setStartPendingPhase(null);
    setSubmitPendingPhase(null);
    setChangeRequestSignal(0);
    setScheduleShiftSignal(0);
    setPastStartAck(null);
    setPastStartAckPending(false);
    setPastStartAckError('');
  }, [jobId]);

  useEffect(() => {
    let active = true; setState({ kind: 'loading' });
    loadJobDetail(jobId)
      .then((detail) => {
        if (!active) return;
        setState({ kind: 'ready', detail });
        // Entity-view notification reconciliation is a secondary consistency
        // side effect: it must never fail the successfully loaded job view.
        markNotificationsReadByEntity('job-card', jobId).catch(() => {});
      })
      .catch((error) => {
        if (active) {
          setState({
            kind: 'error',
            message: error instanceof ApiError ? error.message : 'İş yüklenemedi.',
            retryable: error instanceof ApiError ? error.retryable : true,
          });
        }
      });
    return () => { active = false; };
  }, [jobId, reloadKey]);

  useEffect(() => {
    if (feedbackFocusRequest > 0) feedbackRef.current?.focus();
  }, [feedbackFocusRequest]);

  // UI-FEEDBACK/A: a past-start acknowledgement retry that commits but fails
  // its canonical re-read must return drawer focus to the stale notice, not to
  // the old save control. Refs attach before layout effects, and the drawer
  // reads this ref when it restores focus after unmount.
  useLayoutEffect(() => {
    if (pastStartAck !== null || !committedStale) return;
    if (feedbackRef.current) pastStartAckReturnFocusRef.current = feedbackRef.current;
  }, [committedStale, pastStartAck]);

  function resetFollowUpState() {
    followUpLoadTokenRef.current += 1;
    setFollowUp(null);
    setFollowUpLoading(false);
    setFollowUpLoadError(null);
  }
  function closeDialog() {
    // Focus restoration is owned by ConfirmationAction / ReasonDialog.
    dialogFocusRestoreEnabledRef.current = true;
    setDialog(null);
    resetFollowUpState();
    setCancelContinuity(null);
    setAssignmentReason(null);
    setRevisionCorrection(null);
  }
  async function refreshTruth(): Promise<boolean> {
    const operationJobId = jobId;
    const operationSession = sessionLifetime.current.token;
    const generationAtStart = realtimeInvalidationGeneration.current;
    const epochAtStart = mutationEpoch.current;
    const detail = await loadJobDetail(operationJobId);
    if (!isOperationCurrent(operationSession, operationJobId)) return false;
    if (mutationEpoch.current !== epochAtStart) {
      realtimeDrainRequested.current = true;
      return true;
    }
    setState({ kind: 'ready', detail });
    setTimelineKey((value) => value + 1);
    setLifecycleNoteKey((value) => value + 1);
    markReconciledThrough(generationAtStart);
    return true;
  }

  /**
   * UI-FEEDBACK/A: keep the committed receipt separate from its canonical
   * re-read. `refreshTruth` stays the single serialized reconciliation path;
   * this wrapper only classifies its outcome. A 403/404 after a committed
   * mutation means access to the current record was lost: the screen becomes
   * the terminal error state, never a mutation failure and never the stale
   * record. Any other read failure is not a mutation failure: the notice offers
   * the existing serialized reload instead of starting a second read pipeline
   * or retrying the mutation.
   */
  async function refreshAfterCommit(
    successMessage: string,
  ): Promise<'fresh' | 'stale' | 'inactive' | 'access-lost'> {
    const operationJobId = jobId;
    const operationSession = sessionLifetime.current.token;
    accessLostRef.current = false;
    try {
      return (await refreshTruth()) ? 'fresh' : 'inactive';
    } catch (caught) {
      if (!isOperationCurrent(operationSession, operationJobId)) return 'inactive';
      if (caught instanceof ApiError && (caught.status === 403 || caught.status === 404)) {
        accessLostRef.current = true;
        setState({
          kind: 'error',
          message: 'İşlem kaydedildi. İşin güncel kaydına artık erişilemiyor.',
          retryable: false,
        });
        updateCommittedStale(null);
        setMessage('');
        setMessageIsError(false);
        return 'access-lost';
      }
      updateCommittedStale({ kind: 'committed', message: successMessage });
      setMessage('');
      return 'stale';
    }
  }

  /**
   * UI-FEEDBACK/A P2-a: a successful canonical read does not by itself settle
   * queued realtime invalidations. `requestRealtimeDrain` reports whether this
   * continuation is still current, not whether its chain reconciled; a failed
   * chain leaves the invalidation pending and sets the realtime-stale state. The
   * committed receipt must not disappear in that case, so this wrapper moves it
   * to the committed-stale notice. The drain itself is unchanged.
   */
  async function drainAfterCommit(
    successMessage: string,
  ): Promise<'settled' | 'stale' | 'inactive' | 'access-lost'> {
    // A 403/404 while this known receipt is being reconciled is reported with
    // the committed wording, never as a generic read failure.
    committedReceiptPendingRef.current = true;
    accessLostRef.current = false;
    // Only invalidations known when this drain started decide the outcome; one
    // arriving after a successful drain is ordinary realtime work, not a failed
    // reconcile of this receipt.
    const generationAtStart = realtimeInvalidationGeneration.current;
    try {
      const settled = await requestRealtimeDrain();
      if (accessLostRef.current) return 'access-lost';
      if (!settled) return 'inactive';
      if (reconciledRealtimeGeneration.current < generationAtStart) {
        updateCommittedStale({ kind: 'committed', message: successMessage });
        setMessage('');
        return 'stale';
      }
      return 'settled';
    } finally {
      committedReceiptPendingRef.current = false;
    }
  }

  async function reconcileInvalidationAttempt(
    attempt: JobInvalidationAttempt,
    waitingMessage: string,
    allowSameVersionRetry = true,
  ) {
    setInvalidationMutation({
      kind: 'reconciling', attempt, message: waitingMessage, checking: true,
    });
    const operationJobId = jobId;
    const operationSession = sessionLifetime.current.token;
    const generationAtStart = realtimeInvalidationGeneration.current;
    try {
      const detail = await loadJobDetail(operationJobId);
      if (!isOperationCurrent(operationSession, operationJobId)) return;
      setState({ kind: 'ready', detail });
      setTimelineKey((value) => value + 1);
      setLifecycleNoteKey((value) => value + 1);
      markReconciledThrough(generationAtStart);
      onChanged();
      if (detail.job.status === 'INVALIDATED') {
        setInvalidationMutation({ kind: 'idle' });
        setMessage('Kayıt zaten geçersiz durumda.');
        setMessageIsError(false);
        setFeedbackFocusRequest((value) => value + 1);
        return;
      }
      if (allowSameVersionRetry
        && detail.job.status === attempt.sourceStatus
        && detail.job.version === attempt.expectedVersion) {
        setInvalidationMutation({
          kind: 'retry-ready',
          attempt,
          message: 'Kayıt aynı durumda. Sonucu doğrulamak için aynı işlemi yeniden deneyebilirsiniz.',
        });
        return;
      }
      setInvalidationMutation({ kind: 'error', message: 'İş başka bir işlemle güncellendi. En güncel durum gösteriliyor.' });
      setMessage('İş başka bir işlemle güncellendi. En güncel durum gösteriliyor.');
      setMessageIsError(true);
      setFeedbackFocusRequest((value) => value + 1);
    } catch {
      if (!isOperationCurrent(operationSession, operationJobId)) return;
      setInvalidationMutation({
        kind: 'reconciling',
        attempt,
        message: 'Güncel iş durumu alınamadı. Önce durumu yeniden kontrol edin.',
        checking: false,
      });
      setMessage('İşlem sonucu doğrulanamadı.');
      setMessageIsError(true);
      setFeedbackFocusRequest((value) => value + 1);
    }
  }

  async function recheckInvalidation() {
    const current = invalidationMutation;
    if (current.kind !== 'reconciling' && current.kind !== 'retry-ready') return;
    if (current.kind === 'reconciling' && current.checking) return;
    await reconcileInvalidationAttempt(current.attempt, 'Durum yeniden kontrol ediliyor…');
  }

  async function submitInvalidation(attempt: JobInvalidationAttempt) {
    if (state.kind !== 'ready'
      || state.detail.job.status === 'INVALIDATED'
      || user.role !== 'ADMIN'
      || mutationOwner.current?.sessionToken === sessionLifetime.current.token) return;
    const owner = startMutationOperation();
    if (!owner) return;
    const operationJobId = jobId;
    mutationEpoch.current += 1;
    setInvalidationMutation({ kind: 'submitting', attempt });
    setPending(true);
    setMessage('');
    setMessageIsError(false);
    try {
      const input: JobCardInvalidationInput = {
        clientActionId: attempt.clientActionId,
        expectedVersion: attempt.expectedVersion,
        reasonCode: attempt.reasonCode,
        note: attempt.note,
      };
      const updated = await invalidateJobCard(operationJobId, input, attempt.sourceStatus);
      if (!isOperationCurrent(owner.sessionToken, operationJobId)) return;
      const updatedDetail: LoadedJobDetail = state.detail.kind === 'SALES_MEETING'
        ? {
            ...state.detail,
            job: updated as JobCard & { type: 'SALES_MEETING' },
            meetingDetails: state.detail.meetingDetails === null
              ? null
              : { ...state.detail.meetingDetails, jobCardVersion: updated.version },
          }
        : { ...state.detail, job: updated } as LoadedJobDetail;
      setState({ kind: 'ready', detail: updatedDetail });
      setInvalidationMutation({ kind: 'idle' });
      setTimelineKey((value) => value + 1);
      setLifecycleNoteKey((value) => value + 1);
      setMessage('İş kaydı geçersiz kılındı.');
      setMessageIsError(false);
      setFeedbackFocusRequest((value) => value + 1);
      onChanged();
      if (hasPendingRealtimeInvalidation()) {
        if (!(await requestRealtimeDrain())) return;
      }
    } catch (caught) {
      if (!isOperationCurrent(owner.sessionToken, operationJobId)) return;
      const error = caught instanceof ApiError ? caught : null;
      const ambiguous = error !== null && (
        error.code === 'ACTION_IN_PROGRESS'
        || error.code === 'NETWORK_ERROR'
        || error.code === 'INVALID_RESPONSE'
        || error.retryable
      );
      if (ambiguous) {
        setInvalidationMutation({
          kind: 'reconciling',
          attempt,
          message: error.code === 'ACTION_IN_PROGRESS'
            ? 'İşlem sonucu henüz kesinleşmedi. Önce kaydın durumunu kontrol edin.'
            : 'İşlem sonucu doğrulanamadı. Önce kaydın durumunu kontrol edin.',
          checking: false,
        });
        setMessage('İşlem sonucu doğrulanamadı.');
        setMessageIsError(true);
        setFeedbackFocusRequest((value) => value + 1);
      } else if (error?.code === 'VERSION_CONFLICT' || error?.code === 'JOB_ALREADY_INVALIDATED') {
        await reconcileInvalidationAttempt(
          attempt,
          error.code === 'JOB_ALREADY_INVALIDATED'
            ? 'Kayıt zaten geçersiz olabilir. Güncel durum kontrol ediliyor…'
            : 'İş güncellendi. Güncel durum kontrol ediliyor…',
        );
      } else if (error?.code === 'CLIENT_ACTION_REUSED') {
        await reconcileInvalidationAttempt(
          attempt,
          'İşlem kimliği daha önce kullanılmış. Güncel durum kontrol ediliyor…',
          false,
        );
      } else {
        setInvalidationMutation({
          kind: 'error',
          message: error?.message ?? 'İş kaydı geçersiz kılınamadı. Lütfen tekrar deneyin.',
        });
        setMessageIsError(true);
        setFeedbackFocusRequest((value) => value + 1);
      }
    } finally {
      endMutationOperation(owner);
    }
  }

  async function reconcileRealtimeTruth() {
    if (editing) {
      setRealtimeStale(true);
      return;
    }
    if (pending || mutationOwner.current?.sessionToken === sessionLifetime.current.token) {
      return;
    }
    await requestRealtimeDrain();
  }
  async function runRealtimeDrainChain(sessionToken: number): Promise<boolean> {
    const operationJobId = jobId;
    let roundEpochAtStart = mutationEpoch.current;
    try {
      for (let round = 0; round < MAX_REALTIME_DRAIN_ROUNDS; round += 1) {
        const generationAtStart = realtimeInvalidationGeneration.current;
        const epochAtStart = mutationEpoch.current;
        roundEpochAtStart = epochAtStart;
        const detail = await loadJobDetail(operationJobId);
        if (!isOperationCurrent(sessionToken, operationJobId)) return true;
        if (mutationEpoch.current !== epochAtStart) {
          realtimeDrainRequested.current = true;
          return true;
        }
        setState({ kind: 'ready', detail });
        if (realtimeInvalidationGeneration.current === generationAtStart) {
          markReconciledThrough(generationAtStart);
          return true;
        }
      }
      if (isOperationCurrent(sessionToken, operationJobId)) {
        setRealtimeStale(true);
      }
      return false;
    } catch (error) {
      // Same guard as the success branch: a read that started before a later
      // mutation must not decide the screen, not even with a 403/404.
      if (isOperationCurrent(sessionToken, operationJobId)
        && mutationEpoch.current !== roundEpochAtStart) {
        realtimeDrainRequested.current = true;
        if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
          accessRecheckPending.current = true;
        }
        return true;
      }
      if (isOperationCurrent(sessionToken, operationJobId)) {
        if (state.kind === 'ready' && error instanceof ApiError
          && (error.status === 403 || error.status === 404)) {
          accessLostRef.current = true;
          setState({
            kind: 'error',
            message: committedReceiptPendingRef.current
              || committedStaleRef.current?.kind === 'committed'
              ? 'İşlem kaydedildi. İşin güncel kaydına artık erişilemiyor.'
              : error.message,
            retryable: false,
          });
          setRealtimeStale(false);
          updateCommittedStale(null);
        } else setRealtimeStale(true);
      }
      // A failed read cannot settle queued invalidations. Stop this drain;
      // a new signal or explicit retry may reconcile it without a hot loop.
      return false;
    }
  }
  async function requestRealtimeDrain(): Promise<boolean> {
    const operationJobId = jobId;
    const sessionToken = sessionLifetime.current.token;
    for (;;) {
      if (!isOperationCurrent(sessionToken, operationJobId)) return false;
      const active = realtimeDrain.current;
      if (active && active.sessionToken === sessionToken) {
        realtimeDrainRequested.current = true;
        const settled = await active.promise;
        realtimeDrainRequested.current = false;
        if (!isOperationCurrent(sessionToken, operationJobId)) return false;
        if (!settled) return true;
        realtimeReloadRequested.current = false;
        if (!hasPendingRealtimeInvalidation()) return true;
        continue;
      }
      if (!realtimeReloadRequested.current && !hasPendingRealtimeInvalidation()) return true;
      realtimeReloadRequested.current = false;
      realtimeDrainRequested.current = false;
      const drainToken = ++drainTokenCounter.current;
      const chain = runRealtimeDrainChain(sessionToken);
      realtimeDrain.current = { sessionToken, drainToken, promise: chain };
      let settled = true;
      try {
        settled = await chain;
      } finally {
        if (realtimeDrain.current?.sessionToken === sessionToken
          && realtimeDrain.current?.drainToken === drainToken) {
          realtimeDrain.current = null;
        }
      }
      if (!isOperationCurrent(sessionToken, operationJobId)) return false;
      if (!settled) return true;
      if (!realtimeDrainRequested.current) return true;
      realtimeDrainRequested.current = false;
    }
  }
  /**
   * UI-FEEDBACK/B: a new manager decision retires the previous page receipt
   * before its own request starts. A repeated success with identical wording
   * must be a new live-region update, not a silent text mutation.
   */
  function clearChildReceipt() {
    setMessage('');
    setMessageIsError(false);
  }

  /**
   * UI-FEEDBACK/B: a manager decision made inside a child section owns the same
   * committed-receipt boundary as an in-page command. The receipt is announced
   * once by the page so it survives the child section unmounting; a failed or
   * inaccessible canonical read keeps the existing committed-stale / terminal
   * access-lost states instead of surfacing a false mutation failure. The
   * helper never throws for a read failure, so a committed child mutation is
   * never re-sent by a caller that caught one.
   */
  async function settleChildCommit(receipt: string) {
    // A child decision is a mutation too: invalidate reads that started before
    // the server accepted it, exactly like the in-page handlers do before their
    // request. An older realtime/refresh read must never overwrite the receipt
    // with pre-decision truth when it completes last.
    mutationEpoch.current += 1;
    let read = await refreshAfterCommit(receipt);
    if (read === 'access-lost' || read === 'inactive') return;
    if (read === 'fresh') {
      const drain = await drainAfterCommit(receipt);
      if (drain === 'access-lost' || drain === 'inactive') return;
      if (drain === 'stale') read = 'stale';
    }
    if (read === 'fresh') {
      setMessage(receipt);
      setMessageIsError(false);
      setTimelineKey((value) => value + 1);
    }
    // A fresh receipt or a committed-stale notice must own focus; the child
    // section (and its local status line) may be gone by then.
    setFeedbackFocusRequest((value) => value + 1);
  }

  async function reloadStaleTruth() {
    const operationJobId = jobId;
    const sessionToken = sessionLifetime.current.token;
    if (pending) return;
    const activeReload = realtimeReloadOwner.current;
    if (activeReload && activeReload.sessionToken === sessionToken) {
      await activeReload.promise;
      return;
    }
    setRealtimeReloadPending(true);
    realtimeReloadRequested.current = true;
    const reloadToken = ++reloadTokenCounter.current;
    const operation = (async () => {
      try {
        await requestRealtimeDrain();
      } finally {
        realtimeReloadRequested.current = false;
      }
    })();
    realtimeReloadOwner.current = { sessionToken, reloadToken, promise: operation };
    try {
      await operation;
    } finally {
      if (realtimeReloadOwner.current?.sessionToken === sessionToken
        && realtimeReloadOwner.current?.reloadToken === reloadToken) {
        realtimeReloadOwner.current = null;
      }
      if (isOperationCurrent(sessionToken, operationJobId)) {
        setRealtimeReloadPending(false);
      }
    }
  }
  /**
   * UI-FEEDBACK/B: the committed-stale safety reload is also a fresh canonical
   * read, so the activity timeline must refetch even when realtime is offline
   * and nothing else bumps `timelineKey`.
   */
  /** Serialized reload for children; resolves true only after a reconciled read. */
  async function reloadCommittedTruth(): Promise<boolean> {
    const before = reconciledReadCount.current;
    await reloadStaleTruth();
    setTimelineKey((value) => value + 1);
    return reconciledReadCount.current > before;
  }
  useRealtimeInvalidation([`job-detail:${jobId}`,
    ...(state.kind === 'ready' && state.detail.kind === 'SALE' ? ['sale-origin-context:' + user.id] : []),
  ], () => {
    realtimeInvalidationGeneration.current += 1;
    if (state.kind === 'ready' && state.detail.kind === 'SALE') setSaleOriginPending(true);
    void reconcileRealtimeTruth();
  });
  useRealtimeInvalidation([`job-notes:${jobId}`], () => {
    setNotesRealtimeKey((value) => value + 1);
  });
  function presentationFor(detail: LoadedJobDetail): JobWorkflowPresentation {
    return deriveJobWorkflowPresentation({
      job: detail.job,
      user,
      workflowContext: detail.job.workflowContext,
      deliveryItems: detail.kind === 'PRODUCT_DELIVERY' ? detail.deliveryItems : [],
      meetingDetails: detail.kind === 'SALES_MEETING' ? detail.meetingDetails : null,
    });
  }
  /**
   * SALE-002 §4.2: the linked sale only coordinates while it is active and
   * shares the visit's assignee. Anything else omits `expectedSaleVersion`.
   */
  function coordinatedPairSale() {
    return pairState.kind === 'ready' && pairState.coordinated ? pairState.sale : null;
  }
  /** Sale card only: the readable source visit, for pair guidance targets. */
  function saleSourceVisitId(): string | null {
    if (state.kind !== 'ready' || state.detail.kind !== 'SALE') return null;
    const source = state.detail.saleDetails.sourceVisit;
    return source.kind === 'SALE_FROM_VISIT' && source.access === 'FULL' ? source.id : null;
  }
  /** Visit card only: the discovered linked sale, for conflict targets. */
  function salePairId(): string | null {
    return pairState.kind === 'ready' ? pairState.sale.id : null;
  }
  /**
   * UI-FEEDBACK/A: a committed lifecycle command whose canonical read was
   * answered with 403/404 is finished. The record is inaccessible, so the
   * frozen attempt, its captures and any open dialog must not survive to be
   * replayed by a later realtime read.
   */
  function settleAccessLostLifecycleAttempt(command: LifecycleCommand) {
    lifecycleAttempt.current = null;
    setUncertain(false);
    if (command === 'START') startCapture.current = null;
    if (command === 'SUBMIT_FOR_APPROVAL') submitCapture.current = null;
    setDialog(null);
    resetFollowUpState();
    setCancelContinuity(null);
    setAssignmentReason(null);
    setRevisionCorrection(null);
  }
  async function execute(
    command: LifecycleCommand,
    reason = '',
    extra?: {
      followUpProposal?: FollowUpProposalInput;
      followUp?: ApproveFollowUpInput;
      delivery?: ApproveDeliveryInput;
      followUpContinuity?: FollowUpCancelContinuity;
      assignmentReason?: { code: AssignmentReasonCode; text: string; proposedScheduledAt?: string };
      correctionDueAt?: string;
    },
  ) {
    if (state.kind !== 'ready' || mutationOwner.current?.sessionToken === sessionLifetime.current.token) return;
    if (withdrawEditAttempt.current || (lifecycleAttempt.current && lifecycleAttempt.current.command !== command)) return;
    const owner = startMutationOperation();
    if (!owner) return;
    const operationJobId = jobId;
    mutationEpoch.current += 1;
    setPending(true); setPendingCommand(command); setMessage(''); setMessageIsError(false); setMeetingSubmissionError(null);
    updateCommittedStale(null);
    setPairGuidance(null);
    const retained = lifecycleAttempt.current;
    const input = retained?.input ?? { clientActionId: crypto.randomUUID(), expectedVersion: state.detail.job.version };
    const presentation = presentationFor(state.detail);
    try {
      let commandInput: StartJobCardInput & {
        followUpProposal?: FollowUpProposalInput;
        followUp?: ApproveFollowUpInput;
        delivery?: ApproveDeliveryInput;
        followUpContinuity?: FollowUpCancelContinuity;
        assignmentReason?: { code: AssignmentReasonCode; text: string; proposedScheduledAt?: string };
        correctionDueAt?: string;
        expectedSaleVersion?: number;
      } = input;
      if (!retained && command === 'START' && state.detail.job.workflowContext.startLocationCaptureEnabled) {
        if (startCapture.current?.clientActionId !== input.clientActionId) {
          setStartPendingPhase('capturing');
          const capture = await captureActionLocation();
          if (!isOperationCurrent(owner.sessionToken, operationJobId)) return;
          startCapture.current = { clientActionId: input.clientActionId, capture };
        }
        if (!isOperationCurrent(owner.sessionToken, operationJobId)) return;
        setStartPendingPhase('submitting');
        commandInput = { ...input, locationCapture: startCapture.current.capture };
      }
      // Slice 1: SUBMIT snapshot is advisory; an unavailable capture still
      // submits. The capture is bound to the attempt so uncertain retry
      // never recaptures and never rotates the clientActionId.
      if (!retained && command === 'SUBMIT_FOR_APPROVAL' && state.detail.job.workflowContext.submitLocationCaptureEnabled) {
        if (submitCapture.current?.clientActionId !== input.clientActionId) {
          setSubmitPendingPhase('capturing');
          const capture = await captureActionLocation();
          if (!isOperationCurrent(owner.sessionToken, operationJobId)) return;
          submitCapture.current = { clientActionId: input.clientActionId, capture };
        }
        if (!isOperationCurrent(owner.sessionToken, operationJobId)) return;
        setSubmitPendingPhase('submitting');
        commandInput = { ...input, locationCapture: submitCapture.current.capture };
      }
      if (!retained) {
        if (extra?.followUpProposal) commandInput = { ...commandInput, followUpProposal: extra.followUpProposal };
        if (extra?.followUp) commandInput = { ...commandInput, followUp: extra.followUp };
        // §5.4: the delivery is frozen with the attempt (body, key and all), so
        // an uncertain retry replays it byte-identically.
        if (extra?.delivery) commandInput = { ...commandInput, delivery: extra.delivery };
        if (extra?.followUpContinuity) {
          commandInput = { ...commandInput, followUpContinuity: extra.followUpContinuity };
        }
        if (extra?.assignmentReason) {
          commandInput = { ...commandInput, assignmentReason: extra.assignmentReason };
        }
        if (extra?.correctionDueAt !== undefined) {
          commandInput = { ...commandInput, correctionDueAt: extra.correctionDueAt };
        }
        // SALE-002 §4.5: the sale version is frozen into the attempt, so an
        // uncertain retry replays the identical body and the server hashes the
        // same pair identity.
        const expectedSaleVersion = coordinatedSaleVersion({
          command,
          visitStatus: state.detail.job.status,
          visitAssignedTo: state.detail.job.assignedTo,
          sale: coordinatedPairSale(),
        });
        if (expectedSaleVersion !== null) {
          commandInput = { ...commandInput, expectedSaleVersion };
        }
        lifecycleAttempt.current = { command, input: structuredClone(commandInput), reason };
      }
      const attempt = lifecycleAttempt.current;
      if (!attempt) return;
      const updated = await executeLifecycleCommand(operationJobId, attempt.command, attempt.input, attempt.reason);
      if (!isOperationCurrent(owner.sessionToken, operationJobId)) return;
      // The receipt text is known before the re-read, so a committed-but-stale
      // notice can name exactly what the server accepted (UI-FEEDBACK/A).
      const transition = findTransition(presentation, command);
      const continuity = attempt.input.followUpContinuity;
      let receiptMessage = transition
        ? transition.successMessage
          + pairSuccessSuffix(command, updated.linkedSaleJobCardId ?? null)
          + (updated.deliveryJobCardId ? ' Teslim işi oluşturuldu.' : '')
        : '';
      if (command === 'CANCEL' && continuity?.decision === 'RESCHEDULE') {
        receiptMessage = `İş iptal edildi. Yeni takip ziyareti ${new Intl.DateTimeFormat('tr-TR', {
          dateStyle: 'medium', timeStyle: 'short',
        }).format(new Date(continuity.scheduledAt))} için planlandı.`;
      } else if (command === 'CANCEL' && continuity?.decision === 'END_CYCLE') {
        receiptMessage = 'İş iptal edildi ve takip döngüsü sonlandırıldı.';
      }
      // #347: location is advisory at both checkpoints. Precedence is
      // deterministic: the lifecycle already succeeded, an unavailable local
      // snapshot yields enablement guidance, a captured SUBMIT keeps the
      // Slice-2 DIFFERENT distance advisory, everything else stays ordinary.
      // The advisory remains additional information; the stale heading keeps
      // the receipt sentence so a committed submit is never reported as only a
      // location warning.
      let advisoryMessage = '';
      const localCapture = attempt.input.locationCapture;
      if (command === 'START' && localCapture?.outcome === 'unavailable') {
        advisoryMessage = startLocationUnavailableAdvisory({
          reason: localCapture.reason,
          device: classifyDevice(readDeviceSignals()),
        });
      } else if (command === 'SUBMIT_FOR_APPROVAL' && localCapture?.outcome === 'unavailable') {
        advisoryMessage = submitLocationUnavailableGuidance({
          reason: localCapture.reason,
          device: classifyDevice(readDeviceSignals()),
        });
      } else if (command === 'SUBMIT_FOR_APPROVAL'
        && updated.submitLocationComparison?.outcome === 'DIFFERENT') {
        advisoryMessage = submitComparisonWarning(updated.submitLocationComparison.distanceMeters);
      }
      const committedMessage = advisoryMessage
        ? `${receiptMessage} ${advisoryMessage}`.trim()
        : receiptMessage;
      let read: 'fresh' | 'stale' | 'inactive' | 'access-lost' = 'fresh';
      if (retained || (state.detail.kind === 'SALES_MEETING' && command === 'START')) {
        read = await refreshAfterCommit(committedMessage);
        if (read === 'access-lost') {
          settleAccessLostLifecycleAttempt(command);
          return;
        }
        if (read === 'inactive') return;
        if (read === 'fresh') {
          const drain = await drainAfterCommit(committedMessage);
          if (drain === 'access-lost') {
            settleAccessLostLifecycleAttempt(command);
            return;
          }
          if (drain === 'inactive') return;
          if (drain === 'stale') read = 'stale';
        }
      } else {
        setState({
          kind: 'ready',
          detail: state.detail.kind === 'SALES_MEETING'
            ? {
              ...state.detail,
              job: updated as JobCard & { type: 'SALES_MEETING' },
              meetingDetails: state.detail.meetingDetails === null
                ? null
                : { ...state.detail.meetingDetails, jobCardVersion: updated.version },
            }
            : { ...state.detail, job: updated } as LoadedJobDetail,
        });
        if (hasPendingRealtimeInvalidation()) {
          // The response already proved the commit; only a 403/404 during this
          // drain needs the committed wording and the attempt cleanup.
          committedReceiptPendingRef.current = true;
          // Only an access loss seen by this drain counts; an older realtime
          // read that failed while the command was in flight does not.
          accessLostRef.current = false;
          let settled: boolean;
          try {
            settled = await requestRealtimeDrain();
          } finally {
            committedReceiptPendingRef.current = false;
          }
          if (accessLostRef.current) {
            settleAccessLostLifecycleAttempt(command);
            return;
          }
          if (!settled) return;
        }
      }
      if (!isOperationCurrent(owner.sessionToken, operationJobId)) return;
      lifecycleAttempt.current = null;
      setUncertain(false);
      if (command === 'START') startCapture.current = null;
      if (command === 'SUBMIT_FOR_APPROVAL') submitCapture.current = null;
      setTimelineKey((value) => value + 1);
      setLifecycleNoteKey((value) => value + 1);
      const completedDialogCommand = dialog !== null;
      if (completedDialogCommand) {
        // A committed-but-stale receipt owns focus; the old trigger must not
        // steal it back after the dialog unmounts.
        if (read === 'stale') dialogFocusRestoreEnabledRef.current = false;
        setDialog(null);
        resetFollowUpState();
        setCancelContinuity(null);
        setAssignmentReason(null);
        setRevisionCorrection(null);
      }
      if (read === 'fresh') setMessage(advisoryMessage || receiptMessage);
      if (completedDialogCommand) setFeedbackFocusRequest((value) => value + 1);
      onChanged();
    } catch (caught) {
      if (!isOperationCurrent(owner.sessionToken, operationJobId)) return;
      if (caught instanceof ApiError && (caught.code === 'VERSION_CONFLICT' || caught.code === 'INVALID_TRANSITION')) {
        lifecycleAttempt.current = null;
        setUncertain(false);
        if (command === 'START') startCapture.current = null;
      if (command === 'SUBMIT_FOR_APPROVAL') submitCapture.current = null;
        try {
          if (!(await refreshTruth())) return;
          if (!(await requestRealtimeDrain())) return;
          setMessage('İş başka bir işlemle güncellendi. En güncel durum gösteriliyor.');
        } catch {
          if (!isOperationCurrent(owner.sessionToken, operationJobId)) return;
          setRealtimeStale(true);
          setMessage('Güncel iş bilgileri alınamadı. Lütfen tekrar deneyin.');
          setMessageIsError(true);
        }
        if (!isOperationCurrent(owner.sessionToken, operationJobId)) return;
        setDialog(null);
        setRevisionCorrection(null);
        resetFollowUpState();
        setFeedbackFocusRequest((value) => value + 1);
      } else {
        if (isDefinitiveMutationError(caught)) {
          lifecycleAttempt.current = null;
          setUncertain(false);
          if (command === 'START') startCapture.current = null;
      if (command === 'SUBMIT_FOR_APPROVAL') submitCapture.current = null;
        } else {
          setUncertain(lifecycleAttempt.current !== null);
        }
        if (hasPendingRealtimeInvalidation()) {
          setRealtimeStale(true);
        }
        const pairRedirect = salePairRedirectFrom(caught);
        const pairConflict = pairRedirect === null ? salePairStateConflictFrom(caught) : null;
        const guidance = pairRedirect !== null
          ? pairRedirectGuidance(pairRedirect, saleSourceVisitId())
          : pairConflict !== null
            ? pairConflictGuidance(pairConflict, salePairId(), jobId)
            : null;
        if (guidance !== null) {
          // SALE-002 §4.2/§4.5: a coded redirect or a pair that no longer
          // coordinates is a definitive answer. Close the now-impossible dialog,
          // name the exact next action, and re-read both sides.
          lifecycleAttempt.current = null;
          setUncertain(false);
          if (command === 'SUBMIT_FOR_APPROVAL') submitCapture.current = null;
          setDialog(null);
          setRevisionCorrection(null);
          resetFollowUpState();
          setPairGuidance(guidance);
          try {
            if (!(await refreshTruth())) return;
            if (!(await requestRealtimeDrain())) return;
          } catch {
            if (!isOperationCurrent(owner.sessionToken, operationJobId)) return;
            setRealtimeStale(true);
          }
          if (!isOperationCurrent(owner.sessionToken, operationJobId)) return;
          reloadPair();
          setFeedbackFocusRequest((value) => value + 1);
          return;
        }
        if (command === 'APPROVE' && dialog?.kind === 'approve' && saleDelivery?.draft.enabled
          && isDefinitiveMutationError(caught)) {
          // SALE-002 §8.3/§5.4: a definitive answer to the delivery payload. The
          // attempt (and its key) is already reset above, so the corrected
          // approval is a new intent; the controls are re-enabled and focus
          // moves to the first invalid one.
          saleDeliveryFailureSeq.current += 1;
          const mapped = mapSaleDeliveryServerError(caught, saleDeliveryFailureSeq.current);
          if (mapped !== null) {
            setSaleDelivery((current) => current
              ? { draft: { ...current.draft, ...mapped.patch }, errors: mapped.errors }
              : current);
            return;
          }
        }
        if (isAssignmentWindowStaleError(caught)) {
          // JOB-010 release 2b: the offer moved on the server (deadline passed,
          // another answer already landed). Drop the stale dialog/draft and
          // reload the canonical offer instead of leaving dead buttons.
          setDialog(null);
          setAssignmentReason(null);
          try {
            if (!(await refreshTruth())) return;
            if (!(await requestRealtimeDrain())) return;
          } catch {
            if (!isOperationCurrent(owner.sessionToken, operationJobId)) return;
            setRealtimeStale(true);
          }
          if (!isOperationCurrent(owner.sessionToken, operationJobId)) return;
        }
        const dialogErrorCodes = [
          'FOLLOW_UP_PROPOSAL_REQUIRED', 'FOLLOW_UP_PROPOSAL_INVALID',
          'FOLLOW_UP_OVERRIDE_REASON_REQUIRED',
          'FOLLOW_UP_SOURCE_CUSTOMER_REQUIRED', 'ASSIGNEE_NOT_FOUND',
          'CUSTOMER_VISIT_DUPLICATE', 'CALENDAR_CONFLICT',
        ];
        if (caught instanceof ApiError && caught.code === 'VALIDATION_ERROR'
          && dialog?.kind === 'revision' && revisionCorrection) {
          // OVR-5 §3.9: the correction deadline bound/syntax error belongs to
          // the picker, not the page feedback behind the modal. The dialog and
          // the entered reason stay open for correction.
          const message = apiFieldError(caught, 'correctionDueAt', '');
          if (message) {
            setRevisionCorrection((current) => current ? { ...current, fieldError: message } : current);
            return;
          }
        }
        if (caught instanceof ApiError && dialogErrorCodes.includes(caught.code)
          && dialog !== null && (dialog.kind === 'submit' || dialog.kind === 'approve')) {
          // FOLLOW_UP_PROPOSAL_INVALID carries no structured no-slot
          // discriminator, so a POST validation error never auto-opens the
          // explicit-schedule fallback. The server message stays visible and
          // reopening the dialog re-evaluates the suggestion contract.
          setFollowUp((current) => current ? { ...current, inlineError: caught.message } : current);
          return;
        }
        if (caught instanceof ApiError
          && (dialog?.kind === 'decline' || dialog?.kind === 'release')
          && assignmentReason) {
          // JOB-012: the proposed time is answered inside the still-open dialog,
          // not in the page feedback behind the modal.
          const scheduleMessage = caught.code === 'CALENDAR_CONFLICT'
            ? assignmentWindowErrorMessage(caught, 'Önerilen zaman personelin takvimiyle çakışıyor.')
            : caught.code === 'VALIDATION_ERROR'
              ? apiFieldError(caught, 'proposedScheduledAt', '')
              : '';
          if (scheduleMessage) {
            if (isDefinitiveMutationError(caught)) {
              // The corrected time is a new intent with a fresh action id.
              lifecycleAttempt.current = null;
              setUncertain(false);
            }
            setAssignmentReason((current) => current
              ? { ...current, scheduleError: scheduleMessage }
              : current);
            return;
          }
        }
        setMessage(assignmentWindowErrorMessage(caught, 'İşlem tamamlanamadı. Lütfen tekrar deneyin.'));
        setMessageIsError(true);
        if (caught instanceof ApiError && caught.code === 'MEETING_NOT_READY') {
          setMeetingSubmissionError(caught);
          dialogFocusRestoreEnabledRef.current = false;
          setDialog(null);
          resetFollowUpState();
        }
        setFeedbackFocusRequest((value) => value + 1);
      }
    } finally {
      endMutationOperation(owner);
    }
  }
  async function saveMeeting(input: PatchMeetingDetailsInput) {
    if (state.kind !== 'ready' || state.detail.kind !== 'SALES_MEETING'
      || mutationOwner.current?.sessionToken === sessionLifetime.current.token) {
      throw new ApiError(409, 'ACTION_IN_PROGRESS', 'Başka bir işlem devam ediyor.', true);
    }
    const owner = startMutationOperation();
    if (!owner) {
      throw new ApiError(409, 'ACTION_IN_PROGRESS', 'Başka bir işlem devam ediyor.', true);
    }
    const operationJobId = jobId;
    mutationEpoch.current += 1;
    setPending(true); setMessage(''); setMessageIsError(false); setMeetingSubmissionError(null);
    updateCommittedStale(null);
    meetingReceiptOnPageRef.current = false;
    try {
      const meetingDetails = await patchMeetingDetails(operationJobId, input);
      if (!isOperationCurrent(owner.sessionToken, operationJobId)) return meetingDetails;
      let read = await refreshAfterCommit('Görüşme sonucu kaydedildi.');
      if (read === 'access-lost') return meetingDetails;
      if (read === 'inactive') return meetingDetails;
      if (read === 'fresh') {
        const drain = await drainAfterCommit('Görüşme sonucu kaydedildi.');
        if (drain === 'access-lost') return meetingDetails;
        if (drain === 'inactive') return meetingDetails;
        if (drain === 'stale') read = 'stale';
      }
      // The page notice now owns this receipt; the section skips its own note.
      meetingReceiptOnPageRef.current = read === 'stale';
      setTimelineKey((value) => value + 1);
      if (read === 'stale') setFeedbackFocusRequest((value) => value + 1);
      onChanged();
      return meetingDetails;
    } catch (caught) {
      if (!isOperationCurrent(owner.sessionToken, operationJobId)) throw caught;
      if (caught instanceof ApiError && caught.code === 'VERSION_CONFLICT') {
        if (!(await refreshTruth())) throw caught;
        if (!(await requestRealtimeDrain())) throw caught;
        throw new ApiError(409, 'VERSION_CONFLICT', 'İş başka bir işlemle güncellendi. En güncel durum gösteriliyor.');
      }
      if (hasPendingRealtimeInvalidation()) {
        setRealtimeStale(true);
      }
      throw caught;
    } finally { endMutationOperation(owner); }
  }
  function openRecordEditDialog(action: RecordEditPresentation['action'], trigger: HTMLElement) {
    if (state.kind !== 'ready' || committedStale !== null
      || !['SALES_MEETING', 'PRODUCT_DELIVERY', 'GENERAL_TASK'].includes(state.detail.kind)) return;
    if (action === 'EDIT_JOB_FIELDS') {
      setDeadlineExtensionError(null);
      setEditing(true);
      return;
    }
    if (state.detail.kind !== 'SALES_MEETING') return;
    const presentation = presentationFor(state.detail);
    const recordEdit = presentation.recordEditAction;
    if (!recordEdit || recordEdit.action !== 'WITHDRAW_AND_EDIT_JOB_FIELDS') return;
    dialogTriggerRef.current = trigger;
    setDialog({ kind: 'withdraw-edit', presentation: recordEdit });
  }
  async function confirmWithdrawAndEdit() {
    if (state.kind !== 'ready' || state.detail.kind !== 'SALES_MEETING'
      || mutationOwner.current?.sessionToken === sessionLifetime.current.token) return;
    const owner = startMutationOperation();
    if (!owner) return;
    const operationJobId = jobId;
    mutationEpoch.current += 1;
    setPending(true); setMessage(''); setMessageIsError(false);
    if (lifecycleAttempt.current) { endMutationOperation(owner); return; }
    withdrawEditAttempt.current ??= {
      job: structuredClone(state.detail.job),
      clientActionId: crypto.randomUUID(),
      // §4.5: frozen with the attempt so an uncertain retry replays the same pair.
      expectedSaleVersion: coordinatedSaleVersion({
        command: 'WITHDRAW_FROM_APPROVAL',
        visitStatus: state.detail.job.status,
        visitAssignedTo: state.detail.job.assignedTo,
        sale: coordinatedPairSale(),
      }),
    };
    const attempt = withdrawEditAttempt.current;
    try {
      const updated = await prepareMeetingEdit(
        attempt.job,
        attempt.clientActionId,
        withdrawJobCardFromApproval,
        attempt.expectedSaleVersion ?? undefined,
      );
      if (!isOperationCurrent(owner.sessionToken, operationJobId)) return;
      withdrawEditAttempt.current = null;
      setUncertain(false);
      setState({
        kind: 'ready',
        detail: {
          ...state.detail,
          job: updated as JobCard & { type: 'SALES_MEETING' },
          meetingDetails: state.detail.meetingDetails === null
            ? null
            : { ...state.detail.meetingDetails, jobCardVersion: updated.version },
        },
      });
      setTimelineKey((value) => value + 1);
      setDialog(null);
      setEditing(true);
      setMessage(WITHDRAW_EDIT_SUCCESS_MESSAGE);
      setFeedbackFocusRequest((value) => value + 1);
      onChanged();
      if (hasPendingRealtimeInvalidation()) {
        if (!(await requestRealtimeDrain())) return;
      }
    } catch (caught) {
      if (!isOperationCurrent(owner.sessionToken, operationJobId)) return;
      if (caught instanceof ApiError && (caught.code === 'VERSION_CONFLICT'
        || caught.code === 'INVALID_TRANSITION')) {
        withdrawEditAttempt.current = null;
        setUncertain(false);
        try {
          if (!(await refreshTruth())) return;
          if (!(await requestRealtimeDrain())) return;
          setMessage('İş güncellendi. En güncel durum gösteriliyor.');
        } catch {
          if (!isOperationCurrent(owner.sessionToken, operationJobId)) return;
          setRealtimeStale(true); setMessage('Güncel iş bilgileri alınamadı. Lütfen tekrar deneyin.');
        }
        if (!isOperationCurrent(owner.sessionToken, operationJobId)) return;
        setDialog(null);
      } else {
        if (isDefinitiveMutationError(caught)) {
          withdrawEditAttempt.current = null;
          setUncertain(false);
        } else {
          setUncertain(true);
        }
        if (hasPendingRealtimeInvalidation()) {
          setRealtimeStale(true);
        }
        setMessage(caught instanceof ApiError ? caught.message : 'Düzenleme başlatılamadı.');
      }
      setMessageIsError(true); setFeedbackFocusRequest((value) => value + 1);
    } finally { endMutationOperation(owner); }
  }
  /**
   * Opens the JOB-010 release 2b acknowledgement dialog for a management
   * producer (create-like patch or reschedule). The retry replays the same
   * values plus the acknowledgement; focus returns to the opener.
   */
  function openPastStartAcknowledgement(request: {
    title: string;
    description: string;
    run: (acknowledgement: PastStartAcknowledgement) => Promise<{ ok: true } | { ok: false; error: string }>;
    onShiftToFuture?: () => void;
  }) {
    pastStartAckOpenerRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    pastStartAckReturnFocusRef.current = pastStartAckOpenerRef.current;
    setPastStartAckError('');
    setPastStartAck(request);
  }
  async function saveJobPatch(
    input: PatchJobCardInput,
    successMessage: string,
    acknowledgement?: PastStartAcknowledgement,
    /**
     * OVR-5b visual review: `form` means the caller keeps an inline editor open
     * and renders the patch error beside its fields, so the page feedback must
     * neither take focus from that form nor swallow the error.
     */
    errorOwner: 'page' | 'form' = 'page',
  ): Promise<boolean> {
    if (state.kind !== 'ready'
      || mutationOwner.current?.sessionToken === sessionLifetime.current.token) return false;
    const owner = startMutationOperation();
    if (!owner) return false;
    const operationJobId = jobId;
    mutationEpoch.current += 1;
    lastSavePatchErrorRef.current = '';
    setPending(true); setMessage(''); setMessageIsError(false);
    updateCommittedStale(null);
    setDeadlineExtensionError(null);
    try {
      const patched = await patchJobCard(operationJobId, acknowledgement
        ? { ...input, ...pastStartAcknowledgementPayload(acknowledgement) }
        : input);
      if (!isOperationCurrent(owner.sessionToken, operationJobId)) return false;
      let read = await refreshAfterCommit(successMessage);
      if (read === 'access-lost') {
        // A committed but inaccessible record must not keep its old drafts or
        // the acknowledgement retry that could re-send a mutation later.
        setEditing(false);
        setPastStartAck(null);
        setPastStartAckError('');
        return false;
      }
      if (read === 'inactive') return false;
      setEditing(false); setTimelineKey((value) => value + 1);
      if (read === 'fresh') {
        const drain = await drainAfterCommit(successMessage);
        if (drain === 'access-lost') {
          setEditing(false);
          setPastStartAck(null);
          setPastStartAckError('');
          return false;
        }
        if (drain === 'inactive') return false;
        if (drain === 'stale') read = 'stale';
      }
      if (read === 'fresh') setMessage(successMessage);
      else setFeedbackFocusRequest((value) => value + 1);
      onChanged();
      if (
        patched.assignmentTransitionId
        && input.assignedTo !== undefined
        && input.assignedTo !== state.detail.job.assignedTo
      ) {
        void reassignmentSync.offerSync({
          transitionId: patched.assignmentTransitionId,
          oldAssignee: { id: state.detail.job.assignedTo, name: state.detail.job.assignee.name },
          newAssignee: { id: input.assignedTo ?? null, name: patched.assignee.name },
        });
      }
      return true;
    } catch (caught) {
      if (!isOperationCurrent(owner.sessionToken, operationJobId)) return false;
      // A start that already passed may only be assigned or rescheduled with
      // an explicit customer acknowledgement. Nothing was written, so the same
      // values are replayed once the user fills it in.
      if (isPastStartAcknowledgementRequired(caught) && acknowledgement === undefined) {
        openPastStartAcknowledgement({
          title: 'Başlangıç saati geçti',
          description: 'Planlanan başlangıç saati geçti. Değişikliği kaydetmek için müşterinin güncel durumunu onaylayın.',
          run: async (next) => {
            lastSavePatchErrorRef.current = '';
            try {
              const ok = await saveJobPatch(input, successMessage, next, errorOwner);
              return ok
                ? { ok: true }
                : { ok: false, error: lastSavePatchErrorRef.current || 'İş güncellenemedi.' };
            } catch (err) {
              return {
                ok: false,
                error: assignmentWindowErrorMessage(err, 'İş güncellenemedi.'),
              };
            }
          },
        });
        return false;
      }
      let resolvedError: string;
      if (caught instanceof ApiError && caught.code === 'VERSION_CONFLICT') {
        if (!(await refreshTruth())) return false;
        setEditing(false);
        if (!(await requestRealtimeDrain())) return false;
        resolvedError = 'İş başka bir işlemle güncellendi. En güncel durum gösteriliyor.';
        setMessage(resolvedError);
      } else {
        if (hasPendingRealtimeInvalidation()) {
          setRealtimeStale(true);
        }
        if (caught instanceof ApiError && caught.code === 'DEADLINE_EXTENSION_REASON_REQUIRED') {
          // OVR-5 §5.4: the deadline change would end open lateness and needs
          // a reason the form did not offer yet. Keep the entered values and
          // surface the server field error on the reason field.
          setDeadlineExtensionError(deadlineFieldError(caught));
        }
        resolvedError = assignmentWindowErrorMessage(caught, 'İş güncellenemedi.');
        setMessage(resolvedError);
      }
      lastSavePatchErrorRef.current = resolvedError;
      setMessageIsError(true);
      if (errorOwner === 'form'
        && !(caught instanceof ApiError && caught.code === 'VERSION_CONFLICT')) {
        // Only a version conflict closes the editor; for every other failure the
        // open form owns the message and the focus.
        throw new Error(resolvedError);
      }
      setFeedbackFocusRequest((value) => value + 1);
      return false;
    } finally { endMutationOperation(owner); }
  }
  async function saveJob(input: PatchJobCardInput) {
    await saveJobPatch(input, 'Görüşme bilgileri güncellendi.');
  }
  async function saveDeliveryAssignee(assignedTo: string) {
    if (state.kind !== 'ready') return;
    await saveJobPatch(
      { expectedVersion: state.detail.job.version, assignedTo },
      'Sorumlu personel güncellendi.',
    );
  }
  async function saveGeneralTask(input: GeneralTaskEditInput) {
    if (state.kind !== 'ready') return;
    await saveJobPatch(
      { expectedVersion: state.detail.job.version, ...input },
      'Görev bilgileri güncellendi.',
      undefined,
      'form',
    );
  }
  async function saveSchedule(
    scheduledAt: string | null,
    scheduledEndsAt?: string | null,
    overrideReason?: string | null,
    deadlineChange?: DeadlineChangeOptions,
    acknowledgement?: PastStartAcknowledgement,
  ) {
    if (state.kind !== 'ready' || mutationOwner.current?.sessionToken === sessionLifetime.current.token) {
      throw new ApiError(409, 'ACTION_IN_PROGRESS', 'Başka bir işlem devam ediyor.', true);
    }
    const owner = startMutationOperation();
    if (!owner) {
      throw new ApiError(409, 'ACTION_IN_PROGRESS', 'Başka bir işlem devam ediyor.', true);
    }
    const operationJobId = jobId;
    mutationEpoch.current += 1;
    setPending(true); setMessage(''); setMessageIsError(false);
    updateCommittedStale(null);
    setDeadlineExtensionError(null);
    try {
      await patchJobCard(operationJobId, {
        expectedVersion: state.detail.job.version,
        scheduledAt,
        ...(state.detail.job.type === 'SALES_MEETING' || state.detail.job.type === 'PRODUCT_DELIVERY')
          && scheduledEndsAt !== undefined
          ? { scheduledEndsAt }
          : {},
        ...(overrideReason?.trim() ? { overrideReason: overrideReason.trim() } : {}),
        ...(deadlineChange?.deadlineExtensionReason?.trim()
          ? { deadlineExtensionReason: deadlineChange.deadlineExtensionReason.trim() }
          : {}),
        ...(deadlineChange?.changeRequestResolution
          ? { changeRequestResolution: deadlineChange.changeRequestResolution }
          : {}),
        ...pastStartAcknowledgementPayload(acknowledgement),
      });
      if (!isOperationCurrent(owner.sessionToken, operationJobId)) return;
      let read = await refreshAfterCommit('Planlanan zaman güncellendi.');
      if (read === 'access-lost') {
        setPastStartAck(null);
        setPastStartAckError('');
        return;
      }
      if (read === 'inactive') return;
      if (read === 'fresh') {
        const drain = await drainAfterCommit('Planlanan zaman güncellendi.');
        if (drain === 'access-lost') {
          setPastStartAck(null);
          setPastStartAckError('');
          return;
        }
        if (drain === 'inactive') return;
        if (drain === 'stale') read = 'stale';
      }
      setTimelineKey((value) => value + 1);
      if (read === 'fresh') setMessage('Planlanan zaman güncellendi.');
      else setScheduleCommittedSignal((value) => value + 1);
      setFeedbackFocusRequest((value) => value + 1);
      onChanged();
    } catch (caught) {
      if (!isOperationCurrent(owner.sessionToken, operationJobId)) throw caught;
      // JOB-010 release 2b: a past planned start needs the explicit customer
      // acknowledgement before the new schedule may be recorded. Nothing was
      // written, so the retry replays the same values with the field added.
      if (isPastStartAcknowledgementRequired(caught) && acknowledgement === undefined) {
        openPastStartAcknowledgement({
          title: 'Başlangıç saati geçti',
          description: 'Planlanan başlangıç saati geçti. Yeni zamanı kaydetmek için müşterinin güncel durumunu onaylayın.',
          run: async (next) => {
            try {
              await saveSchedule(scheduledAt, scheduledEndsAt, overrideReason, deadlineChange, next);
              return { ok: true };
            } catch (err) {
              return {
                ok: false,
                error: assignmentWindowErrorMessage(err, 'Planlanan zaman kaydedilemedi.'),
              };
            }
          },
          onShiftToFuture: () => {
            setPastStartAck(null);
            setPastStartAckError('');
            setMessage('');
            setMessageIsError(false);
            setScheduleShiftSignal((value) => value + 1);
          },
        });
        throw new ApiError(
          409,
          'PAST_START_ACKNOWLEDGEMENT_REQUIRED',
          'Başlangıç saati geçti. Kaydetmek için müşteri onayı gerekiyor.',
        );
      }
      if (caught instanceof ApiError && caught.code === 'VERSION_CONFLICT') {
        if (!(await refreshTruth())) throw caught;
        if (!(await requestRealtimeDrain())) throw caught;
        setMessage('İş başka bir işlemle güncellendi. En güncel durum gösteriliyor.');
        setMessageIsError(true);
        setFeedbackFocusRequest((value) => value + 1);
        throw new ApiError(409, 'VERSION_CONFLICT', 'İş başka bir işlemle güncellendi. En güncel durum gösteriliyor.');
      }
      if (hasPendingRealtimeInvalidation()) {
        setRealtimeStale(true);
      }
      if (caught instanceof ApiError && caught.code === 'DEADLINE_EXTENSION_REASON_REQUIRED') {
        setDeadlineExtensionError(deadlineFieldError(caught));
      }
      const message = assignmentWindowErrorMessage(caught, 'Planlanan zaman kaydedilemedi.');
      setMessage(message);
      setMessageIsError(true);
      // OVR-5b visual review: this form renders the failure inline and focuses
      // it, so the page feedback stays informational instead of taking focus.
      throw caught instanceof Error ? caught : new Error('Planlanan zaman kaydedilemedi.');
    } finally {
      endMutationOperation(owner);
    }
  }
  async function saveDeliveredAt(itemId: string, deliveredAt: string) {
    if (state.kind !== 'ready' || state.detail.kind !== 'PRODUCT_DELIVERY'
      || mutationOwner.current?.sessionToken === sessionLifetime.current.token) {
      throw new ApiError(409, 'ACTION_IN_PROGRESS', 'Başka bir işlem devam ediyor.', true);
    }
    const owner = startMutationOperation();
    if (!owner) {
      throw new ApiError(409, 'ACTION_IN_PROGRESS', 'Başka bir işlem devam ediyor.', true);
    }
    const operationJobId = jobId;
    mutationEpoch.current += 1;
    setPending(true); setMessage(''); setMessageIsError(false);
    updateCommittedStale(null);
    try {
      await patchDeliveryItem(operationJobId, itemId, {
        expectedVersion: state.detail.job.version,
        deliveredAt,
      });
      if (!isOperationCurrent(owner.sessionToken, operationJobId)) return;
      let read = await refreshAfterCommit('Gerçekleşen teslim zamanı kaydedildi.');
      if (read === 'access-lost') return;
      if (read === 'inactive') return;
      if (read === 'fresh') {
        const drain = await drainAfterCommit('Gerçekleşen teslim zamanı kaydedildi.');
        if (drain === 'access-lost') return;
        if (drain === 'inactive') return;
        if (drain === 'stale') read = 'stale';
      }
      setTimelineKey((value) => value + 1);
      if (read === 'fresh') setMessage('Gerçekleşen teslim zamanı kaydedildi.');
      else setFeedbackFocusRequest((value) => value + 1);
      onChanged();
    } catch (caught) {
      if (!isOperationCurrent(owner.sessionToken, operationJobId)) throw caught;
      if (caught instanceof ApiError && caught.code === 'VERSION_CONFLICT') {
        if (!(await refreshTruth())) throw caught;
        if (!(await requestRealtimeDrain())) throw caught;
        setMessage('İş başka bir işlemle güncellendi. En güncel durum gösteriliyor.');
        setMessageIsError(true);
        setFeedbackFocusRequest((value) => value + 1);
        throw new ApiError(
          409,
          'VERSION_CONFLICT',
          'İş başka bir işlemle güncellendi. En güncel durum gösteriliyor.',
        );
      }
      if (hasPendingRealtimeInvalidation()) {
        setRealtimeStale(true);
      }
      setMessage(caught instanceof ApiError ? caught.message : 'Gerçekleşen teslim zamanı kaydedilemedi.');
      setMessageIsError(true);
      setFeedbackFocusRequest((value) => value + 1);
      throw caught instanceof Error
        ? caught
        : new Error('Gerçekleşen teslim zamanı kaydedilemedi.');
    } finally {
      endMutationOperation(owner);
    }
  }
  async function saveAllDeliveredAtNow() {
    if (state.kind !== 'ready' || state.detail.kind !== 'PRODUCT_DELIVERY'
      || mutationOwner.current?.sessionToken === sessionLifetime.current.token) {
      return;
    }
    // Only lines without a recorded time: an existing delivered time is
    // evidence and is never overwritten by a bulk shortcut.
    const entries = state.detail.deliveryItems.filter((entry) => entry.deliveredAt === null);
    if (entries.length === 0) return;
    const owner = startMutationOperation();
    if (!owner) return;
    const operationJobId = jobId;
    const deliveredAt = localDateTimeToIso(defaultDeliveredAtLocalValue());
    mutationEpoch.current += 1;
    setPending(true); setMessage(''); setMessageIsError(false);
    updateCommittedStale(null);
    let expectedVersion = state.detail.job.version;
    let savedCount = 0;
    const receipt = `${entries.length} kalem için gerçekleşen teslim zamanı kaydedildi.`;
    try {
      for (const entry of entries) {
        const updated = await patchDeliveryItem(operationJobId, entry.id, {
          expectedVersion,
          deliveredAt,
        });
        if (!isOperationCurrent(owner.sessionToken, operationJobId)) return;
        expectedVersion = updated.jobCardVersion;
        savedCount += 1;
      }
      const read = await refreshAfterCommit(receipt);
      if (read === 'access-lost') return;
      if (read === 'inactive') return;
      setTimelineKey((value) => value + 1);
      if (read === 'fresh') {
        const drain = await drainAfterCommit(receipt);
        if (drain === 'access-lost') return;
        if (drain === 'inactive') return;
        if (drain !== 'stale') setMessage(receipt);
      }
      onChanged();
    } catch (caught) {
      if (!isOperationCurrent(owner.sessionToken, operationJobId)) return;
      try {
        if (!(await refreshTruth())) return;
        if (!(await requestRealtimeDrain())) return;
      } catch {
        if (!isOperationCurrent(owner.sessionToken, operationJobId)) return;
        setRealtimeStale(true);
      }
      if (!isOperationCurrent(owner.sessionToken, operationJobId)) return;
      if (savedCount > 0) {
        setTimelineKey((value) => value + 1);
        onChanged();
      }
      const errorText = caught instanceof ApiError && caught.code === 'VERSION_CONFLICT'
        ? 'İş başka bir işlemle güncellendi. En güncel durum gösteriliyor.'
        : caught instanceof ApiError
          ? caught.message
          : 'Gerçekleşen teslim zamanı kaydedilemedi.';
      // An ambiguous per-item outcome may already be committed on the server:
      // never report it as a failure, never retry it automatically, and keep the
      // stale record locked until a successful reload resolves the unknown.
      if (isAmbiguousMutationError(caught)) {
        updateCommittedStale({
          kind: 'unknown',
          message: savedCount > 0
            ? `${savedCount}/${entries.length} kalem kaydedildi; sonraki kalemin sonucu doğrulanamadı.`
            : 'Gerçekleşen teslim zamanının sonucu doğrulanamadı.',
        });
        setMessage('');
        setMessageIsError(false);
        setFeedbackFocusRequest((value) => value + 1);
        return;
      }
      setMessage(savedCount > 0
        ? `${savedCount}/${entries.length} kalem kaydedildi; sonraki adımda hata oluştu: ${errorText}`
        : errorText);
      setMessageIsError(true);
    } finally {
      endMutationOperation(owner);
    }
  }
  function command(commandName: LifecycleCommand, trigger: HTMLElement) {
    if (state.kind !== 'ready' || saleCorrectionLockedRef.current || committedStale !== null) return;
    const presentation = presentationFor(state.detail);
    if (commandName === 'APPROVE') {
      const transition = findTransition(presentation, 'APPROVE');
      if (!transition) return;
      dialogTriggerRef.current = trigger;
      dialogFocusRestoreEnabledRef.current = true;
      setDialog({ kind: 'approve', presentation: transition });
      void prepareApproveFollowUp(
        state.detail.job,
        state.detail.kind === 'SALES_MEETING' ? state.detail.meetingDetails : null,
      );
      return;
    }
    if (commandName === 'SUBMIT_FOR_APPROVAL') {
      const transition = findTransition(presentation, 'SUBMIT_FOR_APPROVAL');
      if (!transition) return;
      dialogTriggerRef.current = trigger;
      dialogFocusRestoreEnabledRef.current = true;
      setDialog({ kind: 'submit', presentation: transition });
      void prepareSubmitFollowUp(
        state.detail.job,
        state.detail.kind === 'SALES_MEETING' ? state.detail.meetingDetails : null,
      );
      return;
    }
    if (commandName === 'REQUEST_REVISION') {
      const transition = findTransition(presentation, 'REQUEST_REVISION');
      if (!transition) return;
      dialogTriggerRef.current = trigger;
      dialogFocusRestoreEnabledRef.current = true;
      setRevisionCorrection(hasOriginalSubmissionDeadline(state.detail.job)
        ? { value: defaultCorrectionDueLocalValue(), fieldError: null }
        : null);
      setDialog({ kind: 'revision', presentation: transition });
      return;
    }
    if (commandName === 'CANCEL') {
      const transition = findTransition(presentation, 'CANCEL');
      if (!transition) return;
      dialogTriggerRef.current = trigger;
      dialogFocusRestoreEnabledRef.current = true;
      setCancelContinuity(state.kind === 'ready' && isFollowUpVisit(state.detail.job)
        ? { draft: EMPTY_FOLLOW_UP_CANCEL_CONTINUITY, inlineError: null }
        : null);
      setDialog({ kind: 'cancel', presentation: transition });
      return;
    }
    if (commandName === 'DECLINE_ASSIGNMENT' || commandName === 'RELEASE_ASSIGNMENT') {
      // JOB-010 release 2b: the server asks for a structured reason plus text;
      // the dialog owns the text, the prelude owns the code.
      const transition = findTransition(presentation, commandName);
      if (!transition) return;
      dialogTriggerRef.current = trigger;
      dialogFocusRestoreEnabledRef.current = true;
      setAssignmentReason({ draft: EMPTY_ASSIGNMENT_REASON, inlineError: null, scheduleError: null });
      setDialog({
        kind: commandName === 'DECLINE_ASSIGNMENT' ? 'decline' : 'release',
        presentation: transition,
      });
      return;
    }
    void execute(commandName);
  }

  async function prepareSubmitFollowUp(job: JobCard, meetingDetails: MeetingDetails | null) {
    const token = ++followUpLoadTokenRef.current;
    if (!requiresMandatoryFollowUpProposal(job, meetingDetails)) {
      setFollowUp(null);
      setFollowUpLoading(false);
      setFollowUpLoadError(null);
      return;
    }
    setFollowUp(null);
    setFollowUpLoading(true);
    setFollowUpLoadError(null);
    try {
      const suggestion = await getFollowUpSuggestion(job.id);
      if (followUpLoadTokenRef.current !== token) return;
      setFollowUp({
        draft: {
          // Staff AUTO: never prefill a server time. An empty value omits
          // scheduledAt from the request so the backend selects the slot.
          // An explicit value is only ever Staff-chosen via the no-slot fallback.
          scheduledAt: '',
          type: suggestion.type,
          assignedTo: suggestion.assignedTo,
          followUpInstructions: suggestion.followUpInstructions,
        },
        origin: null,
        evaluation: suggestion.evaluation,
        assigneeName: job.assignee.name,
        assignees: [],
        inlineError: null,
        explicitScheduleAllowed: suggestion.scheduledAt === null,
        loadError: null,
        expandInstructions: false,
      });
    } catch (caught) {
      if (followUpLoadTokenRef.current !== token) return;
      // Suggestion load failure is NOT a no-slot signal. Surface a visible
      // error with retry instead of fabricating a scheduling decision.
      const loadErrorMessage = caught instanceof ApiError
        ? caught.message
        : 'Takip önerisi yüklenemedi. Bağlantınızı kontrol edip tekrar deneyin.';
      setFollowUpLoadError(loadErrorMessage);
      setFollowUp({
        draft: null,
        origin: null,
        evaluation: null,
        assigneeName: job.assignee.name,
        assignees: [],
        inlineError: null,
        explicitScheduleAllowed: false,
        loadError: loadErrorMessage,
        expandInstructions: false,
      });
    } finally {
      if (followUpLoadTokenRef.current === token) {
        setFollowUpLoading(false);
      }
    }
  }

  async function retrySubmitFollowUp() {
    if (state.kind !== 'ready') return;
    const job = state.detail.job;
    const meetingDetails = state.detail.kind === 'SALES_MEETING' ? state.detail.meetingDetails : null;
    await prepareSubmitFollowUp(job, meetingDetails);
  }

  async function prepareApproveFollowUp(job: JobCard, meetingDetails: MeetingDetails | null) {
    const token = ++followUpLoadTokenRef.current;
    const persisted = job.followUpProposal;
    if (!requiresMandatoryFollowUpProposal(job, meetingDetails) && !persisted) {
      setFollowUp(null);
      setFollowUpLoading(false);
      setFollowUpLoadError(null);
      return;
    }
    setFollowUp(null);
    setFollowUpLoading(true);
    setFollowUpLoadError(null);
    try {
      let evaluation: CustomerScheduleEvaluation | null = null;
      let fallbackDraft: FollowUpDraft | null = null;
      let suggestionLoadError: string | null = null;
      try {
        const suggestion = await getFollowUpSuggestion(job.id, persisted?.scheduledAt);
        if (followUpLoadTokenRef.current !== token) return;
        evaluation = suggestion.evaluation;
        if (!persisted && suggestion.scheduledAt !== null) {
          fallbackDraft = {
            scheduledAt: suggestion.scheduledAt,
            type: suggestion.type,
            assignedTo: suggestion.assignedTo,
            followUpInstructions: suggestion.followUpInstructions,
            priority: 'normal',
            dueDate: null,
          };
        }
      } catch (caught) {
        if (followUpLoadTokenRef.current !== token) return;
        evaluation = null;
        if (!persisted) {
          suggestionLoadError = caught instanceof ApiError
            ? caught.message
            : 'Takip önerisi yüklenemedi. Bağlantınızı kontrol edip tekrar deneyin.';
        }
      }
      let assignees: RelatedName[] = [];
      try {
        assignees = await listCalendarAssignees();
      } catch {
        assignees = [];
      }
      if (followUpLoadTokenRef.current !== token) return;
      if (suggestionLoadError) {
        setFollowUpLoadError(suggestionLoadError);
      }
      setFollowUp({
        draft: persisted
          ? {
              scheduledAt: persisted.scheduledAt,
              type: persisted.type,
              assignedTo: persisted.assignedTo,
              followUpInstructions: persisted.followUpInstructions,
              priority: 'normal',
              dueDate: null,
            }
          : fallbackDraft,
        origin: persisted?.origin ?? null,
        evaluation,
        assigneeName: job.assignee.name,
        assignees,
        inlineError: null,
        explicitScheduleAllowed: false,
        loadError: suggestionLoadError,
        expandInstructions: false,
      });
    } catch (caught) {
      if (followUpLoadTokenRef.current !== token) return;
      setFollowUpLoadError(
        caught instanceof ApiError
          ? caught.message
          : 'Takip önerisi yüklenemedi. Bağlantınızı kontrol edip tekrar deneyin.',
      );
    } finally {
      if (followUpLoadTokenRef.current === token) {
        setFollowUpLoading(false);
      }
    }
  }

  async function retryApproveFollowUp() {
    if (state.kind !== 'ready') return;
    const job = state.detail.job;
    const meetingDetails = state.detail.kind === 'SALES_MEETING' ? state.detail.meetingDetails : null;
    await prepareApproveFollowUp(job, meetingDetails);
  }

  function updateFollowUpDraft(next: Partial<FollowUpDraft>) {
    setFollowUp((current) => current?.draft
      ? {
          ...current,
          draft: {
            ...current.draft,
            ...next,
            ...(next.type === 'SALES_MEETING' ? { dueDate: null } : {}),
          },
          inlineError: null,
          ...(next.followUpInstructions !== undefined ? { expandInstructions: false } : {}),
        }
      : current);
  }

  function retryUncertainAttempt() {
    const attempt = lifecycleAttempt.current;
    if (attempt) void execute(attempt.command);
    else if (withdrawEditAttempt.current) void confirmWithdrawAndEdit();
  }

  function validateDialogPrelude(): string | null {
    if (uncertain || !dialog || dialog.kind === 'withdraw-edit') return null;

    if (dialog.kind === 'approve') {
      const job = state.kind === 'ready' ? state.detail.job : null;
      const meetingDetails = state.kind === 'ready' && state.detail.kind === 'SALES_MEETING'
        ? state.detail.meetingDetails
        : null;
      const followUpRequired = job !== null
        && (requiresMandatoryFollowUpProposal(job, meetingDetails) || Boolean(job.followUpProposal));
      // The pair is still being discovered: a confirm now would omit the sale
      // version (400) or silently drop the delivery section, so wait for it.
      if (state.kind === 'ready' && state.detail.kind === 'SALES_MEETING'
        && pairState.kind === 'loading') {
        // The pair note already shows its own loading status and the confirm
        // is blocked meanwhile; never park this wait in the follow-up error.
        return 'Bağlı satış kaydı yükleniyor. Lütfen bekleyin.';
      }
      if (followUpLoading) {
        return 'Takip önerisi yükleniyor. Lütfen bekleyin.';
      }
      if (!followUp?.draft) {
        if (followUpRequired) {
          const message = followUpLoadError
            ?? followUp?.loadError
            ?? 'Takip önerisi yüklenemedi. Lütfen tekrar deneyin.';
          setFollowUpLoadError(message);
          return message;
        }
      } else {
        if (!followUp.draft.scheduledAt) {
          const message = 'Takip tarihi ve saati zorunludur.';
          setFollowUp((current) => current ? { ...current, inlineError: message } : current);
          return message;
        }
        if (!followUp.draft.followUpInstructions.trim()) {
          const message = 'Takip kapsamı zorunludur.';
          setFollowUp((current) => current ? { ...current, inlineError: message } : current);
          return message;
        }
      }
      if (approveDeliverySource && saleDelivery && saleDelivery.draft.enabled) {
        const built = buildSaleDeliveryRequest(saleDelivery.draft, saleDeliveryFailureSeq.current + 1);
        if (!built.ok) {
          saleDeliveryFailureSeq.current += 1;
          setSaleDelivery((current) => current ? { ...current, errors: built.errors } : current);
          return built.errors.summary
            ?? Object.values(built.errors.fields)[0]
            ?? Object.values(built.errors.lines)[0]
            ?? 'Teslim işi bilgilerini kontrol edin.';
        }
      }
      return null;
    }

    if (dialog.kind === 'submit') {
      const job = state.kind === 'ready' ? state.detail.job : null;
      const meetingDetails = state.kind === 'ready' && state.detail.kind === 'SALES_MEETING'
        ? state.detail.meetingDetails
        : null;
      const followUpRequired = job !== null && requiresMandatoryFollowUpProposal(job, meetingDetails);
      if (followUpLoading) {
        return 'Takip önerisi yükleniyor. Lütfen bekleyin.';
      }
      if (!followUp?.draft) {
        if (followUpRequired) {
          const message = followUpLoadError
            ?? followUp?.loadError
            ?? 'Takip önerisi yüklenemedi. Lütfen tekrar deneyin.';
          setFollowUpLoadError(message);
          return message;
        }
        return null;
      }
      const staffAuto = isAutoSchedulableFollowUpType(followUp.draft.type);
      if (!followUp.draft.scheduledAt && !(staffAuto && !followUp.explicitScheduleAllowed)) {
        const message = 'Takip tarihi ve saati zorunludur.';
        setFollowUp((current) => current ? { ...current, inlineError: message } : current);
        return message;
      }
      if (!followUp.draft.followUpInstructions.trim()) {
        const message = 'Takip kapsamı zorunludur. “Takip kapsamını düzenle” alanına yazın.';
        setFollowUp((current) => current
          ? { ...current, inlineError: message, expandInstructions: true }
          : current);
        return message;
      }
      return null;
    }

    if (dialog.kind === 'revision') {
      if (revisionCorrection) {
        const message = 'Geçerli bir düzeltme son tarihi seçin.';
        if (!revisionCorrection.value.trim()) {
          setRevisionCorrection({ ...revisionCorrection, fieldError: message });
          return message;
        }
        try {
          localDateTimeToIso(revisionCorrection.value);
        } catch {
          setRevisionCorrection({ ...revisionCorrection, fieldError: message });
          return message;
        }
      }
      return null;
    }

    if (dialog.kind === 'decline' || dialog.kind === 'release') {
      if (!assignmentReason) return 'Atama yanıt nedeni yüklenemedi.';
      if (assignmentReason.draft.code === '') {
        const message = dialog.kind === 'release'
          ? 'Görevi geri bırakma nedenini seçin.'
          : 'Görevi reddetme nedenini seçin.';
        setAssignmentReason({ ...assignmentReason, inlineError: message });
        return message;
      }
      // JOB-012: a SCHEDULE_CONFLICT answer must carry a future proposed time.
      if (assignmentReason.draft.code === 'SCHEDULE_CONFLICT') {
        const localValue = assignmentReason.draft.proposedScheduledLocal.trim();
        let proposedScheduledAt = '';
        if (localValue) {
          try {
            proposedScheduledAt = localDateTimeToIso(localValue);
          } catch {
            proposedScheduledAt = '';
          }
        }
        if (!proposedScheduledAt) {
          const message = 'Plan çakışması için önerdiğiniz zamanı seçin.';
          setAssignmentReason({ ...assignmentReason, scheduleError: message });
          return message;
        }
        if (Date.parse(proposedScheduledAt) <= Date.now()) {
          const message = 'Önerilen zaman gelecekte olmalı.';
          setAssignmentReason({ ...assignmentReason, scheduleError: message });
          return message;
        }
      }
      return null;
    }

    if (dialog.kind === 'cancel' && cancelContinuity && !lifecycleAttempt.current) {
      const resolved = resolveCancelContinuity(cancelContinuity.draft);
      if ('error' in resolved) {
        setCancelContinuity({ ...cancelContinuity, inlineError: resolved.error });
        return resolved.error;
      }
    }

    return null;
  }

  function confirmDialog(reason: string) {
    if (uncertain) { retryUncertainAttempt(); return; }
    if (!dialog) return;
    if (validateDialogPrelude() !== null) return;
    if (dialog.kind === 'approve') {
      const resolveDelivery = (): ApproveDeliveryInput | undefined => {
        if (!approveDeliverySource || !saleDelivery || !saleDelivery.draft.enabled) return undefined;
        const built = buildSaleDeliveryRequest(saleDelivery.draft, saleDeliveryFailureSeq.current);
        if (!built.ok) return undefined;
        setSaleDelivery((current) => current ? { ...current, errors: null } : current);
        return built.delivery;
      };
      const delivery = resolveDelivery();
      if (!followUp?.draft) {
        void execute('APPROVE', reason, delivery ? { delivery } : undefined);
        return;
      }
      void execute('APPROVE', reason, {
        followUp: {
          scheduledAt: followUp.draft.scheduledAt,
          type: followUp.draft.type,
          assignedTo: followUp.draft.assignedTo,
          followUpInstructions: followUp.draft.followUpInstructions.trim(),
          priority: followUp.draft.priority ?? 'normal',
          dueDate: followUp.draft.dueDate ?? null,
        },
        ...(delivery ? { delivery } : {}),
      });
      return;
    }
    if (dialog.kind === 'submit') {
      if (!followUp?.draft) {
        void execute('SUBMIT_FOR_APPROVAL', reason);
        return;
      }
      void execute('SUBMIT_FOR_APPROVAL', reason, {
        followUpProposal: buildStaffFollowUpProposalInput(followUp.draft),
      });
      return;
    }
    if (dialog.kind === 'revision') {
      if (revisionCorrection) {
        void execute('REQUEST_REVISION', reason, {
          correctionDueAt: localDateTimeToIso(revisionCorrection.value),
        });
        return;
      }
      void execute('REQUEST_REVISION', reason);
      return;
    }
    if (dialog.kind === 'decline' || dialog.kind === 'release') {
      if (!assignmentReason) return;
      const code = assignmentReason.draft.code;
      const text = reason.trim();
      if (text.length === 0) {
        setAssignmentReason({
          ...assignmentReason,
          inlineError: 'Durumu açıklayan metin zorunludur.',
        });
        return;
      }
      // The prelude already validated the value; only SCHEDULE_CONFLICT sends it.
      const proposedScheduledAt = code === 'SCHEDULE_CONFLICT'
        ? localDateTimeToIso(assignmentReason.draft.proposedScheduledLocal.trim())
        : undefined;
      void execute(
        dialog.kind === 'decline' ? 'DECLINE_ASSIGNMENT' : 'RELEASE_ASSIGNMENT',
        text,
        {
          assignmentReason: {
            code: code as AssignmentReasonCode,
            text,
            ...(proposedScheduledAt !== undefined ? { proposedScheduledAt } : {}),
          },
        },
      );
      return;
    }
    if (dialog.kind === 'cancel') {
      if (cancelContinuity && !lifecycleAttempt.current) {
        const resolved = resolveCancelContinuity(cancelContinuity.draft);
        if ('error' in resolved) {
          setCancelContinuity({ ...cancelContinuity, inlineError: resolved.error });
          return;
        }
        void execute('CANCEL', reason, { followUpContinuity: resolved.continuity });
        return;
      }
      void execute('CANCEL', reason);
      return;
    }
    void confirmWithdrawAndEdit();
  }

  if (state.kind === 'loading') {
    return <main className="job-detail"><PageHeader fallbackTitle="İş detayı" /><LoadingSkeleton title="İş detayları yükleniyor" headingLevel={2} rows={6} /></main>;
  }
  if (state.kind === 'error') {
    return <main className="job-detail"><PageHeader fallbackTitle="İş detayı" /><ResultState status="error" title="İş yüklenemedi" description={state.message}
      action={state.retryable ? <button className="secondary-button" type="button" onClick={() => setReloadKey((value) => value + 1)}>Tekrar dene</button> : undefined}
    /></main>;
  }
  const { detail } = state;
  // Weekly reports render in their dedicated component: separate draft
  // editor, system activity list and submission history. Generic meeting /
  // delivery sections must never render for this type.
  if (detail.kind === 'WEEKLY_REPORT') {
    return <WeeklyReportDetail jobCardId={jobId} user={user} />;
  }
  const actions = detail.job.workflowContext.allowedActions;
  const viewMeeting = actions.includes('VIEW_MEETING_RESULT');
  const editMeeting = actions.includes('EDIT_MEETING_RESULT');
  const viewNotes = actions.includes('VIEW_NOTES');
  const addNote = actions.includes('ADD_NOTE');
  const hasMeetingResult = detail.kind === 'SALES_MEETING' && detail.meetingDetails !== null
    && Object.values({
      meetingAt: detail.meetingDetails.meetingAt,
      outcome: detail.meetingDetails.outcome,
      unsuccessfulReason: detail.meetingDetails.unsuccessfulReason,
      meetingSummary: detail.meetingDetails.meetingSummary,
      nextFollowUpAt: detail.meetingDetails.nextFollowUpAt,
      metContactId: detail.meetingDetails.metContactId,
    }).some((value) => value !== null);
  const showMeetingResult = detail.kind === 'SALES_MEETING'
    && viewMeeting && detail.meetingDetails !== null
    && (detail.job.status !== 'CANCELLED' || hasMeetingResult);
  const invalidationMutationLocked = invalidationMutation.kind === 'submitting'
    || invalidationMutation.kind === 'reconciling'
    || invalidationMutation.kind === 'retry-ready';
  const invalidationLocked = pending || uncertain || invalidationMutationLocked
    || saleCorrectionLocked || committedStale !== null;
  // JOB-010 recovery: the assignment guidance reuses the one record-edit
  // reassignment flow the decision panel already offers.
  const assignmentRecordEdit = presentationFor(detail).recordEditAction;

  const recordContent = <>
    {detail.kind === 'SALE' && <SaleDetailsSection details={detail.saleDetails} originPending={saleOriginPending} />}
    {detail.kind === 'SALE' && <SalePairContextPanel
      job={detail.job}
      sourceVisit={detail.saleDetails.sourceVisit}
      originPending={saleOriginPending}
    />}
    {detail.kind === 'SALE' && detail.job.customerId && (actions.includes('EDIT_JOB_FIELDS') || saleCorrectionLocked)
      && <SaleCorrectionSection details={detail.saleDetails} customerId={detail.job.customerId}
        disabled={pending || uncertain || invalidationMutationLocked || committedStale !== null
          || !actions.includes('EDIT_JOB_FIELDS')}
        onLockChange={(locked) => { saleCorrectionLockedRef.current = locked; setSaleCorrectionLocked(locked); }}
        onCommitted={settleChildCommit}
        onActionStart={clearChildReceipt}
        onRefresh={() => reloadCommittedTruth()} />}
    {detail.kind === 'SALE' && <LinkedDeliveryPanel
      linkedDelivery={detail.job.linkedDelivery !== undefined
        ? detail.job.linkedDelivery
        : detail.saleDetails.linkedDelivery}
    />}
    {detail.kind === 'PRODUCT_DELIVERY' && <DeliveryProvenanceLine sourceSaleId={detail.job.deliverySourceSaleId} />}
    {detail.kind === 'SALE' && isManagementUser(user) && (
      <section className="sale-pair-note" aria-label="Satış kaydı kapsam bilgisi">
        <p>
          Satış kaydı finansal işlem oluşturmaz. Satış kaydı stok hareketi oluşturmaz.
          Onay sırasında ürün teslimi için ayrı bir teslim işi açılabilir ve bu iş de stok düşümü yapmaz.
        </p>
      </section>
    )}
    {detail.kind === 'SALES_MEETING' && <RelatedSalesSection visitId={jobId} disabled={invalidationLocked} />}
    {editing && detail.kind === 'SALES_MEETING'
      ? <SalesMeetingEditForm job={detail.job} user={user}
        pending={invalidationLocked} onCancel={() => setEditing(false)} onSave={saveJob} />
      : editing && detail.kind === 'PRODUCT_DELIVERY'
        ? <DeliveryAssigneeEditForm job={detail.job}
          pending={invalidationLocked} onCancel={() => setEditing(false)} onSave={saveDeliveryAssignee} />
        : editing && detail.kind === 'GENERAL_TASK'
          ? <GeneralTaskEditForm job={detail.job} user={user}
            pending={invalidationLocked}
            deadlineExtensionError={deadlineExtensionError}
            onCancel={() => setEditing(false)} onSave={saveGeneralTask} />
          : showMeetingResult && detail.kind === 'SALES_MEETING' && detail.meetingDetails
          ? <MeetingDetailsSection
            job={detail.job}
            details={detail.meetingDetails}
            user={user}
            canEdit={editMeeting}
            mutationPending={invalidationLocked}
            submissionError={meetingSubmissionError}
            onSave={saveMeeting}
            receiptShownByPage={() => meetingReceiptOnPageRef.current}
          />
          : null}
    <CustomerCompletenessAction job={detail.job} user={user} disabled={invalidationLocked} />
  </>;

  const activePendingLabel = startPendingPhase === 'capturing'
    ? 'Konum alınıyor…'
    : startPendingPhase === 'submitting'
      ? 'İş başlatılıyor…'
      : submitPendingPhase === 'capturing'
        ? 'Konum alınıyor…'
        : submitPendingPhase === 'submitting'
          ? 'Kontrole gönderiliyor…'
          : undefined;

  return <JobDetailPanel
    job={detail.job}
    items={detail.kind === 'PRODUCT_DELIVERY' ? detail.deliveryItems : []}
    user={user}
    pending={pending || saleCorrectionLocked}
    pendingLabel={activePendingLabel}
    pendingCommand={pendingCommand}
    message={message}
    messageIsError={messageIsError}
    feedbackRef={feedbackRef}
    realtimeStaleNotice={realtimeStale && !committedStale ? <div className="detail-feedback detail-feedback-error" role="status">
      <p>Bu iş başka bir oturumda güncellendi. Açık düzenlemeniz korunuyor.</p>
      <button className="secondary-button" type="button" disabled={pending || realtimeReloadPending}
        onClick={() => void reloadStaleTruth()}>{realtimeReloadPending ? 'Yükleniyor…' : 'En güncel bilgileri yükle'}</button>
    </div> : undefined}
    committedStaleNotice={committedStale ? <CommittedStaleNotice
      message={committedStale.message}
      kind={committedStale.kind}
      reloadPending={pending || realtimeReloadPending}
      onReload={() => { void reloadCommittedTruth(); }}
      feedbackRef={feedbackRef}
    /> : undefined}
    continuity={detail.kind !== 'SALE' && isManagementUser(user) ? <FollowUpBreadcrumb job={detail.job} /> : undefined}
    submissionLateness={
      detail.job.status === 'IN_PROGRESS' || detail.job.status === 'REVISION_REQUESTED' || isManagementUser(user)
        ? (
          <SubmissionLatenessSection
            jobId={jobId}
            jobVersion={detail.job.version}
            user={user}
            onReminded={() => setTimelineKey((value) => value + 1)}
          />
        )
        : undefined
    }
    earlyStart={
      <EarlyStartAuthorizationSection
        job={detail.job}
        user={user}
        disabled={committedStale !== null}
        onCommitted={settleChildCommit}
        onActionStart={clearChildReceipt}
        onRefresh={() => reloadCommittedTruth()}
      />
    }
    changeRequest={
      <ChangeRequestSection
        job={detail.job}
        user={user}
        disabled={invalidationLocked}
        openRequestSignal={changeRequestSignal}
        canSetNewTime={Boolean(presentationFor(detail).scheduleEdit)}
        onReassign={assignmentRecordEdit?.action === 'EDIT_JOB_FIELDS'
          ? (trigger) => { openRecordEditDialog('EDIT_JOB_FIELDS', trigger); }
          : undefined}
        onCancel={(trigger) => { command('CANCEL', trigger); }}
        onCommitted={settleChildCommit}
        onActionStart={clearChildReceipt}
        onRefresh={() => reloadCommittedTruth()}
        onChanged={() => {
          setTimelineKey((value) => value + 1);
          void refreshTruth();
        }}
      />
    }
    assignmentOffer={
      <AssignmentOfferSection
        job={detail.job}
        user={user}
        disabled={invalidationLocked}
        onCommitted={settleChildCommit}
        onActionStart={clearChildReceipt}
        onRefresh={() => reloadCommittedTruth()}
        canSetNewTime={Boolean(presentationFor(detail).scheduleEdit)}
        onReassign={assignmentRecordEdit?.action === 'EDIT_JOB_FIELDS'
          ? (trigger) => { openRecordEditDialog('EDIT_JOB_FIELDS', trigger); }
          : undefined}
      />
    }
    overdueHistory={isManagementUser(user) ? (
      <OverdueIncidentHistorySection jobId={jobId} collapsible={narrowDetail} />
    ) : undefined}
    meetingDetails={detail.kind === 'SALES_MEETING' ? detail.meetingDetails : null}
    onCommand={(name, trigger) => command(name, trigger)}
    onRecordEdit={(action, trigger) => {
      openRecordEditDialog(action, trigger);
    }}
    onSaveSchedule={saveSchedule}
    scheduleShiftSignal={scheduleShiftSignal}
    scheduleCommittedSignal={scheduleCommittedSignal}
    onRequestChange={() => setChangeRequestSignal((value) => value + 1)}
    onSaveDeliveredAt={detail.kind === 'PRODUCT_DELIVERY' ? saveDeliveredAt : undefined}
    onSaveAllDeliveredAtNow={detail.kind === 'PRODUCT_DELIVERY' ? saveAllDeliveredAtNow : undefined}
    deadlineExtensionError={deadlineExtensionError}
    onCreateFollowUp={onCreateFollowUp}
    existingChildrenCount={followUpChildrenCount}
    mutationLocked={invalidationMutationLocked || uncertain || saleCorrectionLocked || committedStale !== null}
    pairGuidance={pairGuidance ? <SalePairGuidanceNotice guidance={pairGuidance} /> : undefined}
    pairManagedCommand={detail.kind === 'SALE' && !saleOriginPending
      && detail.saleDetails.sourceVisit.kind === 'SALE_FROM_VISIT'
      && detail.saleDetails.sourceVisit.access === 'FULL'
      ? pairManagedSaleCommand({
        type: detail.job.type,
        status: detail.job.status,
        allowedCommands: detail.job.workflowContext.allowedCommands,
        sourceVisitAccess: 'FULL',
      })
      : null}
    records={recordContent}
    notes={viewNotes ? (
      <JobNotes
        jobId={jobId}
        jobType={detail.job.type}
        canAdd={addNote && !invalidationLocked}
        hideWhenEmpty={detail.job.status === 'CANCELLED'}
        refreshKey={lifecycleNoteKey}
        realtimeKey={notesRealtimeKey}
        onAdded={() => setTimelineKey((value) => value + 1)}
      />
    ) : undefined}
    messagingAction={user.capabilities?.messaging === true && onOpenMessaging ? (
      <JobConversationAction
        job={detail.job}
        user={user}
        disabled={invalidationLocked}
        onOpenMessaging={onOpenMessaging}
        onVisibilityChange={setMessagingActionVisible}
      />
    ) : undefined}
    messagingActionVisible={messagingActionVisible}
    invalidationAction={user.role === 'ADMIN' && detail.job.status !== 'INVALIDATED' ? (
      <JobInvalidationAction
        job={detail.job}
        mutationState={invalidationMutation}
        disabled={committedStale !== null}
        onSubmit={(attempt) => { void submitInvalidation(attempt); }}
        onRecheck={() => { void recheckInvalidation(); }}
        onRetry={() => {
          if (invalidationMutation.kind === 'retry-ready') {
            void submitInvalidation(invalidationMutation.attempt);
          }
        }}
        onReset={() => {
          setInvalidationMutation({ kind: 'idle' });
          setMessage('');
          setMessageIsError(false);
        }}
      />
    ) : undefined}
    timeline={<JobTimeline jobId={jobId} refreshKey={timelineKey} />}
  >
    {uncertain && !dialog && <div className="detail-feedback" role="status">
      <p>İşlemin sonucu henüz doğrulanamadı. Özgün istek korunuyor; yeni işlemden önce tekrar deneyin.</p>
      <button type="button" className="primary-button" disabled={pending} onClick={retryUncertainAttempt}>Özgün isteği tekrar dene</button>
    </div>}
    {detail.kind !== 'SALE' && isManagementUser(user) && <FollowUpChildrenPanel sourceId={jobId} onCountChange={setFollowUpChildrenCount} />}
    {dialog && <JobWorkflowDialog
      dialog={dialog}
      pending={pending}
      pendingLabel={activePendingLabel}
      uncertain={uncertain}
      loadingFollowUp={followUpLoading}
      followUpLoadError={followUpLoadError}
      confirmBlocked={dialog.kind === 'approve' && detail.kind === 'SALES_MEETING'
        && pairState.kind === 'loading'}
      validatePrelude={validateDialogPrelude}
      onClose={() => { if (!uncertain) closeDialog(); }}
      onConfirm={confirmDialog}
      pairNote={dialog.kind === 'submit'
        ? <VisitPairSubmitNote pair={pairState} onRetry={reloadPair} />
        : dialog.kind === 'approve'
          ? <VisitPairApproveNote pair={pairState} onRetry={reloadPair} />
          : dialog.kind === 'revision'
            ? <VisitPairLifecycleNote
                pair={pairState}
                command="REQUEST_REVISION"
                onRetry={reloadPair}
              />
            : undefined}
      pairDetails={dialog.kind === 'withdraw-edit' && pairState.kind === 'ready' && pairState.coordinated
        ? [lifecycleMovesSale(pairState.sale, 'WITHDRAW_FROM_APPROVAL')
          ? `Bağlı satış kaydı da birlikte yeniden düzenlemeye açılır: ${pairState.sale.title}.`
          : `Bağlı satış kaydı olduğu durumda kalır: ${pairState.sale.title} · ${jobCardStatusLabel(pairState.sale.status)}.`]
        : undefined}
      saleDelivery={dialog.kind === 'approve' && approveDeliverySource && saleDelivery
        ? {
            source: approveDeliverySource,
            draft: saleDelivery.draft,
            errors: saleDelivery.errors,
            pending,
            uncertain,
            onChange: (patch, touched) => setSaleDelivery((current) => {
              if (!current) return current;
              const errors = current.errors;
              let nextErrors = errors;
              if (errors && touched) {
                const fields = { ...errors.fields };
                delete fields[touched];
                const lines = touched === 'items' ? {} : errors.lines;
                nextErrors = { ...errors, fields, lines, summary: errors.summary };
                if (!hasSaleDeliveryErrors(nextErrors)) nextErrors = null;
              }
              return { draft: { ...current.draft, ...patch }, errors: nextErrors };
            }),
          }
        : undefined}
      followUp={(dialog.kind === 'submit' || dialog.kind === 'approve') && followUp
        ? {
            mode: dialog.kind === 'submit' ? 'staff' : 'manager',
            draft: followUp.draft,
            origin: followUp.origin,
            evaluation: followUp.evaluation,
            assigneeName: followUp.assigneeName,
            assignees: followUp.assignees,
            allowTypeEdit: dialog.kind === 'approve',
            mandatoryVisitFollowUp: dialog.kind === 'approve'
              && state.kind === 'ready'
              && state.detail.kind === 'SALES_MEETING'
              && requiresMandatoryFollowUpProposal(state.detail.job, state.detail.meetingDetails),
            inlineError: followUp.inlineError,
            autoSupported: dialog.kind === 'submit'
              && followUp.draft !== null
              && isAutoSchedulableFollowUpType(followUp.draft.type),
            allowExplicitSchedule: followUp.explicitScheduleAllowed,
            loadError: followUp.loadError,
            onRetrySuggestion: () => {
              void (dialog.kind === 'approve' ? retryApproveFollowUp() : retrySubmitFollowUp());
            },
            expandInstructions: followUp.expandInstructions,
            onChange: updateFollowUpDraft,
          }
        : undefined}
      cancelContinuity={dialog.kind === 'cancel' && cancelContinuity
        ? {
            draft: cancelContinuity.draft,
            inlineError: cancelContinuity.inlineError,
            onChange: (patch) => setCancelContinuity((current) => current
              ? { draft: { ...current.draft, ...patch }, inlineError: null }
              : current),
          }
        : undefined}
      assignmentReason={dialog.kind === 'decline' || dialog.kind === 'release'
        ? (assignmentReason
          ? {
              draft: assignmentReason.draft,
              inlineError: assignmentReason.inlineError,
              scheduleError: assignmentReason.scheduleError,
              onChange: (patch) => setAssignmentReason((current) => {
                if (!current) return current;
                // JOB-012: the proposal belongs to SCHEDULE_CONFLICT only;
                // switching away clears the value and its error.
                const nextDraft = patch.code !== undefined && patch.code !== 'SCHEDULE_CONFLICT'
                  ? { ...current.draft, ...patch, proposedScheduledLocal: '' }
                  : { ...current.draft, ...patch };
                return { ...current, draft: nextDraft, inlineError: null, scheduleError: null };
              }),
            }
          : undefined)
        : undefined}
      revisionCorrection={dialog.kind === 'revision' && revisionCorrection
        ? {
            draft: revisionCorrection,
            onChange: setRevisionCorrection,
          }
        : undefined}
      returnFocusRef={dialogTriggerRef}
      restoreFocusEnabledRef={dialogFocusRestoreEnabledRef}
    />}
    <PastStartAcknowledgementDrawer
      open={pastStartAck !== null}
      title={pastStartAck?.title ?? 'Başlangıç saati geçti'}
      description={pastStartAck?.description ?? ''}
      pending={pastStartAckPending}
      error={pastStartAckError}
      onShiftToFuture={pastStartAck?.onShiftToFuture}
      returnFocusRef={pastStartAckReturnFocusRef}
      onDismiss={() => {
        if (!pastStartAckPending) {
          setPastStartAck(null);
          setPastStartAckError('');
        }
      }}
      onConfirm={(acknowledgement) => {
        const request = pastStartAck;
        if (!request) return;
        setPastStartAckPending(true);
        setPastStartAckError('');
        void (async () => {
          try {
            const result = await request.run(acknowledgement);
            if (result.ok) {
              setPastStartAck(null);
              setPastStartAckError('');
            } else {
              setPastStartAckError(result.error);
            }
          } catch (err) {
            setPastStartAckError(err instanceof Error ? err.message : 'İşlem tamamlanamadı.');
          } finally {
            setPastStartAckPending(false);
          }
        })();
      }}
    />
    <ReassignmentSyncPrompt
      state={reassignmentSync.state}
      onConfirm={() => { void reassignmentSync.confirm(); }}
      onDismiss={reassignmentSync.dismiss}
    />
  </JobDetailPanel>;
}
