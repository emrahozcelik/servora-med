import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';

import { ApiError } from '../services/api';
import {
  getBackup,
  getBackupHealth,
  getBackupOverview,
  getBackupPolicy,
  getBackupStorage,
  listBackups,
  requestManualBackup,
  testBackupStorage,
  updateBackupPolicy,
  type BackupHealth,
  type BackupOverview,
  type BackupPolicy,
  type BackupPolicyInput,
  type BackupRun,
  type BackupRunPhase,
  type BackupRunStatus,
  type BackupScope,
  type BackupStorageState,
} from '../services/backup-api';
import { paths } from '../paths';
import { EmptyState } from '../ui/antd/EmptyState';
import { LoadingSkeleton } from '../ui/antd/LoadingSkeleton';
import { OperationalCard } from '../ui/antd/OperationalCard';
import { ResultState } from '../ui/antd/ResultState';
import { SettingsTabs } from '../ui/antd/SettingsTabs';

type BackupSection = 'overview' | 'backups' | 'schedule' | 'storage';

const SECTION_TABS = [
  { key: 'overview', label: 'Genel bakış', to: `${paths.settingsBackupRecovery}?section=overview` },
  { key: 'backups', label: 'Yedekler', to: `${paths.settingsBackupRecovery}?section=backups` },
  { key: 'schedule', label: 'Zamanlama', to: `${paths.settingsBackupRecovery}?section=schedule` },
  { key: 'storage', label: 'Depolama', to: `${paths.settingsBackupRecovery}?section=storage` },
];

const PHASE_LABELS: Record<BackupRunPhase, string> = {
  PREFLIGHT: 'Ön kontroller',
  DATABASE_DUMP: 'Veritabanı hazırlanıyor',
  FILES_ARCHIVE: 'Dosyalar hazırlanıyor',
  MANIFEST: 'Yedek bilgileri hazırlanıyor',
  CHECKSUM: 'Bütünlük kontrolü',
  PACKAGE: 'Paketleniyor',
  ENCRYPT: 'Şifreleniyor',
  UPLOAD: 'Uzak depoya gönderiliyor',
  REMOTE_VERIFY: 'Uzak yedek doğrulanıyor',
  CLEANUP: 'Tamamlanıyor',
};

const STATUS_LABELS: Record<BackupRunStatus, string> = {
  QUEUED: 'Sırada',
  RUNNING: 'Çalışıyor',
  SUCCESS: 'Tamamlandı',
  FAILED: 'Başarısız',
  CANCELLED: 'İptal edildi',
};

const SCOPE_LABELS: Record<BackupScope, string> = {
  DATABASE: 'Yalnızca veritabanı',
  FULL_DATA: 'Veritabanı ve dosyalar',
};

const ORIGIN_LABELS = { MANUAL: 'Elle başlatıldı', SCHEDULED: 'Zamanlanmış', PRE_RESTORE: 'İşlem öncesi' } as const;
const RETENTION_LABELS = { DAILY: 'Günlük', WEEKLY: 'Haftalık', MONTHLY: 'Aylık', MANUAL: 'Elle', PRE_RESTORE: 'İşlem öncesi' } as const;

const TIMEZONES = [
  'UTC', 'Europe/Istanbul', 'Europe/London', 'Europe/Berlin',
  'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo', 'Asia/Dubai',
];

function formatDate(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '—';
  return new Intl.DateTimeFormat('tr-TR', {
    dateStyle: 'medium', timeStyle: 'short',
  }).format(date);
}

function formatBytes(value: number | null): string {
  if (value === null) return '—';
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value;
  let index = -1;
  do { size /= 1024; index += 1; } while (size >= 1024 && index < units.length - 1);
  return `${size.toLocaleString('tr-TR', { maximumFractionDigits: 1 })} ${units[index]}`;
}

function friendlyError(error: unknown, fallback = 'Bilgi alınamadı. Lütfen tekrar deneyin.'): string {
  if (error instanceof ApiError && error.message) return error.message;
  return fallback;
}

