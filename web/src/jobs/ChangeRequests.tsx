import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';

import { useRealtimeInvalidation } from '../realtime/RealtimeProvider';
import { ApiError, type CurrentUser } from '../services/api';
import { OperationalCard } from '../ui/antd/OperationalCard';
import { ResultState } from '../ui/antd/ResultState';
import { ResponsiveFormDrawer } from '../ui/antd/ResponsiveFormDrawer';
import { ServoraListPagination } from '../ui/antd/ServoraPagination';
import { DEFAULT_LIST_PAGE_SIZE, lastListPageOffset } from '../ui/pagination';
import { focusScheduleEditor } from './AssignmentOffer';
import {
  changeRequestReasonLabel,
  changeRequestResolutionLabel,
  jobTypeLabel,
} from './job-labels';
import {
  CHANGE_REQUEST_REASON_CODES,
  createChangeRequest,
  listJobCards,
  listOpenChangeRequests,
  resolveChangeRequest,
  type ChangeRequestReasonCode,
  type ChangeRequestResolution,
  type JobCard,
  type JobCardListItem,
  type OpenChangeRequestItem,
} from './jobs-api';

const REASON_TEXT_MAX_LENGTH = 2000;
/** Same-customer job choices are a short list; one page is enough. */
const LINKED_JOB_LIMIT = 50;

function isManagementUser(user: CurrentUser): boolean {
  return user.role === 'MANAGER' || user.role === 'ADMIN';
}

function formatInstant(value: string): string {
  return new Intl.DateTimeFormat('tr-TR', { dateStyle: 'medium', timeStyle: 'short' })
    .format(new Date(value));
}

/**
 * JOB-010 release 2a: the assigned Staff member asks management to correct or
 * terminate the job. The request never changes the JobCard; management decides
 * with the existing commands. The action is offered only when the server
 * reports `REQUEST_CHANGE`, and the open request is shown as a status line.
 */
