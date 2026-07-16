import {
  useEffect, useId, useRef, useState,
  type FormEvent, type KeyboardEvent, type ReactNode, type Ref,
} from 'react';

import { ApiError, type CurrentUser } from './services/api';
import {
  approveJobCard, cancelJobCard, getJobCard, getMeetingDetails, listDeliveryItems,
  patchJobCard, patchMeetingDetails, planJobCard,
  requestJobCardRevision, resumeJobCard, startJobCard, submitJobCardForApproval,
  withdrawJobCardFromApproval,
  type DeliveryItem, type JobCard, type MeetingDetails, type PatchJobCardInput,
  type PatchMeetingDetailsInput,
} from './jobs/jobs-api';
import { MeetingDetailsSection } from './jobs/MeetingDetails';
import { SalesMeetingEditForm } from './jobs/SalesMeetingEditForm';
import { JobNotes } from './jobs/JobNotes';
import { JobTimeline } from './jobs/JobTimeline';
import { jobTypeLabels } from './jobs/job-labels';
import { jobCapabilities } from './jobs/job-capabilities';
import { PriorityChip } from './ui/PriorityChip';
import { StatusChip } from './ui/StatusChip';

type StaffCommand = 'start' | 'submit';
export type LifecycleCommand = 'edit' | 'plan' | 'start' | 'submit' | 'approve' | 'revise' | 'withdraw' | 'resume' | 'cancel';
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

export function availableLifecycleCommands(job: JobCard, role: CurrentUser['role']): LifecycleCommand[] {
  if (job.status === 'COMPLETED' || job.status === 'CANCELLED') return [];
  const meetingEdit: LifecycleCommand[] = job.type === 'SALES_MEETING' ? ['edit'] : [];
  if (role === 'STAFF') {
    if (job.status === 'NEW') return [...meetingEdit, 'plan', 'start', 'cancel'];
    if (job.status === 'PLANNED') return [...meetingEdit, 'start', 'cancel'];
    if (job.status === 'IN_PROGRESS') return [...meetingEdit, 'submit', 'cancel'];
    if (job.status === 'REVISION_REQUESTED') return [...meetingEdit, 'resume', 'cancel'];
    if (job.status === 'WAITING_APPROVAL') return job.type === 'SALES_MEETING'
      ? ['edit', 'cancel'] : ['withdraw', 'cancel'];
    return [];
  }
  if (job.status === 'WAITING_APPROVAL') return [
    'approve', 'revise', ...meetingEdit, 'cancel',
  ];
  const commands: LifecycleCommand[] = [...meetingEdit];
  if (job.status === 'NEW') commands.push('plan', 'start');
  if (job.status === 'PLANNED') commands.push('start');
  if (job.status === 'IN_PROGRESS') commands.push('submit');
  if (job.status === 'REVISION_REQUESTED') commands.push('resume');
  commands.push('cancel');
  return commands;
}

const purposeLabels = { SALE: 'Satış', SAMPLE: 'Numune', CONSIGNMENT: 'Konsinye', RETURN: 'İade', OTHER: 'Diğer' } as const;
const commandLabels: Record<LifecycleCommand, string> = {
  edit: 'Görüşmeyi düzenle',
  plan: 'Planla', start: 'İşi başlat', submit: 'Onaya gönder', approve: 'Onayla',
  revise: 'Düzeltme iste', resume: 'İşe devam et', cancel: 'İşi iptal et',
  withdraw: 'Onaydan geri çek ve düzenle',
};