function verificationLabel(run: Pick<BackupRun, 'status' | 'phase' | 'verifiedAt' | 'failureCode'>): string {
  if (run.status === 'SUCCESS' && run.verifiedAt) return 'Doğrulandı';
  if (run.status === 'FAILED' && (run.failureCode === 'REMOTE_CHECKSUM_MISMATCH' || run.failureCode === 'R2_VERIFY_FAILED')) {
    return 'Doğrulama başarısız';
  }
  if (run.status === 'RUNNING' && run.phase === 'REMOTE_VERIFY') return 'Doğrulanıyor';
  if (run.status === 'SUCCESS') return 'Doğrulama kanıtı yok';
  if (run.status === 'QUEUED' || run.status === 'RUNNING') return 'Henüz doğrulanmadı';
  return 'Uygulanamaz';
}

function StatusPresentation({ run }: { run: BackupRun | Omit<BackupRun, 'remoteKey' | 'sha256'> }): ReactNode {
  const warning = run.warningCode === 'CLEANUP_FAILED' ? (run.warningSummary || 'Yerel temizlik tamamlanamadı.') : null;
  const failure = run.failureSummary || (run.failureCode ? 'Yedekleme işlemi tamamlanamadı.' : null);
  return (
    <span className="backup-status-presentation" aria-label="Yedek durumu">
      <span className={`backup-status-chip backup-status-chip--${run.status.toLowerCase()}`}>
        İşlem: {STATUS_LABELS[run.status]}
      </span>
      <span className="backup-status-chip backup-status-chip--verification">
        Doğrulama: {verificationLabel(run)}
      </span>
      {warning && <span className="backup-status-chip backup-status-chip--warning">Uyarı: {warning}</span>}
      {failure && <span className="backup-status-detail">{failure}</span>}
    </span>
  );
}

function ActiveRunSummary({ run }: { run: BackupOverview['activeRun'] }): ReactNode {
  if (!run) {
    return <p className="backup-muted-copy">Şu anda sırada veya çalışan bir yedek yok.</p>;
  }
  return (
    <div className="backup-active-run" aria-live="polite">
      <strong>{run.status === 'QUEUED' ? 'Yedekleme isteği sırada' : 'Yedekleme çalışıyor'}</strong>
      <p>{run.phase ? PHASE_LABELS[run.phase] : STATUS_LABELS[run.status]}</p>
      <StatusPresentation run={run} />
    </div>
  );
}

function storageStateLabel(storage: BackupStorageState | null): string {
  if (!storage || !storage.enabled) return 'Yapılandırılmadı';
  if (storage.lastConnectionTestOk === true) return 'Bağlantı başarılı';
  if (storage.lastConnectionTestOk === false) return 'Bağlantı testi başarısız';
  return 'Yapılandırıldı, bağlantı testi yok';
}

