import { useEffect, useRef, useState, type FormEvent } from 'react';

import { ApiError } from '../services/api';
import { EmptyState, LoadingSkeleton, ResultState } from '../ui/antd';
import {
  addJobCardNote,
  listJobCardNotes,
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
}: {
  jobId: string;
  load?: typeof listJobCardNotes;
  add?: typeof addJobCardNote;
  createActionId?: () => string;
  onAdded?: () => void;
  canAdd?: boolean;
  hideWhenEmpty?: boolean;
  refreshKey?: number;
}) {
  const [reloadKey, setReloadKey] = useState(0);
  const [state, setState] = useState<NotesState>({ kind: 'loading' });
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [draft, setDraft] = useState('');
  const [draftError, setDraftError] = useState('');
  const [submitError, setSubmitError] = useState('');
  const [pending, setPending] = useState(false);
  const actionRef = useRef<{ id: string; note: string } | null>(null);

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

  function updateDraft(value: string) {
    if (actionRef.current && actionRef.current.note !== value.trim()) actionRef.current = null;
    setDraft(value);
    setDraftError(codePointLength(value.trim()) > 4000 ? 'Not 1 ile 4.000 karakter arasında olmalıdır.' : '');
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
    const action = actionRef.current?.note === note
      ? actionRef.current : { id: createActionId(), note };
    actionRef.current = action;
    setPending(true);
    setSubmitError('');
    try {
      const created = await add(jobId, { clientActionId: action.id, note });
      actionRef.current = null;
      setDraft('');
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
      {canAdd && <span aria-live="polite">{remaining} karakter kaldı</span>}</div>
    <p className="job-notes-help">
      Notlar iş durumunu değiştirmez. Ek bilgi ve yapılan hazırlıkları ekip için burada paylaşabilirsiniz.
    </p>
    {canAdd && <form onSubmit={submit} noValidate>
      <div className="field-group">
        <label htmlFor="job-note">İş notu</label>
        <textarea id="job-note" name="note" rows={4} value={draft} disabled={pending}
          aria-invalid={draftError ? 'true' : undefined}
          aria-describedby="job-note-help job-note-error"
          onChange={(event) => updateDraft(event.target.value)} />
      </div>
      <p id="job-note-help" className="form-help">Bu not, iş geçmişinde yetkili kullanıcılar tarafından görülebilir.</p>
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
