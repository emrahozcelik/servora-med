import {
  useEffect, useRef, useState,
  type ReactNode, type Ref,
} from 'react';

import { ApiError, type CurrentUser } from './services/api';
import {
  approveJobCard, cancelJobCard, getJobCard, getMeetingDetails, listDeliveryItems,
  patchJobCard, patchMeetingDetails, planJobCard,
  requestJobCardRevision, resumeJobCard, startJobCard, submitJobCardForApproval,
  withdrawJobCardFromApproval,
  type DeliveryItem, type JobCard, type LifecycleCommand, type MeetingDetails,
  type PatchJobCardInput, type PatchMeetingDetailsInput,
} from './jobs/jobs-api';
import {
  deriveJobWorkflowPresentation,
  type JobWorkflowPresentation,
  type RecordEditPresentation,
  type TransitionPresentation,
} from './jobs/job-workflow-presentation';
import { JobApprovalReviewPanel } from './jobs/JobApprovalReviewPanel';
import { JobLifecycleSteps } from './jobs/JobLifecycleSteps';
import {
  CancelledJobBanner,
  CurrentResponsibilityPanel,
  RequirementsChecklist,
  RevisionLoopPanel,
} from './jobs/JobWorkflowPanels';
import {
  JobWorkflowDialog,
  type JobWorkflowDialogKind,
} from './jobs/JobWorkflowDialog';
import { MeetingDetailsSection } from './jobs/MeetingDetails';
import { SalesMeetingEditForm } from './jobs/SalesMeetingEditForm';
import { JobNotes } from './jobs/JobNotes';
import { JobTimeline } from './jobs/JobTimeline';
import { jobTypeLabels } from './jobs/job-labels';
import { PriorityChip } from './ui/PriorityChip';
import { StatusChip } from './ui/StatusChip';

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

function ActionGroup(props: {
  presentation: JobWorkflowPresentation;
  job: JobCard;
  pending: boolean;
  onCommand: (command: LifecycleCommand) => void;
  onRecordEdit?: (action: RecordEditPresentation['action']) => void;
}): ReactNode {
  const { presentation, job, pending, onCommand, onRecordEdit } = props;
  const hasTransitions = presentation.primaryTransition !== null
    || presentation.secondaryTransitions.length > 0
    || (job.type === 'SALES_MEETING' && presentation.recordEditAction !== null);
  if (!hasTransitions) return null;

  return (
    <section className="detail-action surface-flat" aria-label="İş işlemleri">
      {presentation.primaryTransition?.consequence && (
        <p>{presentation.primaryTransition.consequence}</p>
      )}
      <div className="review-buttons">
        {presentation.primaryTransition && (
          <button
            key={presentation.primaryTransition.command}
            className="primary-button compact-button"
            type="button"
            disabled={pending}
            onClick={() => onCommand(presentation.primaryTransition!.command)}
          >
            {pending ? 'İşleniyor…' : presentation.primaryTransition.label}
          </button>
        )}
        {job.type === 'SALES_MEETING'
          && presentation.recordEditAction?.action === 'WITHDRAW_AND_EDIT_JOB_FIELDS'
          && (
            <button
              className="secondary-button"
              type="button"
              disabled={pending}
              onClick={() => onRecordEdit?.(presentation.recordEditAction!.action)}
            >
              {pending ? 'İşleniyor…' : presentation.recordEditAction.label}
            </button>
          )}
        {job.type === 'SALES_MEETING'
          && presentation.recordEditAction?.action === 'EDIT_JOB_FIELDS'
          && (
            <button
              className="secondary-button"
              type="button"
              disabled={pending}
              onClick={() => onRecordEdit?.(presentation.recordEditAction!.action)}
            >
              {pending ? 'İşleniyor…' : presentation.recordEditAction.label}
            </button>
          )}
        {presentation.secondaryTransitions.map((transition) => (
          <button
            key={transition.command}
            className="secondary-button"
            type="button"
            disabled={pending}
            onClick={() => onCommand(transition.command)}
          >
            {pending ? 'İşleniyor…' : transition.label}
          </button>
        ))}
      </div>
    </section>
  );
}

