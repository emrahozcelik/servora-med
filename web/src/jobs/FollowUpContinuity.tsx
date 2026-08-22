import { useCallback, useEffect, useRef, useState } from 'react';

import { paths } from '../paths';
import { useRealtimeInvalidation } from '../realtime/RealtimeProvider';
import { OperationalCard, RecordDescriptions } from '../ui/antd';
import { jobCardStatusLabel, jobTypeLabels } from './job-labels';
import {
  getJobCard,
  listFollowUps,
  type JobCard,
  type MeetingDetails,
  type FollowUpListItem,
} from './jobs-api';
import {
  FOLLOW_UP_BADGE_LABEL,
  FOLLOW_UP_CHILDREN_TITLE,
  FOLLOW_UP_DATE_LABELS,
  FOLLOW_UP_OUTCOME_LABELS,
  FOLLOW_UP_SOURCE_TITLE,
} from './follow-up-presentation';

function formatInstant(value: string | null) {
  if (!value) return 'Belirtilmedi';
  return new Intl.DateTimeFormat('tr-TR', { dateStyle: 'medium', timeStyle: 'short' })
    .format(new Date(value));
}

export function FollowUpBadge({ visible }: { visible: boolean }) {
  return visible ? <span className="follow-up-badge">{FOLLOW_UP_BADGE_LABEL}</span> : null;
}

export function FollowUpSourcePanel({ job }: { job: JobCard }) {
  const context = job.followUpContext;
  if (!context) return null;
  const summary = context.sourceSummary;
  return <section className="follow-up-source-context" aria-labelledby="follow-up-source-context-title"
    data-follow-up-source-access={context.sourceAccess}>
    <details className="follow-up-source-disclosure">
      <summary><span id="follow-up-source-context-title">{FOLLOW_UP_SOURCE_TITLE}</span></summary>
      <div className="follow-up-source-disclosure__content">
        {context.sourceAccess === 'FULL' && context.sourceJobPath
          ? <a className="inline-action" href={context.sourceJobPath}>Önceki işi aç</a>
          : null}
        <p className="follow-up-instructions"><strong>Takip kapsamı</strong><span>{context.followUpInstructions}</span></p>
        <RecordDescriptions ariaLabel="Önceki iş özeti" items={[
          { key: 'type', label: 'İş türü', content: jobTypeLabels[summary.sourceType] },
          { key: 'planned', label: FOLLOW_UP_DATE_LABELS.planned, content: formatInstant(summary.sourcePlannedAt) },
          { key: 'occurred', label: FOLLOW_UP_DATE_LABELS.occurred, content: formatInstant(summary.sourceOccurredAt) },
          { key: 'completed', label: FOLLOW_UP_DATE_LABELS.completed, content: formatInstant(summary.sourceCompletedAt) },
          { key: 'customer', label: 'Müşteri', content: summary.customer?.name ?? 'Belirtilmedi' },
          { key: 'contact', label: 'İlgili kişi', content: summary.contact?.name ?? 'Belirtilmedi' },
          ...(summary.outcome ? [{ key: 'outcome', label: 'Görüşme sonucu', content: FOLLOW_UP_OUTCOME_LABELS[summary.outcome] }] : []),
        ]} />
      </div>
    </details>
  </section>;
}

export function FollowUpRecommendation({ job, details, onCreate }: {
  job: JobCard;
  details: MeetingDetails | null;
  onCreate: () => void;
}) {
  if (job.type !== 'SALES_MEETING' || job.status !== 'COMPLETED'
    || details?.outcome !== 'FOLLOW_UP_REQUIRED') return null;
  return <section className="follow-up-recommendation" aria-labelledby="follow-up-recommendation-title">
    <OperationalCard tone="attention" title={<h2 id="follow-up-recommendation-title">Takip gerekli</h2>}
      actions={<button className="primary-button" type="button" onClick={onCreate}>Takip işi oluştur</button>}>
      <p>Personel bu görüşmenin ardından yeni bir takip işi önerdi.</p>
      {details.nextFollowUpAt && <p><strong>Personelin önerdiği takip zamanı:</strong>{' '}
        <time dateTime={details.nextFollowUpAt}>{formatInstant(details.nextFollowUpAt)}</time></p>}
      <p className="form-help">Önerilen zaman kesinleşmiş bir randevu değildir. Planlanan zamanı yönetici oluşturma formunda onaylar.</p>
    </OperationalCard>
  </section>;
}

export function FollowUpCreateAction({ onCreate, existingChildrenCount }: {
  onCreate: () => void;
  existingChildrenCount?: number | null;
}) {
  return <section className="follow-up-create-action surface-flat" aria-label="Takip işi işlemi">
    <div>
      <h2>Sonraki işi planlayın</h2>
      <p>Tamamlanan kaydı değiştirmeden yeni ve bağlantılı bir iş oluşturun.</p>
      {existingChildrenCount != null && existingChildrenCount > 0 && (
        <p className="follow-up-existing-hint">Bu iş için {existingChildrenCount} takip işi mevcut.</p>
      )}
    </div>
    <button className="primary-button" type="button" onClick={onCreate}>Takip işi oluştur</button>
  </section>;
}

function ChildRow({ item }: { item: FollowUpListItem }) {
  return <li className="follow-up-child-row">
    <div><span className="follow-up-badge">{FOLLOW_UP_BADGE_LABEL}</span>
      <a href={paths.job(item.id)}><strong>{item.title}</strong></a></div>
    <dl><div><dt>Tür</dt><dd>{jobTypeLabels[item.type]}</dd></div>
      <div><dt>Durum</dt><dd>{jobCardStatusLabel(item.status)}</dd></div>
      <div><dt>Sorumlu</dt><dd>{item.assignee.name}</dd></div>
      <div><dt>Planlanan tarih</dt><dd>{formatInstant(item.scheduledAt)}</dd></div></dl>
  </li>;
}

