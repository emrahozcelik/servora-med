import {
  useEffect, useLayoutEffect, useRef, useState,
  type FormEvent, type ReactNode, type Ref,
} from 'react';

import { ApiError, type CurrentUser } from './services/api';
import {
  acceptJobCard, approveJobCard, cancelJobCard, getFollowUpSuggestion, getJobCard,
  getMeetingDetails, listDeliveryItems,
  patchDeliveryItem, patchJobCard, patchMeetingDetails,
  requestJobCardRevision, resumeJobCard, startJobCard, submitJobCardForApproval,
  withdrawJobCardFromApproval,
  type CustomerScheduleEvaluation, type DeliveryItem, type FollowUpProposalInput,
  type FollowUpProposalOrigin, type JobCard, type LifecycleCommand, type MeetingDetails,
  type PatchJobCardInput, type PatchMeetingDetailsInput, type RelatedName,
  type StartJobCardInput,
  type AvailableSlot,
} from './jobs/jobs-api';
import { listCalendarAssignees } from './services/calendar-api';
import {
  captureStartLocation,
  type StartLocationCapture,
} from './jobs/start-location-capture';
import {
  deriveJobWorkflowPresentation,
  requiresMandatoryFollowUpProposal,
  type JobWorkflowPresentation,
  type RecordEditPresentation,
  type ScheduleEditPresentation,
  type TransitionPresentation,
} from './jobs/job-workflow-presentation';
import {
  isoInstantToLocalDateTime,
  localDateTimeToIso,
} from './jobs/scheduling';
import { ResultState } from './ui/antd/ResultState';
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
  type FollowUpDraft,
} from './jobs/FollowUpProposalSection';
import { MeetingDetailsSection } from './jobs/MeetingDetails';
import { SalesMeetingEditForm } from './jobs/SalesMeetingEditForm';
import { DeliveryAssigneeEditForm } from './jobs/DeliveryAssigneeEditForm';
import { GeneralTaskEditForm, type GeneralTaskEditInput } from './jobs/GeneralTaskEditForm';
import { JobNotes } from './jobs/JobNotes';
import { JobTimeline } from './jobs/JobTimeline';
import { useRealtimeInvalidation } from './realtime/RealtimeProvider';
import { jobEngagementLabel, jobTypeLabels } from './jobs/job-labels';
import { JobConversationAction } from './jobs/JobConversationAction';
import { useReassignmentConversationSync } from './jobs/useReassignmentConversationSync';
import { ReassignmentSyncPrompt } from './jobs/ReassignmentSyncPrompt';
import { CustomerScheduleNotice } from './jobs/CustomerScheduleNotice';
import { AvailableSlotsNotice } from './jobs/AvailableSlotsNotice';
import { useCustomerSchedulePreview } from './jobs/useCustomerSchedulePreview';
import { useAvailableSlotSearch } from './jobs/useAvailableSlotSearch';
import { PriorityChip } from './ui/PriorityChip';
import { StatusChip } from './ui/StatusChip';
import { RecordDescriptions, WorkflowSteps, type RecordDescriptionItem } from './ui/antd';
import {
  FollowUpBadge,
  FollowUpBreadcrumb,
  FollowUpChildrenPanel,
  FollowUpCreateAction,
  FollowUpRecommendation,
  FollowUpSourcePanel,
} from './jobs/FollowUpContinuity';

