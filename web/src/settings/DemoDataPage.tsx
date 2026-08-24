import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Link } from 'react-router-dom';

import { ApiError } from '../services/api';
import {
  getDemoDataset,
  listDemoDatasets,
  previewDemoDataset,
  purgeDemoDataset,
  type DemoDataset,
  type DemoDatasetImpactCounts,
  type DemoDatasetPreview,
  type DemoDatasetPurgeResponse,
} from '../services/demo-data-api';
import { paths } from '../paths';
import { EmptyState } from '../ui/antd/EmptyState';
import { ConfirmationAction } from '../ui/antd/ConfirmationAction';
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

const BUSINESS_BLOCKER_CODES = [
  'DEMO_USER_TO_BUSINESS_CUSTOMER',
  'BUSINESS_USER_TO_DEMO_CUSTOMER',
  'DEMO_USER_TO_BUSINESS_STAFF_PROFILE',
  'BUSINESS_STAFF_PROFILE_TO_DEMO_USER',
  'DEMO_USER_TO_BUSINESS_JOB',
  'BUSINESS_USER_TO_DEMO_JOB',
  'BUSINESS_CUSTOMER_TO_DEMO_JOB',
  'DEMO_CUSTOMER_TO_BUSINESS_JOB',
  'DEMO_JOB_TO_BUSINESS_CONTACT',
  'BUSINESS_CONTACT_TO_DEMO_JOB',
  'DEMO_JOB_TO_BUSINESS_FOLLOW_UP',
  'BUSINESS_JOB_TO_DEMO_FOLLOW_UP',
  'DEMO_PRODUCT_TO_BUSINESS_JOB',
  'BUSINESS_PRODUCT_TO_DEMO_JOB',
  'BUSINESS_JOB_ACTIVITY_TO_DEMO_USER',
  'DEMO_USER_TO_BUSINESS_JOB_ACTIVITY',
  'BUSINESS_JOB_NOTE_TO_DEMO_USER',
  'DEMO_USER_TO_BUSINESS_JOB_NOTE',
  'BUSINESS_CONFIDENTIAL_NOTE_AUTHOR_TO_DEMO_USER',
  'DEMO_USER_TO_BUSINESS_CONFIDENTIAL_NOTE',
  'DEMO_USER_TO_BUSINESS_CALENDAR_EVENT',
  'BUSINESS_CALENDAR_EVENT_TO_DEMO_USER',
  'BUSINESS_CALENDAR_ACTIVITY_TO_DEMO_EVENT',
  'DEMO_USER_TO_BUSINESS_CALENDAR_ACTIVITY',
  'DEMO_CONVERSATION_TO_BUSINESS_JOB',
  'DEMO_JOB_TO_BUSINESS_CONVERSATION',
  'DEMO_CONVERSATION_TO_BUSINESS_CUSTOMER',
  'DEMO_CUSTOMER_TO_BUSINESS_CONVERSATION',
  'BUSINESS_CONVERSATION_TO_DEMO_USER',
  'DEMO_USER_TO_BUSINESS_CONVERSATION',
  'BUSINESS_MESSAGE_TO_DEMO_CONVERSATION',
  'DEMO_USER_TO_BUSINESS_MESSAGE',
  'BUSINESS_MESSAGING_ACTIVITY_TO_DEMO_CONVERSATION',
  'DEMO_USER_TO_BUSINESS_MESSAGING_ACTIVITY',
  'BUSINESS_CONVERSATION_STATE_TO_DEMO_CONVERSATION',
  'DEMO_USER_TO_BUSINESS_CONVERSATION_STATE',
] as const;

