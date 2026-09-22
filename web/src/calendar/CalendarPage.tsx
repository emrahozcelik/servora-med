import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { buildContextState } from '../shell/context-return';

import { patchJobCard } from '../jobs/jobs-api';
import type { AvailableSlot } from '../jobs/jobs-api';
import { AvailableSlotsNotice } from '../jobs/AvailableSlotsNotice';
import { isDefinitiveMutationError } from '../jobs/mutation-attempt-error';
import { shiftInterval } from '../jobs/scheduling';
import { useAvailableSlotSearch } from '../jobs/useAvailableSlotSearch';
import { useReassignmentConversationSync } from '../jobs/useReassignmentConversationSync';
import { ReassignmentSyncPrompt } from '../jobs/ReassignmentSyncPrompt';
import { paths } from '../paths';
import { useRealtimeInvalidation } from '../realtime/RealtimeProvider';
import type { ApiError, CurrentUser } from '../services/api';
import { markNotificationsReadByEntity } from '../services/notifications-api';
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
  type ManualEventInput,
  type ManualEventPatch,
} from '../services/calendar-api';
import { EmptyState } from '../ui/antd/EmptyState';
import { LoadingSkeleton } from '../ui/antd/LoadingSkeleton';
import { PageHeader } from '../ui/PageHeader';
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
  if (!event) return 'Manuel plan ekle';
  if (event.source === 'JOB') return 'İş zamanını güncelle';
  return 'Planı düzenle';
}

/**
 * One logical manual mutation owns one id AND its exact request payload.
 * The frozen input is the only request an attempt may ever send; later draft
 * edits cannot leak into a retry of the same attempt.
 */
type ManualMutationAttempt =
  | { kind: 'create'; input: ManualEventInput }
  | { kind: 'patch'; eventId: string; input: ManualEventPatch };

/** Authoritative rejection presentation for manual mutations (definitive path). */
function describeManualMutationError(caught: unknown): {
  message: string;
  conflicts: Array<Record<string, unknown>>;
} {
  const api = caught as ApiError;
  if (api.code === 'NON_WORKING_DAY') {
    // WORKING-DAY V1: organization-local Sunday is a non-working day. The
    // server owns the decision (it alone knows the organization timezone),
    // so the form surfaces its message verbatim and stays usable.
    return { message: api.message, conflicts: [] };
  }
  if (api.code === 'CALENDAR_CONFLICT') {
    const raw = api.details?.conflicts;
    return {
      message: 'Bu zaman aralığı başka bir planla çakışıyor. Taslağınız korundu.',
      conflicts: Array.isArray(raw) ? raw as Array<Record<string, unknown>> : [],
    };
  }
  if (api.code === 'CUSTOMER_VISIT_DUPLICATE') {
    return { message: 'Aynı müşteri, personel ve ziyaret türü için bu saat aralığında zaten bir plan bulunuyor. Taslağınız korundu.', conflicts: [] };
  }
  if (api.code === 'VERSION_CONFLICT') {
    return {
      message: 'Bu kayıt başka bir kullanıcı tarafından değiştirildi. Taslağınız korundu; güncel değerleri yükleyin.',
      conflicts: [],
    };
  }
  return { message: caught instanceof Error ? caught.message : 'Plan kaydedilemedi.', conflicts: [] };
}