export function FollowUpChildrenPanel({ sourceId, onCountChange }: {
  sourceId: string;
  onCountChange?: (count: number) => void;
}) {
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'ready'; items: FollowUpListItem[]; total: number; limit: number; offset: number; loadingMore: boolean }
    | { kind: 'error'; message: string }
  >({ kind: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const requestGeneration = useRef(0);

  const reload = useCallback(() => {
    setReloadKey((value) => value + 1);
  }, []);

  useRealtimeInvalidation([`job-detail:${sourceId}`], reload);

  useEffect(() => {
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    setState({ kind: 'loading' });
    listFollowUps(sourceId, { limit: 100, offset: 0 })
      .then((page) => {
        if (requestGeneration.current !== generation) return;
        setState({
          kind: 'ready', items: page.items, total: page.total, limit: page.limit,
          offset: page.offset, loadingMore: false,
        });
        onCountChange?.(page.total);
      })
      .catch(() => {
        if (requestGeneration.current !== generation) return;
        setState({ kind: 'error', message: 'Takip işleri yüklenemedi.' });
      });
    return () => {
      requestGeneration.current += 1;
    };
  }, [reloadKey, sourceId]);

  async function loadMore() {
    if (state.kind !== 'ready' || state.loadingMore || state.items.length >= state.total) return;
    const generation = requestGeneration.current;
    const nextOffset = state.offset + state.limit;
    setState({ ...state, loadingMore: true });
    try {
      const page = await listFollowUps(sourceId, { limit: state.limit, offset: nextOffset });
      if (requestGeneration.current !== generation) return;
      setState((current) => current.kind === 'ready' ? {
        kind: 'ready',
        items: [...current.items, ...page.items],
        total: page.total,
        limit: page.limit,
        offset: page.offset,
        loadingMore: false,
      } : current);
    } catch {
      if (requestGeneration.current !== generation) return;
      setState((current) => current.kind === 'ready' ? { ...current, loadingMore: false } : current);
    }
  }

  const hasMore = state.kind === 'ready' && state.items.length < state.total;
  return <section className="follow-up-children" aria-labelledby="follow-up-children-title">
    <h2 id="follow-up-children-title">{FOLLOW_UP_CHILDREN_TITLE}</h2>
    {state.kind === 'loading' && <p role="status">Takip işleri yükleniyor…</p>}
    {state.kind === 'error' && <div className="detail-feedback detail-feedback-error" role="alert">{state.message}{' '}
      <button className="inline-action" type="button" onClick={() => setReloadKey((value) => value + 1)}>Tekrar dene</button></div>}
    {state.kind === 'ready' && state.items.length === 0 && <p className="field-status">Bu işten oluşturulmuş takip işi bulunmuyor.</p>}
    {state.kind === 'ready' && state.items.length > 0 && <ul className="follow-up-child-list">
      {state.items.map((item) => <ChildRow key={item.id} item={item} />)}
    </ul>}
    {state.kind === 'ready' && <div className="follow-up-children-pagination">
      <p className="field-status">{state.items.length} / {state.total} takip işi gösteriliyor.</p>
      {hasMore && <button className="secondary-button" type="button" onClick={() => void loadMore()} disabled={state.loadingMore}>
        {state.loadingMore ? 'Yükleniyor…' : 'Daha fazla göster'}
      </button>}
    </div>}
  </section>;
}

type BreadcrumbEntry = { id: string; title: string; path: string };

function sourceIdFromPath(path: string, expectedId: string) {
  const match = /^\/jobs\/([^/?#]+)$/.exec(path);
  if (!match) return null;
  try {
    const id = decodeURIComponent(match[1]!);
    return id === expectedId ? id : null;
  } catch {
    return null;
  }
}

export function FollowUpBreadcrumb({ job }: { job: JobCard }) {
  const [entries, setEntries] = useState<BreadcrumbEntry[]>([]);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const initial = job.followUpContext;
    if (!initial || initial.sourceAccess !== 'FULL' || !initial.sourceJobPath) {
      setEntries([]);
      setFailed(false);
      return;
    }
    let active = true;
    (async () => {
      const nextEntries: BreadcrumbEntry[] = [];
      const visited = new Set<string>([job.id]);
      let context = initial;
      for (let depth = 0; depth < 10; depth += 1) {
        if (context.sourceAccess !== 'FULL' || !context.sourceJobPath) break;
        const sourceId = sourceIdFromPath(context.sourceJobPath, context.sourceJobCardId);
        if (!sourceId || visited.has(sourceId)) throw new Error('invalid follow-up chain');
        visited.add(sourceId);
        const source = await getJobCard(sourceId);
        nextEntries.unshift({ id: source.id, title: source.title, path: context.sourceJobPath });
        if (!source.followUpContext) break;
        context = source.followUpContext;
      }
      if (active) { setEntries(nextEntries); setFailed(false); }
    })().catch(() => { if (active) { setEntries([]); setFailed(true); } });
    return () => { active = false; };
  }, [job]);
  if (!job.followUpContext) return null;
  if (failed) return <p className="field-status" role="status">Takip zinciri şu anda gösterilemiyor.</p>;
  if (entries.length === 0) return null;
  return <nav className="follow-up-breadcrumb" aria-label="Takip zinciri"><ol>
    {entries.map((entry) => <li key={entry.id}><a href={entry.path}>{entry.title}</a></li>)}
    <li aria-current="page">{job.title}</li>
  </ol></nav>;
}
