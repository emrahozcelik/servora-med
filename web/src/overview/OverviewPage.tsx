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
import { EmptyState } from '../ui/antd/EmptyState';
import { LoadingSkeleton } from '../ui/antd/LoadingSkeleton';
import { MetricStatistic } from '../ui/antd/MetricStatistic';
import { OperationalCard } from '../ui/antd/OperationalCard';
import { ResultState } from '../ui/antd/ResultState';

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
    return (
      <main className="workspace overview-workspace" aria-busy="true">
        <LoadingSkeleton title="Genel bakış yükleniyor…" rows={4} />
      </main>
    );
  }
  if (state.kind === 'error') {
    return (
      <main className="workspace overview-workspace">
        <ResultState
          status="error"
          title="Genel bakış yüklenemedi"
          description={state.message}
          action={
            <button className="secondary-button" type="button" onClick={() => void refresh()}>
              Tekrar dene
            </button>
          }
        />
      </main>
    );
  }

  const { overview } = state;
  const isStaff = overview.scope === 'staff';

  const kpis = isStaff
    ? [
        { label: 'Açık işler', value: overview.openJobCards, href: `${paths.jobs}?status=active`, tone: 'default' as const },
        { label: 'Kontrol bekleyen', value: overview.waitingApproval, href: `${paths.jobs}?status=WAITING_APPROVAL`, tone: 'attention' as const },
        { label: 'Düzeltme gereken', value: overview.revisionRequested, href: `${paths.jobs}?status=REVISION_REQUESTED`, tone: 'warning' as const },
        { label: 'Tamamlanan', value: overview.completedInPeriod, href: `${paths.jobs}?status=COMPLETED`, tone: 'success' as const },
      ]
    : [
        { label: 'Aktif işler', value: overview.active, href: `${paths.jobs}?status=active`, tone: 'default' as const },
        { label: 'Geciken', value: overview.overdue, href: `${paths.jobs}?dueBefore=${overview.range.to}`, tone: 'attention' as const },
        { label: 'Kontrol bekleyen', value: overview.waitingApproval, href: paths.approvalReports, tone: 'attention' as const },
        { label: 'Düzeltme gereken', value: overview.revisionRequested, href: `${paths.jobs}?status=REVISION_REQUESTED`, tone: 'warning' as const },
      ];

  return (
    <main className="workspace overview-workspace">
      <header className="workspace-heading">
        <div>
          <p className="eyebrow">{isStaff ? 'Kişisel çalışma alanı' : 'Operasyon görünümü'}</p>
          <h1>Genel Bakış</h1>
          <p>{user.name}, {overview.range.from} – {overview.range.to} dönemi.</p>
        </div>
      </header>

      <div className="overview-kpis" aria-label="Dönem özeti">
        {kpis.map((kpi) => (
          <MetricStatistic
            key={kpi.label}
            title={kpi.label}
            value={kpi.value}
            linkTo={kpi.href}
            tone={kpi.tone}
          />
        ))}
      </div>

      <div className="overview-main-grid">
        {!isStaff && (
          <section className="overview-section" aria-labelledby="completion-trend-title">
            <h2 id="completion-trend-title">Tamamlanma eğilimi</h2>
            <p>{overview.completedInPeriod} iş tamamlandı; {overview.cancelledInPeriod} iş iptal edildi.</p>
            <TrendBars points={overview.completionTrend} className="overview-trend" />
            <p className="overview-text-summary">
              Kontrol kuyruğunda {overview.approvalQueueSummary.pendingCount} iş bulunuyor.
            </p>
          </section>
        )}

        {overview.upcomingWork && (
          <section className="overview-section" aria-labelledby="upcoming-work-title">
            <h2 id="upcoming-work-title">Yaklaşan işler</h2>
            {overview.upcomingWork.items.length === 0
              ? <EmptyState title="Yaklaşan iş bulunmuyor" />
              : <div className="overview-card-stack">
                  {overview.upcomingWork.items.map((item) => (
                    <OperationalCard
                      key={`${item.source}:${item.id}`}
                      title={<Link to={item.path}>{item.title}</Link>}
                      tone="upcoming"
                    >
                      <span>{new Date(item.startsAt).toLocaleString('tr-TR')} · {item.assignedUserName}</span>
                    </OperationalCard>
                  ))}
                </div>
            }
          </section>
        )}

        <section className="overview-section" aria-labelledby="recent-work-title">
          <h2 id="recent-work-title">Son tamamlanan işler</h2>
          {overview.recentCompletedWork.length === 0
            ? <EmptyState title="Bu dönemde tamamlanan iş bulunmuyor" />
            : <div className="overview-card-stack">
                {overview.recentCompletedWork.map((item) => (
                  <OperationalCard
                    key={item.id}
                    title={<Link to={paths.job(item.id)}>{item.title}</Link>}
                    tone="success"
                  >
                    <span>{item.customerName ?? 'Müşteri bağlantısı yok'} · {item.assigneeName ?? 'Atanmamış'}</span>
                  </OperationalCard>
                ))}
              </div>
          }
        </section>

        <section className="overview-section" aria-labelledby="recent-notes-title">
          <h2 id="recent-notes-title">Son notlar</h2>
          {overview.recentNotes.length === 0
            ? <EmptyState title="Yakın tarihli not bulunmuyor" />
            : <div className="overview-card-stack">
                {overview.recentNotes.map((note) => (
                  <OperationalCard
                    key={note.id}
                    title={<Link to={paths.job(note.jobCardId)}>{note.jobTitle}</Link>}
                    tone="default"
                  >
                    <p>{note.preview}</p>
                    <span>{note.authorName}</span>
                  </OperationalCard>
                ))}
              </div>
          }
        </section>
      </div>
    </main>
  );
}