const BLOCKER_MESSAGES = new Map<string, string>([
  ...BUSINESS_BLOCKER_CODES.map((code) => [
    code,
    'Demo içeriği gerçek iş verileriyle bağlantılı.',
  ] as const),
  ['WORKER_CLAIMED_REMINDER', 'Bazı demo işlemleri halen arka planda işleniyor.'],
  ['WORKER_CLAIMED_WEB_PUSH', 'Bazı demo işlemleri halen arka planda işleniyor.'],
  ['PURGE_ACTOR_IN_DATASET', 'Bu demo veri kümesinin parçası olan hesapla kaldırma işlemi yapılamaz.'],
  ['FOLLOW_UP_CYCLE', 'Demo verilerindeki ilişki yapısı güvenli kaldırmaya uygun değil.'],
  ['DATASET_NOT_ACTIVE', 'Yalnızca aktif demo veri kümeleri kaldırılabilir.'],
  ['CROSS_DATASET_EDGE', 'Demo verileri başka bir demo veri kümesiyle bağlantılı.'],
  ['DEMO_USER_TO_EXTERNAL_DEMO_DATASET', 'Demo verileri başka bir demo veri kümesiyle bağlantılı.'],
  ['CROSS_ORGANIZATION_DERIVED_EDGE', 'Demo verileri başka bir organizasyonla bağlantılı.'],
  ['EXTERNAL_DERIVED_EDGE', 'Demo verilerinin dışında kalan türetilmiş bir bağlantı bulundu.'],
  ['DEMO_REMINDER_TO_EXTERNAL_USER', 'Demo hatırlatıcıları demo kapsamı dışındaki bir kullanıcıyla bağlantılı.'],
  ['EXTERNAL_REMINDER_TO_DEMO_USER', 'Demo hatırlatıcıları demo kapsamı dışındaki bir kayıtla bağlantılı.'],
  ['DEMO_NOTIFICATION_TO_EXTERNAL_USER', 'Demo bildirimleri demo kapsamı dışındaki bir kullanıcıyla bağlantılı.'],
  ['EXTERNAL_NOTIFICATION_TO_DEMO_USER', 'Demo bildirimleri demo kapsamı dışındaki bir kayıtla bağlantılı.'],
  ['DEMO_PUSH_TO_EXTERNAL_SUBSCRIPTION', 'Demo push kayıtları demo kapsamı dışındaki bir abonelikle bağlantılı.'],
  ['EXTERNAL_NOTIFICATION_TO_DEMO_SUBSCRIPTION', 'Demo push aboneliği demo kapsamı dışındaki bir bildirimle bağlantılı.'],
  ['BACKUP_DEPENDENCY', 'Demo kullanıcıları sistem yedekleme kayıtlarıyla bağlantılı.'],
]);

const UNKNOWN_BLOCKER_MESSAGE = 'Kaldırma güvenliği doğrulanamadı. İşlem kapalı tutuldu.';

function localizedBlockerMessages(codes: readonly string[]) {
  return Array.from(new Set(codes.map((code) => BLOCKER_MESSAGES.get(code) ?? UNKNOWN_BLOCKER_MESSAGE)));
}

type PurgeApprovalSnapshot = {
  datasetId: string;
  datasetKey: string;
  seedVersion: string;
  planHash: string;
  affectedCounts: DemoDatasetImpactCounts;
};

type PurgeAttempt = PurgeApprovalSnapshot & {
  clientActionId: string;
};

type PurgeReconcileReason = 'AMBIGUOUS' | 'IN_PROGRESS' | 'ALREADY_PURGED';

type PurgeConfirmation =
  | { kind: 'initial'; snapshot: PurgeApprovalSnapshot }
  | { kind: 'retry'; attempt: PurgeAttempt };

type PurgeOperationState =
  | { kind: 'idle' }
  | { kind: 'submitting'; attempt: PurgeAttempt }
  | { kind: 'reconciling'; attempt: PurgeAttempt; reason: PurgeReconcileReason }
  | { kind: 'recheck-required'; attempt: PurgeAttempt; reason: PurgeReconcileReason; description: string }
  | { kind: 'retry-ready'; attempt: PurgeAttempt; description: string }
  | {
      kind: 'success';
      dataset: DemoDataset;
      title: string;
      status: 'success' | 'info';
      description: string;
      refreshWarning: string;
      receipt: DemoDatasetPurgeResponse | null;
    }
  | {
      kind: 'rejected';
      datasetId: string;
      title: string;
      description: string;
      blockerMessages: string[];
      suppressAction: boolean;
    };

