import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { paths } from '../paths';
import { useRealtimeInvalidation } from '../realtime/RealtimeProvider';
import type { CurrentUser } from '../services/api';
import { SignalGlyph } from '../ui/signal-icons';
import { useNarrowShell } from '../ui/useResponsive';
import { assignmentOfferStateLabel, changeRequestReasonLabel } from './job-labels';
import {
  listAssignmentOffersNeedingAction,
  listOpenChangeRequests,
  listUnacceptedPastStart,
  type AssignmentOfferNeedingActionItem,
  type OpenChangeRequestItem,
  type UnacceptedPastStartItem,
} from './jobs-api';
import './job-attention.css';

/** Compact rows stop at three per group; the overview owns the full pages. */
const ROW_LIMIT = 3;

type AttentionListState<T> =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; items: readonly T[]; total: number };

type PagedLoader<T> = (
  page: { limit: number; offset: number },
) => Promise<{ items: T[]; total: number }>;

function formatInstant(value: string): string {
  return new Intl.DateTimeFormat('tr-TR', { dateStyle: 'medium', timeStyle: 'short' })
    .format(new Date(value));
}

/**
 * One server-owned management list, read as a compact group. The first page is
 * three rows so the board is never delayed by a full overview read; `total`
 * still carries the real group size. A stale response from a previous reload
 * never replaces the current one.
 */
function useAttentionList<T>(load: PagedLoader<T>, reload: number): AttentionListState<T> {
  const [state, setState] = useState<AttentionListState<T>>({ kind: 'loading' });
  const requestId = useRef(0);

  useEffect(() => {
    const id = ++requestId.current;
    setState((current) => current.kind === 'ready' ? current : { kind: 'loading' });
    void load({ limit: ROW_LIMIT, offset: 0 }).then(
      (page) => {
        if (id !== requestId.current) return;
        setState({
          kind: 'ready',
          items: [...page.items].slice(0, ROW_LIMIT),
          total: page.total,
        });
      },
      () => {
        if (id !== requestId.current) return;
        setState({ kind: 'error' });
      },
    );
    return () => { requestId.current += 1; };
  }, [load, reload]);

  return state;
}

function isManagementUser(user: CurrentUser): boolean {
  return user.role === 'MANAGER' || user.role === 'ADMIN';
}

function RowSeparator() {
  return <span className="job-attention-separator" aria-hidden="true">·</span>;
}

type AttentionRow = {
  id: string;
  jobId: string;
  title: string;
  reason: string;
  icon: 'edit' | 'exclamation' | 'circle';
  person: string;
  timeLabel: string;
  time: string;
};

function AttentionRowView({ row }: { row: AttentionRow }) {
  return (
    <li className="job-attention-row" data-job-attention-row="true">
      <span className="job-attention-row-icon">
        <SignalGlyph name={row.icon} />
      </span>
      <div className="job-attention-row-content">
        <Link className="job-attention-row-title" to={paths.job(row.jobId)}>
          {row.title}
        </Link>
        <p className="job-attention-row-meta">
          <span className="job-attention-reason">{row.reason}</span>
          <RowSeparator />
          <span className="job-attention-person">
            <span className="sr-only">Personel: </span>
            {row.person}
          </span>
          <RowSeparator />
          <span className="job-attention-time">
            <span className="sr-only">{row.timeLabel}: </span>
            <time dateTime={row.time}>{formatInstant(row.time)}</time>
          </span>
        </p>
      </div>
    </li>
  );
}

function AttentionGroup({ title, id, rows }: {
  title: string;
  id: string;
  rows: readonly AttentionRow[];
}) {
  if (rows.length === 0) return null;
  return (
    <section className="job-attention-group" aria-labelledby={id} data-job-attention-group="true">
      <h3 className="job-attention-group-title" id={id}>{title}</h3>
      <ul className="job-attention-rows">
        {rows.map((row) => <AttentionRowView key={row.id} row={row} />)}
      </ul>
    </section>
  );
}

/**
 * Jobs-page management panel: surfaces the same server-owned intervention
 * lists as the overview ("Müdahale gerekenler") where managers already work,
 * without introducing a second business rule. Staff never mount it.
 */
export function JobAttentionPanel({
  user,
  loadChangeRequests = listOpenChangeRequests,
  loadAssignmentOffers = listAssignmentOffersNeedingAction,
  loadUnacceptedPastStart = listUnacceptedPastStart,
}: {
  user: CurrentUser;
  /** Test seams; production always reads the existing server lists. */
  loadChangeRequests?: typeof listOpenChangeRequests;
  loadAssignmentOffers?: typeof listAssignmentOffersNeedingAction;
  loadUnacceptedPastStart?: typeof listUnacceptedPastStart;
}) {
  if (!isManagementUser(user)) return null;
  return (
    <ManagementAttentionPanel
      loadChangeRequests={loadChangeRequests}
      loadAssignmentOffers={loadAssignmentOffers}
      loadUnacceptedPastStart={loadUnacceptedPastStart}
    />
  );
}

