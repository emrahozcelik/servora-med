import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { paths } from '../paths';
import { useRealtimeInvalidation } from '../realtime/RealtimeProvider';
import { ApiError, type CurrentUser } from '../services/api';
import { formatDurationSeconds } from '../ui/duration';
import {
  fetchOverdueIncidents,
  fetchSubmissionDelay,
  sendSubmissionReminder,
  type OverdueIncidentHistoryItem,
  type SubmissionDelaySignal,
} from './jobs-api';

/**
 * OVR-4 submission-delay surface.
 *
 * Two responsibilities, deliberately kept apart:
 *
 *  - the *open* signal (`GET /:id/submission-delay`) tells whoever can already
 *    reach the job that an onay gönderme obligation is late right now. The
 *    duration comes from the server request clock — the browser clock is never
 *    used to derive it;
 *  - the *history* (`GET /:id/overdue-incidents`) is management-only and shows
 *    the immutable episodes plus the measured total/post-reminder delays.
 *
 * Every write goes through the server: the client cannot mark a delay as
 * recovered, cannot invent a reminder time, and a manual reminder is refused
 * by the server when the incident is already recovered or the job has left the
 * submission phase. This panel only decides what to *show*.
 */

const HISTORY_PAGE_SIZE = 25;
const SUBMISSION_DELAY_HEADLINE = 'Onaya gönderme gecikti';

const DELAY_TYPE_LABELS: Record<OverdueIncidentHistoryItem['delayType'], string> = {
  LATE_START: 'İşe başlama gecikmesi',
  LATE_SUBMISSION: 'Onaya gönderme gecikmesi',
  APPROVAL_WAIT: 'Onay bekleme gecikmesi',
};

function isManagement(user: CurrentUser): boolean {
  return user.role === 'MANAGER' || user.role === 'ADMIN';
}

/**
 * Renders an instant in the organization's zone when one is known. This is
 * display-only: no comparison, ordering or duration is derived here.
 */
function formatInstant(value: string, timeZone: string | null): string {
  return new Intl.DateTimeFormat('tr-TR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(value));
}

type OpenState =
  | { kind: 'loading' }
  | { kind: 'ready'; open: SubmissionDelaySignal | null }
  | { kind: 'error' };

type ReminderState =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'sent'; sentAt: string }
  | { kind: 'error'; message: string };