function OverviewSection({
  overview,
  health,
  policy,
  storage,
  storageUnavailable,
  backupNow,
  actionPending,
  actionMessage,
  actionError,
}: {
  overview: BackupOverview;
  health: BackupHealth | null;
  policy: BackupPolicy;
  storage: BackupStorageState;
  storageUnavailable: boolean;
  backupNow: (scope: BackupScope) => Promise<void>;
  actionPending: boolean;
  actionMessage: string;
  actionError: string;
}): ReactNode {
  const [scope, setScope] = useState<BackupScope>(policy.defaultScope);
  useEffect(() => setScope(policy.defaultScope), [policy.defaultScope]);
  const healthLabel = health?.status === 'ok' && overview.lastVerifiedBackup
    ? 'Sağlıklı'
    : overview.lastVerifiedBackup ? 'Durum kullanılamıyor' : 'Doğrulanmış yedek yok';
  const healthDescription = health?.status === 'ok' && overview.lastVerifiedBackup
    ? 'Son doğrulama kanıtı mevcut ve mevcut sağlık kaynağı olumlu.'
    : overview.lastVerifiedBackup
      ? 'Sunucu sağlık kaynağı bu anda olumlu bir sonuç bildirmiyor.'
      : 'Henüz sağlıklı bir geri dönüş noktası oluşmadı.';
  return (
    <div className="backup-section-stack">
      <div className="backup-overview-grid">
        <OperationalCard tone={health?.status === 'ok' && overview.lastVerifiedBackup ? 'success' : 'attention'} title="Yedekleme sağlığı">
          <strong className="backup-card-value">{healthLabel}</strong>
          <p className="backup-muted-copy">{healthDescription}</p>
        </OperationalCard>
        <OperationalCard tone={overview.lastVerifiedBackup ? 'success' : 'default'} title="Son doğrulanmış yedek">
          {overview.lastVerifiedBackup ? (
            <>
              <dl className="backup-fact-list">
                <div><dt>Doğrulama</dt><dd>{formatDate(overview.lastVerifiedBackup.verifiedAt)}</dd></div>
                <div><dt>Kapsam</dt><dd>{SCOPE_LABELS[overview.lastVerifiedBackup.scope]}</dd></div>
                <div><dt>Boyut</dt><dd>{formatBytes(overview.lastVerifiedBackup.sizeBytes)}</dd></div>
              </dl>
              <StatusPresentation run={overview.lastVerifiedBackup} />
            </>
          ) : <p className="backup-muted-copy">Henüz doğrulanmış yedek yok.</p>}
        </OperationalCard>
        <OperationalCard title="Sonraki zamanlanmış yedek">
          {policy.enabled && overview.nextScheduledAt ? (
            <dl className="backup-fact-list">
              <div><dt>Zaman</dt><dd>{formatDate(overview.nextScheduledAt)}</dd></div>
              <div><dt>Politika saat dilimi</dt><dd>{policy.timezone}</dd></div>
            </dl>
          ) : <p className="backup-muted-copy">{policy.enabled ? 'Sonraki zamanlanmış çalışma şu anda hesaplanamıyor.' : 'Zamanlanmış yedeklemeler kapalı.'}</p>}
        </OperationalCard>
        <OperationalCard tone={storageUnavailable ? 'attention' : storage.enabled && storage.lastConnectionTestOk === true ? 'success' : 'default'} title="Depolama bağlantısı">
          <strong className="backup-card-value">{storageUnavailable ? 'Durum alınamadı' : storageStateLabel(storage)}</strong>
          <p className="backup-muted-copy">{storageUnavailable ? 'Depolama durumu sunucudan okunamadı.' : storage.bucketAlias || 'Cloudflare R2 yönetici yapılandırması'}</p>
        </OperationalCard>
      </div>

      <div className="backup-overview-lower-grid">
        <OperationalCard title="Aktif yedekleme">
          <ActiveRunSummary run={overview.activeRun} />
          {overview.worker ? (
            <p className="backup-muted-copy backup-worker-note">
              Son worker sinyali: {formatDate(overview.worker.workerHeartbeatAt)}
            </p>
          ) : (
            <p className="backup-muted-copy backup-worker-note">Çalışan süreç durumu bu görünümde raporlanmıyor.</p>
          )}
        </OperationalCard>
        <OperationalCard title="Şimdi yedekle" className="backup-action-card">
          <p className="backup-muted-copy">İstek asenkron olarak sıraya alınır; tamamlanma durumu Yedekler bölümünden izlenir.</p>
          <div className="backup-inline-form">
            <div className="field-group">
              <label htmlFor="backup-now-scope">Yedek kapsamı</label>
              <select id="backup-now-scope" value={scope} onChange={(event) => setScope(event.target.value as BackupScope)} disabled={actionPending}>
                <option value="DATABASE">{SCOPE_LABELS.DATABASE}</option>
                <option value="FULL_DATA">{SCOPE_LABELS.FULL_DATA}</option>
              </select>
            </div>
            <button className="primary-button" type="button" onClick={() => void backupNow(scope)} disabled={actionPending}>
              {actionPending ? 'Sıraya alınıyor…' : 'Şimdi yedekle'}
            </button>
          </div>
          {actionMessage && <p className="backup-inline-success" role="status">{actionMessage}</p>}
          {actionError && <p className="form-error" role="alert">{actionError}</p>}
        </OperationalCard>
      </div>
    </div>
  );
}

