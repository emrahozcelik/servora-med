import {
  useEffect, useRef, useState,
  type FormEvent, type ReactNode, type Ref,
} from 'react';

import { ApiError, type CurrentUser } from './services/api';
import {
  acceptJobCard, approveJobCard, cancelJobCard, getJobCard, getMeetingDetails, listDeliveryItems,
  patchDeliveryItem, patchJobCard, patchMeetingDetails,
  requestJobCardRevision, resumeJobCard, startJobCard, submitJobCardForApproval,
  withdrawJobCardFromApproval,
  type DeliveryItem, type JobCard, type LifecycleCommand, type MeetingDetails,
  type PatchJobCardInput, type PatchMeetingDetailsInput, type StartJobCardInput,
} from './jobs/jobs-api';
import {
  captureStartLocation,
  type StartLocationCapture,
} from './jobs/start-location-capture';
import {
  deriveJobWorkflowPresentation,
  type JobWorkflowPresentation,
  type RecordEditPresentation,
  type ScheduleEditPresentation,
  type TransitionPresentation,
} from './jobs/job-workflow-presentation';
import {
  isoInstantToLocalDateTime,
  localDateTimeToIso,
} from './jobs/scheduling';
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
import { MeetingDetailsSection } from './jobs/MeetingDetails';
import { SalesMeetingEditForm } from './jobs/SalesMeetingEditForm';
import { JobNotes } from './jobs/JobNotes';
import { JobTimeline } from './jobs/JobTimeline';
import { useRealtimeInvalidation } from './realtime/RealtimeProvider';
import { jobEngagementLabel, jobTypeLabels } from './jobs/job-labels';
import { PriorityChip } from './ui/PriorityChip';
import { StatusChip } from './ui/StatusChip';
import { RecordDescriptions, WorkflowSteps, type RecordDescriptionItem } from './ui/antd';

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