function ManagementAttentionPanel({
  loadChangeRequests,
  loadAssignmentOffers,
  loadUnacceptedPastStart,
}: {
  loadChangeRequests: typeof listOpenChangeRequests;
  loadAssignmentOffers: typeof listAssignmentOffersNeedingAction;
  loadUnacceptedPastStart: typeof listUnacceptedPastStart;
}) {
  const [reload, setReload] = useState(0);
  const changeRequests = useAttentionList<OpenChangeRequestItem>(loadChangeRequests, reload);
  const assignmentOffers = useAttentionList<AssignmentOfferNeedingActionItem>(loadAssignmentOffers, reload);
  const unacceptedPastStart = useAttentionList<UnacceptedPastStartItem>(loadUnacceptedPastStart, reload);
  useRealtimeInvalidation(['overview', 'job-list'], () => setReload((value) => value + 1));

  const narrow = useNarrowShell();
  const [disclosureOpen, setDisclosureOpen] = useState(true);

  const changeRequestRows: AttentionRow[] = changeRequests.kind === 'ready'
    ? changeRequests.items.map((item) => ({
        id: item.changeRequestId,
        jobId: item.jobCardId,
        title: item.jobTitle,
        reason: changeRequestReasonLabel(item.reasonCode),
        icon: 'edit',
        person: item.requestedBy.name,
        timeLabel: 'Gönderim',
        time: item.requestedAt,
      }))
    : [];
  const assignmentOfferRows: AttentionRow[] = assignmentOffers.kind === 'ready'
    ? assignmentOffers.items.map((item) => ({
        id: item.offerId,
        jobId: item.jobCardId,
        title: item.jobTitle,
        reason: assignmentOfferStateLabel(item.state),
        icon: 'exclamation',
        person: item.assignee.name,
        timeLabel: 'Kabul için son',
        time: item.acceptanceDueAt,
      }))
    : [];
  const unacceptedPastStartRows: AttentionRow[] = unacceptedPastStart.kind === 'ready'
    ? unacceptedPastStart.items.map((item) => ({
        id: item.jobCardId,
        jobId: item.jobCardId,
        title: item.title,
        reason: 'Kabul bekliyor',
        icon: 'circle',
        person: item.assignee.active ? item.assignee.name : `${item.assignee.name} (pasif)`,
        timeLabel: 'Planlanan başlangıç',
        time: item.scheduledAt,
      }))
    : [];

  const groups = [changeRequests, assignmentOffers, unacceptedPastStart];
  const failed = groups.some((group) => group.kind === 'error');
  const loadedGroups = groups.flatMap((group) => (
    group.kind === 'ready' ? [{ total: group.total, shown: group.items.length }] : []
  ));
  const total = loadedGroups.reduce((sum, group) => sum + group.total, 0);
  const hasMore = loadedGroups.some((group) => group.total > group.shown);

  // Loading never delays the board, and a clean empty result shows nothing.
  if (!failed && total === 0) return null;

  const heading = (
    <h2 className="job-attention-title" id="job-attention-title">
      Müdahale gerekenler
      {loadedGroups.length > 0 && (
        <span className="job-attention-count">{total} kayıt</span>
      )}
    </h2>
  );

  const body = (
    <div className="job-attention-body">
      {failed && (
        <div className="job-attention-error" data-job-attention-error="true">
          <p role="alert">Müdahale gerekenler yüklenemedi</p>
          <button
            className="secondary-button"
            type="button"
            onClick={() => setReload((value) => value + 1)}
          >
            Tekrar dene
          </button>
        </div>
      )}
      <AttentionGroup
        id="job-attention-change-requests"
        title="Personel önerileri"
        rows={changeRequestRows}
      />
      <AttentionGroup
        id="job-attention-assignment-offers"
        title="Müdahale gereken atamalar"
        rows={assignmentOfferRows}
      />
      <AttentionGroup
        id="job-attention-unaccepted"
        title="Kabul bekleyen işler"
        rows={unacceptedPastStartRows}
      />
      {hasMore && (
        <p className="job-attention-overview-link">
          <Link to={paths.overview}>Tümünü Genel bakışta gör</Link>
        </p>
      )}
    </div>
  );

  if (narrow) {
    return (
      <section className="job-attention" aria-labelledby="job-attention-title" data-job-attention="true">
        <details
          className="job-attention-disclosure"
          open={disclosureOpen}
          onToggle={(event) => {
            if (event.target === event.currentTarget) {
              setDisclosureOpen(event.currentTarget.open);
            }
          }}
        >
          <summary className="job-attention-summary">{heading}</summary>
          {body}
        </details>
      </section>
    );
  }

  return (
    <section className="job-attention" aria-labelledby="job-attention-title" data-job-attention="true">
      {heading}
      {body}
    </section>
  );
}