export function StaffChangeRequestAction({ job, disabled = false, openRequestSignal, onSubmitted }: {
  job: JobCard;
  disabled?: boolean;
  openRequestSignal?: number;
  onSubmitted?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [reasonCode, setReasonCode] = useState<ChangeRequestReasonCode | ''>('');
  const [reasonText, setReasonText] = useState('');
  const [formError, setFormError] = useState('');
  const [mutationError, setMutationError] = useState('');
  const [pending, setPending] = useState(false);
  // Local confirmation while the caller's detail refresh is in flight; the
  // canonical `changeRequest` replaces it as soon as it arrives.
  const [submittedReason, setSubmittedReason] = useState<ChangeRequestReasonCode | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const lastOpenSignalRef = useRef(0);

  useEffect(() => { setSubmittedReason(null); }, [job.id, job.version]);

  const openRequest = job.changeRequest;
  const canRequest = job.workflowContext.allowedActions.includes('REQUEST_CHANGE');
  const showAction = canRequest
    && (openRequest === null || openRequest === undefined)
    && submittedReason === null;

  useEffect(() => {
    if (openRequestSignal === undefined || openRequestSignal <= 0) {
      lastOpenSignalRef.current = 0;
      return;
    }
    if (openRequestSignal !== lastOpenSignalRef.current) {
      lastOpenSignalRef.current = openRequestSignal;
      if (showAction && !disabled) {
        setOpen(true);
      }
    }
  }, [openRequestSignal, showAction, disabled]);

  const openReason = openRequest?.reasonCode ?? submittedReason;
  if (!showAction && openReason === null) return null;

  function closeDialog() {
    if (pending) return;
    setOpen(false);
    setReasonCode('');
    setReasonText('');
    setFormError('');
    setMutationError('');
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || disabled) return;
    const selectedReason = CHANGE_REQUEST_REASON_CODES.find((code) => code === reasonCode);
    if (selectedReason === undefined) {
      setFormError('Öneri nedenini seçin.');
      return;
    }
    const text = reasonText.trim();
    if (text.length === 0) {
      setFormError('Öneriyi açıklayan metin zorunludur.');
      return;
    }
    if (Array.from(text).length > REASON_TEXT_MAX_LENGTH) {
      setFormError(`Açıklama ${REASON_TEXT_MAX_LENGTH.toLocaleString('tr-TR')} karakteri geçemez.`);
      return;
    }
    setFormError('');
    setMutationError('');
    setPending(true);
    try {
      await createChangeRequest(job.id, {
        clientActionId: crypto.randomUUID(),
        reasonCode: selectedReason,
        reasonText: text,
      });
      setSubmittedReason(selectedReason);
      setOpen(false);
      setReasonCode('');
      setReasonText('');
      onSubmitted?.();
    } catch (caught) {
      setMutationError(caught instanceof ApiError ? caught.message : 'Öneri gönderilemedi.');
    } finally {
      setPending(false);
    }
  }

  return (
    <section
      className="detail-summary surface-flat"
      aria-label="Personel önerisi"
      data-change-request="staff"
    >
      {openReason !== null && (
        <p role="status" data-change-request-status="open">
          Öneriniz yöneticide: {changeRequestReasonLabel(openReason)}
        </p>
      )}
      {showAction && (
        <div>
          <button
            ref={triggerRef}
            className="secondary-button"
            type="button"
            disabled={disabled || pending}
            aria-expanded={open}
            data-change-request-action="true"
            onClick={() => setOpen((value) => !value)}
          >
            Düzenleme / sonlandırma önerisi gönder
          </button>
        </div>
      )}

      <ResponsiveFormDrawer
        open={open}
        title="Düzenleme / sonlandırma önerisi"
        onDismiss={closeDialog}
        returnFocusRef={triggerRef}
        dismissDisabled={pending}
      >
        <form className="change-request-form" onSubmit={submit} noValidate>
          <div className="field-group">
            <label htmlFor="change-request-reason">Neden</label>
            <select
              id="change-request-reason"
              value={reasonCode}
              disabled={pending}
              required
              aria-describedby={formError ? 'change-request-form-error' : undefined}
              onChange={(event) => {
                setReasonCode(event.target.value as ChangeRequestReasonCode | '');
                setFormError('');
              }}
            >
              <option value="">Neden seçin</option>
              {CHANGE_REQUEST_REASON_CODES.map((code) => (
                <option key={code} value={code}>{changeRequestReasonLabel(code)}</option>
              ))}
            </select>
          </div>
          <div className="field-group">
            <label htmlFor="change-request-text">Açıklama</label>
            <textarea
              id="change-request-text"
              rows={4}
              value={reasonText}
              disabled={pending}
              required
              aria-invalid={formError ? true : undefined}
              aria-describedby={formError
                ? 'change-request-text-help change-request-form-error'
                : 'change-request-text-help'}
              onChange={(event) => {
                setReasonText(event.target.value);
                setFormError('');
              }}
            />
            <span className="form-help" id="change-request-text-help">
              Yöneticinin kararı verebilmesi için durumu kısaca açıklayın. En fazla
              {' '}{REASON_TEXT_MAX_LENGTH.toLocaleString('tr-TR')} karakter.
            </span>
          </div>
          <p className="form-help">
            Bu öneri iş kaydını değiştirmez. Kararı yönetici verir.
          </p>
          {formError && <p className="field-error" id="change-request-form-error" role="alert">{formError}</p>}
          {mutationError && <p className="field-error" role="alert">{mutationError}</p>}
          <div className="review-buttons">
            <button className="secondary-button" type="button" disabled={pending} onClick={closeDialog}>
              Vazgeç
            </button>
            <button className="primary-button compact-button" type="submit" disabled={pending}>
              {pending ? 'Gönderiliyor…' : 'Öneriyi gönder'}
            </button>
          </div>
        </form>
      </ResponsiveFormDrawer>
    </section>
  );
}

/** Reasons where the guidance starts with a new planned time. */
const NEW_TIME_FIRST_REASONS: readonly ChangeRequestReasonCode[] = [
  'CUSTOMER_POSTPONED', 'CUSTOMER_ABSENT', 'VISIT_NOT_POSSIBLE',
];

