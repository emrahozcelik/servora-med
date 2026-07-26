import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { patchJobCard } from '../jobs/jobs-api';
import { paths } from '../paths';
import { useRealtimeInvalidation } from '../realtime/RealtimeProvider';
import type { ApiError, CurrentUser } from '../services/api';
import {
  cancelManualEvent,
  createManualEvent,
  getCalendarEvent,
  listCalendar,
  listCalendarAssignees,
  patchManualEvent,
  type CalendarAssignee,
  type CalendarEvent,
  type ManualCalendarEvent,
} from '../services/calendar-api';

const DAY_MS = 24 * 60 * 60 * 1_000;
const localInput = (instant: string) => {
  const date = new Date(instant);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.valueOf() - offset).toISOString().slice(0, 16);
};
const instant = (value: string) => new Date(value).toISOString();
const actionId = () => crypto.randomUUID();
const weekStart = (value: Date) => {
  const result = new Date(value);
  const day = (result.getDay() + 6) % 7;
  result.setHours(0, 0, 0, 0);
  result.setDate(result.getDate() - day);
  return result;
};
const weekRange = (anchor: Date) => {
  const from = weekStart(anchor);
  return {
    from: from.toISOString(),
    to: new Date(from.valueOf() + 7 * DAY_MS).toISOString(),
  };
};

type Draft = {
  assignedUserId: string;
  title: string;
  description: string;
  startsAt: string;
  endsAt: string;
};