function BackupHistory({
  page,
  loading,
  loadingMore,
  onMore,
  onSelect,
  selectedId,
}: {
  page: { items: BackupRun[]; nextCursor: string | null } | null;
  loading: boolean;
  loadingMore: boolean;
  onMore: () => Promise<void>;
  onSelect: (id: string) => Promise<void>;
  selectedId: string | null;
}): ReactNode {
  if (loading && !page) return <LoadingSkeleton title="Yedek geçmişi yükleniyor" />;
  if (!page || page.items.length === 0) {
    return <EmptyState title="Henüz yedek geçmişi yok" description="İlk yedekleme isteği sıraya alındığında geçmiş burada görünecek." />;
  }
  return (
    <div className="backup-history-stack">
      <ul className="backup-history-list" aria-label="Yedek geçmişi">
        {page.items.map((run) => (
          <li key={run.id} className="backup-history-item">
            <button
              type="button"
              className="backup-history-row"
              aria-expanded={selectedId === run.id}
              aria-controls={selectedId === run.id ? 'backup-detail-panel' : undefined}
              onClick={() => void onSelect(run.id)}
            >
              <span className="backup-history-primary">
                <strong>{formatDate(run.createdAt)}</strong>
                <small>{ORIGIN_LABELS[run.origin]} · {SCOPE_LABELS[run.scope]}</small>
              </span>
              <span className="backup-history-secondary">
                <small>{RETENTION_LABELS[run.retentionClass]}</small>
                <strong>{formatBytes(run.sizeBytes)}</strong>
              </span>
              <StatusPresentation run={run} />
            </button>
          </li>
        ))}
      </ul>
      {page.nextCursor && (
        <button className="secondary-button" type="button" onClick={() => void onMore()} disabled={loadingMore}>
          {loadingMore ? 'Yükleniyor…' : 'Daha eski yedekleri göster'}
        </button>
      )}
    </div>
  );
}

function BackupDetail({
  detail,
  loading,
  onClose,
}: {
  detail: BackupRun | null;
  loading: boolean;
  onClose: () => void;
}): ReactNode {
  if (loading) return <LoadingSkeleton title="Yedek ayrıntısı yükleniyor" rows={2} />;
  if (!detail) return null;
  return (
    <section className="backup-detail-panel" id="backup-detail-panel" aria-labelledby="backup-detail-title">
      <div className="backup-detail-heading">
        <div>
          <h2 id="backup-detail-title">Yedek ayrıntısı</h2>
          <p className="backup-muted-copy">{formatDate(detail.createdAt)}</p>
        </div>
        <button className="ghost-button" type="button" onClick={onClose}>Ayrıntıyı kapat</button>
      </div>
      <StatusPresentation run={detail} />
      <dl className="backup-detail-facts">
        <div><dt>Durum</dt><dd>{STATUS_LABELS[detail.status]}</dd></div>
        <div><dt>Aşama</dt><dd>{detail.phase ? PHASE_LABELS[detail.phase] : '—'}</dd></div>
        <div><dt>Kaynak</dt><dd>{ORIGIN_LABELS[detail.origin]}</dd></div>
        <div><dt>Kapsam</dt><dd>{SCOPE_LABELS[detail.scope]}</dd></div>
        <div><dt>Saklama sınıfı</dt><dd>{RETENTION_LABELS[detail.retentionClass]}</dd></div>
        <div><dt>Başlangıç</dt><dd>{formatDate(detail.startedAt)}</dd></div>
        <div><dt>Tamamlanma</dt><dd>{formatDate(detail.completedAt)}</dd></div>
        <div><dt>Doğrulama</dt><dd>{formatDate(detail.verifiedAt)}</dd></div>
        <div><dt>Şifreli boyut</dt><dd>{formatBytes(detail.sizeBytes)}</dd></div>
        <div><dt>Kayıt kimliği</dt><dd className="backup-detail-id">{detail.id}</dd></div>
      </dl>
    </section>
  );
}

