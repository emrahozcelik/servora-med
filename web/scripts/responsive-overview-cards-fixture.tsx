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
    </ServoraAntProvider>,
  );
}
