import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { paths } from '../paths';
import { useRealtimeInvalidation } from '../realtime/RealtimeProvider';
import {
  getOverview,
  type OverviewResponse,
} from '../services/overview-api';
import type { CurrentUser } from '../services/api';
import { TrendBars } from '../reports/report-charts';

function Kpis({ overview }: { overview: OverviewResponse }) {
  const items = overview.scope === 'staff'
    ? [
        ['Açık işler', overview.openJobCards, `${paths.jobs}?status=active`],
        ['Kontrol bekleyen', overview.waitingApproval, `${paths.jobs}?status=WAITING_APPROVAL`],
        ['Düzeltme gereken', overview.revisionRequested, `${paths.jobs}?status=REVISION_REQUESTED`],
        ['Tamamlanan', overview.completedInPeriod, `${paths.jobs}?status=COMPLETED`],
      ]
    : [
        ['Aktif işler', overview.active, `${paths.jobs}?status=active`],
        ['Geciken', overview.overdue, `${paths.jobs}?dueBefore=${overview.range.to}`],
        ['Kontrol bekleyen', overview.waitingApproval, paths.approvalReports],
        ['Düzeltme gereken', overview.revisionRequested, `${paths.jobs}?status=REVISION_REQUESTED`],
      ];
  return (
    <dl className="overview-kpis" aria-label="Dönem özeti">
      {items.map(([label, value, href]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
          <Link to={String(href)}>İşleri aç</Link>
        </div>
      ))}
    </dl>
  );
}

export function OverviewPage({
  user,
  load = getOverview,
}: {
  user: CurrentUser;
  load?: () => Promise<OverviewResponse>;
}) {
  const [state, setState] = useState<
    { kind: 'loading' }
    | { kind: 'error'; message: string }
    | { kind: 'ready'; overview: OverviewResponse }
  >({ kind: 'loading' });

  const refresh = useCallback(async () => {
    setState((current) => current.kind === 'ready' ? current : { kind: 'loading' });
    try {
      setState({ kind: 'ready', overview: await load() });
    } catch (error) {
      setState({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Genel bakış yüklenemedi.',
      });
    }
  }, [load]);

  useEffect(() => { void refresh(); }, [refresh]);
  useRealtimeInvalidation(['overview'], () => { void refresh(); });

  if (state.kind === 'loading') {
    return <main className="workspace overview-workspace" aria-busy="true"><h1>Genel bakış yükleniyor</h1></main>;
  }
  if (state.kind === 'error') {
    return <main className="workspace overview-workspace"><div className="workspace-message" role="alert">
      <h1>Genel bakış yüklenemedi</h1><p>{state.message}</p>
      <button className="secondary-button" type="button" onClick={() => void refresh()}>Tekrar dene</button>
    </div></main>;
  }

  const { overview } = state;
  return (
    <main className="workspace overview-workspace">
      <header className="workspace-heading">
        <div>
          <p className="eyebrow">{overview.scope === 'staff' ? 'Kişisel çalışma alanı' : 'Operasyon görünümü'}</p>
          <h1>Genel Bakış</h1>
          <p>{user.name}, {overview.range.from} – {overview.range.to} dönemi.</p>
        </div>
      </header>
      <Kpis overview={overview} />

      {overview.upcomingWork && (
        <section className="overview-section" aria-labelledby="upcoming-work-title">
          <div className="overview-section-heading">
            <h2 id="upcoming-work-title">Yaklaşan çalışmalar</h2>
            <Link to={paths.calendar}>Takvimi aç</Link>
          </div>
          {overview.upcomingWork.items.length === 0
            ? <p>Önümüzdeki yedi gün için planlanmış çalışma bulunmuyor.</p>
            : <ul>{overview.upcomingWork.items.map((item) => (
              <li key={`${item.source}:${item.id}`}>
                <Link to={item.path}>{item.title}</Link>
                <span>{new Date(item.startsAt).toLocaleString('tr-TR')} · {item.assignedUserName}</span>
              </li>
            ))}</ul>}
        </section>
      )}

      {overview.scope === 'management' && (
        <section className="overview-section" aria-labelledby="completion-trend-title">
          <h2 id="completion-trend-title">Tamamlanma eğilimi</h2>
          <p>{overview.completedInPeriod} iş tamamlandı; {overview.cancelledInPeriod} iş iptal edildi.</p>
          <TrendBars points={overview.completionTrend} className="overview-trend" />
          <p className="overview-text-summary">
            Kontrol kuyruğunda {overview.approvalQueueSummary.pendingCount} iş bulunuyor.
          </p>
        </section>
      )}

      <div className="overview-recent-grid">
        <section className="overview-section" aria-labelledby="recent-work-title">
          <h2 id="recent-work-title">Son tamamlanan işler</h2>
          {overview.recentCompletedWork.length === 0
            ? <p>Bu dönemde tamamlanan iş bulunmuyor.</p>
            : <ul>{overview.recentCompletedWork.map((item) => (
              <li key={item.id}><Link to={paths.job(item.id)}>{item.title}</Link>
                <span>{item.customerName ?? 'Müşteri bağlantısı yok'} · {item.assigneeName ?? 'Atanmamış'}</span></li>
            ))}</ul>}
        </section>
        <section className="overview-section" aria-labelledby="recent-notes-title">
          <h2 id="recent-notes-title">Son notlar</h2>
          {overview.recentNotes.length === 0
            ? <p>Yetki kapsamınızda yakın tarihli not bulunmuyor.</p>
            : <ul>{overview.recentNotes.map((note) => (
              <li key={note.id}><Link to={paths.job(note.jobCardId)}>{note.jobTitle}</Link>
                <p>{note.preview}</p><span>{note.authorName}</span></li>
            ))}</ul>}
        </section>
      </div>
    </main>
  );
}
