import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { useRealtimeInvalidation } from '../realtime/RealtimeProvider';
import { ApiError, type CurrentUser } from '../services/api';
import { OperationalCard } from '../ui/antd/OperationalCard';
import { ServoraListPagination } from '../ui/antd/ServoraPagination';
import { DEFAULT_LIST_PAGE_SIZE, lastListPageOffset } from '../ui/pagination';
import { ResultState } from '../ui/antd/ResultState';
import { formatDurationSeconds } from '../ui/duration';
import {
  getSubmissionLateness,
  listOpenSubmissionLate,
  listOverdueIncidents,
  sendSubmissionReminder,
  type OpenSubmissionLateItem,
  type OverdueIncidentHistoryItem,
  type SubmissionLatenessSnapshot,
} from './jobs-api';

function isManagementUser(user: CurrentUser): boolean {
  return user.role === 'MANAGER' || user.role === 'ADMIN';
}

function formatInstant(value: string): string {
  return new Intl.DateTimeFormat('tr-TR', { dateStyle: 'medium', timeStyle: 'short' })
    .format(new Date(value));
}

const DELAY_TYPE_LABELS = {
  LATE_START: 'Geç başlama',
  LATE_SUBMISSION: 'Geç onaya gönderme',
  APPROVAL_WAIT: 'Yönetici beklemesi',
} as const;

type LatenessState =
  | { kind: 'loading' }
  | { kind: 'ready'; snapshot: SubmissionLatenessSnapshot }
  | { kind: 'error'; message: string; retryable: boolean };

/**
 * OVR-4 per-job operational signal. Renders the server-owned open
 * LATE_SUBMISSION snapshot verbatim: the elapsed duration is a
 * request-clock value from the API, never derived from the client clock.
 * Managers additionally get the manual reminder action.
 */
export function SubmissionLatenessSection({ jobId, jobVersion, user, onReminded }: {
  jobId: string;
  jobVersion: number;
  user: CurrentUser;
  onReminded: () => void;
}) {
  const [state, setState] = useState<LatenessState>({ kind: 'loading' });
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sendDone, setSendDone] = useState(false);

  const refresh = useCallback(async (showLoading: boolean) => {
    if (showLoading) setState({ kind: 'loading' });
    try {
      setState({ kind: 'ready', snapshot: await getSubmissionLateness(jobId) });
    } catch (caught) {
      const error = caught instanceof ApiError
        ? caught
        : new ApiError(0, 'UNKNOWN_ERROR', 'Gecikme bilgisi yüklenemedi.', true);
      setState({ kind: 'error', message: error.message, retryable: error.retryable });
    }
  }, [jobId]);

  useEffect(() => { void refresh(true); }, [refresh]);
  // Any lifecycle transition invalidates the job detail; the snapshot follows
  // the same invalidation instead of polling on a timer.
  useRealtimeInvalidation([`job-detail:${jobId}`], () => { void refresh(false); });

  if (state.kind === 'loading') return null;
  if (state.kind === 'error') {
    return (
      <section aria-label="Onaya gönderme gecikmesi" data-submission-lateness="error">
        <ResultState
          status="error"
          title="Gecikme bilgisi yüklenemedi"
          description={state.message}
          headingLevel={3}
          action={state.retryable
            ? (
              <button className="secondary-button" type="button" onClick={() => void refresh(true)}>
                Tekrar dene
              </button>
            )
            : undefined}
        />
      </section>
    );
  }

  const { open } = state.snapshot;
  if (!open) return null;

  const manager = isManagementUser(user);

  const remind = async () => {
    setSending(true);
    setSendError(null);
    try {
      await sendSubmissionReminder(jobId, {
        clientActionId: crypto.randomUUID(),
        expectedVersion: jobVersion,
      });
      setSendDone(true);
      onReminded();
      await refresh(false);
    } catch (caught) {
      setSendError(caught instanceof ApiError ? caught.message : 'Hatırlatma gönderilemedi.');
    } finally {
      setSending(false);
    }
  };

  return (
    <section
      className="detail-summary surface-flat"
      aria-label="Onaya gönderme gecikmesi"
      data-submission-lateness="open"
    >
      <p role="status">
        <span className="job-overdue-signal" data-submission-late-signal="true">
          Onaya gönderme gecikti · {formatDurationSeconds(open.elapsedSeconds)}
        </span>
      </p>
      <dl className="job-row-facts">
        <div>
          <dt>Son gönderim zamanı</dt>
          <dd><time dateTime={open.deadlineAt}>{formatInstant(open.deadlineAt)}</time></dd>
        </div>
        <div>
          <dt>Gecikme başlangıcı</dt>
          <dd><time dateTime={open.breachedAt}>{formatInstant(open.breachedAt)}</time></dd>
        </div>
        {manager && (
          <div>
            <dt>Sorumlu personel</dt>
            <dd>{open.accountableUser?.name ?? 'Belirtilmedi'}</dd>
          </div>
        )}
        {open.manualReminderCount > 0 && (
          <div>
            <dt>Hatırlatma</dt>
            <dd>
              {open.manualReminderCount} kez
              {open.manualReminderSentAt
                ? <> · son <time dateTime={open.manualReminderSentAt}>{formatInstant(open.manualReminderSentAt)}</time></>
                : null}
            </dd>
          </div>
        )}
      </dl>
      {manager && (
        <div>
          <button
            className="secondary-button"
            type="button"
            disabled={sending}
            data-submission-reminder-action="true"
            onClick={() => void remind()}
          >
            {sending ? 'Gönderiliyor…' : 'Onaya göndermesini hatırlat'}
          </button>
          {sendError && <p role="alert">{sendError}</p>}
          {sendDone && !sendError && <p role="status">Hatırlatma personele gönderildi.</p>}
        </div>
      )}
    </section>
  );
}