export function ReasonDialog({ kind, pending, onClose, onConfirm }: {
  kind: 'revise' | 'cancel'; pending: boolean; onClose: () => void; onConfirm: (reason: string) => void;
}) {
  const titleId = useId();
  const errorId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { cancelRef.current?.focus(); }, []);

  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' && !pending) { event.preventDefault(); onClose(); return; }
    if (event.key !== 'Tab') return;
    const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), textarea:not([disabled])') ?? []);
    if (!controls.length) return;
    const first = controls[0]; const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = reason.trim();
    if (!normalized) { setError('Neden alanı zorunludur.'); return; }
    onConfirm(normalized);
  }
  const revision = kind === 'revise';
  return <div className="dialog-backdrop">
    <div ref={dialogRef} className="reason-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={keyDown}>
      <h2 id={titleId}>{revision ? 'Düzeltme iste' : 'İşi iptal et'}</h2>
      <p>{revision ? 'Personelin neyi düzeltmesi gerektiğini açıklayın.' : 'Bu işlem terminaldir; iptal edilen iş yeniden açılamaz. İptal nedenini iş geçmişine ekleyin.'}</p>
      <form onSubmit={submit} noValidate>
        <div className="field-group"><label htmlFor={`${titleId}-reason`}>{revision ? 'Düzeltme nedeni' : 'İptal nedeni'}</label>
          <textarea id={`${titleId}-reason`} rows={4} maxLength={2000} value={reason} disabled={pending} required
            aria-invalid={error ? 'true' : undefined} aria-describedby={error ? errorId : undefined}
            onChange={(event) => { setReason(event.target.value); setError(''); }} /></div>
        {error && <p id={errorId} className="field-error" role="alert">{error}</p>}
        <div className="review-buttons"><button ref={cancelRef} className="secondary-button" type="button" disabled={pending} onClick={onClose}>Vazgeç</button>
          <button className="primary-button compact-button" type="submit" disabled={pending || !reason.trim()}>{pending ? 'İşleniyor…' : revision ? 'Onayla' : 'İşi iptal et'}</button></div>
      </form>
    </div>
  </div>;
}

