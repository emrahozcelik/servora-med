import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { useRealtimeInvalidation } from '../realtime/RealtimeProvider';
import type { CurrentUser } from '../services/api';
import { OperationalCard } from '../ui/antd/OperationalCard';
import { ResultState } from '../ui/antd/ResultState';
import { ServoraListPagination } from '../ui/antd/ServoraPagination';
import { formatDurationSeconds } from '../ui/duration';
import { DEFAULT_LIST_PAGE_SIZE, lastListPageOffset } from '../ui/pagination';
import { listUnacceptedPastStart, type UnacceptedPastStartItem } from './jobs-api';

function isManagementUser(user: CurrentUser): boolean {
  return user.role === 'MANAGER' || user.role === 'ADMIN';
}

function formatInstant(value: string): string {
  return new Intl.DateTimeFormat('tr-TR', { dateStyle: 'medium', timeStyle: 'short' })
    .format(new Date(value));
}

type UnacceptedPastStartListState =
  | { kind: 'loading' }
  | { kind: 'ready'; items: UnacceptedPastStartItem[]; total: number }
  | { kind: 'error'; message: string };

/**
 * OVR-6 §6 management overview section: `NEW` jobs whose planned start passed
 * without acceptance and that JOB-010 does not own. This is not Staff lateness:
 * the server decides ownership, the elapsed duration is a request-clock value
 * and the section is management-only. It mirrors the "Müdahale gereken
 * atamalar" section next to it.
 */
export function UnacceptedPastStartSection({
  user,
  load = listUnacceptedPastStart,
}: {
  user: CurrentUser;
  load?: typeof listUnacceptedPastStart;
}) {
  const management = isManagementUser(user);
  const [state, setState] = useState<UnacceptedPastStartListState>({ kind: 'loading' });
  const [offset, setOffset] = useState(0);
  const requestId = useRef(0);

  const refresh = useCallback(async () => {
    if (!management) return;
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
    } catch (caught) {
      if (id !== requestId.current) return;
      setState({
        kind: 'error',
        message: caught instanceof Error ? caught.message : 'Kabul bekleyen işler yüklenemedi.',
      });
    }
  }, [load, offset, management]);

  useEffect(() => {
    void refresh();
    return () => { requestId.current += 1; };
  }, [refresh]);
  useRealtimeInvalidation(['overview', 'job-list'], () => { void refresh(); });

  if (!management) return null;
  if (state.kind === 'loading') return null;
  // A failed load must never look like "nothing is waiting for acceptance".
  if (state.kind === 'error') {
    return (
      <section
        className="overview-section"
        aria-label="Kabul bekleyen ve planlanan zamanı geçen işler"
        data-unaccepted-past-start="error"
      >
        <ResultState
          status="error"
          title="Kabul bekleyen işler yüklenemedi"
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
    <section
      className="overview-section"
      aria-labelledby="unaccepted-past-start-title"
      data-unaccepted-past-start="true"
    >
      <h2 id="unaccepted-past-start-title">Kabul bekleyen ve planlanan zamanı geçen işler</h2>
      <ul className="overview-card-stack">
        {state.items.map((item) => (
          <li key={item.jobCardId}>
            <OperationalCard
              title={<Link to={item.jobPath}>{item.title}</Link>}
              tone="attention"
              statusLabel="Kabul bekliyor"
              className="unaccepted-past-start-card"
            >
              <span>
                {item.assignee.name}{item.assignee.active ? '' : ' (pasif)'} · Planlanan başlangıç:{' '}
                <time dateTime={item.scheduledAt}>{formatInstant(item.scheduledAt)}</time>
                {' · '}{formatDurationSeconds(item.elapsedSeconds)} geçti
              </span>
              {item.hasOpenChangeRequest && (
                <p data-unaccepted-past-start-change-request="true">
                  <span className="servora-tone-chip servora-tone-chip--attention">Değişiklik talebi açık</span>
                </p>
              )}
            </OperationalCard>
          </li>
        ))}
      </ul>
      <ServoraListPagination
        total={state.total}
        offset={offset}
        label="Kabul bekleyen işler sayfaları"
        itemName="iş"
        onOffsetChange={(nextOffset) => {
          // Hide the focused pager in the same event as the offset change so an
          // intermediate render cannot consume its keyboard-focus ticket.
          setState({ kind: 'loading' });
          setOffset(nextOffset);
        }}
      />
    </section>
  );
}