function approvalSnapshot(preview: DemoDatasetPreview): PurgeApprovalSnapshot {
  return {
    datasetId: preview.dataset.id,
    datasetKey: preview.dataset.datasetKey,
    seedVersion: preview.dataset.seedVersion,
    planHash: preview.planHash,
    affectedCounts: { ...preview.affectedCounts },
  };
}

function countDetails(affectedCounts: DemoDatasetImpactCounts) {
  const counts = Object.entries(affectedCounts) as Array<[keyof DemoDatasetImpactCounts, number]>;
  return counts
    .filter(([, count]) => count > 0)
    .map(([key, count]) => `${COUNT_LABELS[key]}: ${count.toLocaleString('tr-TR')}`);
}

function confirmationDetails(snapshot: PurgeApprovalSnapshot) {
  const nonZeroCounts = countDetails(snapshot.affectedCounts);
  return [
    `Demo veri kümesi: ${snapshot.datasetKey}`,
    `Seed sürümü: ${snapshot.seedVersion}`,
    ...(nonZeroCounts.length > 0 ? nonZeroCounts : ['Kaldırılacak kayıt bulunmuyor.']),
  ];
}

function confirmationSnapshot(confirmation: PurgeConfirmation) {
  return confirmation.kind === 'initial' ? confirmation.snapshot : confirmation.attempt;
}

function blockerCodesFromError(error: ApiError) {
  const blockerCodes = error.details?.blockerCodes;
  return Array.isArray(blockerCodes)
    ? blockerCodes.filter((code): code is string => typeof code === 'string')
    : [];
}

function isAmbiguousMutationError(error: unknown) {
  return error instanceof ApiError
    && (error.code === 'NETWORK_ERROR' || error.code === 'INVALID_RESPONSE' || error.status >= 500);
}

function operationDatasetId(operation: PurgeOperationState) {
  switch (operation.kind) {
    case 'idle': return null;
    case 'success': return operation.dataset.id;
    case 'rejected': return operation.datasetId;
    default: return operation.attempt.datasetId;
  }
}

function suppressesPreviewAction(operation: PurgeOperationState, datasetId: string) {
  if (operationDatasetId(operation) !== datasetId) return false;
  if (operation.kind === 'idle') return false;
  if (operation.kind === 'submitting') return false;
  if (operation.kind === 'rejected') return operation.suppressAction;
  return true;
}

function queryErrorMessage(error: unknown, fallback: string) {
  if (!(error instanceof ApiError)) return fallback;
  if (error.code === 'NETWORK_ERROR') {
    return 'Sunucuya ulaşılamadı. Bağlantınızı kontrol edip tekrar deneyin.';
  }
  if (error.status === 401) return 'Oturumunuz doğrulanamadı. Lütfen yeniden giriş yapın.';
  if (error.status === 403) return 'Bu bilgileri görüntülemek için yetkiniz yok.';
  return fallback;
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
  disabled,
  onSelect,
}: {
  datasets: DemoDataset[];
  selectedId: string | null;
  disabled: boolean;
  onSelect: (id: string) => void;
}): ReactNode {
  if (datasets.length === 0) {
    return <EmptyState
      title="Demo veri kümesi yok"
      description="Yeni demo veri kümesi oluşturma akışı henüz bu sürümün parçası değil."
    />;
  }
  return <ul className="demo-data-dataset-list" aria-label="Demo veri kümeleri">
    {datasets.map((dataset) => (
      <li key={dataset.id}>
        <button
          type="button"
          className={`demo-data-dataset-row${selectedId === dataset.id ? ' is-selected' : ''}`}
          aria-pressed={selectedId === dataset.id}
          disabled={disabled}
          onClick={() => onSelect(dataset.id)}
        >
          <span>
            <strong>{dataset.datasetKey}</strong>
            <small>Seed {dataset.seedVersion} · {formatDate(dataset.createdAt)}</small>
          </span>
          <span className={`demo-data-status demo-data-status--${dataset.status.toLowerCase()}`}>
            {dataset.status === 'ACTIVE' ? 'Aktif' : 'Kaldırıldı'}
          </span>
        </button>
      </li>
    ))}
  </ul>;
}

