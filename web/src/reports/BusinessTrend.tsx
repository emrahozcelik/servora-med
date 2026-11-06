import { useEffect, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { reportSectionHref } from './report-navigation';
import type { BusinessTrendCounts, BusinessTrendReportResponse, RequestedReportRange } from './report-types';
import { getBusinessTrendReport } from './reports-api';
import { ReportErrorState } from './report-shell';
import './reports-overview.css';

const series: Array<{ key: keyof BusinessTrendCounts; label: string; hint: string }> = [
  { key: 'visits', label: 'Ziyaret ve görüşmeler', hint: 'Yönetici onaylı faaliyet' },
  { key: 'followUps', label: 'Takip ziyaretleri', hint: 'Ziyaretlerin içindeki bağlı takipler' },
  { key: 'sales', label: 'Onaylı satışlar', hint: 'Gerçekleşen satış anlaşması' },
];
const integer = new Intl.NumberFormat('tr-TR');
const dateFormat = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'short', timeZone: 'UTC' });
function dateLabel(date: string) { return dateFormat.format(new Date(`${date}T00:00:00Z`)); }
function deltaLabel(value: number) {
  return value === 0 ? 'Değişim yok' : `${integer.format(Math.abs(value))} ${value > 0 ? 'artış' : 'azalış'}`;
}

