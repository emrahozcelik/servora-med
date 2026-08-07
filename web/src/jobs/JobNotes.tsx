import { useEffect, useRef, useState, type FormEvent } from 'react';

import { ApiError } from '../services/api';
import { EmptyState, LoadingSkeleton, ResultState } from '../ui/antd';
import { ProgressiveCounter } from '../ui/ProgressiveCounter';
import {
  addJobCardNote,
  listJobCardNotes,
  type JobCard,
  type JobCardNote,
  type JobCardNoteCursor,
  type JobCardNotePage,
} from './jobs-api';
import { jobCardStatusLabel } from './job-labels';

const PAGE_SIZE = 25;
const codePointLength = (value: string) => Array.from(value).length;
const roleLabels = {
  ADMIN: 'Sistem yöneticisi',
  MANAGER: 'Yönetici',
  STAFF: 'Personel',
} as const;
const contextLabels = {
  GENERAL: 'Operasyon notu',
  SUBMIT_FOR_APPROVAL: 'Tamamlanma sonucu',
  APPROVE: 'Yönetici onayı',
  REQUEST_REVISION: 'Revizyon isteği',
  CANCEL: 'İptal',
} as const;

type NotesState =
  | { kind: 'loading' }
  | { kind: 'ready'; page: JobCardNotePage }
  | { kind: 'error'; message: string; retryable: boolean };

