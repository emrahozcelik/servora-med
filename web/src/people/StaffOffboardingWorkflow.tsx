import { useEffect, useRef, useState, type FormEvent } from 'react';

import { getJobCard } from '../jobs/jobs-api';
import { ApiError } from '../services/api';
import { getCalendarEvent } from '../services/calendar-api';
import { getCustomer } from '../services/crm-api';
import {
  executeStaffOffboarding,
  listStaff,
  previewStaffOffboarding,
  type ManagedUser,
  type StaffOffboardingExecuteInput,
  type StaffOffboardingPlan,
  type StaffOffboardingReasonCode,
  type StaffOffboardingResponse,
  type StaffProfile,
} from '../services/people-api';
import { ConfirmationAction } from '../ui/antd/ConfirmationAction';
import { EmptyState } from '../ui/antd/EmptyState';
import { LoadingSkeleton } from '../ui/antd/LoadingSkeleton';
import { ResponsiveFormDrawer } from '../ui/antd/ResponsiveFormDrawer';
import { ResultState } from '../ui/antd/ResultState';
import {
  buildOffboardingRequest,
  createOffboardingDraft,
  missingOffboardingDecisions,
  type StaffOffboardingDraft,
} from './staff-offboarding-model';
import {
  clearPersistedStaffOffboardingAttempt,
  persistStaffOffboardingAttempt,
  readPersistedStaffOffboardingAttempt,
  retirePersistedStaffOffboardingAttempt,
  type StaffOffboardingAttempt,
} from './staff-offboarding-attempt';

const REASON_LABELS: Readonly<Record<StaffOffboardingReasonCode, string>> = {
  ACCESS_ENDED: 'Erişim artık gerekli değil',
  ROLE_CHANGED: 'Rol veya sorumluluk değişikliği',
  ACCOUNT_CORRECTION: 'Hesap düzeltmesi',
  OTHER_ADMINISTRATIVE: 'Diğer idari neden',
};

type ContextLabels = {
  jobs: Record<string, string>;
  customers: Record<string, string>;
  calendar: Record<string, string>;
};

type Attempt = StaffOffboardingAttempt;
type Confirmation = { kind: 'initial' } | { kind: 'retry'; attempt: Attempt };
type CleanupContinuation =
  | { kind: 'fresh-plan'; message: string }
  | { kind: 'load-error'; title: string; message: string };
type AttemptOwnership =
  | { kind: 'active'; attempt: Attempt }
  | { kind: 'retired-pending-clear'; attempt: Attempt; continuation: CleanupContinuation }
  | null;
type Operation =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'editing'; message?: string }
  | { kind: 'submitting'; attempt: Attempt }
  | { kind: 'reconciling'; attempt: Attempt }
  | { kind: 'retry-ready'; attempt: Attempt; message: string }
  | { kind: 'load-error'; title: string; message: string }
  | { kind: 'recovery-error'; title: string; message: string; cleanupAvailable?: boolean }
  | { kind: 'success'; response: StaffOffboardingResponse };

const EMPTY_CONTEXT: ContextLabels = { jobs: {}, customers: {}, calendar: {} };
const SEMANTIC_CONFLICT_CODES = new Set([
  'STALE_PLAN', 'INVALID_REPLACEMENT_STAFF', 'VERSION_CONFLICT', 'CALENDAR_CONFLICT',
]);

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function ambiguous(error: unknown) {
  return error instanceof ApiError
    && (error.code === 'NETWORK_ERROR' || error.code === 'INVALID_RESPONSE' || error.retryable || error.status >= 500);
}

function shortId(value: string) {
  return value.length > 8 ? value.slice(0, 8) : value;
}