/** The reason where terminating the job is the first real action. */
const CANCEL_FIRST_REASONS: readonly ChangeRequestReasonCode[] = ['CUSTOMER_CHANGED_MIND'];

/** One real command; only the first rendered entry is the primary action. */
type ChangeRequestGuidanceAction = {
  key: 'new-time' | 'reassign' | 'cancel';
  label: string;
  run: (trigger: HTMLButtonElement) => void;
};

/**
 * Record-only closures. They never change the JobCard, so they live in their
 * own confirmed group below the real commands. Copy is owned by the accepted
 * contract in `docs/features/assignment-acceptance-sla.md`.
 */
const CLOSURE_ACTIONS: ReadonlyArray<{
  resolution: ChangeRequestResolution;
  label: string;
}> = [
  { resolution: 'CORRECTED', label: 'Gerekli düzeltmeyi yaptım' },
  { resolution: 'RESCHEDULED', label: 'Zamanı değiştirdim' },
  { resolution: 'LINKED_JOB_CREATED', label: 'Yerine yeni iş açtım' },
  { resolution: 'REJECTED', label: 'Öneriyi reddet' },
];

const CLOSURE_GROUP_EXPLANATION =
  'Bu seçenekler işi değiştirmez; yalnızca öneriyi kapatır ve personele bildirim gider.';
const CLOSURE_CONFIRMATION =
  'Öneri kapatılır ve geri açılamaz. Personel gerekirse yeni bir öneri gönderebilir.';

type LinkedJobListState =
  | { kind: 'loading' }
  | { kind: 'ready'; items: JobCardListItem[] }
  | { kind: 'error'; message: string };

const linkedJobDateFormatter = new Intl.DateTimeFormat('tr-TR', { dateStyle: 'medium' });

/** The linked job choice: title, type label and the job's own date. */
function linkedJobChoiceLabel(entry: JobCardListItem): string {
  const date = entry.scheduledAt ?? entry.dueDate ?? entry.createdAt;
  return `${entry.title} · ${jobTypeLabel(entry.type)} · ${linkedJobDateFormatter.format(new Date(date))}`;
}

/**
 * JOB-010 release 2a management decision path. The panel leads with the real
 * commands that change the job (planned time, assignee, cancel) and keeps the
 * record-only resolutions in a separate, confirmed group, so a manager never
 * mistakes a recorded resolution for the command itself.
 */
