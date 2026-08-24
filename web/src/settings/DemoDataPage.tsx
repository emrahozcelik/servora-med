import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { ApiError } from '../services/api';
import {
  listDemoDatasets,
  previewDemoDataset,
  type DemoDataset,
  type DemoDatasetImpactCounts,
  type DemoDatasetPreview,
} from '../services/demo-data-api';
import { paths } from '../paths';
import { EmptyState } from '../ui/antd/EmptyState';
import { LoadingSkeleton } from '../ui/antd/LoadingSkeleton';
import { OperationalCard } from '../ui/antd/OperationalCard';
import { ResultState } from '../ui/antd/ResultState';

const COUNT_LABELS: Readonly<Record<keyof DemoDatasetImpactCounts, string>> = {
  users: 'Kullanıcılar',
  staffProfiles: 'Personel profilleri',
  customers: 'Müşteriler',
  contacts: 'İlgili kişiler',
  products: 'Ürünler',
  jobCards: 'JobCard kayıtları',
  deliveryItems: 'Teslimat kalemleri',
  notes: 'Job notları',
  confidentialNotes: 'Gizli personel notları',
  activities: 'Aktiviteler',
  followUps: 'Follow-up kayıtları',
  calendarEvents: 'Takvim kayıtları',
  conversations: 'Konuşmalar',
  messages: 'Mesajlar',
  notifications: 'Bildirimler',
  reminders: 'Hatırlatıcılar',
  realtimeEvents: 'Realtime olayları',
};

function errorMessage(error: unknown) {
  return error instanceof ApiError && error.message
    ? error.message
    : 'Demo verileri alınamadı. Lütfen tekrar deneyin.';
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '—' : new Intl.DateTimeFormat('tr-TR', {
    dateStyle: 'medium', timeStyle: 'short',
  }).format(date);
}

