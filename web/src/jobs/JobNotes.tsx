import { useEffect, useRef, useState, type FormEvent } from 'react';

import { ApiError } from '../services/api';
import {
  addJobCardNote, listJobCardNotes, type JobCardNote, type Paginated,
} from './jobs-api';

const PAGE_SIZE = 25;
const codePointLength = (value: string) => Array.from(value).length;

type NotesState =
  | { kind: 'loading' }
  | { kind: 'ready'; page: Paginated<JobCardNote> }
  | { kind: 'error'; message: string; retryable: boolean };

export function JobNotes({
  jobId,
  load = listJobCardNotes,
  add = addJobCardNote,
  createActionId = () => crypto.randomUUID(),
}: {
  jobId: string;
  load?: typeof listJobCardNotes;
  add?: typeof addJobCardNote;
  createActionId?: () => string;
}) {
  const [offset, setOffset] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);
  const [state, setState] = useState<NotesState>({ kind: 'loading' });
  const [draft, setDraft] = useState('');
  const [draftError, setDraftError] = useState('');
  const [submitError, setSubmitError] = useState('');
  const [pending, setPending] = useState(false);
  const actionRef = useRef<{ id: string; note: string } | null>(null);

  useEffect(() => {
    let active = true;
    setState({ kind: 'loading' });
    load(jobId, { limit: PAGE_SIZE, offset })
      .then((page) => { if (active) setState({ kind: 'ready', page }); })
      .catch((caught) => {
        if (!active) return;
        const error = caught instanceof ApiError
          ? caught : new ApiError(0, 'UNKNOWN_ERROR', 'Notlar yüklenemedi.', true);
        setState({ kind: 'error', message: error.message, retryable: error.retryable });
      });
    return () => { active = false; };
  }, [jobId, load, offset, reloadKey]);

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
      const saved = await add(jobId, { clientActionId: action.id, note });
      setState((current) => {
        if (current.kind !== 'ready') return current;
        const items = [saved, ...current.page.items.filter((item) => item.id !== saved.id)];
        return { kind: 'ready', page: { ...current.page, items, total: Math.max(current.page.total + 1, items.length) } };
      });
      actionRef.current = null;
      setDraft('');
    } catch (caught) {
      const error = caught instanceof Error ? caught.message : 'Not kaydedilemedi.';
      setSubmitError(error);
    } finally {
      setPending(false);
    }
  }

  const remaining = 4000 - codePointLength(draft);
  return <section className="job-notes" aria-labelledby="job-notes-title">
    <div className="detail-section-heading"><h2 id="job-notes-title">Notlar</h2>
      <span aria-live="polite">{remaining} karakter kaldı</span></div>
    <form onSubmit={submit} noValidate>
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
    </form>

    {state.kind === 'loading' && <div aria-busy="true"><p>Notlar yükleniyor</p></div>}
    {state.kind === 'error' && <div className="workspace-message" role="alert"><p>{state.message}</p>
      {state.retryable && <button className="secondary-button" type="button" onClick={() => setReloadKey((value) => value + 1)}>Tekrar dene</button>}
    </div>}
    {state.kind === 'ready' && (state.page.items.length === 0
      ? <p className="detail-empty">Henüz iş notu yok.</p>
      : <ul className="job-note-list">{state.page.items.map((note) => <li key={note.id}>
        <p>{note.note}</p><div><strong>{note.author.name}</strong>
          <time dateTime={note.createdAt}>{new Intl.DateTimeFormat('tr-TR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(note.createdAt))}</time></div>
      </li>)}</ul>)}
    {state.kind === 'ready' && state.page.total > state.page.limit && <nav className="job-pagination" aria-label="Not sayfaları">
      <button type="button" className="secondary-button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>Önceki</button>
      <span>{offset + 1}–{Math.min(offset + state.page.items.length, state.page.total)} / {state.page.total}</span>
      <button type="button" className="secondary-button" disabled={offset + PAGE_SIZE >= state.page.total} onClick={() => setOffset(offset + PAGE_SIZE)}>Sonraki</button>
    </nav>}
  </section>;
}