function EventForm({
  user,
  assignees,
  event,
  defaultAssigneeId,
  onSaved,
  onClose,
}: {
  user: CurrentUser;
  assignees: CalendarAssignee[];
  event: CalendarEvent | null;
  defaultAssigneeId: string;
  onSaved: () => void;
  onClose: () => void;
}) {
  const initialAssignee = event?.assignedUser.id ?? defaultAssigneeId;
  const now = new Date();
  now.setMinutes(Math.ceil(now.getMinutes() / 30) * 30, 0, 0);
  const [draft, setDraft] = useState<Draft>({
    assignedUserId: initialAssignee,
    title: event?.title ?? '',
    description: event?.source === 'MANUAL' ? event.description ?? '' : '',
    startsAt: event ? localInput(event.startsAt) : localInput(now.toISOString()),
    endsAt: event?.endsAt
      ? localInput(event.endsAt)
      : localInput(new Date(now.valueOf() + 60 * 60_000).toISOString()),
  });
  const [error, setError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<Array<Record<string, unknown>>>([]);
  const [pending, setPending] = useState(false);

  const submit = async (submitEvent: FormEvent) => {
    submitEvent.preventDefault();
    setPending(true);
    setError(null);
    setConflicts([]);
    try {
      if (!event) {
        await createManualEvent({
          clientActionId: actionId(),
          assignedUserId: draft.assignedUserId,
          title: draft.title,
          description: draft.description.trim() || null,
          startsAt: instant(draft.startsAt),
          endsAt: instant(draft.endsAt),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        });
      } else if (event.source === 'MANUAL') {
        await patchManualEvent(event.id, {
          clientActionId: actionId(),
          expectedVersion: event.version,
          assignedUserId: draft.assignedUserId,
          title: draft.title,
          description: draft.description.trim() || null,
          startsAt: instant(draft.startsAt),
          endsAt: instant(draft.endsAt),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        });
      } else {
        await patchJobCard(event.jobCardId, {
          expectedVersion: event.version,
          assignedTo: draft.assignedUserId,
          scheduledAt: instant(draft.startsAt),
          scheduledEndsAt: instant(draft.endsAt),
        });
      }
      onSaved();
    } catch (caught) {
      const api = caught as ApiError;
      if (api.code === 'CALENDAR_CONFLICT') {
        setError('Bu zaman aralığı başka bir planla çakışıyor. Taslağınız korundu.');
        const raw = api.details?.conflicts;
        setConflicts(Array.isArray(raw) ? raw as Array<Record<string, unknown>> : []);
      } else if (api.code === 'VERSION_CONFLICT') {
        setError('Bu kayıt başka bir kullanıcı tarafından değiştirildi. Taslağınız korundu; güncel değerleri yükleyin.');
      } else {
        setError(caught instanceof Error ? caught.message : 'Plan kaydedilemedi.');
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <form className="calendar-form surface" onSubmit={submit}>
      <h2>{event ? 'Planı düzenle' : 'Yeni kişisel plan'}</h2>
      {user.role !== 'STAFF' && (
        <label className="field-group"><span className="field-label">Personel</span>
          <select value={draft.assignedUserId} onChange={(e) => setDraft({ ...draft, assignedUserId: e.target.value })}>
            {assignees.map((assignee) => <option key={assignee.id} value={assignee.id}>{assignee.name}</option>)}
          </select>
        </label>
      )}
      {event?.source !== 'JOB' && (
        <>
          <label className="field-group"><span className="field-label">Başlık</span>
            <input required maxLength={200} value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
          </label>
          <label className="field-group"><span className="field-label">Açıklama (isteğe bağlı)</span>
            <textarea maxLength={4000} value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          </label>
        </>
      )}
      <div className="calendar-form-times">
        <label className="field-group"><span className="field-label">Başlangıç</span>
          <input required type="datetime-local" value={draft.startsAt}
            onChange={(e) => setDraft({ ...draft, startsAt: e.target.value })} />
        </label>
        <label className="field-group"><span className="field-label">Bitiş</span>
          <input required type="datetime-local" value={draft.endsAt}
            onChange={(e) => setDraft({ ...draft, endsAt: e.target.value })} />
        </label>
      </div>
      {error && <div className="form-error" role="alert"><p>{error}</p>
        {conflicts.map((conflict) => (
          <p key={String(conflict.id)}>
            {String(conflict.title)} · {new Date(String(conflict.startsAt)).toLocaleString('tr-TR')}
          </p>
        ))}
      </div>}
      <div className="form-actions">
        <button type="button" className="secondary-button" onClick={onClose}>Vazgeç</button>
        <button type="submit" className="primary-button" disabled={pending}>
          {pending ? 'Kaydediliyor…' : 'Kaydet'}
        </button>
      </div>
    </form>
  );
}

function EventItem({
  event,
  onEdit,
  onCancelled,
  selected,
}: {
  event: CalendarEvent;
  onEdit: () => void;
  onCancelled: () => void;
  selected: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const cancel = async () => {
    if (event.source !== 'MANUAL') return;
    const reason = window.prompt('İptal nedenini yazın:');
    if (!reason?.trim()) return;
    if (!window.confirm('Bu takvim planını iptal etmek istediğinize emin misiniz?')) return;
    try {
      await cancelManualEvent(event.id, {
        clientActionId: actionId(),
        expectedVersion: event.version,
        cancelReason: reason,
      });
      onCancelled();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Plan iptal edilemedi.');
    }
  };
  return (
    <article
      className={`calendar-event${selected ? ' calendar-event--selected' : ''}`}
      aria-current={selected ? 'true' : undefined}
    >
      <div>
        <span className={`calendar-source calendar-source--${event.source.toLowerCase()}`}>
          {event.source === 'JOB' ? 'İŞ' : 'KİŞİSEL PLAN'}
        </span>
        <h3>{event.title}</h3>
        <p>{new Date(event.startsAt).toLocaleString('tr-TR')}
          {event.endsAt ? ` – ${new Date(event.endsAt).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}` : ''}</p>
        <p>{event.assignedUser.name}</p>
      </div>
      <div className="calendar-event-actions">
        {event.source === 'JOB' && <Link to={event.relatedJobPath}>İşi aç</Link>}
        {event.canEdit && <button type="button" className="secondary-button" onClick={onEdit}>Düzenle</button>}
        {event.canCancel && <button type="button" className="destructive-button" onClick={() => void cancel()}>İptal et</button>}
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
    </article>
  );
}

export function CalendarPage({ user }: { user: CurrentUser }) {
  const [searchParams] = useSearchParams();
  const selectedEventId = searchParams.get('event');
  const [anchor, setAnchor] = useState(() => new Date());
  const [assignedTo, setAssignedTo] = useState(user.role === 'STAFF' ? user.id : '');
  const [assignees, setAssignees] = useState<CalendarAssignee[]>([]);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<CalendarEvent | null | 'new'>(null);
  const range = useMemo(() => weekRange(anchor), [anchor]);

  const refresh = useCallback(async () => {
    setState('loading');
    try {
      const [calendar, users] = await Promise.all([
        listCalendar({
          ...range,
          assignedTo: user.role === 'STAFF' ? undefined : assignedTo,
        }),
        listCalendarAssignees(),
      ]);
      setEvents(calendar);
      setAssignees(users);
      setState('ready');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Takvim yüklenemedi.');
      setState('error');
    }
  }, [assignedTo, range, user.role]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!selectedEventId) return;
    let active = true;
    void getCalendarEvent(selectedEventId).then((selected) => {
      if (active) setAnchor(new Date(selected.startsAt));
    }).catch(() => {
      // The weekly list remains usable when the selected event is unavailable.
    });
    return () => { active = false; };
  }, [selectedEventId]);
  useRealtimeInvalidation(['calendar', `calendar:${assignedTo}`], () => { void refresh(); });

  return (
    <main className="workspace calendar-workspace">
      <header className="workspace-heading">
        <div><p className="eyebrow">Haftalık planlama</p><h1>Takvim</h1>
          <p>İşlerinizi ve operasyonel planlarınızı tek zaman çizelgesinde görün.</p></div>
        <button
          type="button"
          className="primary-button"
          disabled={user.role !== 'STAFF' && assignees.length === 0}
          onClick={() => setEditing('new')}
        >
          Yeni plan
        </button>
      </header>
      <div className="calendar-toolbar surface">
        <button type="button" className="secondary-button" onClick={() => setAnchor(new Date(anchor.valueOf() - 7 * DAY_MS))}>Önceki hafta</button>
        <strong>{new Date(range.from).toLocaleDateString('tr-TR')} – {new Date(range.to).toLocaleDateString('tr-TR')}</strong>
        <button type="button" className="secondary-button" onClick={() => setAnchor(new Date(anchor.valueOf() + 7 * DAY_MS))}>Sonraki hafta</button>
        {user.role !== 'STAFF' && <label><span>Personel</span>
          <select value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)}>
            <option value="">Tüm yetkili personel</option>
            {assignees.map((assignee) => <option key={assignee.id} value={assignee.id}>{assignee.name}</option>)}
          </select>
        </label>}
      </div>
      {editing && <EventForm user={user} assignees={assignees}
        event={editing === 'new' ? null : editing}
        defaultAssigneeId={assignedTo || assignees[0]?.id || user.id}
        onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); void refresh(); }} />}
      {state === 'loading' && <div className="workspace-message" aria-busy="true"><p>Takvim yükleniyor…</p></div>}
      {state === 'error' && <div className="workspace-message" role="alert"><h2>Takvim yüklenemedi</h2><p>{error}</p>
        <button type="button" className="secondary-button" onClick={() => void refresh()}>Tekrar dene</button></div>}
      {state === 'ready' && events.length === 0 && <div className="workspace-message"><h2>Bu hafta plan bulunmuyor</h2>
        <p>Yeni bir kişisel plan oluşturabilir veya başka bir haftaya geçebilirsiniz.</p></div>}
      {state === 'ready' && events.length > 0 && <section className="calendar-list" aria-label="Haftalık planlar">
        {events.map((event) => <EventItem key={`${event.source}:${event.id}`} event={event}
          selected={event.id === selectedEventId}
          onEdit={() => setEditing(event)} onCancelled={() => void refresh()} />)}
      </section>}
      <p className="calendar-help"><Link to={paths.docs}>Takvim kullanım yardımını aç</Link></p>
    </main>
  );
}
