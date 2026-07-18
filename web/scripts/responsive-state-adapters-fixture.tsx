import { createRoot } from 'react-dom/client';

import {
  EmptyState,
  LoadingSkeleton,
  ResultState,
  ServoraAntProvider,
} from '../src/ui/antd';

const root = document.getElementById('responsive-state-adapters-root');
if (root) {
  createRoot(root).render(
    <ServoraAntProvider>
      <div className="responsive-state-adapters-fixture">
        <ResultState
          status="error"
          title="Operasyon raporu yüklenemedi"
          description="Sunucuya ulaşılamadı; kayıtlar değiştirilmedi ve yeniden deneme güvenlidir."
          headingLevel={2}
          action={<button type="button" className="secondary-button">Tekrar dene</button>}
        />
        <EmptyState
          title="Onaylı teslim bulunmuyor"
          description="Seçilen dönemde onaylı teslim bulunmuyor; tarih aralığını veya filtreleri değiştirin."
          headingLevel={3}
          action={<button type="button" className="secondary-button">Filtreleri temizle</button>}
        />
        <LoadingSkeleton title="Rapor yükleniyor" headingLevel={2} rows={4} />
      </div>
    </ServoraAntProvider>,
  );
}
