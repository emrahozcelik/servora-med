import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { useRealtimeInvalidation } from '../realtime/RealtimeProvider';
import { ApiError, type CurrentUser } from '../services/api';
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

function historyDetail(item: OverdueIncidentHistoryItem): string {
  const parts: string[] = [];
  parts.push(`Son gönderim zamanı: ${formatInstant(item.deadlineAt)}`);
  parts.push(`Gecikme başlangıcı: ${formatInstant(item.breachedAt)}`);
  if (item.recoveredAt) {
    parts.push(`Onaya gönderim: ${formatInstant(item.recoveredAt)}`);
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
export function OverdueIncidentHistorySection({ jobId }: {
  jobId: string;
}) {
  const [state, setState] = useState<HistoryState>({ kind: 'loading' });

  const refresh = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const page = await listOverdueIncidents(jobId, { limit: 25, offset: 0 });
      setState({ kind: 'ready', items: page.items, total: page.total });
    } catch (caught) {
      const error = caught instanceof ApiError
        ? caught
        : new ApiError(0, 'UNKNOWN_ERROR', 'Gecikme geçmişi yüklenemedi.', true);
      setState({ kind: 'error', message: error.message, retryable: error.retryable });
    }
  }, [jobId]);

  useEffect(() => { void refresh(); }, [refresh]);
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

  return (
    <section aria-label="Gecikme geçmişi" data-overdue-history="ready">
      <h2>Gecikme geçmişi</h2>
      <ul>
        {state.items.map((item) => (
          <li key={item.id} data-overdue-history-item={item.delayType}>
            <strong>{DELAY_TYPE_LABELS[item.delayType]}</strong>
            {' '}
            <span>{historyDetail(item)}</span>
          </li>
        ))}
      </ul>
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

  const refresh = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const page = await load({ limit: 20, offset: 0 });
      setState({ kind: 'ready', items: [...page.items], total: page.total });
    } catch (error) {
      setState({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Gecikme listesi yüklenemedi.',
      });
    }
  }, [load]);

  useEffect(() => { void refresh(); }, [refresh]);
  useRealtimeInvalidation(['overview', 'job-list'], () => { void refresh(); });

  if (state.kind === 'loading' || state.kind === 'error') return null;
  if (state.items.length === 0) return null;

  return (
    <section className="overview-section" aria-labelledby="submission-late-title" data-open-submission-late="true">
      <h2 id="submission-late-title">Onaya göndermesi geciken işler</h2>
      <div className="overview-card-stack">
        {state.items.map((item) => (
          <div key={`${item.jobCardId}:${item.episodeNo}`}>
            <Link to={item.jobPath}>
              {item.jobTitle}
            </Link>
            <span>
              {item.staff.name} · {item.customer?.name ?? 'Müşteri belirtilmedi'} · {formatDurationSeconds(item.elapsedSeconds)} gecikti
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
