import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { changeRequestReasonLabels } from '../jobs/job-labels';
import { formatDurationSeconds } from '../ui/duration';
import type {
  LatenessDelayType,
  LatenessGroupCounts,
  LatenessOutcome,
  LatenessTypeBreakdown,
  ResolvedReportRange,
  StaffLatenessIncidentItem,
  StaffLatenessIncidentListResponse,
  StaffLatenessSummary,
} from './report-types';

const PAGE_SIZE = 20;

const delayTypeLabels: Record<LatenessDelayType, string> = {
  LATE_START: 'Geç başlama',
  LATE_SUBMISSION: 'Geç onaya gönderme',
};

const outcomeLabels: Record<LatenessOutcome, string> = {
  RECOVERED: 'Kapandı',
  EXTENDED: 'Tarih uzatıldı',
  OPEN: 'Devam ediyor',
};

const SECTION_TITLE = 'Gecikme kayıtları';
const SECTION_HINT = 'Seçilen dönemde süresi aşılan başlama ve onaya gönderme kayıtları. '
  + 'Tek başına başarı veya zamanında bitirme oranı değildir.';
const RESPONSIBILITY_TITLE = 'Personel sorumluluğundaki gecikmeler';
const RESPONSIBILITY_EMPTY = 'Bu dönemde personel sorumluluğunda gecikme kaydı yok.';
const OPERATIONAL_TITLE = 'Yönetimce sonuçlandırılan değişiklik talebiyle ilişkili gecikmeler';
const OPERATIONAL_HINT = 'Gecikme sürerken personelin kendi açtığı ve yönetimin '
  + 'sonuçlandırdığı bir değişiklik talebiyle aynı zamana denk gelen kayıtlar. '
  + 'Bu ilişki otomatik belirlenir; talebin gecikmenin nedeni olduğu kesin değildir. '
  + 'Bu kayıtlar personel sorumluluğundaki sayılara eklenmez.';
const EMPTY_PERIOD = 'Bu dönemde gecikme kaydı yok.';

const integer = new Intl.NumberFormat('tr-TR');

function formatInstant(value: string, timeZone: string) {
  return new Intl.DateTimeFormat('tr-TR', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  }).format(new Date(value));
}