function ScheduleSection({
  policy,
  onSaved,
}: {
  policy: BackupPolicy;
  onSaved: (policy: BackupPolicy) => void;
}): ReactNode {
  const [draft, setDraft] = useState<BackupPolicyInput>({
    enabled: policy.enabled,
    scheduleTimeLocal: policy.scheduleTimeLocal,
    timezone: policy.timezone,
    dailyRetention: policy.dailyRetention,
    weeklyRetention: policy.weeklyRetention,
    monthlyRetention: policy.monthlyRetention,
    defaultScope: policy.defaultScope,
  });
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => setDraft({
    enabled: policy.enabled,
    scheduleTimeLocal: policy.scheduleTimeLocal,
    timezone: policy.timezone,
    dailyRetention: policy.dailyRetention,
    weeklyRetention: policy.weeklyRetention,
    monthlyRetention: policy.monthlyRetention,
    defaultScope: policy.defaultScope,
  }), [policy]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(''); setError('');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.scheduleTimeLocal)) {
      setError('Saat 24 saat biçiminde HH:MM olmalıdır.'); return;
    }
    if (!draft.timezone.trim()) { setError('Saat dilimi zorunludur.'); return; }
    setPending(true);
    try {
      const saved = await updateBackupPolicy(draft);
      onSaved(saved);
      setMessage('Zamanlama politikası kaydedildi.');
    } catch (caught) {
      setError(friendlyError(caught, 'Zamanlama kaydedilemedi.'));
    } finally { setPending(false); }
  }

  return (
    <OperationalCard title="Zamanlanmış yedeklemeler">
      <form className="backup-policy-form" onSubmit={submit}>
        <label className="backup-toggle-field">
          <input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft((current) => ({ ...current, enabled: event.target.checked }))} disabled={pending} />
          <span><strong>Zamanlanmış yedeklemeleri etkinleştir</strong><small>Worker etkin olduğunda mevcut politika üzerinden çalışır.</small></span>
        </label>
        <div className="backup-form-grid">
          <div className="field-group"><label htmlFor="backup-schedule-time">Saat</label><input id="backup-schedule-time" type="time" value={draft.scheduleTimeLocal} onChange={(event) => setDraft((current) => ({ ...current, scheduleTimeLocal: event.target.value }))} disabled={pending} required /></div>
          <div className="field-group"><label htmlFor="backup-schedule-timezone">Saat dilimi (IANA)</label><input id="backup-schedule-timezone" list="backup-timezone-options" value={draft.timezone} onChange={(event) => setDraft((current) => ({ ...current, timezone: event.target.value }))} disabled={pending} required /><datalist id="backup-timezone-options">{TIMEZONES.map((timezone) => <option key={timezone} value={timezone} />)}</datalist></div>
          <div className="field-group"><label htmlFor="backup-default-scope">Varsayılan kapsam</label><select id="backup-default-scope" value={draft.defaultScope} onChange={(event) => setDraft((current) => ({ ...current, defaultScope: event.target.value as BackupScope }))} disabled={pending}><option value="DATABASE">{SCOPE_LABELS.DATABASE}</option><option value="FULL_DATA">{SCOPE_LABELS.FULL_DATA}</option></select></div>
        </div>
        <fieldset className="backup-retention-fieldset"><legend>Servora mantıksal saklama politikası</legend><p className="field-hint">Her sınıf için tutulacak en son başarılı yedek sayısını belirler. Bu ayar R2 yaşam döngüsü veya Bucket Lock yönetimi değildir.</p><div className="backup-form-grid backup-form-grid--retention">
          <div className="field-group"><label htmlFor="backup-daily-retention">Günlük</label><input id="backup-daily-retention" type="number" min="1" max="365" value={draft.dailyRetention} onChange={(event) => setDraft((current) => ({ ...current, dailyRetention: Number(event.target.value) }))} disabled={pending} required /></div>
          <div className="field-group"><label htmlFor="backup-weekly-retention">Haftalık</label><input id="backup-weekly-retention" type="number" min="1" max="52" value={draft.weeklyRetention} onChange={(event) => setDraft((current) => ({ ...current, weeklyRetention: Number(event.target.value) }))} disabled={pending} required /></div>
          <div className="field-group"><label htmlFor="backup-monthly-retention">Aylık</label><input id="backup-monthly-retention" type="number" min="1" max="120" value={draft.monthlyRetention} onChange={(event) => setDraft((current) => ({ ...current, monthlyRetention: Number(event.target.value) }))} disabled={pending} required /></div>
        </div></fieldset>
        <button className="primary-button" type="submit" disabled={pending}>{pending ? 'Kaydediliyor…' : 'Zamanlamayı kaydet'}</button>
        {message && <p className="backup-inline-success" role="status">{message}</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
      </form>
    </OperationalCard>
  );
}

