import { useEffect, useRef, useState } from 'react';

import { ApiError, type CurrentUser } from '../services/api';
import {
  grantEarlyStartAuthorization,
  type JobCard,
} from './jobs-api';

function isManagementUser(user: CurrentUser): boolean {
  return user.role === 'MANAGER' || user.role === 'ADMIN';
}

function formatInstant(value: string): string {
  return new Intl.DateTimeFormat('tr-TR', { dateStyle: 'medium', timeStyle: 'short' })
    .format(new Date(value));
}

/**
 * JOB-010 §1a: only a planned interval job that is still in its assignment
 * stage, without a valid authorization, can receive one. The server owns the
 * rule; this mirrors it only to decide whether the button is offered.
 *
 * A planned start that is not in the future needs no authorization: START is
 * already allowed from the planned time on. Hiding the offer there removes an
 * action with no effect; the backend rule is unchanged.
 */
export function canGrantEarlyStartAuthorization(
  job: JobCard,
  user: CurrentUser,
  now: Date = new Date(),
): boolean {
  if (!isManagementUser(user)) return false;
  if ((job.earlyStartAuthorization ?? null) !== null) return false;
  if (job.type !== 'PRODUCT_DELIVERY' && job.type !== 'SALES_MEETING') return false;
  if (job.status !== 'NEW' && job.status !== 'ACCEPTED') return false;
  if (job.scheduledAt === null) return false;
  return Date.parse(job.scheduledAt) > now.valueOf();
}

/**
 * JOB-010 §1a early-start authorization surface. Managers get the grant
 * action while the job is eligible; once a valid authorization exists, the
 * manager and the assigned Staff member see who granted it and when.
 *
 * The idle state is one compact row so the panel reads as a schedule detail:
 * the help text and the confirm action appear only after the manager asks for
 * them (owner decision 2026-11-25).
 *
 * Eligibility is re-checked against the clock at save time: the manager can
 * open the confirmation before the planned start and submit it after. Starting
 * is allowed from the planned time on, so that write would authorize nothing;
 * the action reports the expiry instead of posting.
 */
export function EarlyStartAuthorizationSection({ job, user, onGranted, now = new Date() }: {
  job: JobCard;
  user: CurrentUser;
  onGranted: () => void;
  /** Fixed clock for deterministic tests; production uses the current time. */
  now?: Date;
}) {
  const [granting, setGranting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [expired, setExpired] = useState(false);
  const expiredRef = useRef<HTMLParagraphElement>(null);
  // A new job version means the canonical truth changed (the grant landed, or
  // a later reschedule/reassignment voided it): drop the local success state
  // so the button is never left disabled behind a stale message.
  useEffect(() => {
    setDone(false);
    setError(null);
    setRevealed(false);
    setExpired(false);
  }, [job.id, job.version]);
  // The confirm control unmounts when the offer expires, so keep keyboard
  // context on the announced status line instead of dropping focus to <body>.
  useEffect(() => { if (expired) expiredRef.current?.focus(); }, [expired]);

  const authorization = job.earlyStartAuthorization ?? null;
  const canGrant = canGrantEarlyStartAuthorization(job, user, now);
  if (authorization === null && !canGrant && !expired) return null;

  const grant = async () => {
    // Save-time clock check (see the component note). Uses the real clock, not
    // the render-time `now` prop, so a form opened just before the planned
    // start cannot post after it passed.
    if (!canGrantEarlyStartAuthorization(job, user, new Date())) {
      setExpired(true);
      return;
    }
    setGranting(true);
    setError(null);
    try {
      await grantEarlyStartAuthorization(job.id, {
        clientActionId: crypto.randomUUID(),
        expectedVersion: job.version,
      });
      setDone(true);
      onGranted();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Erken başlama izni kaydedilemedi.');
    } finally {
      setGranting(false);
    }
  };

  return (
    <section
      className="detail-summary surface-flat early-start-authorization"
      aria-labelledby="early-start-authorization-title"
      data-early-start-authorization={authorization === null ? 'idle' : 'authorized'}
    >
      <h2 id="early-start-authorization-title">Erken başlama</h2>
      {authorization === null ? (
        expired ? (
          <p
            ref={expiredRef}
            className="early-start-authorization-status"
            role="status"
            tabIndex={-1}
            data-early-start-authorization-status="expired"
          >
            Planlanan başlangıç zamanı geçti; erken başlama izni artık gerekmiyor.
          </p>
        ) : (
          <div className="early-start-authorization-body">
            <div className="early-start-authorization-row">
              <p className="early-start-authorization-status" data-early-start-authorization-status="idle">
                İzin verilmedi
              </p>
              <button
                className="secondary-button"
                type="button"
                aria-expanded={revealed}
                aria-controls="early-start-authorization-detail"
                data-early-start-authorization-reveal="true"
                onClick={() => setRevealed((value) => !value)}
              >
                Erken başlamaya izin ver
              </button>
            </div>
            <div
              className="early-start-authorization-detail"
              id="early-start-authorization-detail"
              hidden={!revealed}
            >
              <p className="form-help" data-early-start-authorization-help="true">
                İzin verirseniz {job.assignee?.name ?? 'sorumlu personel'} işi planlanan zamandan önce
                başlatabilir. Planlanan zaman ya da sorumlu personel değişirse izin geçersiz olur.
              </p>
              <button
                className="secondary-button"
                type="button"
                disabled={granting || done}
                data-early-start-authorization-action="true"
                onClick={() => void grant()}
              >
                {granting ? 'Kaydediliyor…' : 'Erken başlama iznini kaydet'}
              </button>
              {error && <p role="alert">{error}</p>}
              {done && !error && <p role="status">Erken başlama izni kaydedildi.</p>}
            </div>
          </div>
        )
      ) : (
        <p role="status">
          Erken başlama izni: {authorization.grantedBy.name ?? 'Yönetici'},{' '}
          <time dateTime={authorization.grantedAt}>{formatInstant(authorization.grantedAt)}</time>
        </p>
      )}
    </section>
  );
}
