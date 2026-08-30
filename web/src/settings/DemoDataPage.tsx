import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Link } from 'react-router-dom';

import { ApiError, type CurrentUser } from '../services/api';
import {
  createDemoDataset,
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
  ['PURGE_ACTOR_IN_DATASET', 'Bu demo veri kümesinin parçası olan hesapla silme işlemi yapılamaz.'],
  ['FOLLOW_UP_CYCLE', 'Demo verilerindeki ilişki yapısı güvenli silmeye uygun değil.'],
  ['DATASET_NOT_ACTIVE', 'Yalnızca aktif demo veri kümeleri silinebilir.'],
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

const UNKNOWN_BLOCKER_MESSAGE = 'Silme güvenliği doğrulanamadı. İşlem kapalı tutuldu.';

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

type PurgeReconcileReason = 'AMBIGUOUS' | 'IN_PROGRESS';

type PurgeConfirmation =
  | { kind: 'initial'; snapshot: PurgeApprovalSnapshot }
  | { kind: 'retry'; attempt: PurgeAttempt };

type PurgeOperationState =
  | { kind: 'idle' }
  | { kind: 'submitting'; attempt: PurgeAttempt }
  | { kind: 'reconciling'; attempt: PurgeAttempt; reason: PurgeReconcileReason }
  | { kind: 'recheck-required'; attempt: PurgeAttempt; reason: PurgeReconcileReason; description: string }
  | {
      kind: 'success';
      datasetId: string;
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
    ...(nonZeroCounts.length > 0 ? nonZeroCounts : ['Silinecek kayıt bulunmuyor.']),
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
    case 'success': return operation.datasetId;
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

type CreateOperationState =
  | { kind: 'idle' }
  | { kind: 'submitting'; clientActionId: string }
  | { kind: 'success'; dataset: DemoDataset; replayed: boolean }
  | { kind: 'error'; title: string; description: string };

const DEMO_FIXTURE_SUMMARY: readonly string[] = [
  '3 demo personel (1 yönetici, 2 satış)',
  '5 demo müşteri',
  '5 demo ürün',
  '8 demo iş kaydı',
] as const;

const DEMO_FIXTURE_EXPLANATION =
  'Oluşturulacak veriler sentetiktir. Mevcut iş verileriniz değişmez. Aynı anda yalnızca bir aktif demo veri kümesi bulunabilir; daha sonra Demo verisi yönetimi üzerinden silinebilir.';

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
      description="Aktif demo veri kümesi yok. Yeni bir demo veri kümesi oluşturabilirsiniz."
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
            Aktif
          </span>
        </button>
      </li>
    ))}
  </ul>;
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
      title={preview.safeToPurge ? 'Silmeye hazır' : 'Silme işlemi kullanılamıyor'}
    >
      <p className="demo-data-preview-message">
        {preview.safeToPurge
          ? 'Sunucu, seçili demo veri kümesinin mevcut ilişkilerini silme için güvenli buldu.'
          : 'Sunucu güvenlik engelleri buldu. Demo verileri bu durumda silinemez.'}
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
        <p className="field-status">Silmeyi engelleyen bir ilişki bulunmadı.</p>
      ) : (
        <ul className="demo-data-blocker-list" aria-label="Demo veri silme engelleri">
          {blockerMessages.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
    </OperationalCard>

    {preview.safeToPurge && actionAvailable && (
      <OperationalCard tone="attention" title="Demo verilerini sil">
        <p className="demo-data-preview-message">
          Bu işlem yalnız sunucunun demo olarak doğruladığı kayıtları kalıcı olarak siler.
        </p>
        <button
          ref={actionRef}
          className="destructive-button"
          type="button"
          disabled={actionDisabled}
          onClick={onRequestPurge}
        >
          Demo verilerini sil
        </button>
      </OperationalCard>
    )}
  </div>;
}

export function DemoDataPage({ user }: { user: CurrentUser }) {
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
  const [createConfirmationOpen, setCreateConfirmationOpen] = useState(false);
  const [createOperation, setCreateOperation] = useState<CreateOperationState>({ kind: 'idle' });
  const createTriggerRef = useRef<HTMLButtonElement>(null);
  const createClientActionRef = useRef<string | null>(null);
  const createSubmitGateRef = useRef(false);

  const interactionLocked = operation.kind === 'submitting' || operation.kind === 'reconciling';

  async function completePurge(receipt: DemoDatasetPurgeResponse) {
    setConfirmation(null);
    setPreview(null);
    setPreviewError('');
    setDatasets([]);
    setSelectedId(null);
    setOperation({
      kind: 'success',
      datasetId: receipt.datasetId,
      title: 'Demo verileri silindi.',
      status: 'success',
      receipt,
      refreshWarning: '',
      description: 'Sunucu işlemi tamamladı ve demo veri kümesinin tüm kapsamı kalıcı olarak silindi.',
    });
    try {
      const refreshed = await listDemoDatasets();
      setDatasets(refreshed);
      setSelectedId(refreshed[0]?.id ?? null);
    } catch {
      setOperation((current) => current.kind === 'success' && current.datasetId === receipt.datasetId
        ? {
            ...current,
            refreshWarning: 'Aktif demo veri kümesi listesi yenilenemedi. Silme sonucu sunucu tarafından tamamlandı.',
          }
        : current);
    }
  }

  async function reconcilePurgeAttempt(
    attempt: PurgeAttempt,
    reason: PurgeReconcileReason,
  ) {
    try {
      const receipt = await purgeDemoDataset(attempt.datasetId, {
        clientActionId: attempt.clientActionId,
        planHash: attempt.planHash,
      }, {
        datasetKey: attempt.datasetKey,
        seedVersion: attempt.seedVersion,
      });
      await completePurge(receipt);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'DEMO_DATASET_PLAN_STALE') {
        try {
          const latestPreview = await previewDemoDataset(attempt.datasetId);
          setPreview(latestPreview);
          setPreviewError('');
          setOperation({
            kind: 'rejected',
            datasetId: attempt.datasetId,
            title: 'Silme planı değişti',
            description: 'İşlem yapılmadı. Veriler değiştirilmedi. Güncel planı yeniden inceleyip onaylayın.',
            blockerMessages: localizedBlockerMessages(latestPreview.blockers.map((blocker) => blocker.code)),
            suppressAction: !latestPreview.safeToPurge,
          });
          return;
        } catch {
          // Continue with the fail-closed reconciliation state below.
        }
      }
      if (caught instanceof ApiError && caught.code === 'DEMO_DATASET_PURGE_BLOCKED') {
        setOperation({
          kind: 'rejected',
          datasetId: attempt.datasetId,
          title: 'Demo verileri silinemedi',
          description: 'İşlem yapılmadı. Veriler değiştirilmedi.',
          blockerMessages: localizedBlockerMessages(blockerCodesFromError(caught)),
          suppressAction: true,
        });
        return;
      }
      setOperation({
        kind: 'recheck-required',
        attempt,
        reason,
        description: 'Aynı silme isteğiyle sunucu durumu doğrulanamadı. Yeni bir işlem başlatmadan önce durumu tekrar kontrol edin.',
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
      await completePurge(receipt);
    } catch (caught) {
      setConfirmation(null);
      setPreviewError('');
      if (isAmbiguousMutationError(caught)) {
        setOperation({ kind: 'reconciling', attempt, reason: 'AMBIGUOUS' });
        void reconcilePurgeAttempt(attempt, 'AMBIGUOUS');
      } else if (caught instanceof ApiError && caught.code === 'DEMO_DATASET_PURGE_IN_PROGRESS') {
        setOperation({ kind: 'reconciling', attempt, reason: 'IN_PROGRESS' });
        void reconcilePurgeAttempt(attempt, 'IN_PROGRESS');
      } else if (caught instanceof ApiError && caught.code === 'DEMO_DATASET_PLAN_STALE') {
        try {
          const latestPreview = await previewDemoDataset(attempt.datasetId);
          setPreview(latestPreview);
          setOperation({
            kind: 'rejected',
            datasetId: attempt.datasetId,
            title: 'Silme planı değişti',
            description: 'İşlem yapılmadı. Veriler değiştirilmedi. Güncel planı yeniden inceleyip onaylayın.',
            blockerMessages: localizedBlockerMessages(latestPreview.blockers.map((blocker) => blocker.code)),
            suppressAction: !latestPreview.safeToPurge,
          });
        } catch {
          setOperation({
            kind: 'rejected',
            datasetId: attempt.datasetId,
            title: 'Silme planı değişti',
            description: 'İşlem yapılmadı. Veriler değiştirilmedi. Güncel önizleme alınamadığı için silme kapalı tutuldu.',
            blockerMessages: [],
            suppressAction: true,
          });
        }
      } else if (caught instanceof ApiError && caught.code === 'DEMO_DATASET_UNEXPECTED_DEPENDENCY') {
        setOperation({
          kind: 'rejected',
          datasetId: attempt.datasetId,
          title: 'Demo verileri silinemedi',
          description: 'İşlem yapılmadı. Veriler değiştirilmedi. Beklenmeyen bir veri bağımlılığı bulundu.',
          blockerMessages: [],
          suppressAction: true,
        });
      } else if (caught instanceof ApiError && caught.code === 'DEMO_DATASET_PURGE_BLOCKED') {
        setOperation({
          kind: 'rejected',
          datasetId: attempt.datasetId,
          title: 'Demo verileri silinemedi',
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
            : 'Demo verileri silinemedi',
          description: 'İşlem tamamlanamadı. Sunucu durumu doğrulanmadan yeni bir silme işlemi başlatılamaz.',
          blockerMessages: [],
          suppressAction: true,
        });
      }
    } finally {
      submitGateRef.current = false;
    }
  }

  const canCreate = user.role === 'ADMIN' && user.capabilities?.demoDatasetCreation === true;
  const hasActiveDataset = datasets?.some((dataset) => dataset.status === 'ACTIVE') ?? false;
  const isCreating = createOperation.kind === 'submitting';

  async function submitCreate() {
    if (createSubmitGateRef.current) return;
    createSubmitGateRef.current = true;
    const clientActionId = createClientActionRef.current ?? crypto.randomUUID();
    createClientActionRef.current = clientActionId;
    setCreateOperation({ kind: 'submitting', clientActionId });
    try {
      const response = await createDemoDataset({ clientActionId });
      setCreateConfirmationOpen(false);
      setCreateOperation({ kind: 'success', dataset: response.dataset, replayed: response.replayed });
      setOperation({ kind: 'idle' });
      createClientActionRef.current = null;
      const refreshed = await listDemoDatasets();
      setDatasets(refreshed);
      setSelectedId(response.dataset.id);
    } catch (caught) {
      if (isAmbiguousMutationError(caught)) {
        // keep same clientActionId for retry
        setCreateOperation({
          kind: 'error',
          title: 'İşlemin sonucu doğrulanamadı',
          description: 'Ağ bağlantısı kesildi. Aynı işlem kimliğiyle yeniden deneyebilirsiniz.',
        });
      } else if (caught instanceof ApiError && caught.code === 'DEMO_DATASET_ALREADY_EXISTS') {
        setCreateOperation({
          kind: 'error',
          title: 'Zaten etkin bir demo veri seti bulunuyor.',
          description: 'Yeni bir demo veri kümesi oluşturmadan önce mevcut etkin kümenin silinmesi gerekir.',
        });
        try {
          const refreshed = await listDemoDatasets();
          setDatasets(refreshed);
        } catch { /* keep datasets */ }
        createClientActionRef.current = null;
      } else if (caught instanceof ApiError && caught.status === 404) {
        setCreateOperation({
          kind: 'error',
          title: 'Demo verisi oluşturma bu ortamda etkin değil.',
          description: 'Sunucu demo verisi oluşturmayı bu ortam için kapalı tutuyor.',
        });
        createClientActionRef.current = null;
      } else if (caught instanceof ApiError && caught.status === 403) {
        setCreateOperation({
          kind: 'error',
          title: 'Bu işlem için yetkiniz yok',
          description: 'Demo verisi oluşturma yalnızca yönetici hesapları tarafından yapılabilir.',
        });
        createClientActionRef.current = null;
      } else {
        const message = caught instanceof ApiError ? caught.message : 'Bilinmeyen hata';
        setCreateOperation({
          kind: 'error',
          title: 'Demo verisi oluşturulamadı',
          description: message,
        });
        // keep clientActionId for retry on 5xx/network, clear on validation
        if (caught instanceof ApiError && caught.status >= 400 && caught.status < 500 && caught.code !== 'NETWORK_ERROR') {
          createClientActionRef.current = null;
        }
      }
    } finally {
      createSubmitGateRef.current = false;
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

  useEffect(() => {
    if (!selectedId) {
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
  }, [selectedId]);

  if (error) return <main className="workspace"><ResultState
    status="error" title="Demo verileri yüklenemedi" description={error} headingLevel={1}
  /></main>;
  if (!datasets) return <main className="workspace"><LoadingSkeleton title="Demo veri kümeleri yükleniyor" />
  </main>;

  return <main className="workspace settings-workspace">
    <header className="workspace-heading">
      <div>
        <h1>Demo verileri</h1>
        <p className="workspace-heading-copy">
          Demo veri kümelerini inceleyin ve sunucu tarafından güvenli olduğu doğrulanan içeriği kontrollü biçimde silin.
        </p>
      </div>
      <Link className="ghost-button" to={paths.settings}>Ayarlar</Link>
    </header>
    {canCreate && datasets !== null && (
      <OperationalCard title="Demo verisi oluştur">
        <p className="demo-data-preview-message">
          Standart demo veri kümesi oluşturur. Mevcut iş verileriniz etkilenmez.
        </p>
        <ul className="demo-data-fixture-list" aria-label="Demo fixture içeriği">
          {DEMO_FIXTURE_SUMMARY.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <p className="demo-data-preview-message" style={{ marginTop: '0.75rem' }}>
          {DEMO_FIXTURE_EXPLANATION}
        </p>
        {hasActiveDataset && createOperation.kind !== 'success' && createOperation.kind !== 'error' && (
          <p className="demo-data-preview-message" style={{ marginTop: '0.75rem' }}>
            Zaten etkin bir demo veri seti bulunuyor. Yeni bir küme oluşturmadan önce mevcut etkin kümenin Demo verisi yönetimi üzerinden silinmesi gerekir.
          </p>
        )}
        {createOperation.kind === 'success' && (
          <ResultState
            status="success"
            title={createOperation.replayed ? 'Demo verisi zaten oluşturulmuş' : 'Demo verisi oluşturuldu'}
            description={
              createOperation.replayed
                ? 'Bu oluşturma isteği daha önce tamamlanmıştı. Mevcut aktif veri kümesi gösteriliyor.'
                : 'Standart demo veri kümesi başarıyla oluşturuldu.'
            }
            headingLevel={3}
          />
        )}
        {createOperation.kind === 'error' && (
          <ResultState
            status="warning"
            title={createOperation.title}
            description={createOperation.description}
            headingLevel={3}
          />
        )}
        <div style={{ marginTop: '1rem', display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
          <button
            ref={createTriggerRef}
            type="button"
            className="primary-button"
            disabled={isCreating || hasActiveDataset}
            aria-busy={isCreating}
            onClick={() => setCreateConfirmationOpen(true)}
          >
            {isCreating ? 'Demo verisi oluşturuluyor…' : 'Demo verisi oluştur'}
          </button>
          {createOperation.kind === 'error' && (
            <button
              type="button"
              className="secondary-button"
              disabled={isCreating}
              onClick={() => {
                setCreateOperation({ kind: 'idle' });
              }}
            >
              Kapat
            </button>
          )}
        </div>
      </OperationalCard>
    )}
    {!canCreate && datasets !== null && (
      <OperationalCard title="Demo verisi oluşturma">
        <p className="demo-data-preview-message">
          Demo verisi oluşturma bu ortamda etkin değil.
        </p>
      </OperationalCard>
    )}
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
        {operation.kind === 'success' && (selectedId === null || operation.datasetId === selectedId) && (
          <ResultState
            status={operation.status}
            title={operation.title}
            description={<div className="demo-data-result-copy">
              <p>{operation.refreshWarning || operation.description}</p>
              {operation.receipt && (
                <ul className="demo-data-result-counts" aria-label="Silinen demo kayıtları">
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
              ? 'İşlemin sonucu doğrulanamadı. Aynı istek kimliğiyle sonuç kontrol ediliyor.'
              : 'Başka bir silme işlemi raporlandı. Aynı istek kimliğiyle sonuç doğrulanıyor.'}
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
                void reconcilePurgeAttempt(operation.attempt, operation.reason);
              }}
            >
              Durumu yeniden kontrol et
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
      title="Demo verileri silinsin mi?"
      description="Bu işlem geri alınamaz. Sunucu, onaylanan planı işlem anında yeniden doğrular."
      details={confirmation ? confirmationDetails(confirmationSnapshot(confirmation)) : []}
      confirmLabel="Demo verilerini sil"
      pending={interactionLocked}
      pendingLabel="Demo verileri siliniyor…"
      destructive
      onConfirm={() => { void submitApprovedPurge(); }}
      onCancel={() => setConfirmation(null)}
      returnFocusRef={purgeTriggerRef}
    />
    <ConfirmationAction
      open={createConfirmationOpen}
      title="Demo verisi oluşturulsun mu?"
      description="Bu işlem standart demo veri kümesini oluşturur. Mevcut iş verileriniz değişmez."
      details={[...DEMO_FIXTURE_SUMMARY, DEMO_FIXTURE_EXPLANATION]}
      confirmLabel="Oluştur"
      pending={isCreating}
      pendingLabel="Oluşturuluyor…"
      onConfirm={() => { void submitCreate(); }}
      onCancel={() => setCreateConfirmationOpen(false)}
      returnFocusRef={createTriggerRef}
    />
  </main>;
}