type StaffCommand = 'start' | 'submit';
type PendingInteraction = LifecycleCommand | 'WITHDRAW_AND_EDIT_JOB_FIELDS';
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
) {
  const input = { clientActionId: dependencies.createActionId(), expectedVersion: job.version };
  try {
    const updated = command === 'start'
      ? await dependencies.start(job.id, input)
      : await dependencies.submit(job.id, {
          ...input,
          note: note.trim(),
          ...(requiresMandatoryFollowUpProposal(job) && followUpProposal
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
) {
  if (job.status !== 'WAITING_APPROVAL') return job;
  return withdraw(job.id, { clientActionId, expectedVersion: job.version });
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
      <div className="field-group">
        <label htmlFor={fieldId}>Gerçekleşen teslim zamanı</label>
        <input
          id={fieldId}
          name="deliveredAt"
          type="datetime-local"
          value={localValue}
          required
          disabled={pending}
          aria-invalid={fieldError ? true : undefined}
          aria-describedby={fieldError ? `${fieldId}-error` : undefined}
          onChange={(event) => {
            setLocalValue(event.target.value);
            setFieldError('');
            setSubmitError('');
          }}
        />
        {fieldError && <span id={`${fieldId}-error`} className="field-error">{fieldError}</span>}
      </div>
      {submitError && <p className="field-error" role="alert">{submitError}</p>}
      <div className="review-buttons">
        <button className="secondary-button" type="submit" disabled={pending}>
          {pending ? 'Kaydediliyor…' : 'Gerçekleşen teslim zamanını kaydet'}
        </button>
      </div>
    </form>
  );
}

function JobScheduleEditForm({
  job,
  scheduleEdit,
  pending,
  user,
  onSave,
}: {
  job: JobCard;
  scheduleEdit: ScheduleEditPresentation;
  pending: boolean;
  user: CurrentUser;
  onSave?: (
    scheduledAt: string | null,
    scheduledEndsAt?: string | null,
    overrideReason?: string | null,
  ) => Promise<void> | void;
}) {
  const intervalJob = job.type === 'SALES_MEETING' || job.type === 'PRODUCT_DELIVERY';
  const intervalJobType: 'SALES_MEETING' | 'PRODUCT_DELIVERY' = intervalJob
    ? job.type as 'SALES_MEETING' | 'PRODUCT_DELIVERY'
    : 'SALES_MEETING';
  const [localValue, setLocalValue] = useState(() => (
    job.scheduledAt ? isoInstantToLocalDateTime(job.scheduledAt) : ''
  ));
  const [fieldError, setFieldError] = useState('');
  const [submitError, setSubmitError] = useState('');
  const [overrideReason, setOverrideReason] = useState('');
  const canonicalKey = `${job.id}:${job.version}:${job.scheduledAt ?? ''}:${job.scheduledEndsAt ?? ''}`;
  const lastKey = useRef(canonicalKey);

  const { evaluation, previewing } = useCustomerSchedulePreview({
    type: job.type,
    customerId: job.customerId,
    scheduledLocal: localValue,
    jobCardId: job.id,
    enabled: job.type === 'SALES_MEETING' || job.type === 'PRODUCT_DELIVERY',
  });
  const availableSlotSearch = useAvailableSlotSearch({
    type: intervalJobType,
    customerId: job.customerId,
    assignedTo: job.assignedTo,
    scheduledStartLocal: localValue,
    jobCardId: job.id,
    enabled: user.capabilities?.calendar === true && intervalJob,
  });

  function useSuggestedAlternative() {
    if (!evaluation?.suggestedAlternativeAt) return;
    const nextStart = isoInstantToLocalDateTime(evaluation.suggestedAlternativeAt);
    setLocalValue(nextStart);
    setFieldError('');
    setSubmitError('');
  }

  function useAvailableSlot(slot: AvailableSlot) {
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
    setOverrideReason('');
  }, [canonicalKey, job.scheduledAt, intervalJob]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !onSave) return;
    setSubmitError('');
    if (!localValue.trim()) {
      if (!scheduleEdit.optional) {
        setFieldError(`${scheduleEdit.label} seçin.`);
        return;
      }
      setFieldError('');
      try {
        await onSave(null, null, overrideReason.trim() || null);
      } catch (caught) {
        setSubmitError(caught instanceof Error ? caught.message : 'Planlanan zaman kaydedilemedi.');
      }
      return;
    }
    setFieldError('');
    try {
      await onSave(
        localDateTimeToIso(localValue),
        undefined,
        overrideReason.trim() || null,
      );
    } catch (caught) {
      setSubmitError(caught instanceof Error ? caught.message : 'Planlanan zaman kaydedilemedi.');
    }
  }

  return (
    <section className="job-schedule-edit surface-flat" aria-labelledby="job-schedule-edit-title">
      <h2 id="job-schedule-edit-title">Planlanan zamanı düzenle</h2>
      <form onSubmit={submit} noValidate>
        <div className="field-group">
          <label htmlFor="job-scheduled-at">
            {scheduleEdit.label}{scheduleEdit.optional ? ' (isteğe bağlı)' : ''}
          </label>
          <input
            id="job-scheduled-at"
            name="scheduledAt"
            type="datetime-local"
            value={localValue}
            required={!scheduleEdit.optional}
            disabled={pending}
            aria-invalid={fieldError ? true : undefined}
            aria-describedby={fieldError ? 'job-scheduled-at-error' : undefined}
            onChange={(event) => {
              setLocalValue(event.target.value);
              setFieldError('');
              setSubmitError('');
            }}
          />
          {fieldError && <span id="job-scheduled-at-error" className="field-error">{fieldError}</span>}
        </div>
        <CustomerScheduleNotice
          evaluation={evaluation}
          mode={user.role === 'STAFF' ? 'staff' : 'manager'}
          overrideReason={overrideReason}
          onOverrideReasonChange={setOverrideReason}
          onUseSuggestedAlternative={useSuggestedAlternative}
        />
        {previewing && <p className="field-status" role="status">Müşteri planı kontrol ediliyor…</p>}
        <AvailableSlotsNotice
          {...availableSlotSearch}
          onSelect={useAvailableSlot}
        />
        {submitError && <p className="field-error" role="alert">{submitError}</p>}
        <div className="review-buttons">
          <button className="secondary-button" type="submit" disabled={pending || !onSave}>
            {pending ? 'Kaydediliyor…' : 'Planlanan zamanı kaydet'}
          </button>
        </div>
      </form>
    </section>
  );
}

export function JobDetailPanel({
  job, items, user, pending, message, messageIsError = false,
  feedbackRef, onBack, onCommand, onRecordEdit, onSaveSchedule, onSaveDeliveredAt,
  meetingDetails = null, records, realtimeStaleNotice, notes, timeline, children,
  pendingLabel, continuity, onCreateFollowUp, messagingAction,
  messagingActionVisible = false,
}: {
  job: JobCard;
  items: DeliveryItem[];
  user: CurrentUser;
  pending: boolean;
  pendingLabel?: string;
  message: string;
  messageIsError?: boolean;
  feedbackRef?: Ref<HTMLDivElement>;
  onBack: () => void;
  onCommand: (command: LifecycleCommand, trigger: HTMLButtonElement) => void;
  onRecordEdit?: (
    action: RecordEditPresentation['action'], trigger: HTMLButtonElement,
  ) => void;
  onSaveSchedule?: (
    scheduledAt: string | null,
    scheduledEndsAt?: string | null,
    overrideReason?: string | null,
  ) => Promise<void> | void;
  onSaveDeliveredAt?: (itemId: string, deliveredAt: string) => Promise<void>;
  meetingDetails?: MeetingDetails | null;
  records?: ReactNode;
  realtimeStaleNotice?: ReactNode;
  notes?: ReactNode;
  timeline?: ReactNode;
  children?: ReactNode;
  continuity?: ReactNode;
  onCreateFollowUp?: () => void;
  messagingAction?: ReactNode;
  messagingActionVisible?: boolean;
}) {
  const presentation = deriveJobWorkflowPresentation({
    job,
    user,
    workflowContext: job.workflowContext,
    deliveryItems: job.type === 'PRODUCT_DELIVERY' ? items : [],
    meetingDetails: job.type === 'SALES_MEETING' ? meetingDetails : null,
  });
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
  const descriptionItems: RecordDescriptionItem[] = [
    { key: 'status', label: 'Durum', content: <StatusChip status={job.status} /> },
    { key: 'assignee', label: 'Sorumlu personel', content: job.assignee.name },
    { key: 'priority', label: 'Öncelik', content: <PriorityChip priority={job.priority} /> },
    {
      key: 'schedule', label: scheduleLabel,
      content: job.scheduledAt
        ? <time dateTime={job.scheduledAt}>{formatScheduledAt(job.scheduledAt)}</time>
        : 'Belirtilmedi',
    },
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
    ...(job.type === 'SALES_MEETING' ? [] : [{
      key: 'due-date', label: 'Son tarih',
      content: job.dueDate ? <time dateTime={job.dueDate}>{job.dueDate}</time> : 'Belirtilmedi',
    }]),
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
    ] : [
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
  const showFollowUpCreateAction = isManagementUser(user)
    && job.status === 'COMPLETED'
    && onCreateFollowUp !== undefined
    && !showFollowUpRecommendation;
  const showRequirements = !managementReview
    && presentation.terminalState === null
    && presentation.requirements.length > 0;
  const hasDecision = Boolean(
    presentation.primaryTransition
    || presentation.secondaryTransitions.length > 0
    || presentation.recordEditAction,
  );
  const requirements = showRequirements
    ? <RequirementsChecklist requirements={presentation.requirements} />
    : null;
  const decision = hasDecision ? (
    <JobDecisionPanel
      primary={presentation.primaryTransition}
      secondary={presentation.secondaryTransitions}
      recordEditAction={presentation.recordEditAction}
      pending={pending}
      pendingLabel={pendingLabel}
      startLocationCaptureEnabled={job.workflowContext.startLocationCaptureEnabled}
      onCommand={onCommand}
      onRecordEdit={onRecordEdit}
    />
  ) : null;
  const hasWorkflowMain = Boolean(requirements || decision);
  const hasRail = Boolean(managementReview || hasWorkflowMain || notes || messagingActionVisible);

  return (
    <main className="job-detail" data-job-detail="true">
      {/* DOM/keyboard: heading → feedback → lifecycle → revision|terminal|responsibility → facts → type content → management-review → actions → notes → timeline */}
      <div className="detail-heading" data-job-detail-section="heading">
        <div className="detail-heading-main">
          <p className="eyebrow detail-type-eyebrow">{typeLabel}</p>
          <h1>{job.title}</h1>
          <div className="detail-heading-meta" data-job-detail-meta="true">
            <StatusChip status={job.status} />
            <PriorityChip priority={job.priority} longLabel />
            <FollowUpBadge visible={job.followUpContext !== null} />
          </div>
        </div>
        <button
          className="secondary-button detail-back-button"
          type="button"
          onClick={onBack}
          disabled={pending}
        >
          Listeye dön
        </button>
      </div>
      {message && (
        <div
          ref={feedbackRef}
          className={`detail-feedback${messageIsError ? ' detail-feedback-error' : ''}`}
          role={messageIsError ? 'alert' : 'status'}
          tabIndex={-1}
          data-job-detail-section="feedback"
        >
          {message}
        </div>
      )}
      {realtimeStaleNotice}
      {continuity}
      {/* DOM order: heading → feedback → lifecycle → revision|terminal|responsibility → facts → type content → management review → actions → notes → timeline */}
      <div data-job-detail-section="lifecycle">
        <WorkflowSteps
          items={presentation.phaseItems.map((item) => ({
            key: item.phase, label: item.label, state: item.state,
          }))}
          currentKey={presentation.currentPhase}
        />
      </div>

      <FollowUpSourcePanel job={job} />
      {showFollowUpRecommendation && onCreateFollowUp && (
        <FollowUpRecommendation job={job} details={meetingDetails} onCreate={onCreateFollowUp} />
      )}
      {showFollowUpCreateAction && onCreateFollowUp && (
        <FollowUpCreateAction onCreate={onCreateFollowUp} />
      )}
      {presentation.revisionLoop && (
        <div data-job-detail-section="revision">
          <RevisionLoopPanel loop={presentation.revisionLoop} />
        </div>
      )}
      {presentation.terminalDetails && (
        <div data-job-detail-section="terminal">
          <TerminalJobBanner details={presentation.terminalDetails} />
        </div>
      )}
      {presentation.terminalState === null && (
        <div data-job-detail-section="responsibility">
          <CurrentResponsibilityPanel presentation={presentation} assigneeName={job.assignee.name} />
        </div>
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
              pending={pending}
              user={user}
              onSave={onSaveSchedule}
            />
          )}

          {job.type === 'PRODUCT_DELIVERY' && (
            <section
              className="delivery-lines"
              aria-labelledby="delivery-lines-title"
              data-job-detail-block="delivery"
            >
              <h2 id="delivery-lines-title">Teslim bilgileri</h2>
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
                        pending={pending}
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
                  {decision}
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
          </aside>
        )}
      </div>

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
  | { kind: 'PRODUCT_DELIVERY'; job: JobCard & { type: 'PRODUCT_DELIVERY' }; deliveryItems: DeliveryItem[] }
  | { kind: 'GENERAL_TASK'; job: JobCard & { type: 'GENERAL_TASK' } }
  | { kind: 'SALES_MEETING'; job: JobCard & { type: 'SALES_MEETING' }; meetingDetails: MeetingDetails | null };
type DetailState = { kind: 'loading' } | { kind: 'ready'; detail: LoadedJobDetail }
  | { kind: 'error'; message: string; retryable: boolean };

async function loadJobDetailOnce(jobId: string): Promise<LoadedJobDetail> {
  const job = await getJobCard(jobId);
  if (job.type === 'PRODUCT_DELIVERY') {
    return {
      kind: job.type,
      job: { ...job, type: job.type },
      deliveryItems: await listDeliveryItems(jobId),
    };
  }
  if (job.type === 'GENERAL_TASK') {
    return { kind: job.type, job: { ...job, type: job.type } };
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
  if (detail.kind !== 'SALES_MEETING' || detail.meetingDetails === null
    || detail.job.version === detail.meetingDetails.jobCardVersion) return detail;
  detail = await loadJobDetailOnce(jobId);
  if (detail.kind !== 'SALES_MEETING' || detail.meetingDetails === null
    || detail.job.version !== detail.meetingDetails.jobCardVersion) {
    throw new ApiError(409, 'VERSION_CONFLICT', 'İş ve görüşme bilgileri eşleşmedi. Tekrar deneyin.', true);
  }
  return detail;
}

async function executeLifecycleCommand(
  jobId: string,
  command: LifecycleCommand,
  input: StartJobCardInput & {
    followUpProposal?: FollowUpProposalInput;
    followUp?: FollowUpProposalInput & { overrideReason?: string };
  },
  reason: string,
): Promise<JobCard> {
  switch (command) {
    case 'ACCEPT_ASSIGNMENT':
      return acceptJobCard(jobId, input);
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
      return cancelJobCard(jobId, { ...input, cancelReason: reason });
    default: {
      const _exhaustive: never = command;
      throw new Error(`Unsupported lifecycle command: ${_exhaustive}`);
    }
  }
}

export function JobDetailScreen({ jobId, user, onBack, onChanged, onCreateFollowUp, onOpenMessaging }: JobDetailScreenProps) {
  return <JobDetailSessionScreen key={jobId} jobId={jobId} user={user} onBack={onBack} onChanged={onChanged} onCreateFollowUp={onCreateFollowUp} onOpenMessaging={onOpenMessaging} />;
}

type JobDetailScreenProps = {
  jobId: string;
  user: CurrentUser;
  onBack: () => void;
  onChanged: () => void;
  onCreateFollowUp?: () => void;
  onOpenMessaging?: (conversationId: string) => void;
};

let sessionTokenCounter = 0;

function nextSessionToken() {
  sessionTokenCounter += 1;
  return sessionTokenCounter;
}

function JobDetailSessionScreen({ jobId, user, onBack, onChanged, onCreateFollowUp, onOpenMessaging }: JobDetailScreenProps) {
  const [state, setState] = useState<DetailState>({ kind: 'loading' });
  const reassignmentSync = useReassignmentConversationSync(jobId);
  const [pending, setPending] = useState(false);
  const [startPendingPhase, setStartPendingPhase] = useState<'capturing' | 'submitting' | null>(null);
  const [message, setMessage] = useState('');
  const [messageIsError, setMessageIsError] = useState(false);
  const [meetingSubmissionError, setMeetingSubmissionError] = useState<ApiError | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [timelineKey, setTimelineKey] = useState(0);
  const [lifecycleNoteKey, setLifecycleNoteKey] = useState(0);
  const [notesRealtimeKey, setNotesRealtimeKey] = useState(0);
  const [messagingActionVisible, setMessagingActionVisible] = useState(false);
  const [dialog, setDialog] = useState<JobWorkflowDialogKind | null>(null);
  const [followUp, setFollowUp] = useState<{
    draft: FollowUpDraft | null;
    origin: FollowUpProposalOrigin | null;
    evaluation: CustomerScheduleEvaluation | null;
    assigneeName: string;
    assignees: RelatedName[];
    overrideReason: string;
    inlineError: string | null;
  } | null>(null);
  const dialogTriggerRef = useRef<HTMLElement | null>(null);
  const dialogFocusRestoreEnabledRef = useRef(true);
  const mutationInFlight = useRef(false);
  const actionIds = useRef<Partial<Record<PendingInteraction, string>>>({});
  const startCapture = useRef<{
    clientActionId: string;
    capture: StartLocationCapture;
  } | null>(null);
  const feedbackRef = useRef<HTMLDivElement>(null);
  const [feedbackFocusRequest, setFeedbackFocusRequest] = useState(0);
  const [editing, setEditing] = useState(false);
  const [realtimeStale, setRealtimeStale] = useState(false);
  const [realtimeReloadPending, setRealtimeReloadPending] = useState(false);
  const sessionLifetime = useRef({
    jobId,
    token: nextSessionToken(),
    active: true,
  });
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

  function hasPendingRealtimeInvalidation() {
    return realtimeInvalidationGeneration.current > reconciledRealtimeGeneration.current;
  }

  function markReconciledThrough(generationSnapshot: number) {
    if (generationSnapshot > reconciledRealtimeGeneration.current) {
      reconciledRealtimeGeneration.current = generationSnapshot;
    }
    if (realtimeInvalidationGeneration.current <= reconciledRealtimeGeneration.current) {
      setRealtimeStale(false);
    }
  }

  function startMutationOperation() {
    const sessionToken = sessionLifetime.current.token;
    if (!sessionLifetime.current.active) return null;
    if (mutationOwner.current?.sessionToken === sessionToken) return null;
    const owner = { sessionToken, operationToken: ++mutationOperationToken.current };
    mutationOwner.current = owner;
    mutationInFlight.current = true;
    return owner;
  }

  function endMutationOperation(owner: { sessionToken: number; operationToken: number } | null) {
    if (owner && mutationOwner.current?.sessionToken === owner.sessionToken
      && mutationOwner.current?.operationToken === owner.operationToken) {
      mutationOwner.current = null;
      mutationInFlight.current = false;
      setPending(false);
      setStartPendingPhase(null);
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
    actionIds.current = {};
    startCapture.current = null;
    dialogTriggerRef.current = null;
    dialogFocusRestoreEnabledRef.current = true;
    setRealtimeStale(false);
    setRealtimeReloadPending(false);
    setEditing(false);
    setPending(false);
    setMessage('');
    setMessageIsError(false);
    setMeetingSubmissionError(null);
    setDialog(null);
    setStartPendingPhase(null);
  }, [jobId]);

  useEffect(() => {
    let active = true; setState({ kind: 'loading' });
    loadJobDetail(jobId)
      .then((detail) => { if (active) setState({ kind: 'ready', detail }); })
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

  function closeDialog() {
    // Focus restoration is owned by ConfirmationAction / ReasonDialog.
    dialogFocusRestoreEnabledRef.current = true;
    setDialog(null);
    setFollowUp(null);
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
    try {
      for (let round = 0; round < MAX_REALTIME_DRAIN_ROUNDS; round += 1) {
        const generationAtStart = realtimeInvalidationGeneration.current;
        const epochAtStart = mutationEpoch.current;
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
    } catch {
      if (isOperationCurrent(sessionToken, operationJobId)) {
        setRealtimeStale(true);
      }
      return true;
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
  useRealtimeInvalidation([`job-detail:${jobId}`], () => {
    realtimeInvalidationGeneration.current += 1;
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
  async function execute(
    command: LifecycleCommand,
    reason = '',
    extra?: {
      followUpProposal?: FollowUpProposalInput;
      followUp?: FollowUpProposalInput & { overrideReason?: string };
    },
  ) {
    if (state.kind !== 'ready' || mutationOwner.current?.sessionToken === sessionLifetime.current.token) return;
    const owner = startMutationOperation();
    if (!owner) return;
    const operationJobId = jobId;
    mutationEpoch.current += 1;
    setPending(true); setMessage(''); setMessageIsError(false); setMeetingSubmissionError(null);
    actionIds.current[command] ??= crypto.randomUUID();
    const input = { clientActionId: actionIds.current[command]!, expectedVersion: state.detail.job.version };
    const presentation = presentationFor(state.detail);
    try {
      let commandInput: StartJobCardInput & {
        followUpProposal?: FollowUpProposalInput;
        followUp?: FollowUpProposalInput & { overrideReason?: string };
      } = input;
      if (command === 'START' && state.detail.job.workflowContext.startLocationCaptureEnabled) {
        if (startCapture.current?.clientActionId !== input.clientActionId) {
          setStartPendingPhase('capturing');
          const capture = await captureStartLocation();
          if (!isOperationCurrent(owner.sessionToken, operationJobId)) return;
          startCapture.current = { clientActionId: input.clientActionId, capture };
        }
        if (!isOperationCurrent(owner.sessionToken, operationJobId)) return;
        setStartPendingPhase('submitting');
        commandInput = { ...input, locationCapture: startCapture.current.capture };
      }
      if (extra?.followUpProposal) commandInput = { ...commandInput, followUpProposal: extra.followUpProposal };
      if (extra?.followUp) commandInput = { ...commandInput, followUp: extra.followUp };
      const updated = await executeLifecycleCommand(operationJobId, command, commandInput, reason);
      if (!isOperationCurrent(owner.sessionToken, operationJobId)) return;
      if (state.detail.kind === 'SALES_MEETING' && command === 'START') {
        if (!(await refreshTruth())) return;
        if (!(await requestRealtimeDrain())) return;
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
          if (!(await requestRealtimeDrain())) return;
        }
      }
      if (!isOperationCurrent(owner.sessionToken, operationJobId)) return;
      delete actionIds.current[command];
      if (command === 'START') startCapture.current = null;
      setTimelineKey((value) => value + 1);
      setLifecycleNoteKey((value) => value + 1);
      const completedDialogCommand = dialog !== null;
      if (completedDialogCommand) {
        setDialog(null);
        setFollowUp(null);
      }
      const transition = findTransition(presentation, command);
      if (transition) setMessage(transition.successMessage);
      if (completedDialogCommand) setFeedbackFocusRequest((value) => value + 1);
      onChanged();
    } catch (caught) {
      if (!isOperationCurrent(owner.sessionToken, operationJobId)) return;
      if (caught instanceof ApiError && (caught.code === 'VERSION_CONFLICT' || caught.code === 'INVALID_TRANSITION')) {
        delete actionIds.current[command];
        if (command === 'START') startCapture.current = null;
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
        setFollowUp(null);
        setFeedbackFocusRequest((value) => value + 1);
      } else {
        if (!(caught instanceof ApiError) || !caught.retryable) {
          delete actionIds.current[command];
          if (command === 'START') startCapture.current = null;
        }
        if (hasPendingRealtimeInvalidation()) {
          setRealtimeStale(true);
        }
        const dialogErrorCodes = [
          'FOLLOW_UP_PROPOSAL_REQUIRED', 'FOLLOW_UP_PROPOSAL_INVALID',
          'FOLLOW_UP_OVERRIDE_REASON_REQUIRED', 'FOLLOW_UP_CUSTOMER_CONFLICT',
          'FOLLOW_UP_SOURCE_CUSTOMER_REQUIRED', 'ASSIGNEE_NOT_FOUND',
        ];
        if (caught instanceof ApiError && dialogErrorCodes.includes(caught.code)
          && dialog !== null && (dialog.kind === 'submit' || dialog.kind === 'approve')) {
          setFollowUp((current) => current ? { ...current, inlineError: caught.message } : current);
          if (caught.code === 'FOLLOW_UP_CUSTOMER_CONFLICT'
            && typeof caught.details?.suggestedAlternativeAt === 'string') {
            setFollowUp((current) => current ? {
              ...current,
              inlineError: caught.message,
              evaluation: current.evaluation
                ? { ...current.evaluation, suggestedAlternativeAt: caught.details!.suggestedAlternativeAt as string }
                : current.evaluation,
            } : current);
          }
          return;
        }
        setMessage(caught instanceof ApiError ? caught.message : 'İşlem tamamlanamadı. Lütfen tekrar deneyin.');
        setMessageIsError(true);
        if (caught instanceof ApiError && caught.code === 'MEETING_NOT_READY') {
          setMeetingSubmissionError(caught);
          dialogFocusRestoreEnabledRef.current = false;
          setDialog(null);
          setFollowUp(null);
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
    try {
      const meetingDetails = await patchMeetingDetails(operationJobId, input);
      if (!isOperationCurrent(owner.sessionToken, operationJobId)) return meetingDetails;
      if (!(await refreshTruth())) return meetingDetails;
      if (!(await requestRealtimeDrain())) return meetingDetails;
      setTimelineKey((value) => value + 1);
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
    if (state.kind !== 'ready'
      || !['SALES_MEETING', 'PRODUCT_DELIVERY', 'GENERAL_TASK'].includes(state.detail.kind)) return;
    if (action === 'EDIT_JOB_FIELDS') {
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
    actionIds.current.WITHDRAW_AND_EDIT_JOB_FIELDS ??= crypto.randomUUID();
    try {
      const updated = await prepareMeetingEdit(
        state.detail.job,
        actionIds.current.WITHDRAW_AND_EDIT_JOB_FIELDS,
        withdrawJobCardFromApproval,
      );
      if (!isOperationCurrent(owner.sessionToken, operationJobId)) return;
      delete actionIds.current.WITHDRAW_AND_EDIT_JOB_FIELDS;
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
        delete actionIds.current.WITHDRAW_AND_EDIT_JOB_FIELDS;
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
        if (!(caught instanceof ApiError) || !caught.retryable) {
          delete actionIds.current.WITHDRAW_AND_EDIT_JOB_FIELDS;
        }
        if (hasPendingRealtimeInvalidation()) {
          setRealtimeStale(true);
        }
        setMessage(caught instanceof ApiError ? caught.message : 'Düzenleme başlatılamadı.');
      }
      setMessageIsError(true); setFeedbackFocusRequest((value) => value + 1);
    } finally { endMutationOperation(owner); }
  }
  async function saveJobPatch(input: PatchJobCardInput, successMessage: string) {
    if (state.kind !== 'ready'
      || mutationOwner.current?.sessionToken === sessionLifetime.current.token) return;
    const owner = startMutationOperation();
    if (!owner) return;
    const operationJobId = jobId;
    mutationEpoch.current += 1;
    setPending(true); setMessage(''); setMessageIsError(false);
    try {
      const patched = await patchJobCard(operationJobId, input);
      if (!isOperationCurrent(owner.sessionToken, operationJobId)) return;
      if (!(await refreshTruth())) return;
      setEditing(false); setTimelineKey((value) => value + 1);
      if (!(await requestRealtimeDrain())) return;
      setMessage(successMessage); onChanged();
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
    } catch (caught) {
      if (!isOperationCurrent(owner.sessionToken, operationJobId)) return;
      if (caught instanceof ApiError && caught.code === 'VERSION_CONFLICT') {
        if (!(await refreshTruth())) return;
        setEditing(false);
        if (!(await requestRealtimeDrain())) return;
        setMessage('İş başka bir işlemle güncellendi. En güncel durum gösteriliyor.');
      } else {
        if (hasPendingRealtimeInvalidation()) {
          setRealtimeStale(true);
        }
        setMessage(caught instanceof ApiError ? caught.message : 'İş güncellenemedi.');
      }
      setMessageIsError(true); setFeedbackFocusRequest((value) => value + 1);
    } finally { endMutationOperation(owner); }
  }
  function saveJob(input: PatchJobCardInput) {
    return saveJobPatch(input, 'Görüşme bilgileri güncellendi.');
  }
  function saveDeliveryAssignee(assignedTo: string) {
    if (state.kind !== 'ready') return Promise.resolve();
    return saveJobPatch(
      { expectedVersion: state.detail.job.version, assignedTo },
      'Sorumlu personel güncellendi.',
    );
  }
  function saveGeneralTask(input: GeneralTaskEditInput) {
    if (state.kind !== 'ready') return Promise.resolve();
    return saveJobPatch(
      { expectedVersion: state.detail.job.version, ...input },
      'Görev bilgileri güncellendi.',
    );
  }
  async function saveSchedule(
    scheduledAt: string | null,
    scheduledEndsAt?: string | null,
    overrideReason?: string | null,
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
    try {
      await patchJobCard(operationJobId, {
        expectedVersion: state.detail.job.version,
        scheduledAt,
        ...(state.detail.job.type === 'SALES_MEETING' || state.detail.job.type === 'PRODUCT_DELIVERY')
          && scheduledEndsAt !== undefined
          ? { scheduledEndsAt }
          : {},
        ...(overrideReason?.trim() ? { overrideReason: overrideReason.trim() } : {}),
      });
      if (!isOperationCurrent(owner.sessionToken, operationJobId)) return;
      if (!(await refreshTruth())) return;
      if (!(await requestRealtimeDrain())) return;
      setTimelineKey((value) => value + 1);
      setMessage('Planlanan zaman güncellendi.');
      setFeedbackFocusRequest((value) => value + 1);
      onChanged();
    } catch (caught) {
      if (!isOperationCurrent(owner.sessionToken, operationJobId)) throw caught;
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
      setMessage(caught instanceof ApiError ? caught.message : 'Planlanan zaman kaydedilemedi.');
      setMessageIsError(true);
      setFeedbackFocusRequest((value) => value + 1);
      throw caught instanceof Error
        ? caught
        : new Error('Planlanan zaman kaydedilemedi.');
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
    try {
      await patchDeliveryItem(operationJobId, itemId, {
        expectedVersion: state.detail.job.version,
        deliveredAt,
      });
      if (!isOperationCurrent(owner.sessionToken, operationJobId)) return;
      if (!(await refreshTruth())) return;
      if (!(await requestRealtimeDrain())) return;
      setTimelineKey((value) => value + 1);
      setMessage('Gerçekleşen teslim zamanı kaydedildi.');
      setFeedbackFocusRequest((value) => value + 1);
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
  function command(commandName: LifecycleCommand, trigger: HTMLElement) {
    if (state.kind !== 'ready') return;
    const presentation = presentationFor(state.detail);
    if (commandName === 'APPROVE') {
      const transition = findTransition(presentation, 'APPROVE');
      if (!transition) return;
      dialogTriggerRef.current = trigger;
      dialogFocusRestoreEnabledRef.current = true;
      setDialog({ kind: 'approve', presentation: transition });
      void prepareApproveFollowUp(state.detail.job);
      return;
    }
    if (commandName === 'SUBMIT_FOR_APPROVAL') {
      const transition = findTransition(presentation, 'SUBMIT_FOR_APPROVAL');
      if (!transition) return;
      dialogTriggerRef.current = trigger;
      dialogFocusRestoreEnabledRef.current = true;
      setDialog({ kind: 'submit', presentation: transition });
      void prepareSubmitFollowUp(state.detail.job);
      return;
    }
    if (commandName === 'REQUEST_REVISION') {
      const transition = findTransition(presentation, 'REQUEST_REVISION');
      if (!transition) return;
      dialogTriggerRef.current = trigger;
      dialogFocusRestoreEnabledRef.current = true;
      setDialog({ kind: 'revision', presentation: transition });
      return;
    }
    if (commandName === 'CANCEL') {
      const transition = findTransition(presentation, 'CANCEL');
      if (!transition) return;
      dialogTriggerRef.current = trigger;
      dialogFocusRestoreEnabledRef.current = true;
      setDialog({ kind: 'cancel', presentation: transition });
      return;
    }
    void execute(commandName);
  }

  async function prepareSubmitFollowUp(job: JobCard) {
    if (!requiresMandatoryFollowUpProposal(job)) {
      setFollowUp(null);
      return;
    }
    try {
      const suggestion = await getFollowUpSuggestion(job.id);
      setFollowUp({
        draft: {
          scheduledAt: suggestion.scheduledAt ?? '',
          type: suggestion.type,
          assignedTo: suggestion.assignedTo,
          followUpInstructions: suggestion.followUpInstructions,
        },
        origin: null,
        evaluation: suggestion.evaluation,
        assigneeName: job.assignee.name,
        assignees: [],
        overrideReason: '',
        inlineError: null,
      });
    } catch {
      setFollowUp({
        draft: null, origin: null, evaluation: null,
        assigneeName: job.assignee.name, assignees: [], overrideReason: '', inlineError: null,
      });
    }
  }

  async function prepareApproveFollowUp(job: JobCard) {
    const persisted = job.followUpProposal;
    if (!requiresMandatoryFollowUpProposal(job) && !persisted) {
      setFollowUp(null);
      return;
    }
    let evaluation: CustomerScheduleEvaluation | null = null;
    let fallbackDraft: FollowUpDraft | null = null;
    try {
      const suggestion = await getFollowUpSuggestion(job.id, persisted?.scheduledAt);
      evaluation = suggestion.evaluation;
      if (!persisted && suggestion.scheduledAt !== null) {
        fallbackDraft = {
          scheduledAt: suggestion.scheduledAt,
          type: suggestion.type,
          assignedTo: suggestion.assignedTo,
          followUpInstructions: suggestion.followUpInstructions,
        };
      }
    } catch {
      evaluation = null;
    }
    let assignees: RelatedName[] = [];
    try {
      assignees = await listCalendarAssignees();
    } catch {
      assignees = [];
    }
    setFollowUp({
      draft: persisted
        ? {
            scheduledAt: persisted.scheduledAt,
            type: persisted.type,
            assignedTo: persisted.assignedTo,
            followUpInstructions: persisted.followUpInstructions,
          }
        : fallbackDraft,
      origin: persisted?.origin ?? null,
      evaluation,
      assigneeName: job.assignee.name,
      assignees,
      overrideReason: '',
      inlineError: null,
    });
  }

  function updateFollowUpDraft(next: Partial<FollowUpDraft>) {
    setFollowUp((current) => current?.draft
      ? { ...current, draft: { ...current.draft, ...next }, inlineError: null }
      : current);
  }

  function useSuggestedAlternative() {
    setFollowUp((current) => {
      const alternative = current?.evaluation?.suggestedAlternativeAt;
      if (!current?.draft || !alternative) return current;
      return {
        ...current,
        draft: { ...current.draft, scheduledAt: alternative },
        evaluation: current.evaluation
          ? {
              ...current.evaluation,
              level: 'CLEAR',
              conflicts: [],
              safeMessage: null,
              suggestedAlternativeAt: null,
            }
          : current.evaluation,
        inlineError: null,
      };
    });
  }

  function confirmDialog(reason: string) {
    if (!dialog) return;
    if (dialog.kind === 'approve') {
      const job = state.kind === 'ready' ? state.detail.job : null;
      const followUpRequired = job !== null
        && (requiresMandatoryFollowUpProposal(job) || Boolean(job.followUpProposal));
      if (!followUp?.draft) {
        if (!followUpRequired) void execute('APPROVE', reason);
        return;
      }
      if (!followUp.draft.scheduledAt) {
        setFollowUp((current) => current ? { ...current, inlineError: 'Takip tarihi ve saati zorunludur.' } : current);
        return;
      }
      if (!followUp.draft.followUpInstructions.trim()) {
        setFollowUp((current) => current ? { ...current, inlineError: 'Takip kapsamı zorunludur.' } : current);
        return;
      }
      if (followUp.evaluation?.level === 'FREQUENCY_EXCEEDED' && !followUp.overrideReason.trim()) {
        setFollowUp((current) => current ? { ...current, inlineError: 'Sık ziyaret uyarısı için neden zorunludur.' } : current);
        return;
      }
      void execute('APPROVE', reason, {
        followUp: {
          scheduledAt: followUp.draft.scheduledAt,
          type: followUp.draft.type,
          assignedTo: followUp.draft.assignedTo,
          followUpInstructions: followUp.draft.followUpInstructions.trim(),
          ...(followUp.overrideReason.trim()
            ? { overrideReason: followUp.overrideReason.trim() }
            : {}),
        },
      });
      return;
    }
    if (dialog.kind === 'submit') {
      const job = state.kind === 'ready' ? state.detail.job : null;
      const followUpRequired = job !== null && requiresMandatoryFollowUpProposal(job);
      if (!followUp?.draft) {
        if (!followUpRequired) void execute('SUBMIT_FOR_APPROVAL', reason);
        return;
      }
      if (!followUp.draft.scheduledAt) {
        setFollowUp((current) => current ? { ...current, inlineError: 'Takip tarihi ve saati zorunludur.' } : current);
        return;
      }
      if (!followUp.draft.followUpInstructions.trim()) {
        setFollowUp((current) => current ? { ...current, inlineError: 'Takip kapsamı zorunludur.' } : current);
        return;
      }
      void execute('SUBMIT_FOR_APPROVAL', reason, {
        followUpProposal: {
          scheduledAt: followUp.draft.scheduledAt,
          type: followUp.draft.type,
          assignedTo: followUp.draft.assignedTo,
          followUpInstructions: followUp.draft.followUpInstructions.trim(),
        },
      });
      return;
    }
    if (dialog.kind === 'revision') {
      void execute('REQUEST_REVISION', reason);
      return;
    }
    if (dialog.kind === 'cancel') {
      void execute('CANCEL', reason);
      return;
    }
    void confirmWithdrawAndEdit();
  }

  if (state.kind === 'loading') {
    return <main className="job-detail" aria-busy="true"><p>İş detayları yükleniyor</p></main>;
  }
  if (state.kind === 'error') {
    return <main className="job-detail"><ResultState status="error" title="İş yüklenemedi" description={state.message} headingLevel={1}
      action={state.retryable ? <button className="secondary-button" type="button" onClick={() => setReloadKey((value) => value + 1)}>Tekrar dene</button> : undefined}
    /></main>;
  }
  const { detail } = state;
  const actions = detail.job.workflowContext.allowedActions;
  const viewMeeting = actions.includes('VIEW_MEETING_RESULT');
  const editMeeting = actions.includes('EDIT_MEETING_RESULT');
  const viewNotes = actions.includes('VIEW_NOTES');
  const addNote = actions.includes('ADD_NOTE');
  const hasMeetingResult = detail.kind === 'SALES_MEETING' && detail.meetingDetails !== null
    && Object.values({
      meetingAt: detail.meetingDetails.meetingAt,
      outcome: detail.meetingDetails.outcome,
      meetingSummary: detail.meetingDetails.meetingSummary,
      nextFollowUpAt: detail.meetingDetails.nextFollowUpAt,
    }).some((value) => value !== null);
  const showMeetingResult = detail.kind === 'SALES_MEETING'
    && viewMeeting && detail.meetingDetails !== null
    && (detail.job.status !== 'CANCELLED' || hasMeetingResult);

  const recordContent = editing && detail.kind === 'SALES_MEETING'
    ? <SalesMeetingEditForm job={detail.job} user={user}
      pending={pending} onCancel={() => setEditing(false)} onSave={saveJob} />
    : editing && detail.kind === 'PRODUCT_DELIVERY'
      ? <DeliveryAssigneeEditForm job={detail.job}
        pending={pending} onCancel={() => setEditing(false)} onSave={saveDeliveryAssignee} />
      : editing && detail.kind === 'GENERAL_TASK'
        ? <GeneralTaskEditForm job={detail.job} user={user}
          pending={pending} onCancel={() => setEditing(false)} onSave={saveGeneralTask} />
        : showMeetingResult && detail.kind === 'SALES_MEETING' && detail.meetingDetails
        ? <MeetingDetailsSection
          job={detail.job}
          details={detail.meetingDetails}
          user={user}
          canEdit={editMeeting}
          mutationPending={pending}
          submissionError={meetingSubmissionError}
          onSave={saveMeeting}
        />
        : null;

  return <JobDetailPanel
    job={detail.job}
    items={detail.kind === 'PRODUCT_DELIVERY' ? detail.deliveryItems : []}
    user={user}
    pending={pending}
    pendingLabel={startPendingPhase === 'capturing'
      ? 'Konum alınıyor…'
      : startPendingPhase === 'submitting'
        ? 'İş başlatılıyor…'
        : undefined}
    message={message}
    messageIsError={messageIsError}
    feedbackRef={feedbackRef}
    realtimeStaleNotice={realtimeStale ? <div className="detail-feedback detail-feedback-error" role="status">
      <p>Bu iş başka bir oturumda güncellendi. Açık düzenlemeniz korunuyor.</p>
      <button className="secondary-button" type="button" disabled={pending || realtimeReloadPending}
        onClick={() => void reloadStaleTruth()}>{realtimeReloadPending ? 'Yükleniyor…' : 'En güncel bilgileri yükle'}</button>
    </div> : undefined}
    continuity={isManagementUser(user) ? <FollowUpBreadcrumb job={detail.job} /> : undefined}
    onBack={onBack}
    meetingDetails={detail.kind === 'SALES_MEETING' ? detail.meetingDetails : null}
    onCommand={(name, trigger) => command(name, trigger)}
    onRecordEdit={(action, trigger) => {
      openRecordEditDialog(action, trigger);
    }}
    onSaveSchedule={saveSchedule}
    onSaveDeliveredAt={detail.kind === 'PRODUCT_DELIVERY' ? saveDeliveredAt : undefined}
    onCreateFollowUp={onCreateFollowUp}
    records={recordContent}
    notes={viewNotes ? (
      <JobNotes
        jobId={jobId}
        jobType={detail.job.type}
        canAdd={addNote}
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
        onOpenMessaging={onOpenMessaging}
        onVisibilityChange={setMessagingActionVisible}
      />
    ) : undefined}
    messagingActionVisible={messagingActionVisible}
    timeline={<JobTimeline jobId={jobId} refreshKey={timelineKey} />}
  >
    {isManagementUser(user) && <FollowUpChildrenPanel sourceId={jobId} />}
    {dialog && <JobWorkflowDialog
      dialog={dialog}
      pending={pending}
      onClose={closeDialog}
      onConfirm={confirmDialog}
      followUp={(dialog.kind === 'submit' || dialog.kind === 'approve') && followUp
        ? {
            mode: dialog.kind === 'submit' ? 'staff' : 'manager',
            draft: followUp.draft,
            origin: followUp.origin,
            evaluation: followUp.evaluation,
            assigneeName: followUp.assigneeName,
            assignees: followUp.assignees,
            allowTypeEdit: dialog.kind === 'approve',
            overrideReason: followUp.overrideReason,
            inlineError: followUp.inlineError,
            onChange: updateFollowUpDraft,
            onOverrideReasonChange: (value) => setFollowUp((current) => current
              ? { ...current, overrideReason: value }
              : current),
            onUseSuggestedAlternative: useSuggestedAlternative,
          }
        : undefined}
      returnFocusRef={dialogTriggerRef}
      restoreFocusEnabledRef={dialogFocusRestoreEnabledRef}
    />}
    <ReassignmentSyncPrompt
      state={reassignmentSync.state}
      onConfirm={() => { void reassignmentSync.confirm(); }}
      onDismiss={reassignmentSync.dismiss}
    />
  </JobDetailPanel>;
}