type HistoryState =
  | { kind: 'loading' }
  | { kind: 'ready'; items: OverdueIncidentHistoryItem[]; total: number }
  | { kind: 'error'; message: string; retryable: boolean };

/**
 * The first-late boundary means something different per delay type. The
 * recovery label stays neutral: the history DTO does not say which command
 * (start, submit, approve, cancel…) closed the incident, so it is not guessed.
 */
const DEADLINE_LABELS = {
  LATE_START: 'Planlanan bitiş',
  LATE_SUBMISSION: 'Son gönderim zamanı',
  APPROVAL_WAIT: 'Onay süresi sonu',
} as const;

export function historyDetail(item: OverdueIncidentHistoryItem): string {
  const parts: string[] = [];
  parts.push(`${DEADLINE_LABELS[item.delayType]}: ${formatInstant(item.deadlineAt)}`);
  parts.push(`Gecikme başlangıcı: ${formatInstant(item.breachedAt)}`);
  if (item.recoveredAt) {
    parts.push(`Gecikme bitişi: ${formatInstant(item.recoveredAt)}`);
  } else {
    parts.push('Devam eden gecikme');
  }
  if (item.totalDelaySeconds !== null) {
    parts.push(`Toplam gecikme: ${formatDurationSeconds(item.totalDelaySeconds)}`);
  }
  if (item.manualReminderSentAt) {
    parts.push(`Hatırlatma: ${formatInstant(item.manualReminderSentAt)}`);
  }
  if (item.postReminderDelaySeconds !== null) {
    parts.push(`Hatırlatma sonrası: ${formatDurationSeconds(item.postReminderDelaySeconds)}`);
  }
  return parts.join(' · ');
}

/**
 * OVR-4 manager incident history with the measurement appendix. Recovered
 * incidents show deadline, submission time and total delay; manual reminder
 * timing and post-reminder delay appear only when proven (never guessed for
 * legacy history).
 */