function StorageSection({
  storage,
  onTested,
}: {
  storage: BackupStorageState;
  onTested: (storage: BackupStorageState) => void;
}): ReactNode {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [testOk, setTestOk] = useState<boolean | null>(null);
  async function testConnection() {
    setPending(true); setMessage(''); setError(''); setTestOk(null);
    try {
      const result = await testBackupStorage();
      const latest = await getBackupStorage();
      onTested(latest);
      setTestOk(result.ok);
      setMessage(result.ok ? 'Depolama bağlantısı başarılı.' : 'Depolama bağlantısı testi başarısız.');
      if (!result.ok && result.failureClass === 'CONFIG') setError('Depolama yapılandırması kullanılamıyor. Operatör yapılandırmasını kontrol edin.');
    } catch (caught) {
      setTestOk(null);
      setError(friendlyError(caught, 'Depolama bağlantısı test edilemedi.'));
    } finally { setPending(false); }
  }
  return (
    <div className="backup-section-stack">
      <OperationalCard title="Cloudflare R2 depolama">
        <dl className="backup-fact-list backup-fact-list--wide">
          <div><dt>Sağlayıcı</dt><dd>Cloudflare R2</dd></div>
          <div><dt>Yapılandırma</dt><dd>{storage.enabled ? 'Yapılandırıldı' : 'Yapılandırılmadı'}</dd></div>
          <div><dt>Bucket</dt><dd>{storage.bucketAlias || 'Operatör yapılandırması'}</dd></div>
          <div><dt>Önek</dt><dd>{storage.prefix}</dd></div>
          <div><dt>Son bağlantı testi</dt><dd>{storage.lastConnectionTestAt ? `${formatDate(storage.lastConnectionTestAt)} · ${storage.lastConnectionTestOk ? 'Başarılı' : 'Başarısız'}` : 'Henüz test edilmedi'}</dd></div>
        </dl>
        <p className="field-hint">Kimlik bilgileri bu arayüzde gösterilmez veya düzenlenmez. Bağlantı testi gerçek yedek kabulü ya da üretim geçişi anlamına gelmez.</p>
        <button className="secondary-button" type="button" onClick={() => void testConnection()} disabled={pending}>{pending ? 'Test ediliyor…' : 'Bağlantıyı test et'}</button>
        {message && <p className={testOk === true ? 'backup-inline-success' : 'form-error'} role={testOk === true ? 'status' : 'alert'}>{message}</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
      </OperationalCard>
    </div>
  );
}

export function BackupRecoveryPage(): ReactNode {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawSection = searchParams.get('section');
  const section: BackupSection = rawSection === 'backups' || rawSection === 'schedule' || rawSection === 'storage' ? rawSection : 'overview';
  const [overview, setOverview] = useState<BackupOverview | null>(null);
  const [health, setHealth] = useState<BackupHealth | null>(null);
  const [policy, setPolicy] = useState<BackupPolicy | null>(null);
  const [storage, setStorage] = useState<BackupStorageState | null>(null);
  const [storageError, setStorageError] = useState('');
  const [history, setHistory] = useState<{ items: BackupRun[]; nextCursor: string | null } | null>(null);
  const [pending, setPending] = useState(true);
  const [historyPending, setHistoryPending] = useState(true);
  const [historyMorePending, setHistoryMorePending] = useState(false);
  const [error, setError] = useState('');
  const [historyError, setHistoryError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<BackupRun | null>(null);
  const [detailPending, setDetailPending] = useState(false);
  const [actionPending, setActionPending] = useState(false);
  const [actionMessage, setActionMessage] = useState('');
  const [actionError, setActionError] = useState('');
  const actionIdRef = useRef<string | null>(null);

  const loadHistory = useCallback(async (cursor: string | null = null, append = false) => {
    if (append) setHistoryMorePending(true); else setHistoryPending(true);
    setHistoryError('');
    try {
      const next = await listBackups({ limit: 20, cursor });
      setHistory((current) => append && current ? { items: [...current.items, ...next.items], nextCursor: next.nextCursor } : next);
    } catch (caught) {
      setHistoryError(friendlyError(caught, 'Yedek geçmişi alınamadı.'));
    } finally {
      if (append) setHistoryMorePending(false); else setHistoryPending(false);
    }
  }, []);

  const loadCore = useCallback(async () => {
    setPending(true); setError('');
    setStorageError('');
    const [overviewResult, policyResult, storageResult, healthResult] = await Promise.allSettled([
      getBackupOverview(), getBackupPolicy(), getBackupStorage(), getBackupHealth(),
    ]);
    if (overviewResult.status === 'fulfilled') setOverview(overviewResult.value);
    else setError(friendlyError(overviewResult.reason, 'Yedekleme yönetim bilgileri alınamadı.'));
    if (policyResult.status === 'fulfilled') setPolicy(policyResult.value);
    else setError((current) => current || friendlyError(policyResult.reason, 'Yedekleme politikası alınamadı.'));
    if (storageResult.status === 'fulfilled') setStorage(storageResult.value);
    else setStorageError(friendlyError(storageResult.reason, 'Depolama durumu alınamadı.'));
    if (healthResult.status === 'fulfilled') setHealth(healthResult.value);
    else setHealth(null);
    setPending(false);
  }, []);

  useEffect(() => { void loadCore(); void loadHistory(); }, [loadCore, loadHistory]);

  useEffect(() => {
    if (!overview?.activeRun || (overview.activeRun.status !== 'QUEUED' && overview.activeRun.status !== 'RUNNING')) return undefined;
    const timer = window.setInterval(() => {
      void Promise.all([getBackupOverview(), getBackupHealth(), listBackups({ limit: 20 })]).then(([nextOverview, nextHealth, nextHistory]) => {
        setOverview(nextOverview); setHealth(nextHealth); setHistory(nextHistory);
      }).catch(() => {
        setHealth(null);
      });
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [overview?.activeRun?.id, overview?.activeRun?.status]);

  const selectDetail = useCallback(async (id: string) => {
    if (selectedId === id) { setSelectedId(null); setDetail(null); return; }
    setSelectedId(id); setDetailPending(true); setDetail(null);
    try { setDetail(await getBackup(id)); }
    catch (caught) { setHistoryError(friendlyError(caught, 'Yedek ayrıntısı alınamadı.')); }
    finally { setDetailPending(false); }
  }, [selectedId]);

  const backupNow = useCallback(async (scope: BackupScope) => {
    if (actionPending) return;
    const clientActionId = actionIdRef.current ?? (globalThis.crypto?.randomUUID?.() ?? `backup-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    actionIdRef.current = clientActionId;
    setActionPending(true); setActionMessage(''); setActionError('');
    try {
      await requestManualBackup({ clientActionId, scope });
      actionIdRef.current = null;
      setActionMessage('Yedekleme isteği sıraya alındı.');
      try {
        const [nextOverview, nextHistory] = await Promise.all([getBackupOverview(), listBackups({ limit: 20 })]);
        setOverview(nextOverview); setHistory(nextHistory);
      } catch {
        setActionError('İstek sıraya alındı; güncel durum yenilenemedi. Yedekler bölümünü yenileyin.');
      }
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) setActionError('Zaten aktif bir yedekleme çalışması var. Mevcut çalışmanın tamamlanmasını bekleyin.');
      else setActionError(friendlyError(caught, 'Yedekleme isteği sıraya alınamadı.'));
    } finally { setActionPending(false); }
  }, [actionPending]);

  const content = useMemo(() => {
    if (pending) return <LoadingSkeleton title="Yedekleme yönetimi yükleniyor" rows={4} />;
    if (error || !overview || !policy) {
      return <ResultState status="error" title="Yedekleme bilgileri alınamadı" description={error || 'Sunucudan eksik yanıt alındı.'} action={<button className="secondary-button" type="button" onClick={() => void loadCore()}>Tekrar dene</button>} />;
    }
    const displayStorage = storage ?? {
      provider: 'CLOUDFLARE_R2' as const, bucketAlias: null, prefix: '', enabled: false,
      lastConnectionTestAt: null, lastConnectionTestOk: null,
    };
    if (section === 'backups') return <>
      <section className="backup-section-heading"><h2>Yedek geçmişi</h2><p>İşlem, doğrulama ve uyarı bilgileri ayrı gösterilir.</p></section>
      {historyError && !history ? (
        <ResultState status="error" title="Yedek geçmişi alınamadı" description={historyError} action={<button className="secondary-button" type="button" onClick={() => void loadHistory()}>Tekrar dene</button>} />
      ) : <>
        {historyError && <p className="form-error" role="alert">{historyError}</p>}
        <BackupHistory page={history} loading={historyPending} loadingMore={historyMorePending} onMore={() => loadHistory(history?.nextCursor ?? null, true)} onSelect={selectDetail} selectedId={selectedId} />
      </>}
      <BackupDetail detail={detail} loading={detailPending} onClose={() => { setSelectedId(null); setDetail(null); }} />
    </>;
    if (section === 'schedule') return <ScheduleSection policy={policy} onSaved={(saved) => { setPolicy(saved); void loadCore(); }} />;
    if (section === 'storage') return storageError
      ? <ResultState status="error" title="Depolama durumu alınamadı" description={storageError} action={<button className="secondary-button" type="button" onClick={() => void loadCore()}>Tekrar dene</button>} />
      : <StorageSection storage={displayStorage} onTested={setStorage} />;
    return <OverviewSection overview={overview} health={health} policy={policy} storage={displayStorage} storageUnavailable={Boolean(storageError)} backupNow={backupNow} actionPending={actionPending} actionMessage={actionMessage} actionError={actionError} />;
  }, [actionError, actionMessage, actionPending, detail, detailPending, error, health, history, historyError, historyMorePending, historyPending, loadCore, loadHistory, overview, pending, policy, section, selectedId, selectDetail, storage, storageError]);

  return (
    <main className="workspace settings-workspace backup-recovery-workspace">
      <header className="workspace-heading">
        <div>
          <h1>Yedekleme ve Kurtarma</h1>
          <p className="workspace-heading-copy">Yedekleme durumunu, geçmişini, zamanlamasını ve güvenli depolama bağlantısını yönetin.</p>
        </div>
      </header>
      <SettingsTabs items={SECTION_TABS} activeKey={section} ariaLabel="Yedekleme yönetimi bölümleri" />
      <div className="backup-recovery-content">{content}</div>
    </main>
  );
}
