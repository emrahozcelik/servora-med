import { createRoot } from 'react-dom/client';
import { useLayoutEffect } from 'react';

import {
  ActivityTimeline,
  RecordDescriptions,
  ServoraAntProvider,
} from '../src/ui/antd';
import { PriorityChip } from '../src/ui/PriorityChip';
import { StatusChip } from '../src/ui/StatusChip';

const descriptionItems = [
  { key: 'status', label: 'Durum', content: 'Hazırlanıyor' },
  { key: 'assignee', label: 'Sorumlu personel', content: 'Ayşe Personel' },
  { key: 'priority', label: 'Öncelik', content: 'Normal' },
  { key: 'schedule', label: 'Planlanan teslim zamanı', content: 'Belirtilmedi' },
  { key: 'due-date', label: 'Son tarih', content: 'Belirtilmedi' },
  { key: 'customer', label: 'Müşteri', content: 'DentArt Ağız ve Diş Sağlığı' },
  { key: 'contact', label: 'İlgili kişi', content: 'Belirtilmedi' },
  {
    key: 'description',
    label: 'Açıklama',
    content: 'Xenofill Implant Set teslimi ve uygulama kayıtlarının doğrulanması',
    wide: true,
  },
];

const chipItems = [
  { key: 'status', label: 'Durum', content: <StatusChip status="NEW" /> },
  { key: 'priority', label: 'Öncelik', content: <PriorityChip priority="normal" /> },
  { key: 'schedule', label: 'Planlanan teslim zamanı', content: 'Belirtilmedi' },
  {
    key: 'description',
    label: 'Açıklama',
    content: 'Uzun teslimat açıklaması normal kelime sınırlarında sarılır ve değer sütununu taşırmaz.',
    wide: true,
  },
];

/**
 * Explicit React-commit readiness marker for the smoke harness.
 *
 * The marker is written from a layout effect that runs only after the real
 * ActivityTimeline and RecordDescriptions outputs are committed to the DOM.
 * The smoke harness waits for this marker plus the real timeline output; it
 * never treats the static `data-smoke-timeline` parent as proof of a render.
 */
function MarkFixtureReady() {
  useLayoutEffect(() => {
    const timelineMounted = document.querySelector(
      '#responsive-timeline-root .servora-ant-timeline',
    ) !== null;
    const descriptionsMounted = document.querySelector(
      '#responsive-descriptions-root .servora-record-descriptions',
    ) !== null;
    if (timelineMounted && descriptionsMounted) {
      document.documentElement.dataset.smokeJobDetailReady = 'true';
    }
  }, []);
  return null;
}

export function mountResponsiveJobDetailFixture() {
  const descriptionRoot = document.getElementById('responsive-descriptions-root');
  if (descriptionRoot) {
    createRoot(descriptionRoot).render(
      <ServoraAntProvider>
        <RecordDescriptions
          ariaLabel="İş kayıt bilgileri"
          items={chipItems}
          maxColumns={1}
        />
      </ServoraAntProvider>,
    );
  }

  const wideRoot = document.getElementById('responsive-descriptions-wide-root');
  if (wideRoot) {
    createRoot(wideRoot).render(
      <ServoraAntProvider>
        <RecordDescriptions
          ariaLabel="Geniş kayıt bilgileri"
          items={descriptionItems}
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
        <MarkFixtureReady />
      </ServoraAntProvider>,
    );
  }
}

mountResponsiveJobDetailFixture();