function TombstoneDetails({ dataset }: { dataset: DemoDataset }): ReactNode {
  return <OperationalCard title="Demo veri kümesi kaldırıldı">
    <p className="demo-data-preview-message">
      Bu geçmiş kaydı yeniden kaldırılamaz. Demo içeriği artık etkin değildir.
    </p>
    <dl className="demo-data-facts">
      <div><dt>Demo veri kümesi</dt><dd>{dataset.datasetKey}</dd></div>
      <div><dt>Seed sürümü</dt><dd>{dataset.seedVersion}</dd></div>
      <div><dt>Oluşturulma</dt><dd>{formatDate(dataset.createdAt)}</dd></div>
      <div><dt>Kaldırılma</dt><dd>{dataset.purgedAt ? formatDate(dataset.purgedAt) : '—'}</dd></div>
    </dl>
  </OperationalCard>;
}

function PreviewDetails({
  preview,
  actionRef,
  actionDisabled,
  actionAvailable,
  onRequestPurge,
}: {
  preview: DemoDatasetPreview;
  actionRef: RefObject<HTMLButtonElement | null>;
  actionDisabled: boolean;
  actionAvailable: boolean;
  onRequestPurge: () => void;
}): ReactNode {
  const countEntries = useMemo(
    () => Object.entries(preview.affectedCounts) as Array<[keyof DemoDatasetImpactCounts, number]>,
    [preview.affectedCounts],
  );
  const blockerMessages = localizedBlockerMessages(preview.blockers.map((blocker) => blocker.code));
  return <div className="demo-data-preview-stack">
    <OperationalCard
      tone={preview.safeToPurge ? 'success' : 'attention'}
      title={preview.safeToPurge ? 'Kaldırmaya hazır' : 'Kaldırma işlemi kullanılamıyor'}
    >
      <p className="demo-data-preview-message">
        {preview.safeToPurge
          ? 'Sunucu, seçili demo veri kümesinin mevcut ilişkilerini kaldırma için güvenli buldu.'
          : 'Sunucu güvenlik engelleri buldu. Demo verileri bu durumda kaldırılamaz.'}
      </p>
      <dl className="demo-data-facts">
        <div><dt>Organizasyon</dt><dd>{preview.organization.name}</dd></div>
        <div><dt>Demo veri kümesi</dt><dd>{preview.dataset.datasetKey}</dd></div>
        <div><dt>Seed sürümü</dt><dd>{preview.dataset.seedVersion}</dd></div>
      </dl>
    </OperationalCard>

    <OperationalCard title="Etkilenecek kayıtlar">
      <dl className="demo-data-count-grid">
        {countEntries.map(([key, value]) => (
          <div key={key}><dt>{COUNT_LABELS[key]}</dt><dd>{value.toLocaleString('tr-TR')}</dd></div>
        ))}
      </dl>
    </OperationalCard>

    <OperationalCard title={`Güvenlik kontrolü (${blockerMessages.length})`}>
      {blockerMessages.length === 0 ? (
        <p className="field-status">Kaldırmayı engelleyen bir ilişki bulunmadı.</p>
      ) : (
        <ul className="demo-data-blocker-list" aria-label="Demo veri kaldırma engelleri">
          {blockerMessages.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
    </OperationalCard>

    {preview.safeToPurge && actionAvailable && (
      <OperationalCard tone="attention" title="Demo verilerini kaldır">
        <p className="demo-data-preview-message">
          Bu işlem yalnız sunucunun demo olarak doğruladığı kayıtları kalıcı olarak kaldırır.
        </p>
        <button
          ref={actionRef}
          className="destructive-button"
          type="button"
          disabled={actionDisabled}
          onClick={onRequestPurge}
        >
          Demo verilerini kaldır
        </button>
      </OperationalCard>
    )}
  </div>;
}

export function DemoDataPage() {
  const [datasets, setDatasets] = useState<DemoDataset[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [preview, setPreview] = useState<DemoDatasetPreview | null>(null);
  const [error, setError] = useState('');
  const [previewError, setPreviewError] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [confirmation, setConfirmation] = useState<PurgeConfirmation | null>(null);
  const [operation, setOperation] = useState<PurgeOperationState>({ kind: 'idle' });
  const purgeTriggerRef = useRef<HTMLButtonElement>(null);
  const submitGateRef = useRef(false);

  const interactionLocked = operation.kind === 'submitting' || operation.kind === 'reconciling';

  async function reconcilePurgeAttempt(
    attempt: PurgeAttempt,
    reason: PurgeReconcileReason,
    allowRetry: boolean,
  ) {
    try {
      const dataset = await getDemoDataset(attempt.datasetId);
      if (dataset.status === 'PURGED') {
        setPreview(null);
        setDatasets((current) => current?.map((item) =>
          item.id === dataset.id ? dataset : item) ?? [dataset]);
        setOperation({
          kind: 'success',
          dataset,
          title: reason === 'ALREADY_PURGED'
            ? 'Demo verileri daha önce kaldırılmış.'
            : 'Demo verileri kaldırıldı.',
          status: reason === 'ALREADY_PURGED' ? 'info' : 'success',
          receipt: null,
          refreshWarning: '',
          description: reason === 'ALREADY_PURGED'
            ? 'Demo veri kümesinin daha önce kaldırıldığı sunucu durumundan doğrulandı.'
            : 'Kayıp işlem yanıtından sonra kaldırılmış veri kümesi sunucu durumundan doğrulandı.',
        });
        return;
      }
      setDatasets((current) => current?.map((item) =>
        item.id === dataset.id ? dataset : item) ?? [dataset]);
      const latestPreview = await previewDemoDataset(attempt.datasetId);
      setPreview(latestPreview);
      setPreviewError('');
      if (!latestPreview.safeToPurge) {
        setOperation({
          kind: 'rejected',
          datasetId: attempt.datasetId,
          title: 'Demo verileri kaldırılamadı',
          description: 'İşlem yapılmadı. Veriler değiştirilmedi.',
          blockerMessages: localizedBlockerMessages(latestPreview.blockers.map((blocker) => blocker.code)),
          suppressAction: true,
        });
        return;
      }
      if (latestPreview.planHash !== attempt.planHash) {
        setOperation({
          kind: 'rejected',
          datasetId: attempt.datasetId,
          title: 'Kaldırma planı değişti',
          description: 'İşlem yapılmadı. Veriler değiştirilmedi. Güncel planı yeniden inceleyip onaylayın.',
          blockerMessages: [],
          suppressAction: false,
        });
        return;
      }
      if (reason === 'ALREADY_PURGED') {
        setOperation({
          kind: 'rejected',
          datasetId: attempt.datasetId,
          title: 'Sunucu durumu eşleşmiyor',
          description: 'Veri kümesi kaldırılmış olarak doğrulanamadı. Yeni bir işlem başlatmadan önce sayfayı yenileyin.',
          blockerMessages: [],
          suppressAction: true,
        });
        return;
      }
      if (!allowRetry) {
        setOperation({
          kind: 'recheck-required',
          attempt,
          reason,
          description: 'Başka bir kaldırma işlemi raporlandı. Yeni bir gönderimden önce sunucu durumunu tekrar kontrol edin.',
        });
        return;
      }
      setOperation({
        kind: 'retry-ready',
        attempt,
        description: 'Veri kümesi hâlâ aktif ve onaylanan güvenli plan değişmedi. Aynı işlem kimliğiyle açıkça yeniden deneyebilirsiniz.',
      });
    } catch {
      setOperation({
        kind: 'recheck-required',
        attempt,
        reason,
        description: 'Sunucu durumu alınamadı. Demo verilerini yeniden kaldırmayı denemeden önce durumu tekrar kontrol edin.',
      });
    }
  }

  async function submitApprovedPurge() {
    if (!confirmation || submitGateRef.current) return;
    submitGateRef.current = true;
    const attempt: PurgeAttempt = confirmation.kind === 'retry'
      ? confirmation.attempt
      : { ...confirmation.snapshot, clientActionId: crypto.randomUUID() };
    setOperation({ kind: 'submitting', attempt });
    try {
      const receipt = await purgeDemoDataset(attempt.datasetId, {
        clientActionId: attempt.clientActionId,
        planHash: attempt.planHash,
      }, {
        datasetKey: attempt.datasetKey,
        seedVersion: attempt.seedVersion,
      });
      setConfirmation(null);
      setPreview(null);
      setDatasets((current) => current?.map((dataset) =>
        dataset.id === receipt.dataset.id ? receipt.dataset : dataset) ?? [receipt.dataset]);
      setOperation({
        kind: 'success',
        dataset: receipt.dataset,
        title: 'Demo verileri kaldırıldı.',
        status: 'success',
        receipt,
        refreshWarning: '',
        description: 'Sunucu işlemi tamamladı ve veri kümesini kaldırıldı olarak işaretledi.',
      });
      try {
        const refreshed = await listDemoDatasets();
        setDatasets(refreshed);
      } catch {
        setOperation({
          kind: 'success',
          dataset: receipt.dataset,
          title: 'Demo verileri kaldırıldı.',
          status: 'success',
          receipt,
          refreshWarning: 'Veri kümesi listesi yenilenemedi. Kaldırma sonucu yine de sunucu tarafından doğrulandı.',
          description: 'Sunucu işlemi tamamladı ve veri kümesini kaldırıldı olarak işaretledi.',
        });
      }
    } catch (caught) {
      setConfirmation(null);
      setPreviewError('');
      if (isAmbiguousMutationError(caught)) {
        setOperation({ kind: 'reconciling', attempt, reason: 'AMBIGUOUS' });
        void reconcilePurgeAttempt(attempt, 'AMBIGUOUS', true);
      } else if (caught instanceof ApiError && caught.code === 'DEMO_DATASET_PURGE_IN_PROGRESS') {
        setOperation({ kind: 'reconciling', attempt, reason: 'IN_PROGRESS' });
        void reconcilePurgeAttempt(attempt, 'IN_PROGRESS', false);
      } else if (caught instanceof ApiError && caught.code === 'DEMO_DATASET_ALREADY_PURGED') {
        setOperation({ kind: 'reconciling', attempt, reason: 'ALREADY_PURGED' });
        void reconcilePurgeAttempt(attempt, 'ALREADY_PURGED', false);
      } else if (caught instanceof ApiError && caught.code === 'DEMO_DATASET_PLAN_STALE') {
        try {
          const latestPreview = await previewDemoDataset(attempt.datasetId);
          setPreview(latestPreview);
          setOperation({
            kind: 'rejected',
            datasetId: attempt.datasetId,
            title: 'Kaldırma planı değişti',
            description: 'İşlem yapılmadı. Veriler değiştirilmedi. Güncel planı yeniden inceleyip onaylayın.',
            blockerMessages: localizedBlockerMessages(latestPreview.blockers.map((blocker) => blocker.code)),
            suppressAction: !latestPreview.safeToPurge,
          });
        } catch {
          setOperation({
            kind: 'rejected',
            datasetId: attempt.datasetId,
            title: 'Kaldırma planı değişti',
            description: 'İşlem yapılmadı. Veriler değiştirilmedi. Güncel önizleme alınamadığı için işlem kapalı tutuldu.',
            blockerMessages: [],
            suppressAction: true,
          });
        }
      } else if (caught instanceof ApiError && caught.code === 'DEMO_DATASET_UNEXPECTED_DEPENDENCY') {
        setOperation({
          kind: 'rejected',
          datasetId: attempt.datasetId,
          title: 'Demo verileri kaldırılamadı',
          description: 'İşlem yapılmadı. Veriler değiştirilmedi. Beklenmeyen bir veri bağımlılığı bulundu.',
          blockerMessages: [],
          suppressAction: true,
        });
      } else if (caught instanceof ApiError && caught.code === 'DEMO_DATASET_PURGE_BLOCKED') {
        setOperation({
          kind: 'rejected',
          datasetId: attempt.datasetId,
          title: 'Demo verileri kaldırılamadı',
          description: 'İşlem yapılmadı. Veriler değiştirilmedi.',
          blockerMessages: localizedBlockerMessages(blockerCodesFromError(caught)),
          suppressAction: true,
        });
      } else {
        setOperation({
          kind: 'rejected',
          datasetId: attempt.datasetId,
          title: caught instanceof ApiError && caught.status === 403
            ? 'Bu işlem için yetkiniz yok'
            : 'Demo verileri kaldırılamadı',
          description: 'İşlem tamamlanamadı. Sunucu durumu doğrulanmadan yeni bir kaldırma işlemi başlatılamaz.',
          blockerMessages: [],
          suppressAction: true,
        });
      }
    } finally {
      submitGateRef.current = false;
    }
  }

  useEffect(() => {
    let mounted = true;
    void listDemoDatasets().then((items) => {
      if (!mounted) return;
      setDatasets(items);
      setSelectedId((current) => current
        ?? items.find((item) => item.status === 'ACTIVE')?.id
        ?? items[0]?.id
        ?? null);
    }).catch((caught) => {
      if (mounted) setError(queryErrorMessage(
        caught,
        'Demo veri kümeleri alınamadı. Lütfen tekrar deneyin.',
      ));
    });
    return () => { mounted = false; };
  }, []);

  const selectedDatasetStatus = datasets?.find((item) => item.id === selectedId)?.status;

  useEffect(() => {
    if (!selectedId || selectedDatasetStatus === 'PURGED') {
      setPreview(null);
      setPreviewError('');
      setPreviewLoading(false);
      return;
    }
    let mounted = true;
    setPreviewLoading(true);
    setPreviewError('');
    void previewDemoDataset(selectedId).then((result) => {
      if (mounted) setPreview(result);
    }).catch((caught) => {
      if (mounted) setPreviewError(queryErrorMessage(
        caught,
        'Demo veri kümesinin güvenlik önizlemesi alınamadı.',
      ));
    }).finally(() => {
      if (mounted) setPreviewLoading(false);
    });
    return () => { mounted = false; };
  }, [selectedDatasetStatus, selectedId]);

  if (error) return <main className="workspace"><ResultState
    status="error" title="Demo verileri yüklenemedi" description={error} headingLevel={1}
  /></main>;
  if (!datasets) return <main className="workspace"><LoadingSkeleton title="Demo veri kümeleri yükleniyor" />
  </main>;

  const selectedDataset = datasets.find((dataset) => dataset.id === selectedId) ?? null;

  return <main className="workspace settings-workspace">
    <header className="workspace-heading">
      <div>
        <h1>Demo verileri</h1>
        <p className="workspace-heading-copy">
          Demo veri kümelerini inceleyin ve sunucu tarafından güvenli olduğu doğrulanan içeriği kontrollü biçimde kaldırın.
        </p>
      </div>
      <Link className="ghost-button" to={paths.settings}>Ayarlar</Link>
    </header>
    <div className="demo-data-layout">
      <OperationalCard title="Demo veri kümeleri">
        <DatasetList
          datasets={datasets}
          selectedId={selectedId}
          disabled={interactionLocked}
          onSelect={setSelectedId}
        />
      </OperationalCard>
      <section className="demo-data-detail-region" aria-live="polite">
        {operation.kind === 'success' && operation.dataset.id === selectedId && (
          <ResultState
            status={operation.status}
            title={operation.title}
            description={<div className="demo-data-result-copy">
              <p>{operation.refreshWarning || operation.description}</p>
              {operation.receipt && (
                <ul className="demo-data-result-counts" aria-label="Kaldırılan demo kayıtları">
                  {countDetails(operation.receipt.affectedCounts).map((detail) => (
                    <li key={detail}>{detail}</li>
                  ))}
                </ul>
              )}
            </div>}
            headingLevel={2}
          />
        )}
        {operation.kind === 'reconciling' && operation.attempt.datasetId === selectedId && (
          <ResultState
            status="info"
            title="İşlem sonucu doğrulanıyor"
            description={operation.reason === 'AMBIGUOUS'
              ? 'İşlemin sonucu doğrulanamadı. Güncel durum kontrol ediliyor.'
              : operation.reason === 'IN_PROGRESS'
                ? 'Başka bir kaldırma işlemi raporlandı. Güncel durum kontrol ediliyor.'
                : 'Veri kümesinin kaldırılmış durumu sunucudan doğrulanıyor.'}
            headingLevel={2}
          />
        )}
        {operation.kind === 'recheck-required' && operation.attempt.datasetId === selectedId && (
          <ResultState
            status="info"
            title="Sunucu durumu yeniden kontrol edilmeli"
            description={operation.description}
            action={<button
              className="secondary-button"
              type="button"
              onClick={() => {
                setOperation({
                  kind: 'reconciling',
                  attempt: operation.attempt,
                  reason: operation.reason,
                });
                void reconcilePurgeAttempt(operation.attempt, operation.reason, true);
              }}
            >
              Durumu yeniden kontrol et
            </button>}
            headingLevel={2}
          />
        )}
        {operation.kind === 'retry-ready' && operation.attempt.datasetId === selectedId && (
          <ResultState
            status="info"
            title="Aynı işlem yeniden denenebilir"
            description={operation.description}
            action={<button
              className="secondary-button"
              type="button"
              onClick={() => setConfirmation({ kind: 'retry', attempt: operation.attempt })}
            >
              Aynı işlemi yeniden dene
            </button>}
            headingLevel={2}
          />
        )}
        {operation.kind === 'rejected' && operation.datasetId === selectedId && (
          <ResultState
            status="warning"
            title={operation.title}
            description={<div className="demo-data-result-copy">
              <p>{operation.description}</p>
              {operation.blockerMessages.length > 0 && (
                <ul>
                  {operation.blockerMessages.map((message) => <li key={message}>{message}</li>)}
                </ul>
              )}
            </div>}
            headingLevel={2}
          />
        )}
        {selectedDataset?.status === 'PURGED'
          && !(operation.kind === 'success' && operation.dataset.id === selectedDataset.id)
          && <TombstoneDetails dataset={selectedDataset} />}
        {previewLoading && <LoadingSkeleton title="Demo graph önizlemesi hesaplanıyor" rows={3} />}
        {!previewLoading && previewError && <ResultState status="error" title="Önizleme alınamadı" description={previewError} headingLevel={2} />}
        {operation.kind !== 'success' && !previewLoading && !previewError && preview && <PreviewDetails
          preview={preview}
          actionRef={purgeTriggerRef}
          actionDisabled={interactionLocked}
          actionAvailable={!suppressesPreviewAction(operation, preview.dataset.id)}
          onRequestPurge={() => setConfirmation({
            kind: 'initial',
            snapshot: approvalSnapshot(preview),
          })}
        />}
      </section>
    </div>
    <ConfirmationAction
      open={confirmation !== null}
      title="Demo verileri kaldırılsın mı?"
      description="Bu işlem geri alınamaz. Sunucu, onaylanan planı işlem anında yeniden doğrular."
      details={confirmation ? confirmationDetails(confirmationSnapshot(confirmation)) : []}
      confirmLabel="Demo verilerini kaldır"
      pending={interactionLocked}
      pendingLabel="Demo verileri kaldırılıyor…"
      destructive
      onConfirm={() => { void submitApprovedPurge(); }}
      onCancel={() => setConfirmation(null)}
      returnFocusRef={purgeTriggerRef}
    />
  </main>;
}