export function JobNotes({
  jobId,
  load = listJobCardNotes,
  add = addJobCardNote,
  createActionId = () => crypto.randomUUID(),
  onAdded = () => {},
  canAdd = true,
  hideWhenEmpty = false,
  refreshKey = 0,
  realtimeKey = 0,
  jobType = null,
}: {
  jobId: string;
  load?: typeof listJobCardNotes;
  add?: typeof addJobCardNote;
  createActionId?: () => string;
  onAdded?: () => void;
  canAdd?: boolean;
  hideWhenEmpty?: boolean;
  refreshKey?: number;
  realtimeKey?: number;
  jobType?: JobCard['type'] | null;
}) {
  const [reloadKey, setReloadKey] = useState(0);
  const [state, setState] = useState<NotesState>({ kind: 'loading' });
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [draft, setDraft] = useState('');
  const [invoiceDraft, setInvoiceDraft] = useState('');
  const [draftError, setDraftError] = useState('');
  const [submitError, setSubmitError] = useState('');
  const [pending, setPending] = useState(false);
  const actionRef = useRef<{ id: string; note: string; invoiceNumber: string | null } | null>(null);
  const showInvoiceField = jobType === 'SALES_MEETING' || jobType === 'PRODUCT_DELIVERY';

  useEffect(() => {
    let active = true;
    setState({ kind: 'loading' });
    load(jobId, { limit: PAGE_SIZE, before: null })
      .then((page) => { if (active) setState({ kind: 'ready', page }); })
      .catch((caught) => {
        if (!active) return;
        const error = caught instanceof ApiError
          ? caught : new ApiError(0, 'UNKNOWN_ERROR', 'Notlar yüklenemedi.', true);
        setState({ kind: 'error', message: error.message, retryable: error.retryable });
      });
    return () => { active = false; };
  }, [jobId, load, reloadKey, refreshKey]);

  // Realtime invalidation: reload first page and merge new notes without losing
  // older pages or resetting the lifecycle note key.
  const prevRealtimeKey = useRef(realtimeKey);
  useEffect(() => {
    const previous = prevRealtimeKey.current;
    prevRealtimeKey.current = realtimeKey;
    if (realtimeKey === 0 || previous === realtimeKey) return;
    let active = true;
    load(jobId, { limit: PAGE_SIZE, before: null })
      .then((page) => {
        if (!active) return;
        setState((current) => {
          if (current.kind !== 'ready') return { kind: 'ready', page };
          const existingIds = new Set(current.page.items.map((n) => n.id));
          const newItems = page.items.filter((n) => !existingIds.has(n.id));
          // Preserve all previously loaded items; append genuinely new ones
          // deduplicating by stable note ID.
          return {
            ...current,
            page: {
              ...current.page,
              items: [...current.page.items, ...newItems],
              // Preserve existing pagination cursor — do NOT replace with
              // the freshly fetched first-page cursor which would discard
              // previously loaded older page state.
              nextCursor: current.page.nextCursor,
            },
          };
        });
      })
      .catch(() => {});
    return () => { active = false; };
  }, [realtimeKey, jobId, load]);

  function updateDraft(value: string) {
    if (actionRef.current && actionRef.current.note !== value.trim()) actionRef.current = null;
    setDraft(value);
    setDraftError(codePointLength(value.trim()) > 4000 ? 'Not 1 ile 4.000 karakter arasında olmalıdır.' : '');
    setSubmitError('');
  }

  function updateInvoiceDraft(value: string) {
    const invoiceNumber = value.trim() || null;
    if (actionRef.current && actionRef.current.invoiceNumber !== invoiceNumber) {
      actionRef.current = null;
    }
    setInvoiceDraft(value);
    setSubmitError('');
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const note = draft.trim();
    const length = codePointLength(note);
    if (length < 1 || length > 4000) {
      setDraftError('Not 1 ile 4.000 karakter arasında olmalıdır.');
      return;
    }
    const invoiceNumber = invoiceDraft.trim() || null;
    const action = actionRef.current?.note === note && actionRef.current?.invoiceNumber === invoiceNumber
      ? actionRef.current : { id: createActionId(), note, invoiceNumber };
    actionRef.current = action;
    setPending(true);
    setSubmitError('');
    try {
      const created = await add(jobId, {
        clientActionId: action.id,
        note,
        ...(invoiceNumber ? { invoiceNumber } : {}),
      });
      actionRef.current = null;
      setDraft('');
      setInvoiceDraft('');
      setState((current) => current.kind !== 'ready'
        ? current
        : {
            ...current,
            page: {
              ...current.page,
              items: [
                ...current.page.items.filter((item) => item.id !== created.id),
                created,
              ],
            },
          });
      onAdded();
    } catch (caught) {
      const error = caught instanceof Error ? caught.message : 'Not kaydedilemedi.';
      setSubmitError(error);
    } finally {
      setPending(false);
    }
  }

  async function loadOlder(before: JobCardNoteCursor) {
    if (loadingOlder || state.kind !== 'ready') return;
    setLoadingOlder(true);
    setSubmitError('');
    try {
      const older = await load(jobId, { limit: PAGE_SIZE, before });
      setState((current) => {
        if (current.kind !== 'ready') return current;
        const existingIds = new Set(current.page.items.map((note) => note.id));
        return {
          kind: 'ready',
          page: {
            items: [
              ...older.items.filter((note) => !existingIds.has(note.id)),
              ...current.page.items,
            ],
            limit: current.page.limit,
            nextCursor: older.nextCursor,
          },
        };
      });
    } catch (caught) {
      const error = caught instanceof Error ? caught.message : 'Eski notlar yüklenemedi.';
      setSubmitError(error);
    } finally {
      setLoadingOlder(false);
    }
  }

  const remaining = 4000 - codePointLength(draft);
  if (hideWhenEmpty && state.kind === 'ready' && state.page.items.length === 0) return null;
  return <section className="job-notes surface" aria-labelledby="job-notes-title">
    <div className="detail-section-heading"><h2 id="job-notes-title">Notlar</h2>
      {canAdd && <ProgressiveCounter remaining={remaining} dataCounter="job-note">
        {remaining} karakter kaldı
      </ProgressiveCounter>}</div>
    {canAdd && <form onSubmit={submit} noValidate>
      {showInvoiceField && <div className="field-group">
        <label htmlFor="job-note-invoice">Fatura numarası</label>
        <input id="job-note-invoice" name="invoiceNumber" type="text" maxLength={100}
          value={invoiceDraft} disabled={pending}
          placeholder="Örn: FT-2026-00124"
          onChange={(event) => updateInvoiceDraft(event.target.value)} />
      </div>}
      <div className="field-group">
        <label htmlFor="job-note">İş notu</label>
        <textarea id="job-note" name="note" rows={4} value={draft} disabled={pending}
          placeholder="Örn: Müşteri 14:00 sonrası uygun; teslim tarihi teyit edilecek."
          aria-invalid={draftError ? 'true' : undefined}
          aria-describedby="job-note-error"
          onChange={(event) => updateDraft(event.target.value)} />
      </div>
      {draftError && <p id="job-note-error" className="field-error" role="alert">{draftError}</p>}
      {submitError && <p className="field-error" role="alert">{submitError}</p>}
      <button className="primary-button compact-button" type="submit" disabled={pending}>
        {pending ? 'Kaydediliyor…' : 'Not ekle'}
      </button>
    </form>}

    {state.kind === 'loading' && <LoadingSkeleton title="Notlar yükleniyor" headingLevel={3} rows={2} />}
    {state.kind === 'error' && <ResultState status="error" title="Notlar yüklenemedi" description={state.message} headingLevel={3}
      action={state.retryable ? <button className="secondary-button" type="button" onClick={() => setReloadKey((value) => value + 1)}>Tekrar dene</button> : undefined}
    />}
    {state.kind === 'ready' && (state.page.items.length === 0
      ? <EmptyState title="Henüz iş notu yok" />
      : <ul className="job-note-list">{state.page.items.map((note) => <li key={note.id}>
        <p className="job-note-body">{note.note}</p><div className="job-note-meta"><strong>{note.author.name}</strong>
          {note.invoiceNumber && <span className="job-note-invoice">Fatura: {note.invoiceNumber}</span>}
          {note.recordVersion === 1 && <>
            <span>{contextLabels[note.context]}</span>
            <span>{roleLabels[note.author.role]}</span>
            <span>{jobCardStatusLabel(note.workflowStage)}</span>
          </>}
          {note.recordVersion === 0 && <>
            <span>Legacy kimlik</span>
            <span>Aşama kaydı mevcut değil</span>
          </>}
          <time dateTime={note.createdAt}>{new Intl.DateTimeFormat('tr-TR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(note.createdAt))}</time></div>
      </li>)}</ul>)}
    {state.kind === 'ready' && state.page.nextCursor && <div className="job-pagination">
      <button
        type="button"
        className="secondary-button"
        disabled={loadingOlder}
        onClick={() => void loadOlder(state.page.nextCursor!)}
      >
        {loadingOlder ? 'Yükleniyor…' : 'Daha eski notları yükle'}
      </button>
    </div>}
  </section>;
}
