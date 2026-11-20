import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';

import { useRealtimeInvalidation } from '../realtime/RealtimeProvider';
import { ApiError, type CurrentUser } from '../services/api';
import { OperationalCard } from '../ui/antd/OperationalCard';
import { ResultState } from '../ui/antd/ResultState';
import { ResponsiveFormDrawer } from '../ui/antd/ResponsiveFormDrawer';
import { ServoraListPagination } from '../ui/antd/ServoraPagination';
import { DEFAULT_LIST_PAGE_SIZE, lastListPageOffset } from '../ui/pagination';
import {
  changeRequestReasonLabel,
  changeRequestResolutionLabel,
} from './job-labels';
import {
  CHANGE_REQUEST_REASON_CODES,
  createChangeRequest,
  listOpenChangeRequests,
  resolveChangeRequest,
  type ChangeRequestReasonCode,
  type ChangeRequestResolution,
  type JobCard,
  type OpenChangeRequestItem,
} from './jobs-api';

const REASON_TEXT_MAX_LENGTH = 2000;

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
export function StaffChangeRequestAction({ job, disabled = false, onSubmitted }: {
  job: JobCard;
  disabled?: boolean;
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

  useEffect(() => { setSubmittedReason(null); }, [job.id, job.version]);

  const openRequest = job.changeRequest;
  const canRequest = job.workflowContext.allowedActions.includes('REQUEST_CHANGE');
  const showAction = canRequest
    && (openRequest === null || openRequest === undefined)
    && submittedReason === null;
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
              aria-describedby="change-request-text-help"
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

/**
 * JOB-010 release 2a management decision path. The panel records the decision
 * only; correcting, rescheduling and cancelling keep using the existing job
 * commands (the cancel command closes an open request server-side).
 */
export function ManagementChangeRequestPanel({ job, disabled = false, onResolved }: {
  job: JobCard;
  disabled?: boolean;
  onResolved?: () => void;
}) {
  const request = job.changeRequest;
  const canResolve = job.workflowContext.allowedActions.includes('RESOLVE_CHANGE_REQUEST');
  const [dialog, setDialog] = useState<'REJECTED' | 'LINKED_JOB_CREATED' | null>(null);
  const [note, setNote] = useState('');
  const [linkedJobCardId, setLinkedJobCardId] = useState('');
  const [formError, setFormError] = useState('');
  const [pending, setPending] = useState<ChangeRequestResolution | null>(null);
  const [mutationError, setMutationError] = useState('');
  const [resolved, setResolved] = useState<ChangeRequestResolution | null>(null);
  const rejectTriggerRef = useRef<HTMLButtonElement>(null);
  const linkTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setResolved(null);
    setMutationError('');
    setDialog(null);
  }, [job.id, job.version]);

  if (request === null || request === undefined) return null;

  const locked = disabled || pending !== null;

  function closeDialog() {
    if (pending !== null) return;
    setDialog(null);
    setNote('');
    setLinkedJobCardId('');
    setFormError('');
    setMutationError('');
  }

  async function submitResolution(
    resolution: ChangeRequestResolution,
    extra: { note?: string; linkedJobCardId?: string } = {},
  ) {
    if (request === null || locked) return;
    setPending(resolution);
    setMutationError('');
    try {
      await resolveChangeRequest(job.id, request.id, {
        clientActionId: crypto.randomUUID(),
        resolution,
        ...extra,
      });
      setResolved(resolution);
      setDialog(null);
      setNote('');
      setLinkedJobCardId('');
      setFormError('');
      onResolved?.();
    } catch (caught) {
      setMutationError(caught instanceof ApiError ? caught.message : 'Öneri karara bağlanamadı.');
    } finally {
      setPending(null);
    }
  }

  function submitRejection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
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
    void submitResolution('REJECTED', { note: normalized });
  }

  function submitLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = linkedJobCardId.trim();
    if (normalized.length === 0) {
      setFormError('Bağlı yeni işin numarasını girin.');
      return;
    }
    if (normalized === job.id) {
      setFormError('Bir iş kendi kaydına bağlanamaz.');
      return;
    }
    setFormError('');
    void submitResolution('LINKED_JOB_CREATED', { linkedJobCardId: normalized });
  }

  return (
    <section
      className="detail-summary surface-flat"
      aria-labelledby="change-request-title"
      data-change-request="management"
    >
      <h2 id="change-request-title">Personel önerisi</h2>
      <dl className="job-row-facts">
        <div>
          <dt>Neden</dt>
          <dd>{changeRequestReasonLabel(request.reasonCode)}</dd>
        </div>
        <div>
          <dt>Personel</dt>
          <dd>{request.requestedBy.name}</dd>
        </div>
        <div>
          <dt>Gönderim</dt>
          <dd><time dateTime={request.requestedAt}>{formatInstant(request.requestedAt)}</time></dd>
        </div>
      </dl>
      <p data-change-request-reason-text="true">{request.reasonText}</p>
      {resolved !== null && (
        <p role="status" data-change-request-resolved={resolved}>
          Öneri karara bağlandı: {changeRequestResolutionLabel(resolved)}
        </p>
      )}
      {mutationError && dialog === null && <p className="field-error" role="alert">{mutationError}</p>}
      {canResolve && (
        <div className="review-buttons change-request-actions">
          <button
            className="secondary-button"
            type="button"
            disabled={locked}
            data-change-request-resolve="CORRECTED"
            onClick={() => void submitResolution('CORRECTED')}
          >
            {pending === 'CORRECTED' ? 'Kaydediliyor…' : 'Düzeltildi'}
          </button>
          <button
            className="secondary-button"
            type="button"
            disabled={locked}
            data-change-request-resolve="RESCHEDULED"
            onClick={() => void submitResolution('RESCHEDULED')}
          >
            {pending === 'RESCHEDULED' ? 'Kaydediliyor…' : 'Yeniden planlandı'}
          </button>
          <button
            ref={linkTriggerRef}
            className="secondary-button"
            type="button"
            disabled={locked}
            aria-expanded={dialog === 'LINKED_JOB_CREATED'}
            data-change-request-resolve="LINKED_JOB_CREATED"
            onClick={() => { setFormError(''); setMutationError(''); setDialog('LINKED_JOB_CREATED'); }}
          >
            Bağlı yeni iş oluşturuldu
          </button>
          <button
            ref={rejectTriggerRef}
            className="secondary-button"
            type="button"
            disabled={locked}
            aria-expanded={dialog === 'REJECTED'}
            data-change-request-resolve="REJECTED"
            onClick={() => { setFormError(''); setMutationError(''); setDialog('REJECTED'); }}
          >
            Reddet
          </button>
        </div>
      )}
      {job.workflowContext.allowedCommands.includes('CANCEL') && (
        <p className="form-help">
          İşi sonlandırmak için mevcut “İşi iptal et” komutunu kullanın.
        </p>
      )}

      <ResponsiveFormDrawer
        open={dialog === 'REJECTED'}
        title="Öneriyi reddet"
        onDismiss={closeDialog}
        returnFocusRef={rejectTriggerRef}
        dismissDisabled={pending !== null}
      >
        <form className="change-request-form" onSubmit={submitRejection} noValidate>
          <div className="field-group">
            <label htmlFor="change-request-reject-note">Açıklama</label>
            <textarea
              id="change-request-reject-note"
              rows={4}
              value={note}
              disabled={pending !== null}
              required
              aria-describedby="change-request-reject-help"
              onChange={(event) => { setNote(event.target.value); setFormError(''); }}
            />
            <span className="form-help" id="change-request-reject-help">
              Personelin önerisinin neden reddedildiğini açıklayın. En fazla
              {' '}{REASON_TEXT_MAX_LENGTH.toLocaleString('tr-TR')} karakter.
            </span>
          </div>
          {formError && <p className="field-error" role="alert">{formError}</p>}
          {mutationError && <p className="field-error" role="alert">{mutationError}</p>}
          <div className="review-buttons">
            <button className="secondary-button" type="button" disabled={pending !== null} onClick={closeDialog}>
              Vazgeç
            </button>
            <button className="primary-button compact-button" type="submit" disabled={pending !== null}>
              {pending === 'REJECTED' ? 'Kaydediliyor…' : 'Öneriyi reddet'}
            </button>
          </div>
        </form>
      </ResponsiveFormDrawer>

      <ResponsiveFormDrawer
        open={dialog === 'LINKED_JOB_CREATED'}
        title="Bağlı yeni iş oluşturuldu"
        onDismiss={closeDialog}
        returnFocusRef={linkTriggerRef}
        dismissDisabled={pending !== null}
      >
        <form className="change-request-form" onSubmit={submitLink} noValidate>
          <div className="field-group">
            <label htmlFor="change-request-linked-job">Yeni iş numarası</label>
            <input
              id="change-request-linked-job"
              value={linkedJobCardId}
              disabled={pending !== null}
              required
              aria-describedby="change-request-linked-job-help"
              onChange={(event) => { setLinkedJobCardId(event.target.value); setFormError(''); }}
            />
            <span className="form-help" id="change-request-linked-job-help">
              Oluşturulan yeni işin numarasını yazın. Bu iş kaydı değişmez.
            </span>
          </div>
          {formError && <p className="field-error" role="alert">{formError}</p>}
          {mutationError && <p className="field-error" role="alert">{mutationError}</p>}
          <div className="review-buttons">
            <button className="secondary-button" type="button" disabled={pending !== null} onClick={closeDialog}>
              Vazgeç
            </button>
            <button className="primary-button compact-button" type="submit" disabled={pending !== null}>
              {pending === 'LINKED_JOB_CREATED' ? 'Kaydediliyor…' : 'Bağlantıyı kaydet'}
            </button>
          </div>
        </form>
      </ResponsiveFormDrawer>
    </section>
  );
}

/** Role-aware job-detail surface; each branch renders nothing when inapplicable. */
export function ChangeRequestSection({ job, user, disabled = false, onChanged }: {
  job: JobCard;
  user: CurrentUser;
  disabled?: boolean;
  onChanged?: () => void;
}) {
  if (isManagementUser(user)) {
    return <ManagementChangeRequestPanel job={job} disabled={disabled} onResolved={onChanged} />;
  }
  return <StaffChangeRequestAction job={job} disabled={disabled} onSubmitted={onChanged} />;
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
