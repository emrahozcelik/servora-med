import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { OpenSubmissionLateSection } from '../jobs/SubmissionLateness';
import { OpenChangeRequestsSection } from '../jobs/ChangeRequests';
import { OpenAssignmentOffersSection } from '../jobs/AssignmentOffer';
import { UnacceptedPastStartSection } from '../jobs/UnacceptedPastStart';
import { jobTypeLabel } from '../jobs/job-labels';
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
import { PageHeader } from '../ui/PageHeader';
import { ResultState } from '../ui/antd/ResultState';

function resolveTimeZone(value: string): string {
  try {
    new Intl.DateTimeFormat('tr-TR', { timeZone: value });
    return value;
  } catch {
    return 'UTC';
  }
}

/** Period range copy: date only, no time-of-day and no seconds. */
function formatOverviewDate(value: string, timeZone: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(`${value}T12:00:00.000Z`);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString('tr-TR', {
      day: 'numeric', month: 'long', year: 'numeric', timeZone: resolveTimeZone(timeZone),
    });
}

/**
 * Record timestamps use one scannable shape, e.g. "Çar 19 Kas · 10:00".
 * Seconds are operational noise on overview lists; the server timezone keeps
 * the reading independent of the operator's device.
 */
function formatOverviewDateTime(value: string, timeZone: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const zone = resolveTimeZone(timeZone);
  // tr-TR orders the weekday last; the brief's scanning shape leads with it.
  const parts = new Intl.DateTimeFormat('tr-TR', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: zone,
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? '';
  const time = date.toLocaleTimeString('tr-TR', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: zone,
  });
  return `${part('weekday')} ${part('day')} ${part('month')} · ${time}`;
}

/** "45 dk", "2 sa 15 dk". Null when the API has no measurement yet. */
function formatWaitingDuration(minutes: number | null): string | null {
  if (minutes === null || !Number.isFinite(minutes) || minutes < 0) return null;
  const total = Math.floor(minutes);
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return hours > 0 ? `${hours} sa ${rest} dk` : `${rest} dk`;
}