export function JobDetailPanel({ job, items, viewerRole = 'STAFF', viewerId, pending, message, messageIsError = false,
  feedbackRef, onBack, onCommand, children }: {
  job: JobCard; items: DeliveryItem[]; pending: boolean; message: string; messageIsError?: boolean;
  viewerRole?: CurrentUser['role']; viewerId?: string; feedbackRef?: Ref<HTMLDivElement>;
  onBack: () => void; onCommand: (command: LifecycleCommand) => void; children?: ReactNode;
}) {
  const commands = viewerRole === 'STAFF' && viewerId !== undefined && viewerId !== job.assignedTo
    ? [] : availableLifecycleCommands(job, viewerRole);
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
    {job.type === 'PRODUCT_DELIVERY' && <section className="delivery-lines" aria-labelledby="delivery-lines-title"><h2 id="delivery-lines-title">Teslim bilgileri</h2>
      <ul>{items.map((item) => <li key={item.id}><div><strong>{item.productNameSnapshot}</strong><span>{item.productSkuSnapshot ?? 'Ürün kodu belirtilmedi'}</span></div>
        <dl><div><dt>Amaç</dt><dd>{purposeLabels[item.deliveryPurpose]}</dd></div><div><dt>Miktar</dt><dd>{item.quantity}{item.unit ? ` ${item.unit}` : ''}</dd></div>
          <div><dt>Teslim zamanı</dt><dd>{new Intl.DateTimeFormat('tr-TR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.deliveredAt))}</dd></div></dl></li>)}</ul>
    </section>}
    {commands.length > 0 && <section className="detail-action surface-flat" aria-label="İş işlemleri"><p>Yalnızca mevcut duruma uygun işlemler gösterilir.</p>
      <div className="review-buttons">{commands.map((command) => <button key={command}
        className={command === 'cancel' || command === 'revise' ? 'secondary-button' : 'primary-button compact-button'}
        type="button" disabled={pending} onClick={() => onCommand(command)}>{pending ? 'İşleniyor…'
          : command === 'edit' && job.status === 'WAITING_APPROVAL'
            ? 'Onaydan geri çek ve düzenle' : commandLabels[command]}</button>)}</div></section>}
    {job.status === 'WAITING_APPROVAL' && viewerRole === 'STAFF' && <div className="workspace-message" role="status"><h2>Yönetici onayı bekleniyor</h2>
      <p>{job.type === 'PRODUCT_DELIVERY' ? 'Teslim bilgileri' : job.type === 'SALES_MEETING' ? 'Görüşme bilgileri' : 'Görev bilgileri'} inceleme tamamlanana kadar değiştirilemez.</p></div>}
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
  if (job.type === 'PRODUCT_DELIVERY') return { kind: job.type,
    job: { ...job, type: job.type }, deliveryItems: await listDeliveryItems(jobId) };
  if (job.type === 'GENERAL_TASK') return { kind: job.type, job: { ...job, type: job.type } };
  return { kind: job.type, job: { ...job, type: job.type },
    meetingDetails: ['NEW', 'PLANNED'].includes(job.status) ? null : await getMeetingDetails(jobId) };
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

export function JobDetailScreen({ jobId, user, onBack, onChanged }: { jobId: string; user: CurrentUser; onBack: () => void; onChanged: () => void }) {
  const [state, setState] = useState<DetailState>({ kind: 'loading' });
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [messageIsError, setMessageIsError] = useState(false);
  const [meetingSubmissionError, setMeetingSubmissionError] = useState<ApiError | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [timelineKey, setTimelineKey] = useState(0);
  const [dialog, setDialog] = useState<'revise' | 'cancel' | null>(null);
  const dialogTriggerRef = useRef<HTMLElement | null>(null);
  const mutationInFlight = useRef(false);
  const actionIds = useRef<Partial<Record<LifecycleCommand, string>>>({});
  const feedbackRef = useRef<HTMLDivElement>(null);
  const [feedbackFocusRequest, setFeedbackFocusRequest] = useState(0);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    let active = true; setState({ kind: 'loading' });
    loadJobDetail(jobId)
      .then((detail) => { if (active) setState({ kind: 'ready', detail }); })
      .catch((error) => { if (active) setState({ kind: 'error', message: error instanceof ApiError ? error.message : 'İş yüklenemedi.', retryable: error instanceof ApiError ? error.retryable : true }); });
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
  async function execute(command: LifecycleCommand, reason = '') {
    if (state.kind !== 'ready' || mutationInFlight.current) return;
    mutationInFlight.current = true;
    setPending(true); setMessage(''); setMessageIsError(false); setMeetingSubmissionError(null);
    actionIds.current[command] ??= crypto.randomUUID();
    const input = { clientActionId: actionIds.current[command]!, expectedVersion: state.detail.job.version };
    try {
      const updated = command === 'plan' ? await planJobCard(jobId, input)
        : command === 'start' ? await startJobCard(jobId, input)
        : command === 'submit' ? await submitJobCardForApproval(jobId, input)
        : command === 'approve' ? await approveJobCard(jobId, input)
        : command === 'revise' ? await requestJobCardRevision(jobId, { ...input, revisionReason: reason })
        : command === 'withdraw' ? await withdrawJobCardFromApproval(jobId, input)
        : command === 'resume' ? await resumeJobCard(jobId, input)
        : await cancelJobCard(jobId, { ...input, cancelReason: reason });
      if (state.detail.kind === 'SALES_MEETING' && command === 'start') {
        await refreshTruth();
      } else {
      setState({ kind: 'ready', detail: state.detail.kind === 'SALES_MEETING'
        ? { ...state.detail, job: updated as JobCard & { type: 'SALES_MEETING' },
          meetingDetails: state.detail.meetingDetails === null ? null
            : { ...state.detail.meetingDetails, jobCardVersion: updated.version } }
        : { ...state.detail, job: updated } as LoadedJobDetail });
      }
      delete actionIds.current[command];
      setTimelineKey((value) => value + 1);
      const completedDialogCommand = dialog !== null;
      if (completedDialogCommand) setDialog(null);
      setMessage(`${commandLabels[command]} işlemi tamamlandı.`);
      if (completedDialogCommand) setFeedbackFocusRequest((value) => value + 1);
      onChanged();
    } catch (caught) {
      if (caught instanceof ApiError && (caught.code === 'VERSION_CONFLICT' || caught.code === 'INVALID_TRANSITION')) {
        delete actionIds.current[command];
        try { await refreshTruth(); setMessage('İş başka bir işlemle güncellendi. En güncel durum gösteriliyor.'); }
        catch { setMessage('Güncel iş bilgileri alınamadı. Lütfen tekrar deneyin.'); setMessageIsError(true); }
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
      setState({ kind: 'ready', detail: { ...state.detail,
        job: { ...state.detail.job, version: meetingDetails.jobCardVersion }, meetingDetails } });
      setTimelineKey((value) => value + 1); onChanged(); return meetingDetails;
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'VERSION_CONFLICT') {
        await refreshTruth();
        throw new ApiError(409, 'VERSION_CONFLICT', 'İş başka bir işlemle güncellendi. En güncel durum gösteriliyor.');
      }
      throw caught;
    } finally { mutationInFlight.current = false; setPending(false); }
  }
  async function beginEdit() {
    if (state.kind !== 'ready' || state.detail.kind !== 'SALES_MEETING'
      || mutationInFlight.current) return;
    const capabilities = jobCapabilities(user, state.detail.job);
    if (!capabilities.canEditJob) return;
    if (!capabilities.requiresWithdrawalBeforeEdit) { setEditing(true); return; }
    mutationInFlight.current = true;
    setPending(true); setMessage(''); setMessageIsError(false);
    actionIds.current.edit ??= crypto.randomUUID();
    try {
      const updated = await prepareMeetingEdit(
        state.detail.job, actionIds.current.edit, withdrawJobCardFromApproval,
      );
      delete actionIds.current.edit;
      setState({ kind: 'ready', detail: {
        ...state.detail,
        job: updated as JobCard & { type: 'SALES_MEETING' },
        meetingDetails: state.detail.meetingDetails === null ? null
          : { ...state.detail.meetingDetails, jobCardVersion: updated.version },
      } });
      setTimelineKey((value) => value + 1); setEditing(true);
      setMessage('İş onaydan geri çekildi. Görüşme bilgilerini düzenleyebilirsiniz.');
      onChanged();
    } catch (caught) {
      if (caught instanceof ApiError && (caught.code === 'VERSION_CONFLICT'
        || caught.code === 'INVALID_TRANSITION')) {
        delete actionIds.current.edit;
        try { await refreshTruth(); setMessage('İş güncellendi. En güncel durum gösteriliyor.'); }
        catch { setMessage('Güncel iş bilgileri alınamadı. Lütfen tekrar deneyin.'); }
      } else {
        if (!(caught instanceof ApiError) || !caught.retryable) delete actionIds.current.edit;
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
    if (commandName === 'edit') { void beginEdit(); return; }
    if (commandName === 'revise' || commandName === 'cancel') {
      dialogTriggerRef.current = trigger; setDialog(commandName); return;
    }
    void execute(commandName);
  }

  if (state.kind === 'loading') return <main className="job-detail" aria-busy="true"><p>İş detayları yükleniyor</p></main>;
  if (state.kind === 'error') return <main className="job-detail"><div className="workspace-message" role="alert"><h1>İş yüklenemedi</h1><p>{state.message}</p>
    {state.retryable && <button className="secondary-button" type="button" onClick={() => setReloadKey((value) => value + 1)}>Tekrar dene</button>}</div></main>;
  const { detail } = state;
  const capabilities = jobCapabilities(user, detail.job);
  const hasMeetingResult = detail.kind === 'SALES_MEETING' && detail.meetingDetails !== null
    && Object.values({
      meetingAt: detail.meetingDetails.meetingAt,
      outcome: detail.meetingDetails.outcome,
      meetingSummary: detail.meetingDetails.meetingSummary,
      nextFollowUpAt: detail.meetingDetails.nextFollowUpAt,
    }).some((value) => value !== null);
  const showMeetingResult = detail.kind === 'SALES_MEETING'
    && capabilities.canViewMeetingResult && detail.meetingDetails !== null
    && (detail.job.status !== 'CANCELLED' || hasMeetingResult);
  const showNotes = detail.kind !== 'SALES_MEETING' || capabilities.canViewMeetingNotes;
  return <JobDetailPanel job={detail.job} items={detail.kind === 'PRODUCT_DELIVERY' ? detail.deliveryItems : []} viewerRole={user.role} viewerId={user.id} pending={pending}
    message={message} messageIsError={messageIsError} feedbackRef={feedbackRef} onBack={onBack}
    onCommand={(name) => command(name, document.activeElement as HTMLElement)}>
    {editing && detail.kind === 'SALES_MEETING' ? <SalesMeetingEditForm job={detail.job} user={user}
      pending={pending} onCancel={() => setEditing(false)} onSave={saveJob} />
      : showMeetingResult && detail.kind === 'SALES_MEETING' && detail.meetingDetails && <MeetingDetailsSection job={detail.job} details={detail.meetingDetails}
      user={user} canEdit={capabilities.canEditMeetingResult} mutationPending={pending} submissionError={meetingSubmissionError}
      onSave={saveMeeting} />}
    <div className="job-detail-sections">{showNotes && <JobNotes jobId={jobId}
      canAdd={detail.kind !== 'SALES_MEETING' || capabilities.canAddMeetingNote}
      hideWhenEmpty={detail.kind === 'SALES_MEETING' && detail.job.status === 'CANCELLED'}
      onAdded={() => setTimelineKey((value) => value + 1)} />}<JobTimeline jobId={jobId} refreshKey={timelineKey} /></div>
    {dialog && <ReasonDialog kind={dialog} pending={pending} onClose={closeDialog} onConfirm={(reason) => void execute(dialog, reason)} />}
  </JobDetailPanel>;
}