export function SubmissionDelayPanel({
  jobId,
  user,
  organizationTimezone = null,
  jobTitle,
  customerName = null,
  onReminderSent,
}: {
  jobId: string;
  user: CurrentUser;
  organizationTimezone?: string | null;
  jobTitle: string;
  customerName?: string | null;
  onReminderSent?: () => void;
}) {
  const management = isManagement(user);
  const [open, setOpen] = useState<OpenState>({ kind: 'loading' });
  const [history, setHistory] = useState<OverdueIncidentHistoryItem[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyError, setHistoryError] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [reminder, setReminder] = useState<ReminderState>({ kind: 'idle' });
  /**
   * One id per reminder attempt. Held across a retry so a resend after an
   * uncertain failure reuses the same receipt, and cleared only on success so
   * a later, genuinely new reminder gets its own id.
   */
  const reminderActionId = useRef<string | null>(null);
  const requestGeneration = useRef(0);

  const loadOpen = useCallback(async () => {
    const generation = requestGeneration.current;
    try {
      const signal = await fetchSubmissionDelay(jobId);
      if (requestGeneration.current !== generation) return;
      setOpen({ kind: 'ready', open: signal });
    } catch {
      if (requestGeneration.current !== generation) return;
      setOpen({ kind: 'error' });
    }
  }, [jobId]);

  const loadHistory = useCallback(async (offset: number) => {
    const generation = requestGeneration.current;
    setHistoryLoading(true);
    try {
      const page = await fetchOverdueIncidents(jobId, { limit: HISTORY_PAGE_SIZE, offset });
      if (requestGeneration.current !== generation) return;
      setHistory((current) => (offset === 0 ? page.items : [...current, ...page.items]));
      setHistoryTotal(page.total);
      setHistoryError(false);
    } catch {
      if (requestGeneration.current !== generation) return;
      setHistoryError(true);
    } finally {
      if (requestGeneration.current === generation) setHistoryLoading(false);
    }
  }, [jobId]);

  useEffect(() => {
    requestGeneration.current += 1;
    setOpen({ kind: 'loading' });
    setHistory([]);
    setHistoryTotal(0);
    setHistoryError(false);
    setHistoryLoading(false);
    setReminder({ kind: 'idle' });
    reminderActionId.current = null;
    void loadOpen();
    if (management) void loadHistory(0);
    return () => {
      // Discard any in-flight reply for this job after unmount or a job change,
      // so a late response can never overwrite newer truth.
      requestGeneration.current += 1;
    };
  }, [jobId, management, loadOpen, loadHistory]);

  // Any job-detail change (including a reminder the manager just sent from
  // another session, or a lifecycle recovery) invalidates both reads. The
  // server owns the decision; this only re-asks.
  useRealtimeInvalidation([`job-detail:${jobId}`], () => {
    void loadOpen();
    if (management) void loadHistory(0);
  });

  const currentOpen = open.kind === 'ready' ? open.open : null;

  async function submitReminder() {
    if (reminder.kind === 'pending' || currentOpen === null) return;
    const clientActionId = reminderActionId.current ?? crypto.randomUUID();
    reminderActionId.current = clientActionId;
    setReminder({ kind: 'pending' });
    try {
      const receipt = await sendSubmissionReminder(jobId, clientActionId);
      reminderActionId.current = null;
      setReminder({ kind: 'sent', sentAt: receipt.sentAt });
      await loadOpen();
      if (management) await loadHistory(0);
      onReminderSent?.();
    } catch (error) {
      setReminder({
        kind: 'error',
        message: error instanceof ApiError ? error.message : 'Hatırlatma gönderilemedi.',
      });
    }
  }

  if (open.kind === 'loading') return null;
  if (open.kind === 'error') {
    if (!management) return null;
    return (
      <div className="submission-delay-panel" data-job-submission-delay="error">
        <p className="submission-delay-note" role="status">
          Onaya gönderme gecikmesi bilgisi alınamadı.
        </p>
      </div>
    );
  }

  const submissionHistory = history.filter(
    (item) => item.delayType === 'LATE_SUBMISSION',
  );
  // The panel must not become permanent furniture on every JobCard, so it
  // appears only when there is something to say: an open delay, a recorded
  // episode, a read failure management should know about, or the outcome of a
  // reminder the manager just sent.
  const showPanel = currentOpen !== null
    || reminder.kind === 'sent'
    || (management && (submissionHistory.length > 0 || historyError || reminder.kind === 'error'));
  if (!showPanel) return null;

  return (
    <section
      className="submission-delay-panel surface-flat"
      data-job-submission-delay="true"
      aria-labelledby="submission-delay-title"
    >
      <h2 id="submission-delay-title" className="submission-delay-heading">
        Onaya gönderme gecikmesi
      </h2>

      {currentOpen && (
        <div className="submission-delay-open" data-job-submission-delay-open="true">
          <p className="submission-delay-signal">
            <span className="submission-delay-badge" data-job-submission-delay-signal="true">
              {SUBMISSION_DELAY_HEADLINE} · {formatDurationSeconds(currentOpen.elapsedSeconds)}
            </span>
          </p>
          {management && (
            <dl className="submission-delay-facts">
              <div>
                <dt>Gecikme türü</dt>
                <dd>{DELAY_TYPE_LABELS[currentOpen.delayType]}</dd>
              </div>
              <div>
                <dt>Personel</dt>
                <dd>{currentOpen.accountableStaff?.name ?? 'Kanıtlanamadı'}</dd>
              </div>
              <div>
                <dt>Müşteri / iş</dt>
                <dd>
                  <Link className="submission-delay-job-link" to={paths.job(jobId)}>
                    {jobTitle}
                  </Link>
                  {customerName ? ` · ${customerName}` : ''}
                </dd>
              </div>
              <div>
                <dt>Geçen süre</dt>
                <dd>{formatDurationSeconds(currentOpen.elapsedSeconds)}</dd>
              </div>
              <div>
                <dt>Son tarih</dt>
                <dd>{formatInstant(currentOpen.deadlineAt, organizationTimezone)}</dd>
              </div>
            </dl>
          )}
          {management && (
            <div className="submission-delay-actions">
              <button
                className="primary-button"
                type="button"
                data-job-submission-reminder-action="true"
                disabled={reminder.kind === 'pending'}
                onClick={() => { void submitReminder(); }}
              >
                {reminder.kind === 'pending' ? 'Gönderiliyor…' : 'Onaya göndermesini hatırlat'}
              </button>
            </div>
          )}
        </div>
      )}

      {reminder.kind === 'sent' && (
        <p className="submission-delay-note" role="status" data-job-submission-reminder-sent="true">
          Hatırlatma personelinize gönderildi · {formatInstant(reminder.sentAt, organizationTimezone)}
        </p>
      )}
      {reminder.kind === 'error' && (
        <p className="field-error" role="alert">{reminder.message}</p>
      )}

      {management && (
        <div className="submission-delay-history" data-job-submission-delay-history="true">
          <h3 className="submission-delay-history-heading">Gecikme geçmişi</h3>
          {historyError && submissionHistory.length === 0 ? (
            <p className="submission-delay-note" role="status">Gecikme geçmişi alınamadı.</p>
          ) : submissionHistory.length === 0 ? (
            <p className="submission-delay-note">Kayıtlı bir onaya gönderme gecikmesi yok.</p>
          ) : (
            <ul className="submission-delay-history-list">
              {submissionHistory.map((item) => (
                <li
                  key={item.id}
                  className="submission-delay-history-item"
                  data-job-submission-delay-episode={item.episodeNo}
                >
                  <dl className="submission-delay-facts">
                    <div>
                      <dt>Son tarih</dt>
                      <dd>{formatInstant(item.deadlineAt, organizationTimezone)}</dd>
                    </div>
                    <div>
                      <dt>Gönderim zamanı</dt>
                      <dd>
                        {item.recoveredAt === null
                          ? 'Henüz gönderilmedi'
                          : formatInstant(item.recoveredAt, organizationTimezone)}
                      </dd>
                    </div>
                    <div>
                      <dt>Toplam gecikme</dt>
                      <dd>
                        {item.totalDelaySeconds === null
                          ? 'Ölçülemedi'
                          : formatDurationSeconds(item.totalDelaySeconds)}
                      </dd>
                    </div>
                    <div>
                      <dt>Hatırlatma zamanı</dt>
                      <dd>
                        {item.managerReminder === null
                          ? 'Hatırlatma yapılmadı'
                          : formatInstant(item.managerReminder.sentAt, organizationTimezone)}
                      </dd>
                    </div>
                    <div>
                      <dt>Hatırlatma sonrası geçen süre</dt>
                      <dd>
                        {item.postReminderDelaySeconds === null
                          ? 'Ölçülemedi'
                          : formatDurationSeconds(item.postReminderDelaySeconds)}
                      </dd>
                    </div>
                  </dl>
                </li>
              ))}
            </ul>
          )}
          {!historyError && submissionHistory.length < historyTotal && (
            <button
              className="secondary-button"
              type="button"
              disabled={historyLoading}
              onClick={() => { void loadHistory(submissionHistory.length); }}
            >
              {historyLoading ? 'Yükleniyor…' : 'Daha fazla göster'}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
