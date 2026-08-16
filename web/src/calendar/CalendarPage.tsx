import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { patchJobCard } from '../jobs/jobs-api';
import type { AvailableSlot } from '../jobs/jobs-api';
import { AvailableSlotsNotice } from '../jobs/AvailableSlotsNotice';
import { useAvailableSlotSearch } from '../jobs/useAvailableSlotSearch';
import { useReassignmentConversationSync } from '../jobs/useReassignmentConversationSync';
import { ReassignmentSyncPrompt } from '../jobs/ReassignmentSyncPrompt';
import { paths } from '../paths';
import { useRealtimeInvalidation } from '../realtime/RealtimeProvider';
import type { ApiError, CurrentUser } from '../services/api';
import { intervalIntersectsLocalDay } from './calendar-date';
import {
  cancelManualEvent,
  createManualEvent,
  getCalendarEvent,
  listCalendar,
  listCalendarAssignees,
  patchManualEvent,
  type CalendarAssignee,
  type CalendarEvent,
} from '../services/calendar-api';
import { EmptyState } from '../ui/antd/EmptyState';
import { LoadingSkeleton } from '../ui/antd/LoadingSkeleton';
import { OperationalCard } from '../ui/antd/OperationalCard';
import { ReasonDialog } from '../ui/antd/ReasonDialog';
import { ResponsiveFormDrawer } from '../ui/antd/ResponsiveFormDrawer';
import { ResultState } from '../ui/antd/ResultState';
import { ServoraCalendar } from '../ui/antd/ServoraCalendar';
import type { ServoraCalendarEventSummary } from '../ui/antd/ServoraCalendar';
import { useCompact } from '../ui/useResponsive';

// ── helpers ──

const localInput = (instant: string) => {
  const d = new Date(instant);
  const off = d.getTimezoneOffset() * 60_000;
  return new Date(d.valueOf() - off).toISOString().slice(0, 16);
};
const instant = (value: string) => new Date(value).toISOString();
const actionId = () => crypto.randomUUID();

/** Monday of the week containing `d`. */
function mondayOf(d: Date): Date {
  const r = new Date(d);
  const day = (r.getDay() + 6) % 7;
  r.setHours(0, 0, 0, 0);
  r.setDate(r.getDate() - day);
  return r;
}

/**
 * Visible calendar grid range: from Monday of the first visible week
 * to Monday after the last visible week (35–42 days).
 */
function visibleMonthRange(anchor: Date) {
  const year = anchor.getFullYear();
  const month = anchor.getMonth();
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const from = mondayOf(firstDay);
  // 42 local calendar days from Monday, DST-safe
  const to = new Date(from);
  to.setDate(to.getDate() + 42);
  return {
    from: from.toISOString(),
    to: to.toISOString(),
  };
}

/** Convert CalendarEvent to ServoraCalendarEventSummary. */
function toSummary(event: CalendarEvent): ServoraCalendarEventSummary {
  return {
    id: event.id,
    source: event.source,
    title: event.title,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
  };
}

// ── EventForm (moved into drawer) ──

type Draft = {
  assignedUserId: string;
  title: string;
  description: string;
  startsAt: string;
  endsAt: string;
};

function drawerTitle(event: CalendarEvent | null): string {
  if (!event) return 'Yeni plan';
  if (event.source === 'JOB') return 'İş zamanını güncelle';
  return 'Planı düzenle';
}