function OverviewList({ children }: { children: ReactNode }) {
  return (
    <OperationalCard>
      <ul className="overview-row-list">{children}</ul>
    </OperationalCard>
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
  const timeZone = overview.range.timezone;
  const distributionTotal = overview.scope === 'management'
    ? Math.max(1, (overview.workTypeDistribution ?? []).reduce((sum, item) => sum + item.count, 0))
    : 1;
  const unreadMessages = overview.messageUnreadSummary?.unreadTotal ?? 0;

  const kpis = isStaff
    ? [
        {
          label: 'Açık işler',
          value: overview.openJobCards,
          href: `${paths.jobs}?status=active`,
          tone: 'default' as const,
          statusPhrase: 'Açık görev kayıtları',
        },
        {
          // Awaiting a manager is a to-do, not a warning: neutral surface plus
          // the explicit wait phrase (UI audit F-17).
          label: 'Kontrol bekleyen',
          value: overview.waitingApproval,
          href: `${paths.jobs}?status=WAITING_APPROVAL`,
          tone: 'default' as const,
          statusPhrase: overview.waitingApproval > 0 ? 'Yönetici değerlendirmesinde' : 'Bekleyen onay yok',
        },
        {
          label: 'Düzeltme gereken',
          value: overview.revisionRequested,
          href: `${paths.jobs}?status=REVISION_REQUESTED`,
          tone: overview.revisionRequested > 0 ? ('warning' as const) : ('default' as const),
          statusPhrase: overview.revisionRequested > 0 ? 'Düzeltme bekleyen kayıtlar' : 'Düzeltme bekleyen iş yok',
        },
        {
          label: 'Tamamlanan',
          value: overview.completedInPeriod,
          href: `${paths.jobs}?status=COMPLETED`,
          tone: overview.completedInPeriod > 0 ? ('success' as const) : ('default' as const),
          statusPhrase: overview.completedInPeriod > 0 ? 'Bu dönemde tamamlandı' : 'Bu dönemde tamamlanan iş yok',
        },
      ]
    : [
        {
          label: 'Aktif işler',
          value: overview.active,
          href: `${paths.jobs}?status=active`,
          tone: 'default' as const,
          statusPhrase: 'Devam eden işler',
        },
        {
          // Lateness is the strongest operational signal on this page.
          label: 'Geciken',
          value: overview.overdue,
          href: `${paths.jobs}?overdue=true`,
          tone: overview.overdue > 0 ? ('overdue' as const) : ('default' as const),
          statusPhrase: overview.overdue > 0 ? 'Termin süresi aşıldı' : 'Geciken iş yok',
        },
        {
          label: 'Kontrol bekleyen',
          value: overview.waitingApproval,
          // The actionable queue is the Jobs "Onay kuyruğu" view; the approval
          // report under Raporlar is analysis, not the place to decide.
          href: `${paths.jobs}?status=WAITING_APPROVAL`,
          tone: 'default' as const,
          statusPhrase: overview.waitingApproval > 0 ? 'Yönetici değerlendirmesinde' : 'Bekleyen onay yok',
        },
        {
          label: 'Düzeltme gereken',
          value: overview.revisionRequested,
          href: `${paths.jobs}?status=REVISION_REQUESTED`,
          tone: overview.revisionRequested > 0 ? ('warning' as const) : ('default' as const),
          statusPhrase: overview.revisionRequested > 0 ? 'Düzeltme bekleyen kayıtlar' : 'Düzeltme bekleyen iş yok',
        },
      ];

  const approvalQueue = overview.scope === 'management' ? overview.approvalQueueSummary : null;
  const oldestWaiting = approvalQueue ? formatWaitingDuration(approvalQueue.oldestWaitingMinutes) : null;

  return (
    <main className="workspace overview-workspace">
      <PageHeader
        eyebrow={isStaff ? 'Kişisel çalışma alanı' : 'Operasyon görünümü'}
        fallbackTitle="Genel Bakış"
        description={`${user.name} · ${formatOverviewDate(overview.range.from, timeZone)} – ${formatOverviewDate(overview.range.to, timeZone)}`}
      />

      <h2 id="overview-kpis-title" className="sr-only">Dönem özeti</h2>
      <div className="overview-kpis" role="region" aria-labelledby="overview-kpis-title">
        {kpis.map((kpi) => (
          <MetricStatistic
            key={kpi.label}
            title={kpi.label}
            value={kpi.value}
            linkTo={kpi.href}
            tone={kpi.tone}
            statusPhrase={kpi.statusPhrase}
          />
        ))}
      </div>

      <div className="overview-main-grid">
        <div className="overview-main-column">
        {approvalQueue && (
          <section className="overview-section" aria-labelledby="approval-queue-title">
            <h2 id="approval-queue-title">Onay kuyruğu</h2>
            <OperationalCard
              tone={approvalQueue.pendingCount > 0 ? 'attention' : 'default'}
              statusLabel="Yönetici kontrolü bekliyor"
            >
              {approvalQueue.pendingCount > 0 ? (
                <>
                  <p className="overview-queue-count">
                    <strong>{approvalQueue.pendingCount}</strong> iş onay bekliyor
                  </p>
                  <p className="overview-queue-wait">
                    {oldestWaiting
                      ? `En eskisi ${oldestWaiting} bekliyor.`
                      : 'En eski bekleme süresi henüz ölçülmedi.'}
                  </p>
                </>
              ) : (
                <p className="overview-queue-count">Kontrol bekleyen iş yok.</p>
              )}
              <Link className="overview-queue-link" to={`${paths.jobs}?status=WAITING_APPROVAL`}>
                Onay kuyruğuna git
              </Link>
            </OperationalCard>
          </section>
        )}
        {!isStaff && <OpenSubmissionLateSection />}
        {!isStaff && <OpenChangeRequestsSection />}
        {!isStaff && <OpenAssignmentOffersSection />}
        {!isStaff && <UnacceptedPastStartSection user={user} />}
        {!isStaff && (
          <section className="overview-section" aria-labelledby="completion-trend-title">
            <h2 id="completion-trend-title">Tamamlanma eğilimi</h2>
            <OperationalCard title="Tamamlanan ve iptal edilen işler">
              <p>{overview.completedInPeriod} iş tamamlandı; {overview.cancelledInPeriod} iş iptal edildi.</p>
              <TrendBars points={overview.completionTrend} className="overview-trend" dateLabels />
            </OperationalCard>
          </section>
        )}

        {overview.upcomingWork && (
          <section className="overview-section" aria-labelledby="upcoming-work-title">
            <h2 id="upcoming-work-title">Yaklaşan işler</h2>
            {overview.upcomingWork.items.length === 0
              ? <EmptyState title="Yaklaşan iş bulunmuyor" />
              : <OverviewList>
                  {overview.upcomingWork.items.map((item) => (
                    <li key={`${item.source}:${item.id}`} className="overview-row">
                      <Link className="overview-row-title" to={item.path}>{item.title}</Link>
                      <p className="overview-row-meta">
                        {formatOverviewDateTime(item.startsAt, timeZone)} · {item.assignedUserName}
                      </p>
                    </li>
                  ))}
                </OverviewList>
            }
          </section>
        )}

        <section className="overview-section" aria-labelledby="recent-work-title">
          <h2 id="recent-work-title">Son tamamlanan işler</h2>
          {overview.recentCompletedWork.length === 0
            ? <EmptyState title="Bu dönemde tamamlanan iş bulunmuyor" />
            : <OverviewList>
                {overview.recentCompletedWork.map((item) => (
                  <li key={item.id} className="overview-row">
                    <Link className="overview-row-title" to={paths.job(item.id)}>{item.title}</Link>
                    <p className="overview-row-meta">
                      {item.customerName ?? 'Müşteri bağlantısı yok'} · {item.assigneeName ?? 'Atanmamış'}
                    </p>
                  </li>
                ))}
              </OverviewList>
          }
        </section>

        </div>
        <div className="overview-main-column">
        <section className="overview-section" aria-labelledby="recent-notes-title">
          <h2 id="recent-notes-title">Son notlar</h2>
          {overview.recentNotes.length === 0
            ? <EmptyState title="Yakın tarihli not bulunmuyor" />
            : <OverviewList>
                {overview.recentNotes.map((note) => (
                  <li key={note.id} className="overview-row">
                    <Link className="overview-row-title" to={paths.job(note.jobCardId)}>{note.jobTitle}</Link>
                    <p className="overview-row-meta">
                      {note.authorName} · {formatOverviewDateTime(note.createdAt, timeZone)}
                    </p>
                  </li>
                ))}
              </OverviewList>
          }
        </section>

        {!isStaff && overview.workTypeDistribution && overview.workTypeDistribution.length > 0 && (
          <section className="overview-section" aria-labelledby="work-type-dist-title">
            <h2 id="work-type-dist-title">İş dağılımı</h2>
            <OperationalCard title="Türlere göre iş dağılımı">
              <ul className="overview-distribution-list">
                {overview.workTypeDistribution.map((item) => (
                  <li key={item.type}>
                    <div className="overview-distribution-label">
                      <strong>{jobTypeLabel(item.type)}</strong>
                      <span>{item.count} iş · %{Math.round(item.count / distributionTotal * 100)}</span>
                    </div>
                    <div className="overview-distribution-track" aria-hidden="true">
                      <span style={{ width: (Math.round(item.count / distributionTotal * 100)).toString() + '%' }} />
                    </div>
                  </li>
                ))}
              </ul>
            </OperationalCard>
          </section>
        )}

        {unreadMessages > 0 && (
          <section className="overview-section" aria-labelledby="message-summary-title">
            <h2 id="message-summary-title">Okunmamış mesaj</h2>
            <OperationalCard tone="attention">
              <Link to={paths.messages}>{unreadMessages} okunmamış mesaj</Link>
            </OperationalCard>
          </section>
        )}
        </div>
      </div>
    </main>
  );
}