export function BusinessTrendView({ report }: { report: BusinessTrendReportResponse }) {
  const id = useId();
  const { points } = report;
  const [selected, setSelected] = useState(points.length - 1);
  const index = Math.max(0, Math.min(selected, points.length - 1));
  const point = points[index];
  // Only drawing geometry is derived here; report facts and totals are server-owned.
  const maximum = Math.max(4, ...points.flatMap((p) => series.map((s) => p[s.key])));
  const top = Math.ceil(maximum / 4) * 4;
  const x = (i: number) => points.length === 1 ? 500 : 12 + i / (points.length - 1) * 976;
  const y = (value: number) => 244 - value / top * 228;
  const selectedLabel = point ? `${dateLabel(point.date)}: ${series.map((s) => `${s.label} ${point[s.key]}`).join(', ')}` : '';
  // A plot without layout width (hidden or synthetic click) yields no meaningful position.
  const selectAt = (clientX: number, rect: { left: number; width: number }) => {
    if (!Number.isFinite(clientX) || rect.width <= 0) return;
    const ratio = ((clientX - rect.left) / rect.width * 1000 - 12) / 976;
    setSelected(Math.round(Math.max(0, Math.min(1, ratio)) * Math.max(0, points.length - 1)));
  };
  const comparison = report.comparison;
  const observedLabel = report.observedThrough ? `${dateLabel(report.range.from)} – ${dateLabel(report.observedThrough)}` : 'Henüz başlamayan dönem';

  return <section className="business-trend" aria-labelledby={`${id}-title`}>
    <div className="business-trend-heading">
      <div><h2 id={`${id}-title`}>Ziyaretten satışa</h2><p>Ekibin müşteriyle teması, takibi ve ticari sonuçları.</p></div>
      <span className="business-trend-period">{observedLabel}</span>
    </div>
    <dl className="business-trend-totals">
      {series.map((s) => <div key={s.key} className={`business-series business-series--${s.key}`}>
        <dt><span className="business-series-stroke" aria-hidden="true" />{s.label}</dt>
        <dd><strong>{integer.format(report.totals[s.key])}</strong>
          {comparison && <span className="business-trend-change">{deltaLabel(report.totals[s.key] - comparison.totals[s.key])}</span>}
        </dd>
        <dd className="business-trend-prior">{comparison ? `Önceki dönem: ${integer.format(comparison.totals[s.key])}` : 'Karşılaştırma henüz yok'}<span>{s.hint}</span></dd>
      </div>)}
    </dl>
    {point ? <>
      <figure className="business-trend-figure" aria-label="Günlük ziyaret, takip ziyareti ve onaylı satış sayıları">
        <div className="business-trend-axis" aria-hidden="true">{[top, top * .75, top * .5, top * .25, 0].map((tick) => <span key={tick}>{integer.format(tick)}</span>)}</div>
        <svg className="business-trend-plot" viewBox="0 0 1000 260" preserveAspectRatio="none" aria-hidden="true"
          onPointerMove={(event) => {
            if (event.pointerType === 'touch') return;
            selectAt(event.clientX, event.currentTarget.getBoundingClientRect());
          }}
          onClick={(event) => selectAt(event.clientX, event.currentTarget.getBoundingClientRect())}>
          {[0, 1, 2, 3, 4].map((tick) => <line key={tick} className="business-trend-grid" x1="0" x2="1000" y1={y(tick * top / 4)} y2={y(tick * top / 4)} vectorEffect="non-scaling-stroke" />)}
          {series.map((s) => <g key={s.key} className={`business-series--${s.key}`}>
            <polyline className="business-trend-line" points={points.map((p, i) => `${x(i)},${y(p[s.key])}`).join(' ')} vectorEffect="non-scaling-stroke" />
            {points.length === 1 && <circle cx={x(0)} cy={y(point[s.key])} r="4" fill="currentColor" />}
          </g>)}
          <line className="business-trend-cursor" x1={x(index)} x2={x(index)} y1="10" y2="250" vectorEffect="non-scaling-stroke" />
        </svg>
        <div className="business-trend-dates" aria-hidden="true"><span>{dateLabel(points[0].date)}</span>{points.length > 2 && <span>{dateLabel(points[Math.floor((points.length - 1) / 2)].date)}</span>}{points.length > 1 && <span>{dateLabel(points[points.length - 1].date)}</span>}</div>
        <figcaption className="business-trend-readout"><strong>{dateLabel(point.date)}</strong>{series.map((s) => <span key={s.key} className={`business-series--${s.key}`}><span className="business-series-stroke" aria-hidden="true" />{s.label}: <b>{point[s.key]}</b></span>)}</figcaption>
        <label className="business-trend-inspector" htmlFor={`${id}-date`}><span>Günü incele</span>
          <input id={`${id}-date`} type="range" min={0} max={Math.max(0, points.length - 1)} value={index} disabled={points.length === 1}
            aria-valuetext={selectedLabel} onChange={(e) => setSelected(Number(e.target.value))} />
        </label>
      </figure>
      {report.totals.visits === 0 && report.totals.sales === 0 && <p className="business-trend-empty">Bu dönemde onaylı ziyaret veya satış kaydı bulunmuyor.</p>}
    </> : <p className="business-trend-empty">Seçilen dönem henüz başlamadı. Gelecek günler grafiğe eklenmez.</p>}
    <p className="business-trend-footnote">Günlük ziyaret, takip ve satış sayıları.
      {comparison && <> Karşılaştırma: {dateLabel(comparison.range.from)} – {dateLabel(comparison.range.to)}.</>}
      {report.partialDay && ' Bugün henüz tamamlanmadı; önceki dönemin son günü de aynı yerel saate kadar sayılır.'}
      {' Takip ziyaretleri, toplam ziyaretlerin içindedir.'}
    </p>
    <details className="business-trend-data"><summary><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>Günlük veriler ve hesaplama bilgisi</summary>
      <p>Yalnız yönetici onaylı kayıtlar gösterilir. Ziyaretler görüşmenin gerçekleştiği, satışlar anlaşmanın gerçekleştiği tarihte sayılır. Takip ziyareti, önceki bir işe açıkça bağlı ziyaret veya görüşmedir. Ürün teslimleri satış sayısına dahil değildir.</p>
      {points.length > 0 && <div className="business-trend-table-scroll" tabIndex={0} role="region" aria-label="Günlük eğilim verileri"><table>
        <caption>Günlük ziyaret, takip ve satış adetleri</caption><thead><tr><th scope="col">Tarih</th>{series.map((s) => <th scope="col" key={s.key}>{s.label}</th>)}</tr></thead>
        <tbody>{points.map((p) => <tr key={p.date}><th scope="row">{p.date}</th>{series.map((s) => <td key={s.key}>{p[s.key]}</td>)}</tr>)}</tbody>
      </table></div>}
    </details>
    <section className="business-relationships" aria-labelledby={`${id}-relationships`}>
      <div><h3 id={`${id}-relationships`}>Ziyaretlerin devamında ne oldu?</h3><p>Bu dönemde yapılan {integer.format(report.totals.visits)} ziyaret ve görüşmenin kayıtlı bağlantıları.</p></div>
      <dl>
        <div><dt>Tekrar ziyaret edilen</dt><dd>{integer.format(report.relationships.visitsWithFollowUp)}<span>En az bir onaylı takip ziyareti olan</span></dd></div>
        <div><dt>Satışa bağlanan</dt><dd>{integer.format(report.relationships.visitsWithSale)}<span>Doğrudan onaylı satış kaydı olan</span></dd></div>
        <div><dt>Takipten satışa bağlanan</dt><dd>{integer.format(report.relationships.followUpsWithSale)}<span>{integer.format(report.totals.followUps)} takip ziyaretinin içinde</span></dd></div>
      </dl>
      <p className="business-trend-footnote">Dönem sonrasındaki bağlantılar da {new Intl.DateTimeFormat('tr-TR', { dateStyle: 'medium', timeStyle: 'short', timeZone: report.range.timezone }).format(new Date(report.asOf))} itibarıyla dahildir. Aynı ziyaret hem takip hem satış bağlantısında yer alabilir; takipten satış, satışa bağlananların alt kümesidir.</p>
      <Link to={reportSectionHref('salesFollowUp', report.range)} className="business-trend-report-link">Satış ve takip raporunu aç <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M4 12h16m-6-6 6 6-6 6" /></svg></Link>
    </section>
  </section>;
}

export function BusinessTrend({ range }: { range: RequestedReportRange }) {
  const [report, setReport] = useState<BusinessTrendReportResponse | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const from = range?.from;
  const to = range?.to;
  useEffect(() => {
    let current = true;
    setReport(null);
    setError('');
    getBusinessTrendReport(from && to ? { from, to } : null).then((next) => {
      if (current) setReport(next);
    }).catch((reason: unknown) => {
      if (current) setError(reason instanceof Error ? reason.message : 'Eğilim verileri yüklenemedi.');
    });
    return () => { current = false; };
  }, [from, to, attempt]);
  if (error) return <ReportErrorState title="Ziyaret ve satış eğilimi yüklenemedi" message={error} onRetry={() => setAttempt((n) => n + 1)} />;
  if (!report) return <section className="business-trend business-trend-loading" aria-busy="true"><h2>Ziyaretten satışa</h2><p role="status">Ziyaret, takip ve satış verileri yükleniyor…</p></section>;
  return <BusinessTrendView key={`${report.range.from}:${report.range.to}`} report={report} />;
}