export function JobDetailPanel({
  job, items, user, pending, message, messageIsError = false,
  feedbackRef, onBack, onCommand, onRecordEdit, meetingDetails = null,
  records, children,
}: {
  job: JobCard;
  items: DeliveryItem[];
  user: CurrentUser;
  pending: boolean;
  message: string;
  messageIsError?: boolean;
  feedbackRef?: Ref<HTMLDivElement>;
  onBack: () => void;
  onCommand: (command: LifecycleCommand) => void;
  onRecordEdit?: (action: RecordEditPresentation['action']) => void;
  meetingDetails?: MeetingDetails | null;
  records?: ReactNode;
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

  return <main className="job-detail">
    <div className="detail-heading"><div><p className="eyebrow">{jobTypeLabels[job.type]}</p><h1>{job.title}</h1></div>
      <button className="secondary-button" type="button" onClick={onBack} disabled={pending}>Listeye dön</button></div>
    {message && <div ref={feedbackRef} className={`detail-feedback${messageIsError ? ' detail-feedback-error' : ''}`}
      role={messageIsError ? 'alert' : 'status'} tabIndex={-1}>{message}</div>}
    <dl className="detail-summary surface">
      <div><dt>Durum</dt><dd><StatusChip status={job.status} /></dd></div>
      <div><dt>Sorumlu personel</dt><dd>{job.assignee.name}</dd></div>
      <div><dt>Öncelik</dt><dd><PriorityChip priority={job.priority} /></dd></div>
      <div><dt>{job.type === 'SALES_MEETING' ? 'Planlanan görüşme günü' : 'Son tarih'}</dt><dd>{job.dueDate ? <time dateTime={job.dueDate}>{job.dueDate}</time> : 'Belirtilmedi'}</dd></div>
      <div><dt>Müşteri</dt><dd>{job.customer?.name ?? 'Belirtilmedi'}</dd></div>
      <div><dt>İlgili kişi</dt><dd>{job.contact?.name ?? 'Belirtilmedi'}</dd></div>
      <div className="detail-summary-wide"><dt>Açıklama</dt><dd>{job.description ?? 'Belirtilmedi'}</dd></div>
    </dl>

    <JobLifecycleSteps phaseItems={presentation.phaseItems} currentPhase={presentation.currentPhase} />

    {presentation.terminalState === 'CANCELLED' && (
      <CancelledJobBanner lifecycle={job.workflowContext.lifecycle} />
    )}
    {presentation.revisionLoop && <RevisionLoopPanel loop={presentation.revisionLoop} />}
    {!managementReview && presentation.terminalState !== 'CANCELLED' && (
      <CurrentResponsibilityPanel presentation={presentation} assigneeName={job.assignee.name} />
    )}
    <RequirementsChecklist requirements={presentation.requirements} />

    {managementReview && (
      <JobApprovalReviewPanel
        job={job}
        lifecycle={job.workflowContext.lifecycle}
        requirements={presentation.requirements}
      />
    )}

    {job.type === 'PRODUCT_DELIVERY' && <section className="delivery-lines" aria-labelledby="delivery-lines-title"><h2 id="delivery-lines-title">Teslim bilgileri</h2>
      <ul>{items.map((entry) => <li key={entry.id}><div><strong>{entry.productNameSnapshot}</strong><span>{entry.productSkuSnapshot ?? 'Ürün kodu belirtilmedi'}</span></div>
        <dl><div><dt>Amaç</dt><dd>{purposeLabels[entry.deliveryPurpose]}</dd></div><div><dt>Miktar</dt><dd>{entry.quantity}{entry.unit ? ` ${entry.unit}` : ''}</dd></div>
          <div><dt>Teslim zamanı</dt><dd>{new Intl.DateTimeFormat('tr-TR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(entry.deliveredAt))}</dd></div></dl></li>)}</ul>
    </section>}

    {records}

    <ActionGroup
      presentation={presentation}
      job={job}
      pending={pending}
      onCommand={onCommand}
      onRecordEdit={onRecordEdit}
    />

    {children}
  </main>;
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
  input: { clientActionId: string; expectedVersion: number },
  reason: string,
): Promise<JobCard> {
  switch (command) {
    case 'PLAN':
      return planJobCard(jobId, input);
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
  const [message, setMessage] = useState('');
  const [messageIsError, setMessageIsError] = useState(false);
  const [meetingSubmissionError, setMeetingSubmissionError] = useState<ApiError | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [timelineKey, setTimelineKey] = useState(0);
  const [dialog, setDialog] = useState<JobWorkflowDialogKind | null>(null);
  const dialogTriggerRef = useRef<HTMLElement | null>(null);
  const mutationInFlight = useRef(false);
  const actionIds = useRef<Partial<Record<PendingInteraction, string>>>({});
  const feedbackRef = useRef<HTMLDivElement>(null);
  const [feedbackFocusRequest, setFeedbackFocusRequest] = useState(0);
  const [editing, setEditing] = useState(false);

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
    setDialog(null);
    requestAnimationFrame(() => dialogTriggerRef.current?.focus());
  }
  async function refreshTruth() {
    const detail = await loadJobDetail(jobId);
    setState({ kind: 'ready', detail });
    setTimelineKey((value) => value + 1);
  }
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
      const updated = await executeLifecycleCommand(jobId, command, input, reason);
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
      setTimelineKey((value) => value + 1);
      const completedDialogCommand = dialog !== null;
      if (completedDialogCommand) setDialog(null);
      const transition = findTransition(presentation, command);
      setMessage(transition?.successMessage ?? `${transition?.label ?? command} işlemi tamamlandı.`);
      if (completedDialogCommand) setFeedbackFocusRequest((value) => value + 1);
      onChanged();
    } catch (caught) {
      if (caught instanceof ApiError && (caught.code === 'VERSION_CONFLICT' || caught.code === 'INVALID_TRANSITION')) {
        delete actionIds.current[command];
        try { await refreshTruth(); setMessage('İş başka bir işlemle güncellendi. En güncel durum gösteriliyor.'); }
        catch { setMessage('Güncel iş bilgileri alınamadı. Lütfen tekrar deneyin.'); setMessageIsError(true); }
        setDialog(null);
        setFeedbackFocusRequest((value) => value + 1);
      } else {
        if (!(caught instanceof ApiError) || !caught.retryable) delete actionIds.current[command];
        setMessage(caught instanceof ApiError ? caught.message : 'İşlem tamamlanamadı. Lütfen tekrar deneyin.');
        setMessageIsError(true);
        if (caught instanceof ApiError && caught.code === 'MEETING_NOT_READY') {
          setMeetingSubmissionError(caught);
        }
        setFeedbackFocusRequest((value) => value + 1);
      }
    } finally { mutationInFlight.current = false; setPending(false); }
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
      setState({
        kind: 'ready',
        detail: {
          ...state.detail,
          job: { ...state.detail.job, version: meetingDetails.jobCardVersion },
          meetingDetails,
        },
      });
      setTimelineKey((value) => value + 1); onChanged(); return meetingDetails;
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
    message={message}
    messageIsError={messageIsError}
    feedbackRef={feedbackRef}
    onBack={onBack}
    meetingDetails={detail.kind === 'SALES_MEETING' ? detail.meetingDetails : null}
    onCommand={(name) => command(name, document.activeElement as HTMLElement)}
    onRecordEdit={(action) => {
      openRecordEditDialog(action, document.activeElement as HTMLElement);
    }}
    records={recordContent}
  >
    <div className="job-detail-sections">
      {viewNotes && <JobNotes
        jobId={jobId}
        canAdd={addNote}
        hideWhenEmpty={detail.job.status === 'CANCELLED'}
        onAdded={() => setTimelineKey((value) => value + 1)}
      />}
      <JobTimeline jobId={jobId} refreshKey={timelineKey} />
    </div>
    {dialog && <JobWorkflowDialog
      dialog={dialog}
      pending={pending}
      onClose={closeDialog}
      onConfirm={confirmDialog}
    />}
  </JobDetailPanel>;
}
