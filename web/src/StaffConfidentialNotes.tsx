import { useEffect, useRef, useState, type FormEvent } from 'react';

import { useRealtimeInvalidation } from './realtime/RealtimeProvider';
import { isDefinitiveMutationError } from './jobs/mutation-attempt-error';
import type { CurrentUser } from './services/api';
import { createRequestGate } from './services/request-gate';
import {
  createStaffConfidentialNote,
  listStaffConfidentialNotes,
  type StaffConfidentialNote,
  type StaffConfidentialNotePage,
} from './services/staff-confidential-notes-api';
import { EmptyState } from './ui/antd/EmptyState';
import { ResultState } from './ui/antd/ResultState';

const PAGE_LIMIT = 10;

type ConfidentialNoteAttempt = {
  subjectStaffUserId: string;
  clientActionId: string;
  body: string;
};

function formatNoteDate(value: string) {
  return new Date(value).toLocaleString('tr-TR', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function StaffConfidentialNotesSection({
  staffUserId,
  actor,
}: {
  staffUserId: string;
  actor: CurrentUser;
}) {
  const [page, setPage] = useState<StaffConfidentialNotePage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [body, setBody] = useState('');
  const [pending, setPending] = useState(false);
  const [ambiguous, setAmbiguous] = useState(false);
  const [createError, setCreateError] = useState('');
  const [notice, setNotice] = useState('');
  const requestGate = useRef(createRequestGate());
  const actionRef = useRef<ConfidentialNoteAttempt | null>(null);
  // Mutation ownership: replaced on every Staff-subject transition so async
  // completions belonging to a previous subject become fully inert. Object
  // identity is the token — a stale sendAttempt holds the old object.
  const mutationOwner = useRef({ subjectStaffUserId: staffUserId, generation: 0 });
  const noticeRef = useRef<HTMLParagraphElement>(null);

  const load = async (offset: number) => {
    const generation = requestGate.current.next();
    setLoading(true);
    setError('');
    try {
      const result = await listStaffConfidentialNotes(staffUserId, {
        limit: PAGE_LIMIT,
        offset,
      });
      if (!requestGate.current.isCurrent(generation)) return;
      setPage(result);
    } catch (caught) {
      if (requestGate.current.isCurrent(generation)) {
        setError(caught instanceof Error ? caught.message : 'Gizli notlar yüklenemedi.');
      }
    } finally {
      if (requestGate.current.isCurrent(generation)) setLoading(false);
    }
  };

  useEffect(() => {
    // An unresolved attempt belongs to exactly one Staff subject; never let it
    // migrate to another subject when the viewed profile changes. Invalidate
    // the previous mutation ownership first so its late completions stay inert,
    // then reset all subject-local mutation UI (including a carried-over draft).
    mutationOwner.current = {
      subjectStaffUserId: staffUserId,
      generation: mutationOwner.current.generation + 1,
    };
    actionRef.current = null;
    setAmbiguous(false);
    setPending(false);
    setCreateError('');
    setNotice('');
    setBody('');
    void load(0);
    return () => { requestGate.current.next(); };
  }, [staffUserId]);

  useRealtimeInvalidation([`staff-confidential-notes:${staffUserId}`], () => {
    void load(page?.offset ?? 0);
  });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (ambiguous) return;
    const trimmed = body.trim();
    if (!trimmed) {
      setCreateError('Not boş olamaz.');
      return;
    }
    if (trimmed.length > 4000) {
      setCreateError('Not 4000 karakterden uzun olamaz.');
      return;
    }
    const action = actionRef.current?.subjectStaffUserId === staffUserId
      && actionRef.current?.body === trimmed
      ? actionRef.current
      : { subjectStaffUserId: staffUserId, clientActionId: crypto.randomUUID(), body: trimmed };
    actionRef.current = action;
    await sendAttempt(action);
  }

  async function sendAttempt(attempt: ConfidentialNoteAttempt) {
    // Capture ownership before the async mutation: only completions that still
    // hold the current owner object may touch state. A Staff-subject switch
    // replaces mutationOwner.current, so stale completions return inertly.
    // Never rely on the closure staffUserId here — it still holds Staff A.
    const ownership = mutationOwner.current;
    const owned = () => mutationOwner.current === ownership;
    if (attempt.subjectStaffUserId !== ownership.subjectStaffUserId) {
      actionRef.current = null;
      setAmbiguous(false);
      return;
    }
    setPending(true);
    setCreateError('');
    setNotice('');
    try {
      await createStaffConfidentialNote(attempt.subjectStaffUserId, {
        clientActionId: attempt.clientActionId,
        body: attempt.body,
      });
      if (!owned()) return;
      actionRef.current = null;
      setAmbiguous(false);
      setCreateError('');
      setBody('');
      setNotice('Gizli not eklendi.');
      window.setTimeout(() => noticeRef.current?.focus(), 0);
      await load(page?.offset ?? 0);
    } catch (caught) {
      if (!owned()) return;
      // Fail-safe: only an authoritative non-retryable server response proves
      // the attempt resolved; anything else keeps the frozen attempt so the
      // exact retry replays the original subject/key/body.
      if (isDefinitiveMutationError(caught)) {
        actionRef.current = null;
        setAmbiguous(false);
      } else {
        setAmbiguous(true);
      }
      setCreateError(caught instanceof Error ? caught.message : 'Gizli not eklenemedi.');
    } finally {
      // A stale completion must not clear pending for a newer request.
      if (!owned()) return;
      setPending(false);
    }
  }

  const items: StaffConfidentialNote[] = page?.items ?? [];
  const hasNext = page ? page.offset + page.items.length < page.total : false;
  const hasPrevious = (page?.offset ?? 0) > 0;

  return <section className="record-section staff-confidential-notes" aria-labelledby="confidential-notes-title">
    <div className="section-heading">
      <h2 id="confidential-notes-title">Gizli yönetim notları</h2>
      <span>{page?.total ?? '…'} kayıt</span>
    </div>
    <p className="confidential-notes-privacy-hint">
      Bu notlar yalnız yönetim rolleri (yönetici ve müdür) tarafından görülebilir ve hiçbir
      personel tarafından okunamaz.
    </p>
    {notice && <p className="success-message" role="status" tabIndex={-1} ref={noticeRef}>{notice}</p>}
    {createError && <p className="form-error" role="alert">{createError}</p>}
    <form className="confidential-note-form" onSubmit={submit} noValidate>
      {ambiguous && <div className="detail-feedback" role="status">
        <p>İşlemin sonucu henüz doğrulanamadı. Özgün istek korunuyor; yeni işlemden önce tekrar deneyin.</p>
        <button type="button" className="primary-button" data-original-retry disabled={pending}
          onClick={() => { const attempt = actionRef.current; if (attempt) void sendAttempt(attempt); }}>Özgün isteği tekrar dene</button>
      </div>}
      <label className="field-group" htmlFor="confidential-note-body">Yeni not
        <textarea id="confidential-note-body" name="body" rows={4}
          value={body} maxLength={4000} disabled={pending || ambiguous} aria-busy={pending}
          placeholder="Personel hakkında gizli operasyon notu…"
          onChange={(event) => setBody(event.target.value)} />
      </label>
      <div className="form-actions">
        <button className="primary-button compact-button" type="submit" disabled={pending || loading || ambiguous}>
          {pending ? 'Ekleniyor…' : 'Not ekle'}
        </button>
      </div>
    </form>
    {loading && <p className="muted-copy" aria-busy="true">Gizli notlar yükleniyor…</p>}
    {!loading && error && <ResultState status="error" title="Gizli notlar yüklenemedi" description={error}
      headingLevel={3} action={<button className="secondary-button" type="button" onClick={() => void load(page?.offset ?? 0)}>Tekrar dene</button>} />}
    {!loading && !error && items.length === 0 && <EmptyState title="Not bulunmuyor"
      description="Bu personel için henüz gizli yönetim notu yok." headingLevel={3} />}
    {!loading && !error && items.length > 0 && <ul className="confidential-note-list">
      {items.map((note) => <li key={note.id} className="confidential-note-row">
        <p className="confidential-note-body">{note.body}</p>
        <p className="confidential-note-meta">
          <time dateTime={note.createdAt}>{formatNoteDate(note.createdAt)}</time>
          <span>Ekleyen: {note.authorName}</span>
        </p>
      </li>)}
    </ul>}
    {(hasPrevious || hasNext) && <div className="pagination-actions">
      <button type="button" className="secondary-button" disabled={!hasPrevious || loading}
        onClick={() => void load(Math.max(0, (page?.offset ?? 0) - PAGE_LIMIT))}>Önceki</button>
      <button type="button" className="secondary-button" disabled={!hasNext || loading}
        onClick={() => void load((page?.offset ?? 0) + PAGE_LIMIT)}>Daha fazla göster</button>
    </div>}
  </section>;
}