export function OverdueIncidentHistorySection({ jobId, load = listOverdueIncidents, collapsible = false }: {
  jobId: string;
  load?: typeof listOverdueIncidents;
  /** Collapsed disclosure presentation; the job detail opts in below 1024px (UI-005). */
  collapsible?: boolean;
}) {
  const asDisclosure = collapsible;
  const [state, setState] = useState<HistoryState>({ kind: 'loading' });
  const [offset, setOffset] = useState(0);
  const requestId = useRef(0);

  const refresh = useCallback(async () => {
    const id = ++requestId.current;
    setState({ kind: 'loading' });
    try {
      const page = await load(jobId, { limit: DEFAULT_LIST_PAGE_SIZE, offset });
      if (id !== requestId.current) return;
      const lastOffset = lastListPageOffset(page.total);
      if (offset > lastOffset) {
        setOffset(lastOffset);
        return;
      }
      setState({ kind: 'ready', items: page.items, total: page.total });
    } catch (caught) {
      if (id !== requestId.current) return;
      const error = caught instanceof ApiError
        ? caught
        : new ApiError(0, 'UNKNOWN_ERROR', 'Gecikme geçmişi yüklenemedi.', true);
      setState({ kind: 'error', message: error.message, retryable: error.retryable });
    }
  }, [jobId, load, offset]);

  useEffect(() => { setOffset(0); }, [jobId]);
  useEffect(() => {
    void refresh();
    return () => { requestId.current += 1; };
  }, [refresh]);
  useRealtimeInvalidation([`job-detail:${jobId}`], () => { void refresh(); });

  if (state.kind === 'loading') return null;
  if (state.kind === 'error') {
    return (
      <section aria-label="Gecikme geçmişi" data-overdue-history="error">
        <ResultState
          status="error"
          title="Gecikme geçmişi yüklenemedi"
          description={state.message}
          headingLevel={3}
          action={state.retryable
            ? (
              <button className="secondary-button" type="button" onClick={() => void refresh()}>
                Tekrar dene
              </button>
            )
            : undefined}
        />
      </section>
    );
  }
  if (state.items.length === 0) return null;

  const historyList = (
    <ul>
      {state.items.map((item) => (
        <li key={item.id} data-overdue-history-item={item.delayType}>
          <strong>{DELAY_TYPE_LABELS[item.delayType]}</strong>
          {' '}
          <span>{historyDetail(item)}</span>
        </li>
      ))}
    </ul>
  );
  const pager = (
    <ServoraListPagination
      total={state.total}
      offset={offset}
      label="Gecikme geçmişi sayfaları"
      itemName="gecikme kaydı"
      onOffsetChange={(nextOffset) => {
        // Hide the focused pager in the same event as the offset change.
        // Otherwise an intermediate render consumes its keyboard-focus ticket
        // before the async page arrives and focus falls back to document.body.
        setState({ kind: 'loading' });
        setOffset(nextOffset);
      }}
    />
  );

  return (
    <section aria-label="Gecikme geçmişi" data-overdue-history="ready">
      {asDisclosure ? (
        <details className="overdue-history" data-overdue-history-disclosure="true">
          <summary className="overdue-history-summary">
            <span className="overdue-history-title">Gecikme geçmişi</span>
            <span className="overdue-history-count">{state.total} kayıt</span>
          </summary>
          {historyList}
          {pager}
        </details>
      ) : (
        <>
          <h2>Gecikme geçmişi</h2>
          {historyList}
          {pager}
        </>
      )}
    </section>
  );
}

type OpenListState =
  | { kind: 'loading' }
  | { kind: 'ready'; items: OpenSubmissionLateItem[]; total: number }
  | { kind: 'error'; message: string };

/**
 * OVR-4 manager overview section: currently open LATE_SUBMISSION episodes,
 * longest-waiting first, with staff, customer, elapsed duration and job
 * navigation. A separate operational signal — the due-date `Geciken`
 * contract is untouched.
 */
export function OpenSubmissionLateSection({ load = listOpenSubmissionLate }: {
  load?: typeof listOpenSubmissionLate;
}) {
  const [state, setState] = useState<OpenListState>({ kind: 'loading' });
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
        message: error instanceof Error ? error.message : 'Gecikme listesi yüklenemedi.',
      });
    }
  }, [load, offset]);

  useEffect(() => {
    void refresh();
    return () => { requestId.current += 1; };
  }, [refresh]);
  useRealtimeInvalidation(['overview', 'job-list'], () => { void refresh(); });

  if (state.kind === 'loading') return null;
  // A failed load must never look like "nothing is late".
  if (state.kind === 'error') {
    return (
      <section className="overview-section" aria-label="Onaya göndermesi geciken işler" data-open-submission-late="error">
        <ResultState
          status="error"
          title="Gecikme listesi yüklenemedi"
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
    <section className="overview-section" aria-labelledby="submission-late-title" data-open-submission-late="true">
      <h2 id="submission-late-title">Onaya göndermesi geciken işler</h2>
      <ul className="overview-card-stack">
        {state.items.map((item) => (
          <li key={`${item.jobCardId}:${item.episodeNo}`}>
            <OperationalCard
              title={<Link to={item.jobPath}>{item.jobTitle}</Link>}
              tone="overdue"
              statusLabel="Gönderim gecikti"
              className="submission-late-card"
            >
              <span>
                {item.staff.name} · {item.customer?.name ?? 'Müşteri belirtilmedi'} · {formatDurationSeconds(item.elapsedSeconds)} gecikti
              </span>
            </OperationalCard>
          </li>
        ))}
      </ul>
      <ServoraListPagination
        total={state.total}
        offset={offset}
        label="Onaya gönderme gecikmesi sayfaları"
        itemName="geciken iş"
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