function EventForm({
  user,
  assignees,
  event,
  defaultAssigneeId,
  onSaved,
  onClose,
  onReassignmentOffer,
}: {
  user: CurrentUser;
  assignees: CalendarAssignee[];
  event: CalendarEvent | null;
  defaultAssigneeId: string;
  onSaved: () => void;
  onClose: () => void;
  onReassignmentOffer?: (params: {
    transitionId: string;
    oldAssignee: { id: string | null; name: string | null };
    newAssignee: { id: string | null; name: string | null };
  }) => void;
}) {
  const initialAssignee = event?.assignedUser.id ?? defaultAssigneeId;
  const isGeneralTaskJob = event?.source === 'JOB' && event.jobType === 'GENERAL_TASK';
  const intervalJobType = event?.source === 'JOB'
    && (event.jobType === 'SALES_MEETING' || event.jobType === 'PRODUCT_DELIVERY')
    ? event.jobType
    : null;
  const now = new Date();
  now.setMinutes(Math.ceil(now.getMinutes() / 30) * 30, 0, 0);
  const defaultEnd = new Date(now.valueOf() + 60 * 60_000);

  const [draft, setDraft] = useState<Draft>({
    assignedUserId: initialAssignee,
    title: event?.title ?? '',
    description: event?.source === 'MANUAL' ? event.description ?? '' : '',
    startsAt: event ? localInput(event.startsAt) : localInput(now.toISOString()),
    endsAt: event?.endsAt
      ? localInput(event.endsAt)
      : isGeneralTaskJob ? '' : localInput(defaultEnd.toISOString()),
  });
  const [error, setError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<Array<Record<string, unknown>>>([]);
  const [pending, setPending] = useState(false);
  const availableSlotSearch = useAvailableSlotSearch({
    type: intervalJobType ?? 'SALES_MEETING',
    customerId: event?.source === 'JOB' ? event.customer?.id ?? null : null,
    assignedTo: intervalJobType ? draft.assignedUserId : null,
    scheduledStartLocal: draft.startsAt,
    scheduledEndLocal: draft.endsAt,
    jobCardId: event?.source === 'JOB' ? event.jobCardId : null,
    enabled: user.capabilities?.calendar === true && intervalJobType !== null,
  });

  function useAvailableSlot(slot: AvailableSlot) {
    setDraft((current) => ({
      ...current,
      startsAt: localInput(slot.startsAt),
      endsAt: localInput(slot.endsAt),
    }));
  }

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
        const patched = event.jobType === 'GENERAL_TASK'
          ? await patchJobCard(event.jobCardId, {
              expectedVersion: event.version,
              assignedTo: draft.assignedUserId,
              scheduledAt: instant(draft.startsAt),
            })
          : await patchJobCard(event.jobCardId, {
              expectedVersion: event.version,
              assignedTo: draft.assignedUserId,
              scheduledAt: instant(draft.startsAt),
              scheduledEndsAt: instant(draft.endsAt),
            });
        if (
          patched.assignmentTransitionId
          && draft.assignedUserId !== initialAssignee
        ) {
          onReassignmentOffer?.({
            transitionId: patched.assignmentTransitionId,
            oldAssignee: { id: initialAssignee, name: event.assignedUser.name },
            newAssignee: { id: draft.assignedUserId, name: patched.assignee.name },
          });
        }
      }
      onSaved();
    } catch (caught) {
      const api = caught as ApiError;
      if (api.code === 'CALENDAR_CONFLICT') {
        setError('Bu zaman aralığı başka bir planla çakışıyor. Taslağınız korundu.');
        const raw = api.details?.conflicts;
        setConflicts(Array.isArray(raw) ? raw as Array<Record<string, unknown>> : []);
      } else if (api.code === 'CUSTOMER_SCHEDULE_CONFLICT') {
        setError('Aynı müşteriye aynı gün başka bir saha işi planlanmış. Farklı bir gün seçin; taslağınız korundu.');
      } else if (api.code === 'CUSTOMER_VISIT_FREQUENCY_REVIEW_REQUIRED') {
        setError('Bu müşteri için ziyaret sıklığı sınırı aşılıyor. Planlama için yönetici değerlendirmesi gerekiyor.');
      } else if (api.code === 'CUSTOMER_VISIT_OVERRIDE_REASON_REQUIRED') {
        setError('Bu müşteri için ziyaret sıklığı sınırı aşılıyor. İş detayından planlama nedenini belirterek kaydedebilirsiniz.');
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
    <form className="calendar-form" onSubmit={submit}>
      {user.role !== 'STAFF' && (
        <label className="field-group"><span className="field-label">Personel</span>
          <select value={draft.assignedUserId} onChange={(e) => setDraft({ ...draft, assignedUserId: e.target.value })}>
            {assignees.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
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
        {!isGeneralTaskJob && (
          <label className="field-group"><span className="field-label">Bitiş</span>
            <input required type="datetime-local" value={draft.endsAt}
              onChange={(e) => setDraft({ ...draft, endsAt: e.target.value })} />
          </label>
        )}
      </div>
      <AvailableSlotsNotice
        {...availableSlotSearch}
        onSelect={useAvailableSlot}
      />
      {error && <div className="form-error" role="alert"><p>{error}</p>
        {conflicts.map((c) => (
          <p key={String(c.id)}>
            {String(c.title)} · {new Date(String(c.startsAt)).toLocaleString('tr-TR')}
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

// ── EventItem (agenda card) ──

function EventItem({
  event,
  onEdit,
  onCancelled,
  selected,
  cancelTriggerRef,
}: {
  event: CalendarEvent;
  onEdit: () => void;
  onCancelled: () => void;
  selected: boolean;
  cancelTriggerRef?: React.RefObject<HTMLButtonElement | null>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelPending, setCancelPending] = useState(false);
  const localCancelRef = useRef<HTMLButtonElement>(null);
  const cancelBtnRef = cancelTriggerRef ?? localCancelRef;

  const handleCancelConfirm = async (reason: string) => {
    setCancelPending(true);
    setError(null);
    try {
      await cancelManualEvent(event.id, {
        clientActionId: actionId(),
        expectedVersion: event.version,
        cancelReason: reason,
      });
      setCancelOpen(false);
      onCancelled();
    } catch (caught) {
      setCancelOpen(false);
      setError(caught instanceof Error ? caught.message : 'Plan iptal edilemedi.');
    } finally {
      setCancelPending(false);
    }
  };

  const sourceLabel = event.source === 'JOB' ? 'İŞ' : 'KİŞİSEL PLAN';
  const followUpContext = event.source === 'JOB' ? event.followUpContext : null;
  const timeText = new Date(event.startsAt).toLocaleString('tr-TR')
    + (event.endsAt
      ? ` – ${new Date(event.endsAt).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}`
      : '');

  const actionBar = (
    <div className="calendar-event-actions">
      {event.source === 'JOB' && <Link to={event.relatedJobPath}>İşi aç</Link>}
      {followUpContext?.sourceJobPath && <Link to={followUpContext.sourceJobPath}>Önceki işi aç</Link>}
      {event.canEdit && <button type="button" className="secondary-button" onClick={onEdit}>Düzenle</button>}
      {event.canCancel && (
        <button
          ref={cancelBtnRef}
          type="button"
          className="destructive-button"
          onClick={() => setCancelOpen(true)}
        >
          İptal et
        </button>
      )}
    </div>
  );

  return (
    <>
      <article aria-current={selected ? 'true' : undefined}>
        <OperationalCard
          tone={selected ? 'selected' : 'default'}
          actions={actionBar}
          className="calendar-event-card"
        >
          <span className={`calendar-source calendar-source--${event.source.toLowerCase()}`}>
            {sourceLabel}
          </span>
          {followUpContext && <span className="calendar-follow-up-badge">Takip</span>}
          <h3>{event.title}</h3>
          <p className="calendar-event-time">{timeText}</p>
          <p>{event.assignedUser.name}</p>
          {followUpContext && (
            <dl className="calendar-follow-up-context">
              {followUpContext.sourcePlannedAt && <div><dt>Planlanan tarih</dt><dd>{new Date(followUpContext.sourcePlannedAt).toLocaleString('tr-TR')}</dd></div>}
              {followUpContext.sourceOccurredAt && <div><dt>Gerçekleşme tarihi</dt><dd>{new Date(followUpContext.sourceOccurredAt).toLocaleString('tr-TR')}</dd></div>}
              <div><dt>Tamamlanma tarihi</dt><dd>{new Date(followUpContext.sourceCompletedAt).toLocaleString('tr-TR')}</dd></div>
            </dl>
          )}
          {error && <p className="form-error" role="alert">{error}</p>}
        </OperationalCard>
      </article>

      <ReasonDialog
        open={cancelOpen}
        title="Plan iptali"
        description={
          <>
            <strong>{event.title}</strong> planını iptal etmek istediğinize emin misiniz?
          </>
        }
        reasonLabel="İptal nedeni"
        confirmLabel="İptal et"
        cancelLabel="Vazgeç"
        maxLength={500}
        required
        pending={cancelPending}
        pendingLabel="İptal ediliyor…"
        destructive
        onConfirm={(reason) => { void handleCancelConfirm(reason); }}
        onCancel={() => setCancelOpen(false)}
        returnFocusRef={cancelBtnRef}
      />
    </>
  );
}

// ── CalendarPage ──

const MAX_VISIBLE_PER_DAY = 3;

export function CalendarPage({ user }: { user: CurrentUser }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedEventId = searchParams.get('event');
  const [month, setMonth] = useState(() => new Date());
  const [selectedDate, setSelectedDate] = useState(() => new Date());
  const [assignedTo, setAssignedTo] = useState(user.role === 'STAFF' ? user.id : '');
  const [assignees, setAssignees] = useState<CalendarAssignee[]>([]);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<CalendarEvent | null | 'new'>(null);
  const reassignmentSync = useReassignmentConversationSync(
    editing !== null && editing !== 'new' && editing.source === 'JOB'
      ? editing.jobCardId
      : '',
  );
  const newPlanTriggerRef = useRef<HTMLButtonElement>(null);

  const range = useMemo(() => visibleMonthRange(month), [month]);
  const compact = useCompact();

  // Event summaries for calendar cells
  const summaries = useMemo(() => events.map(toSummary), [events]);

  // Events intersecting selected day for agenda
  const selectedDayEvents = useMemo(() => {
    const dayStart = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate());
    return events.filter((e) => intervalIntersectsLocalDay(e.startsAt, e.endsAt, dayStart));
  }, [events, selectedDate]);

  const refresh = useCallback(async () => {
    setState('loading');
    try {
      const [calendar, users] = await Promise.all([
        listCalendar({
          from: range.from,
          to: range.to,
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

  // Deep-link: navigate to event's month and select its date
  useEffect(() => {
    if (!selectedEventId) return;
    let active = true;
    void getCalendarEvent(selectedEventId).then((selected) => {
      if (!active) return;
      const d = new Date(selected.startsAt);
      setMonth(new Date(d.getFullYear(), d.getMonth(), 1));
      setSelectedDate(new Date(d.getFullYear(), d.getMonth(), d.getDate()));
    }).catch(() => {
      // Event unavailable — calendar remains usable.
    });
    return () => { active = false; };
  }, [selectedEventId]);

  useRealtimeInvalidation(['calendar', `calendar:${assignedTo}`], () => { void refresh(); });

  const onMonthChange = useCallback((m: Date) => setMonth(m), []);
  const onDateSelect = useCallback((d: Date) => setSelectedDate(d), []);
  const onEventSelect = useCallback((eventId: string) => {
    const next = new URLSearchParams(searchParams);
    next.set('event', eventId);
    setSearchParams(next);
  }, [searchParams, setSearchParams]);
  const openNewPlan = useCallback(() => setEditing('new'), []);

  return (
    <main className="workspace calendar-workspace">
      <header className="workspace-heading">
        <div>
          <p className="eyebrow">Aylık planlama</p>
          <h1 className="route-identity-heading">Takvim</h1>
          <p>İşlerinizi ve operasyonel planlarınızı aylık zaman çizelgesinde görün.</p>
        </div>
        <button
          ref={newPlanTriggerRef}
          type="button"
          className="primary-button"
          disabled={user.role !== 'STAFF' && assignees.length === 0}
          onClick={openNewPlan}
        >
          Yeni plan
        </button>
      </header>

      {/* Loading state */}
      {state === 'loading' && (
        <LoadingSkeleton title="Takvim yükleniyor…" headingLevel={2} rows={4} />
      )}

      {/* Error state with retry */}
      {state === 'error' && (
        <ResultState
          status="error"
          title="Takvim yüklenemedi"
          description={error}
          action={
            <button type="button" className="secondary-button" onClick={() => { void refresh(); }}>
              Tekrar dene
            </button>
          }
        />
      )}

      {/* Monthly calendar + agenda */}
      {state === 'ready' && (
        <>
          {/* Toolbar with Staff filter for Manager/Admin */}
          {user.role !== 'STAFF' && (
            <div className="calendar-toolbar surface">
              <label htmlFor="calendar-personnel-filter"><span>Personel</span>
                <select id="calendar-personnel-filter" name="personnel" value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)}>
                  <option value="">Tüm yetkili personel</option>
                  {assignees.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </label>
            </div>
          )}

          <div className="calendar-layout">
            <section className="calendar-grid-section" aria-label="Aylık takvim">
              <ServoraCalendar
                month={month}
                selectedDate={selectedDate}
                events={summaries}
                compact={compact}
                maxVisibleEventsPerDay={MAX_VISIBLE_PER_DAY}
                onMonthChange={onMonthChange}
                onDateSelect={onDateSelect}
                onEventSelect={onEventSelect}
              />
            </section>
            <section className="calendar-agenda-section" aria-label="Seçili gün planları">
              <h2 className="calendar-agenda-heading">
                {selectedDate.toLocaleDateString('tr-TR', { weekday: 'long', day: 'numeric', month: 'long' })}
              </h2>
              {selectedDayEvents.length === 0 ? (
                <EmptyState
                  title="Bu gün için plan bulunmuyor"
                  description="Seçili tarihte herhangi bir plan kaydı yok."
                />
              ) : (
                <div className="calendar-list">
                  {selectedDayEvents.map((e) => (
                    <EventItem
                      key={`${e.source}:${e.id}`}
                      event={e}
                      selected={e.id === selectedEventId}
                      onEdit={() => setEditing(e)}
                      onCancelled={() => { void refresh(); }}
                    />
                  ))}
                </div>
              )}
            </section>
          </div>
        </>
      )}

      <ReassignmentSyncPrompt
        state={reassignmentSync.state}
        onConfirm={() => { void reassignmentSync.confirm(); }}
        onDismiss={reassignmentSync.dismiss}
      />
      {/* Form drawer */}
      <ResponsiveFormDrawer
        open={editing !== null}
        title={drawerTitle(editing === 'new' ? null : editing)}
        onDismiss={() => setEditing(null)}
        returnFocusRef={newPlanTriggerRef}
      >
        <EventForm
          user={user}
          assignees={assignees}
          event={editing === 'new' ? null : editing}
          defaultAssigneeId={assignedTo || assignees[0]?.id || user.id}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void refresh(); }}
          onReassignmentOffer={(params) => { void reassignmentSync.offerSync(params); }}
        />
      </ResponsiveFormDrawer>

      <p className="calendar-help"><Link to={paths.docs}>Takvim kullanım yardımını aç</Link></p>
    </main>
  );
}