export async function runStaffJobCommand(job: JobCard, command: StaffCommand, dependencies: CommandDependencies = commandDependencies) {
  const input = { clientActionId: dependencies.createActionId(), expectedVersion: job.version };
  try {
    const updated = command === 'start'
      ? await dependencies.start(job.id, input)
      : await dependencies.submit(job.id, input);
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
      ? await dependencies.approve(job.id, base)
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
  onSave,
}: {
  job: JobCard;
  scheduleEdit: ScheduleEditPresentation;
  pending: boolean;
  onSave?: (scheduledAt: string | null) => Promise<void> | void;
}) {
  const [localValue, setLocalValue] = useState(() => (
    job.scheduledAt ? isoInstantToLocalDateTime(job.scheduledAt) : ''
  ));
  const [fieldError, setFieldError] = useState('');
  const [submitError, setSubmitError] = useState('');
  const canonicalKey = `${job.id}:${job.version}:${job.scheduledAt ?? ''}`;
  const lastKey = useRef(canonicalKey);

  useEffect(() => {
    if (lastKey.current === canonicalKey) return;
    lastKey.current = canonicalKey;
    setLocalValue(job.scheduledAt ? isoInstantToLocalDateTime(job.scheduledAt) : '');
    setFieldError('');
    setSubmitError('');
  }, [canonicalKey, job.scheduledAt]);

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
        await onSave(null);
      } catch (caught) {
        setSubmitError(caught instanceof Error ? caught.message : 'Planlanan zaman kaydedilemedi.');
      }
      return;
    }
    setFieldError('');
    try {
      await onSave(localDateTimeToIso(localValue));
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
  pendingLabel,
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
  onSaveSchedule?: (scheduledAt: string | null) => Promise<void> | void;
  onSaveDeliveredAt?: (itemId: string, deliveredAt: string) => Promise<void>;
  meetingDetails?: MeetingDetails | null;
  records?: ReactNode;
  realtimeStaleNotice?: ReactNode;
  notes?: ReactNode;
  timeline?: ReactNode;
  children?: ReactNode;
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

  return (
    <main className="job-detail" data-job-detail="true">
      {/* DOM/keyboard: heading → feedback → lifecycle → revision|terminal|responsibility → facts → type content → management-review → actions/notes → timeline */}
      <div className="detail-heading" data-job-detail-section="heading">
        <div className="detail-heading-main">
          <p className="eyebrow detail-type-eyebrow">{typeLabel}</p>
          <h1>{job.title}</h1>
          <div className="detail-heading-meta" data-job-detail-meta="true">
            <StatusChip status={job.status} />
            <PriorityChip priority={job.priority} longLabel />
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
      {/* DOM order: heading → feedback → lifecycle → revision|terminal|responsibility → facts → type content → management review → actions → notes → timeline */}
      <div data-job-detail-section="lifecycle">
        <WorkflowSteps
          items={presentation.phaseItems.map((item) => ({
            key: item.phase, label: item.label, state: item.state,
          }))}
          currentKey={presentation.currentPhase}
        />
      </div>
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
      <div className="job-detail-content">
        <section
          className="detail-summary surface-flat"
          data-job-detail-section="facts"
          data-job-detail-block="record-facts"
        >
          <RecordDescriptions ariaLabel="İş kayıt bilgileri" items={descriptionItems} />
        </section>

        {presentation.scheduleEdit && (
          <JobScheduleEditForm
            job={job}
            scheduleEdit={presentation.scheduleEdit}
            pending={pending}
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
      </div>

      {(() => {
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
        if (!hasWorkflowMain && !notes) return null;
        if (notes && hasWorkflowMain) {
          return (
            <div
              className="job-detail-workflow-layout"
              data-job-detail-section="actions"
            >
              <div className="job-detail-workflow-main">
                {requirements}
                {decision}
              </div>
              <div className="job-detail-workflow-notes" data-job-detail-block="notes">
                {notes}
              </div>
            </div>
          );
        }
        if (hasWorkflowMain) {
          return (
            <div
              className="job-detail-workflow-main job-detail-workflow-main--full"
              data-job-detail-section="actions"
            >
              {requirements}
              {decision}
            </div>
          );
        }
        return (
          <div
            className="job-detail-workflow-notes job-detail-workflow-notes--full"
            data-job-detail-section="notes"
            data-job-detail-block="notes"
          >
            {notes}
          </div>
        );
      })()}

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
  input: StartJobCardInput,
  reason: string,
): Promise<JobCard> {
  switch (command) {
    case 'ACCEPT_ASSIGNMENT':
      return acceptJobCard(jobId, input);
    case 'START':
      return startJobCard(jobId, input);
    case 'SUBMIT_FOR_APPROVAL':
      return submitJobCardForApproval(jobId, input);
    case 'APPROVE':
      return approveJobCard(jobId, input);
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

export function JobDetailScreen({ jobId, user, onBack, onChanged }: {
  jobId: string;
  user: CurrentUser;
  onBack: () => void;
  onChanged: () => void;
}) {
  const [state, setState] = useState<DetailState>({ kind: 'loading' });
  const [pending, setPending] = useState(false);
  const [startPendingPhase, setStartPendingPhase] = useState<'capturing' | 'submitting' | null>(null);
  const [message, setMessage] = useState('');
  const [messageIsError, setMessageIsError] = useState(false);
  const [meetingSubmissionError, setMeetingSubmissionError] = useState<ApiError | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [timelineKey, setTimelineKey] = useState(0);
  const [dialog, setDialog] = useState<JobWorkflowDialogKind | null>(null);
  const dialogTriggerRef = useRef<HTMLElement | null>(null);
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
  const realtimeRefreshInFlight = useRef(false);

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
    setDialog(null);
  }
  async function refreshTruth() {
    const detail = await loadJobDetail(jobId);
    setState({ kind: 'ready', detail });
    setTimelineKey((value) => value + 1);
  }
  async function reconcileRealtimeTruth() {
    if (pending || editing || mutationInFlight.current) {
      setRealtimeStale(true);
      return;
    }
    if (realtimeRefreshInFlight.current) return;
    realtimeRefreshInFlight.current = true;
    try {
      await refreshTruth();
      setRealtimeStale(false);
    } catch {
      setRealtimeStale(true);
    } finally {
      realtimeRefreshInFlight.current = false;
    }
  }
  async function reloadStaleTruth() {
    if (pending || realtimeRefreshInFlight.current) return;
    realtimeRefreshInFlight.current = true;
    try {
      await refreshTruth();
      setRealtimeStale(false);
    } catch {
      setRealtimeStale(true);
    } finally {
      realtimeRefreshInFlight.current = false;
    }
  }
  useRealtimeInvalidation([`job-detail:${jobId}`], () => {
    void reconcileRealtimeTruth();
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
  async function execute(command: LifecycleCommand, reason = '') {
    if (state.kind !== 'ready' || mutationInFlight.current) return;
    mutationInFlight.current = true;
    setPending(true); setMessage(''); setMessageIsError(false); setMeetingSubmissionError(null);
    actionIds.current[command] ??= crypto.randomUUID();
    const input = { clientActionId: actionIds.current[command]!, expectedVersion: state.detail.job.version };
    const presentation = presentationFor(state.detail);
    try {
      let commandInput: StartJobCardInput = input;
      if (command === 'START' && state.detail.job.workflowContext.startLocationCaptureEnabled) {
        if (startCapture.current?.clientActionId !== input.clientActionId) {
          setStartPendingPhase('capturing');
          startCapture.current = {
            clientActionId: input.clientActionId,
            capture: await captureStartLocation(),
          };
        }
        setStartPendingPhase('submitting');
        commandInput = { ...input, locationCapture: startCapture.current.capture };
      }
      const updated = await executeLifecycleCommand(jobId, command, commandInput, reason);
      if (state.detail.kind === 'SALES_MEETING' && command === 'START') {
        await refreshTruth();
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
      }
      delete actionIds.current[command];
      if (command === 'START') startCapture.current = null;
      setTimelineKey((value) => value + 1);
      const completedDialogCommand = dialog !== null;
      if (completedDialogCommand) setDialog(null);
      const transition = findTransition(presentation, command);
      if (transition) setMessage(transition.successMessage);
      if (completedDialogCommand) setFeedbackFocusRequest((value) => value + 1);
      onChanged();
    } catch (caught) {
      if (caught instanceof ApiError && (caught.code === 'VERSION_CONFLICT' || caught.code === 'INVALID_TRANSITION')) {
        delete actionIds.current[command];
        if (command === 'START') startCapture.current = null;
        try { await refreshTruth(); setMessage('İş başka bir işlemle güncellendi. En güncel durum gösteriliyor.'); }
        catch { setMessage('Güncel iş bilgileri alınamadı. Lütfen tekrar deneyin.'); setMessageIsError(true); }
        setDialog(null);
        setFeedbackFocusRequest((value) => value + 1);
      } else {
        if (!(caught instanceof ApiError) || !caught.retryable) {
          delete actionIds.current[command];
          if (command === 'START') startCapture.current = null;
        }
        setMessage(caught instanceof ApiError ? caught.message : 'İşlem tamamlanamadı. Lütfen tekrar deneyin.');
        setMessageIsError(true);
        if (caught instanceof ApiError && caught.code === 'MEETING_NOT_READY') {
          setMeetingSubmissionError(caught);
        }
        setFeedbackFocusRequest((value) => value + 1);
      }
    } finally {
      mutationInFlight.current = false;
      setPending(false);
      setStartPendingPhase(null);
    }
  }
  async function saveMeeting(input: PatchMeetingDetailsInput) {
    if (state.kind !== 'ready' || state.detail.kind !== 'SALES_MEETING'
      || mutationInFlight.current) {
      throw new ApiError(409, 'ACTION_IN_PROGRESS', 'Başka bir işlem devam ediyor.', true);
    }
    mutationInFlight.current = true;
    setPending(true); setMessage(''); setMessageIsError(false); setMeetingSubmissionError(null);
    try {
      const meetingDetails = await patchMeetingDetails(jobId, input);
      await refreshTruth();
      setTimelineKey((value) => value + 1);
      onChanged();
      return meetingDetails;
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'VERSION_CONFLICT') {
        await refreshTruth();
        throw new ApiError(409, 'VERSION_CONFLICT', 'İş başka bir işlemle güncellendi. En güncel durum gösteriliyor.');
      }
      throw caught;
    } finally { mutationInFlight.current = false; setPending(false); }
  }
  function openRecordEditDialog(action: RecordEditPresentation['action'], trigger: HTMLElement) {
    if (state.kind !== 'ready' || state.detail.kind !== 'SALES_MEETING') return;
    if (action === 'EDIT_JOB_FIELDS') {
      setEditing(true);
      return;
    }
    const presentation = presentationFor(state.detail);
    const recordEdit = presentation.recordEditAction;
    if (!recordEdit || recordEdit.action !== 'WITHDRAW_AND_EDIT_JOB_FIELDS') return;
    dialogTriggerRef.current = trigger;
    setDialog({ kind: 'withdraw-edit', presentation: recordEdit });
  }
  async function confirmWithdrawAndEdit() {
    if (state.kind !== 'ready' || state.detail.kind !== 'SALES_MEETING'
      || mutationInFlight.current) return;
    mutationInFlight.current = true;
    setPending(true); setMessage(''); setMessageIsError(false);
    actionIds.current.WITHDRAW_AND_EDIT_JOB_FIELDS ??= crypto.randomUUID();
    try {
      const updated = await prepareMeetingEdit(
        state.detail.job,
        actionIds.current.WITHDRAW_AND_EDIT_JOB_FIELDS,
        withdrawJobCardFromApproval,
      );
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
    } catch (caught) {
      if (caught instanceof ApiError && (caught.code === 'VERSION_CONFLICT'
        || caught.code === 'INVALID_TRANSITION')) {
        delete actionIds.current.WITHDRAW_AND_EDIT_JOB_FIELDS;
        try { await refreshTruth(); setMessage('İş güncellendi. En güncel durum gösteriliyor.'); }
        catch { setMessage('Güncel iş bilgileri alınamadı. Lütfen tekrar deneyin.'); }
        setDialog(null);
      } else {
        if (!(caught instanceof ApiError) || !caught.retryable) {
          delete actionIds.current.WITHDRAW_AND_EDIT_JOB_FIELDS;
        }
        setMessage(caught instanceof ApiError ? caught.message : 'Düzenleme başlatılamadı.');
      }
      setMessageIsError(true); setFeedbackFocusRequest((value) => value + 1);
    } finally { mutationInFlight.current = false; setPending(false); }
  }
  async function saveJob(input: PatchJobCardInput) {
    if (state.kind !== 'ready' || state.detail.kind !== 'SALES_MEETING'
      || mutationInFlight.current) return;
    mutationInFlight.current = true;
    setPending(true); setMessage(''); setMessageIsError(false);
    try {
      await patchJobCard(jobId, input);
      await refreshTruth(); setEditing(false); setTimelineKey((value) => value + 1);
      setMessage('Görüşme bilgileri güncellendi.'); onChanged();
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'VERSION_CONFLICT') {
        await refreshTruth(); setEditing(false);
        setMessage('İş başka bir işlemle güncellendi. En güncel durum gösteriliyor.');
      } else {
        setMessage(caught instanceof ApiError ? caught.message : 'Görüşme güncellenemedi.');
      }
      setMessageIsError(true); setFeedbackFocusRequest((value) => value + 1);
    } finally { mutationInFlight.current = false; setPending(false); }
  }
  async function saveSchedule(scheduledAt: string | null) {
    if (state.kind !== 'ready' || mutationInFlight.current) {
      throw new ApiError(409, 'ACTION_IN_PROGRESS', 'Başka bir işlem devam ediyor.', true);
    }
    mutationInFlight.current = true;
    setPending(true); setMessage(''); setMessageIsError(false);
    try {
      await patchJobCard(jobId, {
        expectedVersion: state.detail.job.version,
        scheduledAt,
      });
      await refreshTruth();
      setTimelineKey((value) => value + 1);
      setMessage('Planlanan zaman güncellendi.');
      setFeedbackFocusRequest((value) => value + 1);
      onChanged();
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'VERSION_CONFLICT') {
        await refreshTruth();
        setMessage('İş başka bir işlemle güncellendi. En güncel durum gösteriliyor.');
        setMessageIsError(true);
        setFeedbackFocusRequest((value) => value + 1);
        throw new ApiError(409, 'VERSION_CONFLICT', 'İş başka bir işlemle güncellendi. En güncel durum gösteriliyor.');
      }
      setMessage(caught instanceof ApiError ? caught.message : 'Planlanan zaman kaydedilemedi.');
      setMessageIsError(true);
      setFeedbackFocusRequest((value) => value + 1);
      throw caught instanceof Error
        ? caught
        : new Error('Planlanan zaman kaydedilemedi.');
    } finally {
      mutationInFlight.current = false;
      setPending(false);
    }
  }
  async function saveDeliveredAt(itemId: string, deliveredAt: string) {
    if (state.kind !== 'ready' || state.detail.kind !== 'PRODUCT_DELIVERY'
      || mutationInFlight.current) {
      throw new ApiError(409, 'ACTION_IN_PROGRESS', 'Başka bir işlem devam ediyor.', true);
    }
    mutationInFlight.current = true;
    setPending(true); setMessage(''); setMessageIsError(false);
    try {
      await patchDeliveryItem(jobId, itemId, {
        expectedVersion: state.detail.job.version,
        deliveredAt,
      });
      await refreshTruth();
      setTimelineKey((value) => value + 1);
      setMessage('Gerçekleşen teslim zamanı kaydedildi.');
      setFeedbackFocusRequest((value) => value + 1);
      onChanged();
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'VERSION_CONFLICT') {
        await refreshTruth();
        setMessage('İş başka bir işlemle güncellendi. En güncel durum gösteriliyor.');
        setMessageIsError(true);
        setFeedbackFocusRequest((value) => value + 1);
        throw new ApiError(
          409,
          'VERSION_CONFLICT',
          'İş başka bir işlemle güncellendi. En güncel durum gösteriliyor.',
        );
      }
      setMessage(caught instanceof ApiError ? caught.message : 'Gerçekleşen teslim zamanı kaydedilemedi.');
      setMessageIsError(true);
      setFeedbackFocusRequest((value) => value + 1);
      throw caught instanceof Error
        ? caught
        : new Error('Gerçekleşen teslim zamanı kaydedilemedi.');
    } finally {
      mutationInFlight.current = false;
      setPending(false);
    }
  }
  function command(commandName: LifecycleCommand, trigger: HTMLElement) {
    if (state.kind !== 'ready') return;
    const presentation = presentationFor(state.detail);
    if (commandName === 'APPROVE') {
      const transition = findTransition(presentation, 'APPROVE');
      if (!transition) return;
      dialogTriggerRef.current = trigger;
      setDialog({ kind: 'approve', presentation: transition });
      return;
    }
    if (commandName === 'REQUEST_REVISION') {
      const transition = findTransition(presentation, 'REQUEST_REVISION');
      if (!transition) return;
      dialogTriggerRef.current = trigger;
      setDialog({ kind: 'revision', presentation: transition });
      return;
    }
    if (commandName === 'CANCEL') {
      const transition = findTransition(presentation, 'CANCEL');
      if (!transition) return;
      dialogTriggerRef.current = trigger;
      setDialog({ kind: 'cancel', presentation: transition });
      return;
    }
    void execute(commandName);
  }

  function confirmDialog(reason: string) {
    if (!dialog) return;
    if (dialog.kind === 'approve') {
      void execute('APPROVE');
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
    return <main className="job-detail"><div className="workspace-message" role="alert"><h1>İş yüklenemedi</h1><p>{state.message}</p>
      {state.retryable && <button className="secondary-button" type="button" onClick={() => setReloadKey((value) => value + 1)}>Tekrar dene</button>}</div></main>;
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
      <button className="secondary-button" type="button" disabled={pending}
        onClick={() => void reloadStaleTruth()}>En güncel bilgileri yükle</button>
    </div> : undefined}
    onBack={onBack}
    meetingDetails={detail.kind === 'SALES_MEETING' ? detail.meetingDetails : null}
    onCommand={(name, trigger) => command(name, trigger)}
    onRecordEdit={(action, trigger) => {
      openRecordEditDialog(action, trigger);
    }}
    onSaveSchedule={saveSchedule}
    onSaveDeliveredAt={detail.kind === 'PRODUCT_DELIVERY' ? saveDeliveredAt : undefined}
    records={recordContent}
    notes={viewNotes ? (
      <JobNotes
        jobId={jobId}
        canAdd={addNote}
        hideWhenEmpty={detail.job.status === 'CANCELLED'}
        onAdded={() => setTimelineKey((value) => value + 1)}
      />
    ) : undefined}
    timeline={<JobTimeline jobId={jobId} refreshKey={timelineKey} />}
  >
    {dialog && <JobWorkflowDialog
      dialog={dialog}
      pending={pending}
      onClose={closeDialog}
      onConfirm={confirmDialog}
      returnFocusRef={dialogTriggerRef}
    />}
  </JobDetailPanel>;
}
