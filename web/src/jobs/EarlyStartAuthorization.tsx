import { useEffect, useState } from 'react';

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
 */
export function canGrantEarlyStartAuthorization(job: JobCard, user: CurrentUser): boolean {
  if (!isManagementUser(user)) return false;
  if ((job.earlyStartAuthorization ?? null) !== null) return false;
  if (job.type !== 'PRODUCT_DELIVERY' && job.type !== 'SALES_MEETING') return false;
  if (job.status !== 'NEW' && job.status !== 'ACCEPTED') return false;
  return job.scheduledAt !== null;
}

/**
 * JOB-010 §1a early-start authorization surface. Managers get the grant
 * button while the job is eligible; once a valid authorization exists, the
 * manager and the assigned Staff member see who granted it and when.
 */
export function EarlyStartAuthorizationSection({ job, user, onGranted }: {
  job: JobCard;
  user: CurrentUser;
  onGranted: () => void;
}) {
  const [granting, setGranting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  // A new job version means the canonical truth changed (the grant landed, or
  // a later reschedule/reassignment voided it): drop the local success state
  // so the button is never left disabled behind a stale message.
  useEffect(() => { setDone(false); setError(null); }, [job.id, job.version]);

  const authorization = job.earlyStartAuthorization ?? null;
  const canGrant = canGrantEarlyStartAuthorization(job, user);
  if (authorization === null && !canGrant) return null;

  const grant = async () => {
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
      className="detail-summary surface-flat"
      aria-label="Erken başlama izni"
      data-early-start-authorization={authorization === null ? 'idle' : 'authorized'}
    >
      {authorization === null ? (
        <div>
          <button
            className="secondary-button"
            type="button"
            disabled={granting || done}
            data-early-start-authorization-action="true"
            onClick={() => void grant()}
          >
            {granting ? 'Kaydediliyor…' : 'Erken başlamaya izin ver'}
          </button>
          {error && <p role="alert">{error}</p>}
          {done && !error && <p role="status">Erken başlama izni kaydedildi.</p>}
        </div>
      ) : (
        <p role="status">
          Erken başlama izni: {authorization.grantedBy.name ?? 'Yönetici'},{' '}
          <time dateTime={authorization.grantedAt}>{formatInstant(authorization.grantedAt)}</time>
        </p>
      )}
    </section>
  );
}