function DatasetList({
  datasets,
  selectedId,
  onSelect,
}: {
  datasets: DemoDataset[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}): ReactNode {
  if (datasets.length === 0) {
    return <EmptyState
      title="Demo veri kümesi yok"
      description="Yeni demo dataset oluşturma akışı henüz bu sürümün parçası değil."
    />;
  }
  return <ul className="demo-data-dataset-list" aria-label="Demo veri kümeleri">
    {datasets.map((dataset) => (
      <li key={dataset.id}>
        <button
          type="button"
          className={`demo-data-dataset-row${selectedId === dataset.id ? ' is-selected' : ''}`}
          aria-pressed={selectedId === dataset.id}
          onClick={() => onSelect(dataset.id)}
        >
          <span>
            <strong>{dataset.datasetKey}</strong>
            <small>Seed {dataset.seedVersion} · {formatDate(dataset.createdAt)}</small>
          </span>
          <span className={`demo-data-status demo-data-status--${dataset.status.toLowerCase()}`}>
            {dataset.status === 'ACTIVE' ? 'Aktif' : 'Arşivlenmiş'}
          </span>
        </button>
      </li>
    ))}
  </ul>;
}

function PreviewDetails({ preview }: { preview: DemoDatasetPreview }): ReactNode {
  const countEntries = useMemo(
    () => Object.entries(preview.affectedCounts) as Array<[keyof DemoDatasetImpactCounts, number]>,
    [preview.affectedCounts],
  );
  return <div className="demo-data-preview-stack">
    <OperationalCard
      tone={preview.safeToPurge ? 'success' : 'attention'}
      title={preview.safeToPurge ? 'Gelecekteki purge için blocker yok' : 'Purge güvenli değil'}
    >
      <p className="demo-data-preview-message">
        {preview.safeToPurge
          ? 'Bu yalnızca salt-okunur bir güvenlik önizlemesidir. Silme işlemi henüz uygulanmıyor.'
          : 'Business veriye bağlı kayıtlar bulundu. Sistem gelecekteki purge işlemini fail-closed durdurmalıdır.'}
      </p>
      <dl className="demo-data-facts">
        <div><dt>Organizasyon</dt><dd>{preview.organization.name}</dd></div>
        <div><dt>Dataset</dt><dd>{preview.dataset.datasetKey}</dd></div>
        <div><dt>Plan hash</dt><dd className="demo-data-plan-hash">{preview.planHash}</dd></div>
      </dl>
    </OperationalCard>

    <OperationalCard title="Etkilenecek kayıtlar">
      <dl className="demo-data-count-grid">
        {countEntries.map(([key, value]) => (
          <div key={key}><dt>{COUNT_LABELS[key]}</dt><dd>{value.toLocaleString('tr-TR')}</dd></div>
        ))}
      </dl>
    </OperationalCard>

    <OperationalCard title={`Blocker'lar (${preview.blockers.length})`}>
      {preview.blockers.length === 0 ? (
        <p className="field-status">Mixed BUSINESS/DEMO ilişkisi bulunamadı.</p>
      ) : (
        <ul className="demo-data-blocker-list" aria-label="Demo veri blocker listesi">
          {preview.blockers.map((blocker, index) => (
            <li key={`${blocker.code}-${blocker.sourceId}-${blocker.relatedId ?? 'none'}-${index}`}>
              <strong>{blocker.code}</strong>
              <span>{blocker.message}</span>
              <small>{blocker.sourceType} · {blocker.sourceId}{blocker.relatedId ? ` → ${blocker.relatedType} · ${blocker.relatedId}` : ''}</small>
            </li>
          ))}
        </ul>
      )}
    </OperationalCard>
  </div>;
}

export function DemoDataPage() {
  const [datasets, setDatasets] = useState<DemoDataset[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [preview, setPreview] = useState<DemoDatasetPreview | null>(null);
  const [error, setError] = useState('');
  const [previewError, setPreviewError] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);

  useEffect(() => {
    let mounted = true;
    void listDemoDatasets().then((items) => {
      if (!mounted) return;
      setDatasets(items);
      setSelectedId((current) => current ?? items[0]?.id ?? null);
    }).catch((caught) => {
      if (mounted) setError(errorMessage(caught));
    });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setPreview(null);
      return;
    }
    let mounted = true;
    setPreviewLoading(true);
    setPreviewError('');
    void previewDemoDataset(selectedId).then((result) => {
      if (mounted) setPreview(result);
    }).catch((caught) => {
      if (mounted) setPreviewError(errorMessage(caught));
    }).finally(() => {
      if (mounted) setPreviewLoading(false);
    });
    return () => { mounted = false; };
  }, [selectedId]);

  if (error) return <main className="workspace"><ResultState
    status="error" title="Demo verileri yüklenemedi" description={error} headingLevel={1}
  /></main>;
  if (!datasets) return <main className="workspace"><LoadingSkeleton title="Demo veri kümeleri yükleniyor" />
  </main>;

  return <main className="workspace settings-workspace">
    <header className="workspace-heading">
      <div>
        <p className="eyebrow">Veri yönetimi</p>
        <h1>Demo verileri</h1>
        <p className="workspace-heading-copy">Demo içeriklerin dataset sahipliğini ve gelecekteki güvenli silme etkisini görüntüleyin.</p>
      </div>
      <Link className="ghost-button" to={paths.settings}>Ayarlar</Link>
    </header>
    <div className="demo-data-layout">
      <OperationalCard title="Demo veri kümeleri">
        <DatasetList datasets={datasets} selectedId={selectedId} onSelect={setSelectedId} />
      </OperationalCard>
      <section aria-live="polite">
        {previewLoading && <LoadingSkeleton title="Demo graph önizlemesi hesaplanıyor" rows={3} />}
        {!previewLoading && previewError && <ResultState status="error" title="Önizleme alınamadı" description={previewError} headingLevel={2} />}
        {!previewLoading && !previewError && preview && <PreviewDetails preview={preview} />}
      </section>
    </div>
  </main>;
}
