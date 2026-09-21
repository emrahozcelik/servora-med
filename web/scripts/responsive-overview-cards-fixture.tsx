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
        <MetricStatistic title="Geciken" value={2} tone="attention" />
        <MetricStatistic title="Düzeltme gereken" value={1} tone="warning" />
        <MetricStatistic title="Tamamlanan" value={4} tone="success" />
      </div>
      <OperationalCard
        tone="success"
        title={<a href="#">UXA-20260809 Dental Klinik ürün teslimi</a>}
      >
        <span>UXA-20260809 Dental Klinik · Kaan Gürsoy</span>
      </OperationalCard>
      <OperationalCard
        tone="default"
        title={<a href="#">M5 gorsel kabul — konusmasiz tamamlanmis is</a>}
      >
        <span>Müşteri bağlantısı yok · Demo Staff</span>
      </OperationalCard>
      <OperationalCard tone="default" title="İş dağılımı">
        <span>3 iş</span>
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
