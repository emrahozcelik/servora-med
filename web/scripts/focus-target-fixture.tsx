import { useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';

import '../src/styles.css';
import { ResultState, ServoraAntProvider, ServoraSelect } from '../src/ui/antd';
import { ServoraListPagination } from '../src/ui/antd/ServoraPagination';
import { SettingsTabs } from '../src/ui/antd/SettingsTabs';

// Synthetic, deterministic fixture for focus-ring and touch-target geometry.
function Pager() {
  const [offset, setOffset] = useState(0);
  return <ServoraListPagination total={60} offset={offset} pageSize={20} label="Müşteri sayfaları"
    itemName="müşteri" onOffsetChange={setOffset} />;
}

const root = document.getElementById('root');
const resultCase = new URLSearchParams(location.search).get('case');
if (root && (resultCase === '403' || resultCase === '404')) {
  flushSync(() => createRoot(root).render(
    <ServoraAntProvider>
      <main className="workspace">
        <ResultState
          status={resultCase}
          title={resultCase === '403' ? 'Erişim yetkiniz yok' : 'Sayfa bulunamadı'}
          headingLevel={1}
          description={resultCase === '403'
            ? 'Bu alana erişim yetkiniz bulunmuyor. Yetkili olduğunuz alanlara dönebilirsiniz.'
            : 'Bağlantı değişmiş veya sayfa kaldırılmış olabilir.'}
          action={<a className="secondary-button" href="/jobs">İşlere dön</a>}
        />
      </main>
    </ServoraAntProvider>,
  ));
  document.documentElement.dataset.fixtureReady = 'true';
} else if (root) {
  flushSync(() => createRoot(root).render(
    <MemoryRouter initialEntries={['/settings/profile']}>
      <ServoraAntProvider>
        <main style={{ padding: 16, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 24 }}>
          <div className="field-group">
            <label htmlFor="fixture-select">Müşteri</label>
            <ServoraSelect
              id="fixture-select"
              data-fixture-select
              showSearch
              style={{ width: '100%' }}
              placeholder="Müşteri ara"
              options={[
                { value: 'c1', label: 'Demo Diş Kliniği' },
                { value: 'c2', label: 'Sentetik Ağız Sağlığı Merkezi' },
              ]}
            />
          </div>
          <div className="field-group">
            <label htmlFor="fixture-select-error">Hatalı müşteri alanı</label>
            <ServoraSelect id="fixture-select-error" status="error" aria-invalid showSearch
              style={{ width: '100%' }} placeholder="Müşteri ara"
              options={[{ value: 'c1', label: 'Demo Diş Kliniği' }]} />
          </div>
          <div className="field-group">
            <label htmlFor="fixture-input">Not</label>
            <input id="fixture-input" className="form-control" />
          </div>
          <Pager />
          <SettingsTabs ariaLabel="Ayarlar bölümleri" activeKey="profile" items={[
            { key: 'profile', label: 'Profil', to: '/settings/profile' },
            { key: 'security', label: 'Güvenlik', to: '/settings/security' },
            { key: 'notifications', label: 'Bildirimler', to: '/settings/notifications' },
            { key: 'app', label: 'Uygulama', to: '/settings/app' },
          ]} />
        </main>
      </ServoraAntProvider>
    </MemoryRouter>,
  ));
  document.documentElement.dataset.fixtureReady = 'true';
}
