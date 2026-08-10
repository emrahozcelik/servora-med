import { createRoot } from 'react-dom/client';

import { OperationalCard } from '../src/ui/antd/OperationalCard';
import { ServoraAntProvider } from '../src/ui/antd';

const root = document.getElementById('responsive-overview-cards-root');
if (root) {
  createRoot(root).render(
    <ServoraAntProvider>
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
