import { useEffect, useRef, useState, type FormEvent } from 'react';

import { useRealtimeInvalidation } from './realtime/RealtimeProvider';
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
  const [createError, setCreateError] = useState('');
  const [notice, setNotice] = useState('');
  const requestGate = useRef(createRequestGate());
  const actionRef = useRef<{ id: string; body: string } | null>(null);
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
    void load(0);
    return () => { requestGate.current.next(); };
  }, [staffUserId]);

  useRealtimeInvalidation([`staff-confidential-notes:${staffUserId}`], () => {
    void load(page?.offset ?? 0);
  });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = body.trim();
    if (!trimmed) {
      setCreateError('Not boş olamaz.');
      return;
    }
    if (trimmed.length > 4000) {
      setCreateError('Not 4000 karakterden uzun olamaz.');
      return;
    }
    setPending(true);
    setCreateError('');
    setNotice('');
    const action = actionRef.current?.body === trimmed
      ? actionRef.current
      : { id: crypto.randomUUID(), body: trimmed };
    actionRef.current = action;
    try {
      await createStaffConfidentialNote(staffUserId, {
        clientActionId: action.id,
        body: trimmed,
      });
      actionRef.current = null;
      setBody('');
      setNotice('Gizli not eklendi.');
      window.setTimeout(() => noticeRef.current?.focus(), 0);
      await load(page?.offset ?? 0);
    } catch (caught) {
      setCreateError(caught instanceof Error ? caught.message : 'Gizli not eklenemedi.');
    } finally {
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
      <label className="field-group" htmlFor="confidential-note-body">Yeni not
        <textarea id="confidential-note-body" name="body" rows={4}
          value={body} maxLength={4000} disabled={pending} aria-busy={pending}
          placeholder="Personel hakkında gizli operasyon notu…"
          onChange={(event) => setBody(event.target.value)} />
      </label>
      <div className="form-actions">
        <button className="primary-button compact-button" type="submit" disabled={pending || loading}>
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