function formatCalendarDate(value: string) {
  return new Intl.DateTimeFormat('tr-TR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${value}T00:00:00Z`));
}

function secondsLabel(seconds: number | null) {
  return seconds === null ? '—' : formatDurationSeconds(seconds);
}

function GroupCounts({ counts }: { counts: LatenessGroupCounts }) {
  return (
    <dl className="staff-lateness-group-counts">
      <div><dt>Geciken iş</dt><dd>{integer.format(counts.delayedJobCount)}</dd></div>
      <div><dt>Gecikme kaydı</dt><dd>{integer.format(counts.incidentCount)}</dd></div>
    </dl>
  );
}

function TypeBreakdown({
  breakdown,
  headingId,
}: {
  breakdown: LatenessTypeBreakdown;
  headingId: string;
}) {
  const { recovered, extended, open } = breakdown;
  return (
    <section className="staff-lateness-type" aria-labelledby={headingId}>
      <h5 id={headingId}>{delayTypeLabels[breakdown.delayType]}</h5>
      <dl className="staff-lateness-type-metrics">
        <div className="staff-lateness-outcome" data-outcome="recovered">
          <dt>Kapandı</dt>
          <dd className="staff-lateness-count-value">{integer.format(recovered.count)}</dd>
          {recovered.count > 0 && <>
            <dt>Ortanca süre</dt>
            <dd>{secondsLabel(recovered.medianSeconds)}</dd>
            <dt>En uzun süre</dt>
            <dd>{secondsLabel(recovered.maxSeconds)}</dd>
          </>}
        </div>
        <div className="staff-lateness-outcome" data-outcome="extended">
          <dt>Tarih uzatıldı</dt>
          <dd className="staff-lateness-count-value">{integer.format(extended.count)}</dd>
          {extended.count > 0 && <>
            <dt>Ortanca süre</dt>
            <dd>{secondsLabel(extended.medianSeconds)}</dd>
            <dt>En uzun süre</dt>
            <dd>{secondsLabel(extended.maxSeconds)}</dd>
          </>}
        </div>
        <div className="staff-lateness-outcome" data-outcome="open">
          <dt>Devam ediyor</dt>
          <dd className="staff-lateness-count-value">{integer.format(open.count)}</dd>
          {open.count > 0 && <>
            <dt>Devam eden en uzun süre</dt>
            <dd>{secondsLabel(open.maxElapsedSeconds)}</dd>
          </>}
        </div>
      </dl>
    </section>
  );
}

function IncidentRow({
  item,
  timezone,
}: {
  item: StaffLatenessIncidentItem;
  timezone: string;
}) {
  return (
    <li className="staff-lateness-row">
      <div className="staff-lateness-row-heading">
        <strong>{delayTypeLabels[item.delayType]}</strong>
        <span className="status-label">{outcomeLabels[item.outcome]}</span>
      </div>
      <dl className="staff-lateness-row-facts">
        <div>
          <dt>Son tarih</dt>
          <dd><time dateTime={item.deadlineAt}>{formatInstant(item.deadlineAt, timezone)}</time></dd>
        </div>
        <div>
          <dt>Aşım zamanı</dt>
          <dd><time dateTime={item.breachedAt}>{formatInstant(item.breachedAt, timezone)}</time></dd>
        </div>
        <div>
          <dt>Süre</dt>
          <dd>{formatDurationSeconds(item.durationSeconds)}</dd>
        </div>
        <div>
          <dt>İş</dt>
          <dd>
            {item.job
              ? <Link to={item.job.jobPath}>{item.job.title}</Link>
              : 'Devredilmiş iş'}
          </dd>
        </div>
      </dl>
      {item.operationalReason && <p className="staff-lateness-row-reason">
        İlişkili değişiklik talebi: {changeRequestReasonLabels[item.operationalReason.reasonCode]}
      </p>}
      {(item.episodeNo > 1 || item.scheduleRevisionNo > 1) && <p className="staff-lateness-row-meta">
        {item.episodeNo > 1 && `Gönderim turu ${integer.format(item.episodeNo)}`}
        {item.episodeNo > 1 && item.scheduleRevisionNo > 1 && ' · '}
        {item.scheduleRevisionNo > 1 && `Plan sürümü ${integer.format(item.scheduleRevisionNo)}`}
      </p>}
    </li>
  );
}

/**
 * OVR-7 "Gecikme kayıtları" section of the Staff operational report.
 *
 * The server owns every group and classification; this section renders the
 * summary it receives and only fetches the incident list through the callback
 * its parent supplies, so the management and Staff self paths never diverge
 * inside the component. Reset on Staff member or range change is handled by the
 * parent's `key`.
 */
export function StaffLatenessSection({
  lateness,
  timezone,
  range,
  loadIncidents,
  onRefresh,
}: {
  lateness: StaffLatenessSummary;
  timezone: string;
  range: ResolvedReportRange;
  loadIncidents?: (page: { limit: number; offset: number }) => Promise<StaffLatenessIncidentListResponse>;
  onRefresh?: () => void;
}) {
  const id = useId();
  const listId = `${id}-list`;
  const [expanded, setExpanded] = useState(false);
  const [items, setItems] = useState<StaffLatenessIncidentItem[]>([]);
  const [total, setTotal] = useState(0);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState('');
  const requestSequence = useRef(0);
  const generatedAt = useRef(lateness.generatedAt);
  const lastRequest = useRef<{ offset: number; limit: number; mode: 'replace' | 'append' }>(
    { offset: 0, limit: PAGE_SIZE, mode: 'replace' },
  );

  const fetchPage = useCallback(async (
    offset: number,
    limit: number,
    mode: 'replace' | 'append',
  ) => {
    if (!loadIncidents) return;
    lastRequest.current = { offset, limit, mode };
    const requestId = ++requestSequence.current;
    setListLoading(true);
    setListError('');
    try {
      const page = await loadIncidents({ limit, offset });
      if (requestId !== requestSequence.current) return;
      setTotal(page.total);
      setItems((current) => (mode === 'replace' ? page.items : current.concat(page.items)));
    } catch (reason) {
      if (requestId !== requestSequence.current) return;
      setListError(reason instanceof Error ? reason.message : 'Gecikme kayıtları yüklenemedi.');
    } finally {
      if (requestId === requestSequence.current) setListLoading(false);
    }
  }, [loadIncidents]);

  // A refreshed summary (new generatedAt) invalidates the loaded rows, so an
  // OVR-3 incident written after load appears after "Yenile": an open list
  // reloads its newest page; a closed list forgets its rows and fetches again
  // when it is opened.
  useEffect(() => {
    if (generatedAt.current === lateness.generatedAt) return;
    generatedAt.current = lateness.generatedAt;
    if (expanded && loadIncidents) {
      void fetchPage(0, PAGE_SIZE, 'replace');
      return;
    }
    requestSequence.current += 1;
    setItems([]);
    setTotal(0);
    setListError('');
    setListLoading(false);
  }, [lateness.generatedAt, expanded, loadIncidents, fetchPage]);

  const responsibility = lateness.staffResponsibility;
  const operational = lateness.operational;
  const empty = responsibility.incidentCount === 0 && operational.incidentCount === 0;
  const trackingNote = range.from < lateness.trackingStartedOn
    ? `Gecikme kayıtları ${formatCalendarDate(lateness.trackingStartedOn)}'dan önce eksik olabilir.`
    : null;
  const hasList = Boolean(loadIncidents) && !empty;
  const hasMore = items.length > 0 && items.length < total;

  function toggleList() {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (items.length === 0 && !listLoading) void fetchPage(0, PAGE_SIZE, 'replace');
  }

  return (
    <section
      className="staff-analysis-group staff-analysis-lateness"
      aria-labelledby={`${id}-title`}
    >
      <div className="staff-lateness-heading">
        <h3 id={`${id}-title`}>{SECTION_TITLE}</h3>
        <button
          type="button"
          className="secondary-button"
          disabled={!onRefresh}
          onClick={onRefresh}
        >
          Yenile
        </button>
      </div>
      <p className="report-section-hint">{SECTION_HINT}</p>
      <p className="staff-lateness-freshness">
        Durumlar {formatInstant(lateness.generatedAt, timezone)} itibarıyladır.
      </p>
      {trackingNote && <p className="report-section-hint">{trackingNote}</p>}

      {empty
        ? <p className="report-empty-copy">{EMPTY_PERIOD}</p>
        : <>
          <section className="staff-detail-section staff-lateness-group" aria-labelledby={`${id}-responsibility`}>
            <h4 id={`${id}-responsibility`}>{RESPONSIBILITY_TITLE}</h4>
            {responsibility.incidentCount === 0
              ? <p className="report-empty-copy">{RESPONSIBILITY_EMPTY}</p>
              : <>
                <GroupCounts counts={responsibility} />
                {responsibility.byType.map((breakdown) => <TypeBreakdown
                  key={breakdown.delayType}
                  breakdown={breakdown}
                  headingId={`${id}-${breakdown.delayType.toLocaleLowerCase('en-US')}`}
                />)}
              </>}
          </section>

          {operational.incidentCount > 0 && <section
            className="staff-detail-section staff-lateness-group staff-lateness-operational"
            aria-labelledby={`${id}-operational`}
          >
            <h4 id={`${id}-operational`}>{OPERATIONAL_TITLE}</h4>
            <p className="report-section-hint">{OPERATIONAL_HINT}</p>
            <GroupCounts counts={operational} />
            <dl className="staff-lateness-reasons">
              {operational.byReason.map((entry) => <div key={entry.reasonCode}>
                <dt>{changeRequestReasonLabels[entry.reasonCode]}</dt>
                <dd>{integer.format(entry.incidentCount)}</dd>
              </div>)}
            </dl>
          </section>}
        </>}

      {hasList && <div className="staff-lateness-list">
        <button
          type="button"
          className="secondary-button"
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={toggleList}
        >
          {expanded ? 'Kayıtları gizle' : 'Kayıtları göster'}
        </button>
        <div id={listId} aria-busy={listLoading || undefined}>
          {expanded && <>
            {/* Loaded rows stay visible while a further page loads. */}
            {items.length > 0 && <ol className="staff-lateness-records">
              {items.map((item) => <IncidentRow key={item.incidentId} item={item} timezone={timezone} />)}
            </ol>}
            {listLoading && <p className="staff-lateness-list-status" role="status">
              Gecikme kayıtları yükleniyor…
            </p>}
            {!listLoading && listError && <>
              <p className="form-error" role="alert">{listError}</p>
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  const { offset, limit, mode } = lastRequest.current;
                  void fetchPage(offset, limit, mode);
                }}
              >
                Tekrar dene
              </button>
            </>}
            {!listLoading && !listError && hasMore && <div className="pagination-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => void fetchPage(items.length, PAGE_SIZE, 'append')}
              >
                Daha fazla göster
              </button>
            </div>}
          </>}
        </div>
      </div>}
    </section>
  );
}
