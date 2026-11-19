import { createRoot } from 'react-dom/client';

import { OperationalCard } from '../src/ui/antd/OperationalCard';
import { MetricStatistic } from '../src/ui/antd/MetricStatistic';
import { ServoraAntProvider } from '../src/ui/antd';

const root = document.getElementById('responsive-overview-cards-root');
if (root) {
  createRoot(root).render(
    <ServoraAntProvider>
      {/* Metric tones must keep a radius-following full outline (VIS-02). */}
      <div className="overview-kpis" data-smoke-overview-kpis>
        <MetricStatistic title="Aktif işler" value={11} tone="default" />
        <MetricStatistic title="Geciken" value={2} tone="overdue" />
        <MetricStatistic title="Düzeltme gereken" value={1} tone="warning" />
        <MetricStatistic title="Tamamlanan" value={4} tone="success" />
      </div>
      {/* F-17: one card per section; records are plain divided rows without a
          per-item frame or a chip repeating the section name. */}
      <OperationalCard>
        <ul className="overview-row-list">
          <li className="overview-row">
            <a className="overview-row-title" href="#">UXA-20260809 Dental Klinik ürün teslimi</a>
            <p className="overview-row-meta">Mavi Klinik · Elif Saha</p>
          </li>
          <li className="overview-row">
            <a className="overview-row-title" href="#">M5 gorsel kabul — konusmasiz tamamlanmis is</a>
            <p className="overview-row-meta">Müşteri bağlantısı yok · Demo Staff</p>
          </li>
          <li className="overview-row">
            <a className="overview-row-title" href="#">Ortodonti braket kontrolü</a>
            <p className="overview-row-meta">Deniz Ağız Sağlığı · Mert Saha</p>
          </li>
        </ul>
      </OperationalCard>
      {/* Focus/disabled probes (VIS-03/VIS-06): keyboard-focus token contract
          runs inside the Ant provider scope so the real runtime cascade
          (Ant injected link style vs authored rules) is exercised. */}
      <div data-smoke-focus-probes>
        <nav aria-label="Odak deneme gezgini">
          <a href="#odak-gezgin" data-smoke-focus-nav-link>Gezgin bağlantısı</a>
        </nav>
        <p>
          <a href="#odak-icerik" data-smoke-focus-content-link>İçerik bağlantısı</a>
        </p>
        <button type="button" className="secondary-button" data-smoke-focus-control>
          Normal denetim
        </button>
        <button type="button" className="secondary-button" disabled data-smoke-disabled-control>
          Pasif denetim
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled
          aria-busy="true"
          data-smoke-loading-control
        >
          Yükleniyor…
        </button>
      </div>
    </ServoraAntProvider>,
  );
}
