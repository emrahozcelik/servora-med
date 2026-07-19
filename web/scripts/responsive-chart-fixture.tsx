import { createRoot } from 'react-dom/client';

import {
  CompletedTrendCalendar,
  IndependentMeterBars,
  SegmentedDistributionBar,
  TrendBars,
} from '../src/reports/report-charts';

// ---------------------------------------------------------------------------
// Stress-test data
// ---------------------------------------------------------------------------

/** 366-point trend (leap year) with alternating zero/non-zero counts. */
function leapYearTrend() {
  const points: { date: string; count: number }[] = [];
  const start = new Date('2024-01-01T00:00:00Z');
  for (let i = 0; i < 366; i += 1) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    points.push({ date: `${yyyy}-${mm}-${dd}`, count: i % 3 === 0 ? 0 : (i % 7) + 1 });
  }
  return points;
}

/** Long meter labels — designed to stress label+value layout. */
const longLabelMeters = [
  {
    key: 'waiting',
    label: 'Yönetici onayı bekleyen işler (toplam)',
    value: 47,
    tone: 'warning' as const,
  },
  {
    key: 'overdue',
    label: 'Termin tarihi geçmiş açık işler',
    value: 12,
    tone: 'danger' as const,
  },
  {
    key: 'revision',
    label: 'Personel düzeltme talep edilenler',
    value: 8,
    tone: 'primary' as const,
  },
  {
    key: 'completed',
    label: 'Bu dönem tamamlanan işler',
    value: 134,
    tone: 'muted' as const,
  },
];

/** Long segmented legend labels with varied value distribution. */
const longLegendSegments = [
  { key: 'under2', label: '2 saatten kısa (hızlı onay)', value: 23 },
  { key: 'between2And8', label: '2 ile 8 saat arası (normal süre)', value: 41 },
  { key: 'between8And24', label: '8 ile 24 saat arası (gecikme riski)', value: 18 },
  { key: 'over24', label: '24 saatten uzun (kritik gecikme)', value: 7 },
];

const trend366 = leapYearTrend();

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

const root = document.getElementById('responsive-chart-fixture-root');
if (root) {
  createRoot(root).render(
    <>
      {/* ---- TrendBars: 366 points (dense density) ---- */}
      <section
        className="report-workspace"
        aria-label="366 noktalı trend fixture"
        data-smoke-chart-trend
      >
        <h2>Günlük tamamlanan iş trendi (366 gün)</h2>
        <TrendBars points={trend366} />
      </section>

      {/* ---- CompletedTrendCalendar: 366 points ---- */}
      <section
        className="report-workspace"
        aria-label="366 günlük takvim fixture"
        data-smoke-chart-calendar
      >
        <h2>Takvim görünümü (366 gün)</h2>
        <CompletedTrendCalendar points={trend366} />
      </section>

      {/* ---- IndependentMeterBars: long labels ---- */}
      <section
        className="report-workspace"
        aria-label="Uzun etiketli göstergeler fixture"
        data-smoke-chart-meters
      >
        <h2>Gösterge çubuğu — uzun etiket stres testi</h2>
        <IndependentMeterBars items={longLabelMeters} />
      </section>

      {/* ---- SegmentedDistributionBar: long legend labels ---- */}
      <section
        className="report-workspace"
        aria-label="Uzun legend etiketli segment fixture"
        data-smoke-chart-segmented
      >
        <h2>Onay SLA dağılımı — uzun açıklama stres testi</h2>
        <SegmentedDistributionBar segments={longLegendSegments} />
      </section>
    </>,
  );
}