function dateLabel(value: string, includeTime = false) {
  const date = new Date(value);
  return new Intl.DateTimeFormat('tr-TR', {
    day: 'numeric', month: 'long', year: 'numeric',
    ...(includeTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  }).format(date);
}

async function loadContext(plan: StaffOffboardingPlan): Promise<ContextLabels> {
  const jobIds = [...new Set([...plan.jobs.map((item) => item.id), ...plan.followUps.map((item) => item.jobCardId)])];
  const [jobs, customers, calendar] = await Promise.all([
    Promise.allSettled(jobIds.map(async (id) => [id, (await getJobCard(id)).title] as const)),
    Promise.allSettled(plan.customers.map(async (item) => [item.id, (await getCustomer(item.id)).name] as const)),
    Promise.allSettled(plan.calendar.map(async (item) => [item.id, (await getCalendarEvent(item.id)).title] as const)),
  ]);
  const successful = (items: PromiseSettledResult<readonly [string, string]>[]) => Object.fromEntries(
    items.flatMap((item) => item.status === 'fulfilled' ? [item.value] : []),
  );
  return { jobs: successful(jobs), customers: successful(customers), calendar: successful(calendar) };
}

function ReplacementSelect({ name, label, value, replacements, disabled, onChange }: {
  name: string;
  label: string;
  value: string;
  replacements: StaffProfile[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return <label className="offboarding-control"><span>{label}</span><select name={name} value={value}
    onChange={(event) => onChange(event.target.value)} disabled={disabled} required>
    <option value="">Personel seçin</option>
    {replacements.map((profile) => <option key={profile.user.id} value={profile.user.id}>
      {profile.user.name}{profile.title ? ` · ${profile.title}` : ''}
    </option>)}
  </select></label>;
}

function ResponsibilityHeading({ title, id, secondary }: { title: string; id: string; secondary?: string }) {
  return <div className="offboarding-responsibility-heading"><strong>{title}</strong>
    {secondary && <span>{secondary}</span>}<small>Kayıt {shortId(id)}</small></div>;
}

export function StaffOffboardingWorkflow({ target, onCompleted }: {
  target: ManagedUser;
  onCompleted: (response: StaffOffboardingResponse) => void;
}) {
  const [initialRecovery] = useState(readPersistedStaffOffboardingAttempt);
  const recoveredAttempt = initialRecovery.kind === 'valid' && initialRecovery.targetUserId === target.id
    ? initialRecovery.attempt : null;
  const recoveredOwnership: AttemptOwnership = recoveredAttempt
    ? initialRecovery.kind === 'valid' && initialRecovery.status === 'RETIRED'
      ? { kind: 'retired-pending-clear', attempt: recoveredAttempt,
        continuation: { kind: 'fresh-plan', message: 'Yerel işlem kaydı temizlendi. Güncel sorumlulukları yeniden inceleyin.' } }
      : { kind: 'active', attempt: recoveredAttempt }
    : null;
  const recoveryBlocked = initialRecovery.kind === 'invalid'
    || (initialRecovery.kind === 'valid' && initialRecovery.targetUserId !== target.id);
  const [operation, setOperation] = useState<Operation>(() => {
    if (initialRecovery.kind === 'invalid') return { kind: 'recovery-error',
      title: 'Önceki işlem güvenle geri yüklenemedi',
      message: 'Bu sekmede sonucu kesinleşmemiş bir işlem kaydı var ancak bütünlüğü doğrulanamadı. Yeni işlem başlatılmadı.' };
    if (initialRecovery.kind === 'valid' && initialRecovery.targetUserId !== target.id) return { kind: 'recovery-error',
      title: 'Başka bir personel için sonuç bekleniyor',
      message: 'Bu sekmede başka bir personel için sonucu kesinleşmemiş bir işlem bulunuyor. Önce o işlemi doğrulayın.' };
    if (recoveredOwnership?.kind === 'retired-pending-clear') return { kind: 'recovery-error',
      title: 'Önceki işlem yeniden gönderilemez',
      message: 'Önceki işlem yerel olarak temizleniyor. Temizlik tamamlanmadan yeni işlem başlatılamaz.',
      cleanupAvailable: true };
    if (recoveredOwnership?.kind === 'active') return { kind: 'retry-ready', attempt: recoveredOwnership.attempt,
      message: 'Bu personel için sonucu kesinleşmemiş işlem aynı kimlik ve kararlarla geri yüklendi.' };
    return { kind: 'idle' };
  });
  const [plan, setPlan] = useState<StaffOffboardingPlan | null>(null);
  const [draft, setDraft] = useState<StaffOffboardingDraft | null>(null);
  const [replacements, setReplacements] = useState<StaffProfile[]>([]);
  const [context, setContext] = useState<ContextLabels>(EMPTY_CONTEXT);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const finalActionRef = useRef<HTMLButtonElement>(null);
  const attemptOwnershipRef = useRef<AttemptOwnership>(recoveredOwnership);
  const attemptCreationGateRef = useRef(false);
  const submitGateRef = useRef(false);
  const hydrationCleanupStartedRef = useRef(false);
  const previewGenerationRef = useRef(0);
  const currentTargetIdRef = useRef(target.id);
  currentTargetIdRef.current = target.id;
  const [navigationProtected, setNavigationProtected] = useState(initialRecovery.kind !== 'none');
  const open = operation.kind !== 'idle';
  const locked = operation.kind === 'submitting' || operation.kind === 'reconciling';

  useEffect(() => {
    if (!navigationProtected) return;
    const protectUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', protectUnload);
    return () => window.removeEventListener('beforeunload', protectUnload);
  }, [navigationProtected]);

  function isCurrentPreviewGeneration(generation: number, expectedTargetId: string) {
    return generation === previewGenerationRef.current && expectedTargetId === currentTargetIdRef.current;
  }

  async function fetchAuthoritativePlan(message?: string) {
    if (attemptOwnershipRef.current) return;
    const generation = ++previewGenerationRef.current;
    const expectedTargetId = target.id;
    setOperation({ kind: 'loading' });
    setConfirmation(null);
    setPlan(null);
    setDraft(null);
    setReplacements([]);
    setContext(EMPTY_CONTEXT);
    try {
      const [nextPlan, activeStaff] = await Promise.all([
        previewStaffOffboarding(expectedTargetId), listStaff('active'),
      ]);
      const nextDraft = createOffboardingDraft(nextPlan);
      const nextReplacements = activeStaff.filter((profile) => profile.user.id !== expectedTargetId && profile.user.isActive);
      const nextContext = await loadContext(nextPlan);
      if (!isCurrentPreviewGeneration(generation, expectedTargetId)) return;
      setPlan(nextPlan);
      setDraft(nextDraft);
      setReplacements(nextReplacements);
      setContext(nextContext);
      setOperation({ kind: 'editing', ...(message ? { message } : {}) });
    } catch (error) {
      if (!isCurrentPreviewGeneration(generation, expectedTargetId)) return;
      setOperation({ kind: 'load-error', title: 'Sorumluluklar yüklenemedi',
        message: errorMessage(error, 'Güncel Staff sorumlulukları alınamadı. İşlem başlatılmadı.') });
    }
  }

  function closeWorkflow() {
    if (attemptOwnershipRef.current || locked) return;
    previewGenerationRef.current += 1;
    setConfirmation(null);
    setOperation({ kind: 'idle' });
    setPlan(null);
    setDraft(null);
    setReplacements([]);
    setContext(EMPTY_CONTEXT);
  }

  async function cleanupRetiredAttempt() {
    const ownership = attemptOwnershipRef.current;
    if (ownership?.kind !== 'retired-pending-clear') return false;
    setConfirmation(null);
    try {
      retirePersistedStaffOffboardingAttempt(target.id, ownership.attempt);
      clearPersistedStaffOffboardingAttempt();
    } catch {
      setOperation({ kind: 'recovery-error', title: 'İşlem durumu güvenli biçimde temizlenemedi',
        message: 'Yeni bir işlem başlatmadan önce yerel işlem kaydını yeniden temizleyin.', cleanupAvailable: true });
      return false;
    }
    attemptOwnershipRef.current = null;
    setNavigationProtected(false);
    submitGateRef.current = false;
    if (ownership.continuation.kind === 'fresh-plan') {
      await fetchAuthoritativePlan(ownership.continuation.message);
    } else {
      setOperation({ kind: 'load-error', title: ownership.continuation.title, message: ownership.continuation.message });
    }
    return true;
  }

  async function retireAttempt(attempt: Attempt, continuation: CleanupContinuation) {
    const ownership = attemptOwnershipRef.current;
    if (ownership?.kind !== 'active' || ownership.attempt !== attempt) return false;
    attemptOwnershipRef.current = { kind: 'retired-pending-clear', attempt, continuation };
    setConfirmation(null);
    return cleanupRetiredAttempt();
  }

  function resolveAttemptAfterSuccess(attempt: Attempt) {
    try {
      retirePersistedStaffOffboardingAttempt(target.id, attempt);
      clearPersistedStaffOffboardingAttempt();
    } catch { /* authoritative success remains final; an exact replay stays idempotent */ }
    attemptOwnershipRef.current = null;
    setNavigationProtected(false);
  }

  function updateDraft(update: (current: StaffOffboardingDraft) => StaffOffboardingDraft) {
    setDraft((current) => current ? update(current) : current);
  }

  async function refreshAfterConflict(message: string) {
    const ownership = attemptOwnershipRef.current;
    if (ownership?.kind !== 'active') return;
    await retireAttempt(ownership.attempt, { kind: 'fresh-plan', message });
  }

  async function executeAttempt(attempt: Attempt, isReconciliation: boolean) {
    const ownership = attemptOwnershipRef.current;
    if (ownership?.kind !== 'active' || ownership.attempt !== attempt) return;
    if (submitGateRef.current) return;
    submitGateRef.current = true;
    setConfirmation(null);
    setOperation(isReconciliation ? { kind: 'reconciling', attempt } : { kind: 'submitting', attempt });
    try {
      const next = await executeStaffOffboarding(target.id, attempt.request);
      resolveAttemptAfterSuccess(attempt);
      setOperation({ kind: 'success', response: next });
      onCompleted(next);
    } catch (error) {
      if (ambiguous(error) && !isReconciliation) {
        submitGateRef.current = false;
        setOperation({ kind: 'reconciling', attempt });
        await executeAttempt(attempt, true);
      } else if (ambiguous(error) || (error instanceof ApiError && error.code === 'ACTION_IN_PROGRESS')) {
        setOperation({ kind: 'retry-ready', attempt,
          message: error instanceof ApiError && error.code === 'ACTION_IN_PROGRESS'
            ? 'İşlem sunucuda hâlâ sürüyor. Aynı işlem kimliğiyle yeniden doğrulayabilirsiniz.'
            : 'Sunucu sonucu kesinleştirilemedi. Aynı işlem ve işlem kimliği korunuyor.' });
      } else if (error instanceof ApiError && error.code === 'CLIENT_ACTION_REUSED') {
        await refreshAfterConflict('İşlem kimliği sunucu durumuyla eşleşmedi. Güncel sorumlulukları yeniden inceleyip yeni bir onay verin.');
      } else if (error instanceof ApiError && SEMANTIC_CONFLICT_CODES.has(error.code)) {
        await refreshAfterConflict('Sorumluluklar veya uygun personel değişti. Güncel planı yeniden inceleyip tüm kararları tekrar verin.');
      } else if (error instanceof ApiError && error.code === 'USER_ALREADY_INACTIVE') {
        await retireAttempt(attempt, { kind: 'load-error', title: 'Personel zaten devre dışı',
          message: 'Bu girişimle eşleşen tamamlanmış bir sonuç doğrulanamadı. Güncel People durumunu yenileyin.' });
      } else {
        await retireAttempt(attempt, { kind: 'load-error', title: 'İşlem tamamlanamadı',
          message: errorMessage(error, 'Personel devre dışı bırakılamadı. İşlem yapılmadı.') });
      }
    } finally {
      submitGateRef.current = false;
    }
  }

  function requestConfirmation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!plan || !draft || missingOffboardingDecisions(plan, draft).length > 0) return;
    setConfirmation({ kind: 'initial' });
  }

  function confirmExecute() {
    if (!confirmation) return;
    if (confirmation.kind === 'retry') {
      const ownership = attemptOwnershipRef.current;
      if (ownership?.kind !== 'active'
        || ownership.attempt !== confirmation.attempt) return;
      void executeAttempt(ownership.attempt, true);
      return;
    }
    if (!plan || !draft) return;
    if (attemptOwnershipRef.current || attemptCreationGateRef.current || submitGateRef.current) return;
    attemptCreationGateRef.current = true;
    try {
      const attempt: Attempt = { request: buildOffboardingRequest(plan, draft, crypto.randomUUID()) };
      attemptOwnershipRef.current = { kind: 'active', attempt };
      persistStaffOffboardingAttempt(target.id, attempt);
      setNavigationProtected(true);
      void executeAttempt(attempt, false);
    } catch {
      attemptOwnershipRef.current = null;
      setNavigationProtected(false);
      setConfirmation(null);
      setOperation({ kind: 'load-error', title: 'İşlem güvenli biçimde başlatılamadı',
        message: 'İşlem kimliği bu sekmede güvenle saklanamadı. Sunucuya istek gönderilmedi.' });
    } finally {
      attemptCreationGateRef.current = false;
    }
  }

  useEffect(() => {
    if (hydrationCleanupStartedRef.current || recoveredOwnership?.kind !== 'retired-pending-clear') return;
    hydrationCleanupStartedRef.current = true;
    void cleanupRetiredAttempt();
  }, []);

  const missing = plan && draft ? missingOffboardingDecisions(plan, draft) : [];
  const transferBlocked = replacements.length === 0 && Boolean(plan && (
    plan.jobs.length || plan.calendar.length || plan.followUps.length
  ));
  const hasTransferableResponsibilities = Boolean(plan && (
    plan.jobs.length || plan.customers.length || plan.calendar.length || plan.followUps.length || plan.reminders.length
  ));

  return <>
    {target.isActive && <button ref={triggerRef} className="destructive-button command-button" type="button"
      disabled={recoveryBlocked} onClick={() => { void fetchAuthoritativePlan(); }}>Personeli devre dışı bırak</button>
    }
    <ResponsiveFormDrawer open={open} title={`${target.name} · erişim ve sorumluluklar`} rootClassName="offboarding-drawer-root"
      onDismiss={closeWorkflow} returnFocusRef={triggerRef}>
      {operation.kind === 'loading' && <LoadingSkeleton title="Sorumluluklar yükleniyor" rows={5} />}
      {operation.kind === 'load-error' && <ResultState status="error" title={operation.title} description={operation.message}
        action={<div className="offboarding-result-actions"><button className="secondary-button" type="button" onClick={() => { void fetchAuthoritativePlan(); }}>Güncel durumu yeniden yükle</button>
          <button className="ghost-button" type="button" onClick={closeWorkflow}>Kapat</button></div>} />}
      {operation.kind === 'recovery-error' && <ResultState status="warning" title={operation.title} description={operation.message}
        action={operation.cleanupAvailable
          ? <button className="secondary-button" type="button" onClick={() => { void cleanupRetiredAttempt(); }}>Tekrar dene</button>
          : <button className="secondary-button" type="button" onClick={closeWorkflow}>Kapat</button>} />}
      {(operation.kind === 'submitting' || operation.kind === 'reconciling') && <ResultState status="info"
        title={operation.kind === 'submitting' ? 'Erişim sonlandırılıyor' : 'İşlem sonucu doğrulanıyor'}
        description={operation.kind === 'submitting'
          ? 'Sunucu sorumluluk planını yeniden doğruluyor. Bu pencere işlem kesinleşene kadar kapatılamaz.'
          : 'Aynı işlem kimliği ve aynı kararlarla sunucu sonucu doğrulanıyor.'} />}
      {operation.kind === 'retry-ready' && <ResultState status="info" title="İşlem sonucu henüz kesin değil" description={operation.message}
        action={<button className="secondary-button" type="button" onClick={() => setConfirmation({ kind: 'retry', attempt: operation.attempt })}>
          Aynı işlemi yeniden doğrula
        </button>} />}
      {operation.kind === 'success' && <ResultState status="success" title="Personel devre dışı bırakıldı"
        description={<div className="offboarding-success-copy"><p>Erişim sonlandırıldı, aktif oturumlar kapatıldı ve geçmiş kayıtlar korundu.</p>
          <ul><li>{operation.response.summary.jobCardsTransferred} aktif iş aktarıldı</li>
            <li>{operation.response.summary.customersReassigned} müşteri aktarıldı</li>
            <li>{operation.response.summary.customersUnassigned} müşteri ataması kaldırıldı</li>
            <li>{operation.response.summary.calendarAssignmentsTransferred} takvim ataması aktarıldı</li>
            <li>{operation.response.summary.followUpAssignmentsTransferred} takip ataması aktarıldı</li>
            <li>{operation.response.summary.remindersHandled} hatırlatıcı işlendi</li></ul></div>}
        action={<button className="primary-button compact-button" type="button" onClick={closeWorkflow}>Tamam</button>} />}
      {operation.kind === 'editing' && plan && draft && <form className="offboarding-form" onSubmit={requestConfirmation}>
        {operation.message && <div className="offboarding-alert" role="status">{operation.message}</div>}
        <div className="offboarding-intro"><p>Sunucu, aktif sorumlulukları bu an için doğruladı. Erişim sonlanmadan önce her kayıt için açık karar verin.</p>
          <dl><div><dt>Aktif oturum</dt><dd>{plan.sessions.activeCount}</dd></div>
            <div><dt>İş konuşması</dt><dd>{plan.jobConversations.length}</dd></div></dl>
          <p className="offboarding-preservation-note">İşlem geçmişi ve denetim kayıtları korunur.</p></div>
        <label className="offboarding-control"><span>İdari neden</span><select name="reasonCode" value={draft.reasonCode}
          onChange={(event) => updateDraft((current) => ({ ...current, reasonCode: event.target.value as StaffOffboardingReasonCode | '' }))} required>
          <option value="">Neden seçin</option>{Object.entries(REASON_LABELS).map(([code, label]) => <option key={code} value={code}>{label}</option>)}
        </select></label>
        {!hasTransferableResponsibilities && <EmptyState headingLevel={3}
          title="Aktarılması gereken aktif sorumluluk bulunmuyor."
          description="Erişim sonlandırıldığında aktif oturumlar kapatılır; geçmiş kayıtlar korunur." />}
        {plan.jobs.length > 0 && <section className="offboarding-section"><h3>Aktif işler</h3>{plan.jobs.map((item) => <div className="offboarding-responsibility" key={item.id}>
          <ResponsibilityHeading title={context.jobs[item.id] ?? 'Aktif iş'} id={item.id} secondary={`Durum: ${item.status}`} />
          <ReplacementSelect name={`job-${item.id}`} label="Yeni sorumlu" value={draft.jobs[item.id] ?? ''} replacements={replacements} disabled={false}
            onChange={(value) => updateDraft((current) => ({ ...current, jobs: { ...current.jobs, [item.id]: value } }))} />
        </div>)}</section>}
        {plan.customers.length > 0 && <section className="offboarding-section"><h3>Müşteriler</h3>{plan.customers.map((item) => {
          const decision = draft.customers[item.id];
          return <div className="offboarding-responsibility" key={item.id}><ResponsibilityHeading title={context.customers[item.id] ?? 'Müşteri kaydı'} id={item.id} />
            <label className="offboarding-control"><span>Müşteri ataması</span><select name={`customer-action-${item.id}`} value={decision?.action ?? ''}
              onChange={(event) => updateDraft((current) => ({ ...current, customers: { ...current.customers,
                [item.id]: event.target.value === 'REASSIGN' ? { action: 'REASSIGN' } : { action: 'UNASSIGN' } } }))} required>
              <option value="">Karar seçin</option><option value="REASSIGN">Başka personele aktar</option><option value="UNASSIGN">Atamayı kaldır</option>
            </select></label>
            {decision?.action === 'REASSIGN' && <ReplacementSelect name={`customer-replacement-${item.id}`} label="Yeni sorumlu"
              value={decision.replacementUserId ?? ''} replacements={replacements} disabled={false}
              onChange={(value) => updateDraft((current) => ({ ...current, customers: { ...current.customers,
                [item.id]: { action: 'REASSIGN', replacementUserId: value } } }))} />}
          </div>;
        })}</section>}
        {plan.calendar.length > 0 && <section className="offboarding-section"><h3>Takvim atamaları</h3>{plan.calendar.map((item) => <div className="offboarding-responsibility" key={item.id}>
          <ResponsibilityHeading title={context.calendar[item.id] ?? 'Takvim kaydı'} id={item.id} secondary={`${dateLabel(item.startsAt, true)} – ${dateLabel(item.endsAt, true)}`} />
          <ReplacementSelect name={`calendar-${item.id}`} label="Yeni sorumlu" value={draft.calendar[item.id] ?? ''} replacements={replacements} disabled={false}
            onChange={(value) => updateDraft((current) => ({ ...current, calendar: { ...current.calendar, [item.id]: value } }))} />
        </div>)}</section>}
        {plan.followUps.length > 0 && <section className="offboarding-section"><h3>Takip atamaları</h3>{plan.followUps.map((item) => <div className="offboarding-responsibility" key={item.jobCardId}>
          <ResponsibilityHeading title={context.jobs[item.jobCardId] ?? 'Planlı takip'} id={item.jobCardId} secondary={dateLabel(item.proposedAt, true)} />
          <ReplacementSelect name={`follow-up-${item.jobCardId}`} label="Yeni sorumlu" value={draft.followUps[item.jobCardId] ?? ''} replacements={replacements} disabled={false}
            onChange={(value) => updateDraft((current) => ({ ...current, followUps: { ...current.followUps, [item.jobCardId]: value } }))} />
        </div>)}</section>}
        {plan.reminders.length > 0 && <section className="offboarding-section"><h3>Hatırlatıcılar</h3>{plan.reminders.map((item) => {
          const decision = draft.reminders[item.id];
          return <div className="offboarding-responsibility" key={item.id}><ResponsibilityHeading title={`${dateLabel(item.remindAt, true)} hatırlatıcısı`} id={item.id} secondary={item.state === 'CLAIMED' ? 'İşleniyor' : 'Bekliyor'} />
            <label className="offboarding-control"><span>Hatırlatıcı kararı</span><select name={`reminder-action-${item.id}`} value={decision?.action ?? ''}
              onChange={(event) => updateDraft((current) => ({ ...current, reminders: { ...current.reminders,
                [item.id]: event.target.value === 'TRANSFER' ? { action: 'TRANSFER' } : { action: 'CANCEL' } } }))} required>
              <option value="">Karar seçin</option><option value="TRANSFER">Başka personele aktar</option><option value="CANCEL">İptal et</option>
            </select></label>
            {decision?.action === 'TRANSFER' && <ReplacementSelect name={`reminder-replacement-${item.id}`} label="Yeni alıcı"
              value={decision.replacementUserId ?? ''} replacements={replacements} disabled={false}
              onChange={(value) => updateDraft((current) => ({ ...current, reminders: { ...current.reminders,
                [item.id]: { action: 'TRANSFER', replacementUserId: value } } }))} />}
          </div>;
        })}</section>}
        {transferBlocked && <div className="offboarding-alert" role="alert">Aktarılması zorunlu sorumluluklar için başka bir aktif Staff bulunamadı.</div>}
        <div className="form-actions"><button className="secondary-button" type="button" onClick={closeWorkflow}>Vazgeç</button>
          <button ref={finalActionRef} className="destructive-button" type="submit" disabled={missing.length > 0 || transferBlocked}>Kararları onayla</button></div>
      </form>}
    </ResponsiveFormDrawer>
    <ConfirmationAction open={confirmation !== null} title="Personel devre dışı bırakılsın mı?"
      description="Erişim sonlandırılır, aktif oturumlar kapatılır ve seçtiğiniz sorumluluk kararları uygulanır. İşlem geçmişi korunur."
      details={confirmation?.kind === 'retry' ? [
        `${confirmation.attempt.request.jobDecisions.length} aktif iş`,
        `${confirmation.attempt.request.customerDecisions.length} müşteri`,
        `${confirmation.attempt.request.calendarDecisions.length} takvim ataması`,
        `${confirmation.attempt.request.followUpDecisions.length} takip ataması`,
        `${confirmation.attempt.request.reminderDecisions.length} hatırlatıcı`,
        `Neden: ${REASON_LABELS[confirmation.attempt.request.reasonCode]}`,
      ] : plan && draft ? [
        `${plan.jobs.length} aktif iş`, `${plan.customers.length} müşteri`, `${plan.calendar.length} takvim ataması`,
        `${plan.followUps.length} takip ataması`, `${plan.reminders.length} hatırlatıcı`,
        `Neden: ${draft.reasonCode ? REASON_LABELS[draft.reasonCode] : 'Seçilmedi'}`,
      ] : []}
      confirmLabel="Erişimi sonlandır" pending={locked} pendingLabel="İşlem doğrulanıyor…" destructive
      onConfirm={confirmExecute} onCancel={() => setConfirmation(null)} returnFocusRef={finalActionRef} fallbackFocusRef={triggerRef} />
  </>;
}