export function EventForm({
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
  /**
   * Frozen logical attempt (MeetingDetails convention): while an attempt is
   * ambiguous the outcome is unknown, so the exact original request is the
   * only thing that may be retried. The drawer unmounts this form on
   * close/success, so mount lifetime bounds one operation; a fresh open
   * mounts a new form and therefore a new attempt.
   */
  const attemptRef = useRef<ManualMutationAttempt | null>(null);
  const [ambiguous, setAmbiguous] = useState(false);
  const availableSlotSearch = useAvailableSlotSearch({
    type: intervalJobType ?? 'SALES_MEETING',
    customerId: event?.source === 'JOB' ? event.customer?.id ?? null : null,
    assignedTo: intervalJobType ? draft.assignedUserId : null,
    scheduledStartLocal: draft.startsAt,
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

  /**
   * User-planned interval semantics: moving the start preserves the current
   * interval duration (elapsed time) instead of leaving a stale absolute end.
   * Editing the end directly is a plain value set — the resulting duration
   * then owns later start moves. Invalid current pairs only move the start;
   * submit-time validation rejects end <= start without inventing a duration.
   */
  function handleStartChange(value: string) {
    setDraft((current) => {
      const parts = [current.startsAt, current.endsAt, value];
      if (parts.some((part) => !part || Number.isNaN(Date.parse(part)))) {
        return { ...current, startsAt: value };
      }
      try {
        const [, shiftedEnd] = shiftInterval(current.startsAt, current.endsAt, value);
        return { ...current, startsAt: value, endsAt: shiftedEnd };
      } catch {
        return { ...current, startsAt: value };
      }
    });
  }

  /**
   * Sends exactly the frozen attempt input. Returns true when the mutation
   * was saved. A definitive rejection resolves the attempt (the next submit
   * is a new logical operation); an ambiguous outcome keeps the attempt
   * frozen so only the exact original request may be retried.
   */
  async function sendAttempt(attempt: ManualMutationAttempt): Promise<boolean> {
    setPending(true);
    setError(null);
    setConflicts([]);
    try {
      if (attempt.kind === 'create') {
        await createManualEvent(attempt.input);
      } else {
        await patchManualEvent(attempt.eventId, attempt.input);
      }
      attemptRef.current = null;
      setAmbiguous(false);
      return true;
    } catch (caught) {
      // Fail-safe: only an authoritative non-retryable server response proves
      // the attempt resolved (status-0, retryable, ACTION_IN_PROGRESS and
      // unknown errors are ambiguous — see isAmbiguousMutationError).
      if (isDefinitiveMutationError(caught)) {
        attemptRef.current = null;
        setAmbiguous(false);
        const failure = describeManualMutationError(caught);
        setError(failure.message);
        setConflicts(failure.conflicts);
      } else {
        setAmbiguous(true);
        setError('Sonuç belirsiz: plan sunucuya kaydedilmiş olabilir. Lütfen özgün isteği tekrar deneyin; form, sonuç netleşene kadar kilitli.');
        setConflicts([]);
      }
      return false;
    } finally {
      setPending(false);
    }
  }

  async function retryAttempt() {
    const attempt = attemptRef.current;
    if (!attempt || pending) return;
    if (await sendAttempt(attempt)) {
      onSaved();
    }
  }

  const submit = async (submitEvent: FormEvent) => {
    submitEvent.preventDefault();
    if (pending || ambiguous) return;
    setPending(true);
    setError(null);
    setConflicts([]);
    try {
      if (!event || event.source === 'MANUAL') {
        const startMs = Date.parse(draft.startsAt);
        const endMs = Date.parse(draft.endsAt);
        if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) {
          setError('Bitiş zamanı başlangıç zamanından sonra olmalıdır.');
          return;
        }
        const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const attempt: ManualMutationAttempt = !event
          ? {
            kind: 'create',
            input: {
              clientActionId: crypto.randomUUID(),
              assignedUserId: draft.assignedUserId,
              title: draft.title,
              description: draft.description.trim() || null,
              startsAt: instant(draft.startsAt),
              endsAt: instant(draft.endsAt),
              timezone,
            },
          }
          : {
            kind: 'patch',
            eventId: event.id,
            input: {
              clientActionId: crypto.randomUUID(),
              expectedVersion: event.version,
              assignedUserId: draft.assignedUserId,
              title: draft.title,
              description: draft.description.trim() || null,
              startsAt: instant(draft.startsAt),
              endsAt: instant(draft.endsAt),
              timezone,
            },
          };
        attemptRef.current = attempt;
        if (await sendAttempt(attempt)) {
          onSaved();
        }
      } else {
        const patched = await patchJobCard(event.jobCardId, {
          expectedVersion: event.version,
          assignedTo: draft.assignedUserId,
          scheduledAt: instant(draft.startsAt),
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
        onSaved();
      }
    } catch (caught) {
      // Only the JOB path (which owns no frozen attempt) reaches this catch;
      // manual attempts map their errors inside sendAttempt.
      const failure = describeManualMutationError(caught);
      setError(failure.message);
      setConflicts(failure.conflicts);
    } finally {
      setPending(false);
    }
  };

  return (
    <form className="calendar-form" onSubmit={submit}>
      <fieldset disabled={pending || ambiguous}>
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
            onChange={(e) => handleStartChange(e.target.value)} />
        </label>
        {event?.source !== 'JOB' && (
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
      </fieldset>
      {error && <div className="form-error" role="alert"><p>{error}</p>
        {conflicts.map((c) => (
          <p key={String(c.id)}>
            {String(c.title)} · {new Date(String(c.startsAt)).toLocaleString('tr-TR')}
          </p>
        ))}
      </div>}
      <div className="form-actions">
        <button type="button" className="secondary-button" onClick={onClose}>Vazgeç</button>
        {ambiguous && (
          <button data-original-retry className="secondary-button" type="button" disabled={pending}
            onClick={() => { void retryAttempt(); }}>
            Özgün isteği tekrar dene
          </button>
        )}
        <button type="submit" className="primary-button" disabled={pending || ambiguous}>
          {pending ? 'Kaydediliyor…' : 'Kaydet'}
        </button>
      </div>
    </form>
  );
}

// ── EventItem (agenda card) ──

export function EventItem({
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
  /**
   * Frozen cancel attempt (MeetingDetails convention): the first confirm
   * captures eventId, clientActionId, expectedVersion and cancelReason as one
   * immutable unit. While the outcome is ambiguous no new normal CANCEL may
   * start; only the exact original body may be retried. Success or a
   * definitive rejection resolves the attempt.
   */
  const cancelAttemptRef = useRef<{
    eventId: string;
    input: { clientActionId: string; expectedVersion: number; cancelReason: string };
  } | null>(null);
  const [cancelAmbiguous, setCancelAmbiguous] = useState(false);
  const localCancelRef = useRef<HTMLButtonElement>(null);
  const cancelBtnRef = cancelTriggerRef ?? localCancelRef;
  const location = useLocation();
  const calendarReturnState = buildContextState({
    pathname: location.pathname,
    search: location.search,
    hash: '',
  });

  async function runCancelAttempt(attempt: {
    eventId: string;
    input: { clientActionId: string; expectedVersion: number; cancelReason: string };
  }) {
    setCancelPending(true);
    setError(null);
    try {
      await cancelManualEvent(attempt.eventId, attempt.input);
      cancelAttemptRef.current = null;
      setCancelAmbiguous(false);
      setCancelOpen(false);
      onCancelled();
    } catch (caught) {
      setCancelOpen(false);
      if (isDefinitiveMutationError(caught)) {
        cancelAttemptRef.current = null;
        setCancelAmbiguous(false);
        setError(caught instanceof Error ? caught.message : 'Plan iptal edilemedi.');
      } else {
        setCancelAmbiguous(true);
        setError('İptal sonucu belirsiz: plan sunucuda iptal edilmiş olabilir. Lütfen özgün isteği tekrar deneyin.');
      }
    } finally {
      setCancelPending(false);
    }
  }

  const handleCancelConfirm = async (reason: string) => {
    if (cancelPending || cancelAmbiguous) return;
    const attempt = {
      eventId: event.id,
      input: {
        clientActionId: crypto.randomUUID(),
        expectedVersion: event.version,
        cancelReason: reason,
      },
    };
    cancelAttemptRef.current = attempt;
    await runCancelAttempt(attempt);
  };

  async function retryCancel() {
    const attempt = cancelAttemptRef.current;
    if (!attempt || cancelPending) return;
    await runCancelAttempt(attempt);
  }

  const sourceLabel = event.source === 'JOB' ? 'İŞ' : 'KİŞİSEL PLAN';
  const followUpContext = event.source === 'JOB' ? event.followUpContext : null;
  const timeText = new Date(event.startsAt).toLocaleString('tr-TR')
    + (event.endsAt
      ? ` – ${new Date(event.endsAt).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}`
      : '');

  const actionBar = (
    <div className="calendar-event-actions">
      {event.source === 'JOB' && (
        <Link to={event.relatedJobPath} state={calendarReturnState ?? undefined}>İşi aç</Link>
      )}
      {followUpContext?.sourceJobPath && (
        <Link to={followUpContext.sourceJobPath} state={calendarReturnState ?? undefined}>Önceki işi aç</Link>
      )}
      {event.canEdit && <button type="button" className="secondary-button" onClick={onEdit}>Düzenle</button>}
      {event.canCancel && (
        <button
          ref={cancelBtnRef}
          type="button"
          className="destructive-button"
          disabled={cancelAmbiguous}
          onClick={() => setCancelOpen(true)}
        >
          İptal et
        </button>
      )}
      {cancelAmbiguous && (
        <button
          data-original-retry
          type="button"
          className="secondary-button"
          disabled={cancelPending}
          onClick={() => { void retryCancel(); }}
        >
          Özgün isteği tekrar dene
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
    const eventId = selectedEventId;
    void getCalendarEvent(eventId).then((selected) => {
      if (!active) return;
      const d = new Date(selected.startsAt);
      setMonth(new Date(d.getFullYear(), d.getMonth(), 1));
      setSelectedDate(new Date(d.getFullYear(), d.getMonth(), d.getDate()));
      // Entity-view notification reconciliation: the event resolved for the viewer
      // and owns the selection. Never fails the calendar; never fires for failed
      // or superseded resolutions.
      markNotificationsReadByEntity('calendar-event', eventId).catch(() => {});
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
      <PageHeader
        eyebrow="Aylık planlama"
        fallbackTitle="Takvim"
        description="İşlerinizi ve operasyonel planlarınızı aylık zaman çizelgesinde görün."
        actions={(
          <button
            ref={newPlanTriggerRef}
            type="button"
            className="primary-button"
            disabled={user.role !== 'STAFF' && assignees.length === 0}
            onClick={openNewPlan}
          >
            Manuel plan ekle
          </button>
        )}
      />

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
