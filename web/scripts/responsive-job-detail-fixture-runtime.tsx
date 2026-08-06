import { createRoot } from 'react-dom/client';
import { useLayoutEffect } from 'react';

import {
  ActivityTimeline,
  RecordDescriptions,
  ServoraAntProvider,
} from '../src/ui/antd';
import { PriorityChip } from '../src/ui/PriorityChip';
import { StatusChip } from '../src/ui/StatusChip';

/**
 * Order-independent React-commit readiness coordinator for the smoke harness.
 *
 * Each fixture root renders a <FixtureCommitSignal part="..."/> next to its
 * real component. Every signal records its own commit from a layout effect;
 * the shared coordinator writes the `smokeJobDetailReady` marker only when
 * BOTH parts have committed AND both real outputs exist in the DOM. No signal
 * queries another root's effect timing — commit order is irrelevant. The
 * static `data-smoke-timeline` parent is never treated as proof of a render.
 */

export type FixturePart = 'timeline' | 'descriptions';

const committedParts = new Set<FixturePart>();

function updateReadyMarker(): boolean {
  const ready =
    committedParts.has('timeline')
    && committedParts.has('descriptions')
    && document.querySelector('#responsive-timeline-root .servora-ant-timeline') !== null
    && document.querySelector('#responsive-descriptions-root .servora-record-descriptions') !== null;
  if (ready) {
    document.documentElement.dataset.smokeJobDetailReady = 'true';
  } else {
    delete document.documentElement.dataset.smokeJobDetailReady;
  }
  return ready;
}

export function getCommittedFixtureParts(): FixturePart[] {
  return Array.from(committedParts);
}

export function FixtureCommitSignal({ part }: { part: FixturePart }) {
  useLayoutEffect(() => {
    committedParts.add(part);
    updateReadyMarker();
    return () => {
      committedParts.delete(part);
      updateReadyMarker();
    };
  }, [part]);
  return null;
}

if (typeof window !== 'undefined') {
  window.__servoraSmokeFixtureParts = () => Array.from(committedParts);
}

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

const timelineItems = [
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
];

/**
 * Mounts every JobDetail fixture root exactly once per container. Called by
 * the browser entrypoint; the runtime module itself never auto-mounts so
 * tests exercise the same mount contract without duplicating roots.
 */
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
        <FixtureCommitSignal part="descriptions" />
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
        <ActivityTimeline items={timelineItems} />
        <FixtureCommitSignal part="timeline" />
      </ServoraAntProvider>,
    );
  }
}