export function ManagementChangeRequestPanel({
  job,
  disabled = false,
  onChanged,
  onCommitted,
  onActionStart,
  onRefresh,
  onReassign,
  canSetNewTime = true,
  onCancel,
  loadLinkedJobs = listJobCards,
}: {
  job: JobCard;
  disabled?: boolean;
  onChanged?: () => void;
  /**
   * UI-FEEDBACK/B: the page owns the committed receipt so it survives this
   * panel unmounting. When provided, the panel never renders its own success
   * status line.
   */
  onCommitted?: (receipt: string) => Promise<void>;
  /** Clears the previous page receipt when a new decision starts. */
  onActionStart?: () => void;
  /** Serialized canonical reload after a failed or conflicting decision. */
  onRefresh?: () => Promise<void>;
  /**
   * Opens the existing record-edit reassignment form. Purpose-bound so this
   * guidance never grows a second assignee form of its own.
   */
  onReassign?: (trigger: HTMLButtonElement) => void;
  /** False when this viewer has no planned-time editor on the page. */
  canSetNewTime?: boolean;
  /** Opens the existing cancel command dialog; never a second cancel form. */
  onCancel?: (trigger: HTMLButtonElement) => void;
  /** Test seam; production always reads the existing job list API. */
  loadLinkedJobs?: typeof listJobCards;
}) {
  const request = job.changeRequest;
  const canResolve = job.workflowContext.allowedActions.includes('RESOLVE_CHANGE_REQUEST');
  const customerId = job.customerId;
  const [dialog, setDialog] = useState<ChangeRequestResolution | null>(null);
  const [note, setNote] = useState('');
  const [linkedJobCardId, setLinkedJobCardId] = useState('');
  const [linkedJobs, setLinkedJobs] = useState<LinkedJobListState>({ kind: 'loading' });
  const [linkedJobsReload, setLinkedJobsReload] = useState(0);
  const [formError, setFormError] = useState('');
  const [pending, setPending] = useState<ChangeRequestResolution | null>(null);
  const [mutationError, setMutationError] = useState('');
  const [resolved, setResolved] = useState<ChangeRequestResolution | null>(null);
  const [alreadyClosed, setAlreadyClosed] = useState(false);
  const closureTriggerRef = useRef<HTMLButtonElement>(null);

  const requestId = request?.id ?? null;
  // The (job, request) the panel is answering. An async closure that settles
  // after the reader moved on must not write its outcome onto another one, but
  // a request that our own decision just closed (id becomes null on the
  // refreshed card) is still the same record and must keep its receipt.
  const latestTarget = useRef<{ jobId: string; requestId: string | null }>({
    jobId: job.id, requestId,
  });
  latestTarget.current = { jobId: job.id, requestId };
  const outcomeRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    setResolved(null);
    setAlreadyClosed(false);
  }, [job.id]);

  useEffect(() => {
    // A closed request disappears from the refreshed card: keep its outcome
    // visible. Only a (new) open request or a new version resets the panel.
    if (requestId === null) return;
    setResolved(null);
    setAlreadyClosed(false);
    setMutationError('');
    setDialog(null);
    setNote('');
    setLinkedJobCardId('');
    setFormError('');
  }, [job.id, job.version, requestId]);

  useEffect(() => {
    if (requestId === null && (resolved !== null || alreadyClosed)) {
      outcomeRef.current?.focus({ preventScroll: true });
    }
  }, [requestId, resolved, alreadyClosed]);

  // The linked job is chosen from the same customer's other jobs; the raw id
  // is never typed. Loaded only when its closure dialog opens.
  useEffect(() => {
    if (dialog !== 'LINKED_JOB_CREATED' || customerId === null) return;
    let cancelled = false;
    setLinkedJobs({ kind: 'loading' });
    void loadLinkedJobs({ customerId, limit: LINKED_JOB_LIMIT }).then(
      (page) => {
        if (cancelled) return;
        setLinkedJobs({
          kind: 'ready',
          items: [...page.items].filter((entry) => entry.id !== job.id),
        });
      },
      (caught: unknown) => {
        if (cancelled) return;
        setLinkedJobs({
          kind: 'error',
          message: caught instanceof Error ? caught.message : 'Müşterinin işleri yüklenemedi.',
        });
      },
    );
    return () => { cancelled = true; };
  }, [dialog, customerId, job.id, loadLinkedJobs, linkedJobsReload]);

  if (request === null || request === undefined) {
    if (resolved === null && !alreadyClosed) return null;
    return (
      <section
        className="detail-summary surface-flat"
        aria-label="Personel önerisi"
        data-change-request="management-closed"
      >
        <p ref={outcomeRef} tabIndex={-1} role="status"
          data-change-request-resolved={resolved ?? undefined}
          data-change-request-not-open={alreadyClosed ? 'true' : undefined}>
          {alreadyClosed
            ? 'Öneri zaten kapatılmış.'
            : `Öneri kapatıldı: ${resolved === null ? '' : changeRequestResolutionLabel(resolved)}`}
        </p>
      </section>
    );
  }

  const locked = disabled || pending !== null;
  const reason = request.reasonCode;
  // The request names its author, so a different assignee means the job moved
  // on after the request was written.
  const reassigned = request.requestedBy.id !== job.assignedTo;

  function closeDialog() {
    if (pending !== null) return;
    setDialog(null);
    setNote('');
    setLinkedJobCardId('');
    setFormError('');
    setMutationError('');
  }

  const newTimeAction: ChangeRequestGuidanceAction | null = canSetNewTime
    ? { key: 'new-time', label: 'Yeni zaman belirle', run: () => { focusScheduleEditor(); } }
    : null;
  const reassignAction: ChangeRequestGuidanceAction | null = onReassign === undefined
    ? null
    : { key: 'reassign', label: 'Sorumlu personeli değiştir', run: onReassign };
  const cancelAction: ChangeRequestGuidanceAction | null =
    onCancel === undefined || !job.workflowContext.allowedCommands.includes('CANCEL')
      ? null
      : { key: 'cancel', label: 'İşi iptal et', run: onCancel };
  const orderedActions: Array<ChangeRequestGuidanceAction | null> = CANCEL_FIRST_REASONS.includes(reason)
    ? [cancelAction, newTimeAction, reassignAction]
    : NEW_TIME_FIRST_REASONS.includes(reason)
      ? [newTimeAction, reassignAction, cancelAction]
      : [reassignAction, newTimeAction, cancelAction];
  const guidanceActions = orderedActions.filter(
    (action): action is ChangeRequestGuidanceAction => action !== null,
  );
  const closureActions = canResolve
    ? CLOSURE_ACTIONS.filter((entry) => entry.resolution !== 'LINKED_JOB_CREATED' || customerId !== null)
    : [];
  const dialogLabel = dialog === null
    ? null
    : CLOSURE_ACTIONS.find((entry) => entry.resolution === dialog)?.label ?? null;

  async function refreshAfterFailure() {
    if (onRefresh !== undefined) {
      await onRefresh();
      return;
    }
    onChanged?.();
  }

  async function submitResolution(
    resolution: ChangeRequestResolution,
    extra: { note?: string; linkedJobCardId?: string } = {},
  ) {
    if (request === null || locked) return;
    const operation = { jobId: job.id, requestId: request.id };
    onActionStart?.();
    setPending(resolution);
    setMutationError('');
    try {
      await resolveChangeRequest(job.id, request.id, {
        clientActionId: crypto.randomUUID(),
        resolution,
        ...extra,
      });
      const currentTarget = latestTarget.current;
      const stillSameRecord = currentTarget.jobId === operation.jobId
        && (currentTarget.requestId === null || currentTarget.requestId === operation.requestId);
      if (!stillSameRecord) return;
      const receipt = resolution === 'REJECTED'
        ? 'Öneri reddedildi. İş bilgileri değişmedi.'
        : `Öneri kapatıldı: ${changeRequestResolutionLabel(resolution)}. İş bilgileri değişmedi.`;
      if (onCommitted === undefined) setResolved(resolution);
      setAlreadyClosed(false);
      setDialog(null);
      setNote('');
      setLinkedJobCardId('');
      setFormError('');
      if (onCommitted !== undefined) await onCommitted(receipt);
      else onChanged?.();
    } catch (caught) {
      const currentTarget = latestTarget.current;
      const stillSameRecord = currentTarget.jobId === operation.jobId
        && (currentTarget.requestId === null || currentTarget.requestId === operation.requestId);
      if (!stillSameRecord) return;
      if (caught instanceof ApiError && caught.code === 'CHANGE_REQUEST_NOT_OPEN') {
        // Another manager closed it meanwhile: refresh the card and say so
        // instead of leaving the drawer open on a request that no longer is.
        setDialog(null);
        setResolved(null);
        setAlreadyClosed(true);
        setNote('');
        setLinkedJobCardId('');
        setFormError('');
        setMutationError('');
        await refreshAfterFailure();
        return;
      }
      setMutationError(caught instanceof ApiError ? caught.message : 'Öneri karara bağlanamadı.');
    } finally {
      setPending(null);
    }
  }

  function submitClosure(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (dialog === null || locked) return;
    if (dialog === 'REJECTED') {
      const normalized = note.trim();
      if (normalized.length === 0) {
        setFormError('Reddetmek için açıklama zorunludur.');
        return;
      }
      if (Array.from(normalized).length > REASON_TEXT_MAX_LENGTH) {
        setFormError(`Açıklama ${REASON_TEXT_MAX_LENGTH.toLocaleString('tr-TR')} karakteri geçemez.`);
        return;
      }
      setFormError('');
      void submitResolution(dialog, { note: normalized });
      return;
    }
    if (dialog === 'LINKED_JOB_CREATED') {
      if (linkedJobCardId.trim().length === 0) {
        setFormError('Yeni işi listeden seçin.');
        return;
      }
      setFormError('');
      void submitResolution(dialog, { linkedJobCardId: linkedJobCardId.trim() });
      return;
    }
    setFormError('');
    void submitResolution(dialog);
  }

  return (
    <section
      className="detail-summary surface-flat"
      aria-labelledby="change-request-title"
      data-change-request="management"
    >
      <h2 id="change-request-title">Personel önerisi</h2>
      <div className="change-request-guidance">
        <h3 className="change-request-guidance-headline">
          {request.requestedBy.name} bu iş için değişiklik istiyor
        </h3>
        <dl className="job-row-facts">
          <div>
            <dt>Neden</dt>
            <dd>{changeRequestReasonLabel(request.reasonCode)}</dd>
          </div>
          <div>
            <dt>Personelin açıklaması</dt>
            <dd data-change-request-reason-text="true">{request.reasonText}</dd>
          </div>
          <div>
            <dt>Gönderim</dt>
            <dd><time dateTime={request.requestedAt}>{formatInstant(request.requestedAt)}</time></dd>
          </div>
        </dl>
        {reassigned && (
          <p className="form-help" data-change-request-reassigned="true">
            Sorumlu personel değişti; öneriyi kapatmayı unutmayın.
          </p>
        )}
        {guidanceActions.length > 0 && (
          <>
            <p className="change-request-guidance-label"><strong>Ne yapabilirsiniz</strong></p>
            <div className="review-buttons change-request-guidance-actions">
              {guidanceActions.map((action, index) => (
                <button
                  key={action.key}
                  className={index === 0
                    ? 'primary-button compact-button'
                    : 'secondary-button compact-button'}
                  type="button"
                  disabled={locked}
                  data-change-request-guidance={action.key}
                  onClick={(event) => { setMutationError(''); action.run(event.currentTarget); }}
                >
                  {action.label}
                </button>
              ))}
            </div>
          </>
        )}
        {closureActions.length > 0 && (
          <div className="change-request-closures" data-change-request-closures="true">
            <p className="change-request-guidance-label"><strong>Öneriyi kapat</strong></p>
            <p className="form-help">{CLOSURE_GROUP_EXPLANATION}</p>
            <div className="review-buttons">
              {closureActions.map((entry) => (
                <button
                  key={entry.resolution}
                  className="secondary-button compact-button"
                  type="button"
                  disabled={locked}
                  aria-expanded={dialog === entry.resolution}
                  data-change-request-resolve={entry.resolution}
                  onClick={(event) => {
                    setFormError('');
                    setMutationError('');
                    setNote('');
                    setLinkedJobCardId('');
                    closureTriggerRef.current = event.currentTarget;
                    setDialog(entry.resolution);
                  }}
                >
                  {entry.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {resolved !== null && onCommitted === undefined && (
          <p role="status" data-change-request-resolved={resolved}>
            Öneri kapatıldı: {changeRequestResolutionLabel(resolved)}
          </p>
        )}
        {alreadyClosed && (
          <p role="status" data-change-request-not-open="true">Öneri zaten kapatılmış.</p>
        )}
        {mutationError && dialog === null && <p className="field-error" role="alert">{mutationError}</p>}
      </div>

      <ResponsiveFormDrawer
        open={dialog !== null && dialogLabel !== null}
        title={`Öneriyi kapat: ${dialogLabel ?? ''}`}
        onDismiss={closeDialog}
        returnFocusRef={closureTriggerRef}
        dismissDisabled={pending !== null}
      >
        {dialog !== null && dialogLabel !== null && (
          <form className="change-request-form" onSubmit={submitClosure} noValidate>
            <p data-change-request-closure-outcome={dialog}>
              <strong>{dialogLabel}</strong>
            </p>
            <p>{CLOSURE_CONFIRMATION}</p>
            {dialog === 'REJECTED' && (
              <div className="field-group">
                <label htmlFor="change-request-reject-note">Açıklama</label>
                <textarea
                  id="change-request-reject-note"
                  rows={4}
                  value={note}
                  disabled={pending !== null}
                  required
                  aria-invalid={formError ? true : undefined}
                  aria-describedby={formError
                    ? 'change-request-reject-help change-request-closure-error'
                    : 'change-request-reject-help'}
                  onChange={(event) => { setNote(event.target.value); setFormError(''); }}
                />
                <span className="form-help" id="change-request-reject-help">
                  Personelin önerisinin neden reddedildiğini açıklayın. En fazla
                  {' '}{REASON_TEXT_MAX_LENGTH.toLocaleString('tr-TR')} karakter.
                </span>
              </div>
            )}
            {dialog === 'LINKED_JOB_CREATED' && (
              <div className="field-group">
                <label htmlFor="change-request-linked-job">Yerine açtığınız iş</label>
                {linkedJobs.kind === 'loading' && (
                  <p className="field-status" role="status">Müşterinin işleri yükleniyor…</p>
                )}
                {linkedJobs.kind === 'error' && (
                  <>
                    <p className="field-error" role="alert">{linkedJobs.message}</p>
                    <button className="secondary-button compact-button" type="button"
                      onClick={() => setLinkedJobsReload((value) => value + 1)}>
                      Tekrar dene
                    </button>
                  </>
                )}
                {linkedJobs.kind === 'ready' && (
                  <>
                    <select
                      id="change-request-linked-job"
                      value={linkedJobCardId}
                      disabled={pending !== null}
                      required
                      aria-invalid={formError ? true : undefined}
                      aria-describedby={formError
                        ? 'change-request-linked-job-help change-request-closure-error'
                        : 'change-request-linked-job-help'}
                      onChange={(event) => {
                        setLinkedJobCardId(event.target.value);
                        setFormError('');
                      }}
                    >
                      <option value="">İş seçin</option>
                      {linkedJobs.items.map((entry) => (
                        <option key={entry.id} value={entry.id}>{linkedJobChoiceLabel(entry)}</option>
                      ))}
                    </select>
                    <span className="form-help" id="change-request-linked-job-help">
                      {linkedJobs.items.length === 0
                        ? 'Bu müşteri için başka iş bulunmuyor.'
                        : 'Yalnızca bu müşterinin diğer işleri listelenir.'}
                    </span>
                  </>
                )}
              </div>
            )}
            {formError && (
              <p className="field-error" id="change-request-closure-error" role="alert">{formError}</p>
            )}
            {mutationError && <p className="field-error" role="alert">{mutationError}</p>}
            <div className="review-buttons">
              <button className="secondary-button" type="button" disabled={pending !== null} onClick={closeDialog}>
                Vazgeç
              </button>
              <button className="primary-button compact-button" type="submit" disabled={pending !== null}>
                {pending !== null ? 'Kaydediliyor…' : 'Öneriyi kapat'}
              </button>
            </div>
          </form>
        )}
      </ResponsiveFormDrawer>
    </section>
  );
}

/** Role-aware job-detail surface; each branch renders nothing when inapplicable. */
export function ChangeRequestSection({
  job,
  user,
  disabled = false,
  openRequestSignal,
  onChanged,
  onCommitted,
  onActionStart,
  onRefresh,
  canSetNewTime = true,
  onReassign,
  onCancel,
}: {
  job: JobCard;
  user: CurrentUser;
  disabled?: boolean;
  openRequestSignal?: number;
  onChanged?: () => void;
  /** UI-FEEDBACK/B: page-owned committed receipt for the management decision. */
  onCommitted?: (receipt: string) => Promise<void>;
  /** Clears the previous page receipt when a new decision starts. */
  onActionStart?: () => void;
  /** Serialized canonical reload after a failed management decision. */
  onRefresh?: () => Promise<void>;
  /** False when this viewer has no planned-time editor on the page. */
  canSetNewTime?: boolean;
  /** Opens the existing reassignment form (management guidance only). */
  onReassign?: (trigger: HTMLButtonElement) => void;
  /** Opens the existing cancel command dialog (management guidance only). */
  onCancel?: (trigger: HTMLButtonElement) => void;
}) {
  if (isManagementUser(user)) {
    return (
      <ManagementChangeRequestPanel
        job={job}
        disabled={disabled}
        onChanged={onChanged}
        onCommitted={onCommitted}
        onActionStart={onActionStart}
        onRefresh={onRefresh}
        canSetNewTime={canSetNewTime}
        onReassign={onReassign}
        onCancel={onCancel}
      />
    );
  }
  return (
    <StaffChangeRequestAction
      job={job}
      disabled={disabled}
      openRequestSignal={openRequestSignal}
      onSubmitted={onChanged}
    />
  );
}

type OpenChangeRequestListState =
  | { kind: 'loading' }
  | { kind: 'ready'; items: OpenChangeRequestItem[]; total: number }
  | { kind: 'error'; message: string };

/**
 * JOB-010 release 2a management overview section: open Staff requests, oldest
 * first, with requester, customer, reason and job navigation. Placement and
 * state handling mirror the open-late section next to it.
 */
export function OpenChangeRequestsSection({ load = listOpenChangeRequests }: {
  load?: typeof listOpenChangeRequests;
}) {
  const [state, setState] = useState<OpenChangeRequestListState>({ kind: 'loading' });
  const [offset, setOffset] = useState(0);
  const requestId = useRef(0);

  const refresh = useCallback(async () => {
    const id = ++requestId.current;
    setState((current) => current.kind === 'ready' ? current : { kind: 'loading' });
    try {
      const page = await load({ limit: DEFAULT_LIST_PAGE_SIZE, offset });
      if (id !== requestId.current) return;
      const lastOffset = lastListPageOffset(page.total);
      if (offset > lastOffset) {
        setOffset(lastOffset);
        return;
      }
      setState({ kind: 'ready', items: [...page.items], total: page.total });
    } catch (error) {
      if (id !== requestId.current) return;
      setState({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Personel önerileri yüklenemedi.',
      });
    }
  }, [load, offset]);

  useEffect(() => {
    void refresh();
    return () => { requestId.current += 1; };
  }, [refresh]);
  useRealtimeInvalidation(['overview', 'job-list'], () => { void refresh(); });

  if (state.kind === 'loading') return null;
  // A failed load must never look like "no requests".
  if (state.kind === 'error') {
    return (
      <section
        className="overview-section"
        aria-label="Personel önerileri"
        data-open-change-requests="error"
      >
        <ResultState
          status="error"
          title="Personel önerileri yüklenemedi"
          description={state.message}
          headingLevel={2}
          action={(
            <button className="secondary-button" type="button" onClick={() => void refresh()}>
              Tekrar dene
            </button>
          )}
        />
      </section>
    );
  }
  if (state.items.length === 0) return null;

  return (
    <section
      className="overview-section"
      aria-labelledby="change-requests-title"
      data-open-change-requests="true"
    >
      <h2 id="change-requests-title">Personel önerileri</h2>
      <ul className="overview-card-stack">
        {state.items.map((item) => (
          <li key={item.changeRequestId}>
            <OperationalCard
              title={<Link to={item.jobPath}>{item.jobTitle}</Link>}
              tone="attention"
              statusLabel={changeRequestReasonLabel(item.reasonCode)}
              className="change-request-card"
            >
              <span>
                {item.requestedBy.name} · {item.customer?.name ?? 'Müşteri belirtilmedi'} ·{' '}
                <time dateTime={item.requestedAt}>{formatInstant(item.requestedAt)}</time>
              </span>
              <p>{item.reasonText}</p>
            </OperationalCard>
          </li>
        ))}
      </ul>
      <ServoraListPagination
        total={state.total}
        offset={offset}
        label="Personel önerileri sayfaları"
        itemName="öneri"
        onOffsetChange={(nextOffset) => {
          // Hide the focused pager in the same event as the offset change.
          // Otherwise an intermediate render consumes its keyboard-focus ticket
          // before the async page arrives and focus falls back to document.body.
          setState({ kind: 'loading' });
          setOffset(nextOffset);
        }}
      />
    </section>
  );
}
