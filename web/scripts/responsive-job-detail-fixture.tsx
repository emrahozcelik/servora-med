import { createRoot } from 'react-dom/client';

import {
  ActivityTimeline,
  RecordDescriptions,
  ServoraAntProvider,
} from '../src/ui/antd';

const descriptionRoot = document.getElementById('responsive-descriptions-root');
if (descriptionRoot) {
  createRoot(descriptionRoot).render(
    <ServoraAntProvider>
      <RecordDescriptions
        ariaLabel="İş kayıt bilgileri"
        items={[
          { key: 'status', label: 'Durum', content: 'Uygulanıyor' },
          { key: 'customer', label: 'Müşteri', content: 'DentArt Ağız ve Diş Sağlığı' },
          {
            key: 'description',
            label: 'Açıklama',
            content: 'Xenofill Implant Set teslimi ve uygulama kayıtlarının doğrulanması',
            wide: true,
          },
        ]}
      />
    </ServoraAntProvider>,
  );
}

const timelineRoot = document.getElementById('responsive-timeline-root');
if (timelineRoot) {
  createRoot(timelineRoot).render(
    <ServoraAntProvider>
      <ActivityTimeline items={[
        {
          key: 'smoke-activity-1',
          action: 'Düzeltme için geri gönderildi',
          detail: 'Yönetici kontrolünde → Düzeltme gerekiyor',
          reason: 'Teslim miktarı ve seri numarası kaydını doğrulayın',
          actor: 'Emrah Yönetici',
          occurredAt: '2026-07-18T09:00:00.000Z',
          occurredAtLabel: '18 Tem 2026 12:00',
        },
        {
          key: 'smoke-activity-2',
          action: 'İş başlatıldı',
          detail: 'Atandı → Uygulanıyor · Konum: Yukarı Bahçelievler Mahallesi, Çok Uzun Operasyon Bölgesi, Çankaya / Ankara · Doğruluk: yaklaşık 987,6 metre · Yakalama zamanı: 18 Tem 2026 11:30',
          reason: null,
          actor: 'Ayşe Personel',
          occurredAt: '2026-07-18T08:30:00.000Z',
          occurredAtLabel: '18 Tem 2026 11:30',
        },
      ]} />
    </ServoraAntProvider>,
  );
}
