import { useEffect, useRef, useState, type FormEvent } from 'react';

import { ApiError, type CurrentUser } from './services/api';
import { listStaff, type StaffProfile } from './services/people-api';
import { createRequestGate } from './services/request-gate';
import { PageHeader } from './ui/PageHeader';
import { ServoraSelect } from './ui/antd';
import { isDefinitiveMutationError } from './jobs/mutation-attempt-error';
import {
  MAX_BULK_TARGETS,
  MAX_RECURRENCE_TARGETS,
  bulkCreateWeeklyReportRecurrences,
  bulkRequestWeeklyReports,
  createWeeklyReport,
  getWeeklyReportReference,
  type WeeklyReportBulkRequestInput,
  type WeeklyReportBulkResult,
  type WeeklyReportCreateInput,
  type WeeklyReportRecurrenceBulkCreateInput,
  type WeeklyReportRecurrenceBulkCreateResult,
  type WeeklyReportReference,
} from './jobs/weekly-report-api';
import {
  WEEKLY_REPORT_PRESET_QUESTIONS,
  WeeklyReportQuestionEditor,
  collectManagerQuestions,
  nextCustomQuestionKey,
  promptCodePoints,
  type CustomQuestionDraft,
} from './jobs/WeeklyReportQuestionEditor';
import { WeeklyReportRecurrenceManager } from './WeeklyReportRecurrences';

type LoadState = 'idle' | 'loading' | 'ready' | 'error';
type FieldErrors = {
  periodStart?: string; staffUserIds?: string; questions?: string;
};
/**
 * A frozen attempt. `single` is the STAFF self-create command; `bulk` is the
 * MANAGER/ADMIN multi-target one-time command; `recurring` is the
 * MANAGER/ADMIN automatic-rule command. All three retain the exact request that
 * was sent so an ambiguous outcome can only ever be retried verbatim.
 */
type CreateAttempt =
  | { kind: 'single'; input: WeeklyReportCreateInput }
  | { kind: 'bulk'; input: WeeklyReportBulkRequestInput }
  | { kind: 'recurring'; input: WeeklyReportRecurrenceBulkCreateInput };

/** Manager-only create mode. STAFF has no mode switch and never sees it. */
type CreateMode = 'single' | 'recurring';

const MONDAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function WeeklyReportCreateScreen({ user, onCancel, onCreated }: {
  user: CurrentUser;
  onCancel: () => void;
  onCreated: (jobCardId: string) => void;
}) {
  const isStaff = user.role === 'STAFF';
  const [mode, setMode] = useState<CreateMode>('single');
  const [periodStart, setPeriodStart] = useState('');
  const [selectedStaffIds, setSelectedStaffIds] = useState<string[]>([]);
  const [selectedPresetKeys, setSelectedPresetKeys] = useState<ReadonlySet<string>>(new Set());
  const [customQuestions, setCustomQuestions] = useState<CustomQuestionDraft[]>([]);
  const [questionsError, setQuestionsError] = useState<string | null>(null);
  const [instructions, setInstructions] = useState('');
  const [staff, setStaff] = useState<StaffProfile[]>([]);
  const [staffState, setStaffState] = useState<LoadState>(isStaff ? 'ready' : 'loading');
  const [reference, setReference] = useState<WeeklyReportReference | null>(null);
  const [referenceState, setReferenceState] = useState<LoadState>('loading');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [existingJobId, setExistingJobId] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [ambiguous, setAmbiguous] = useState(false);
  const [bulkResult, setBulkResult] = useState<WeeklyReportBulkResult | null>(null);
  const [recurrenceResult, setRecurrenceResult] = useState<WeeklyReportRecurrenceBulkCreateResult | null>(null);
  const attemptRef = useRef<CreateAttempt | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const gate = useRef(createRequestGate());
  // Separate request gate: the canonical-week load and the staff list load are
  // independent reads and must not cancel each other.
  const referenceGate = useRef(createRequestGate());

  async function loadReference() {
    const generation = referenceGate.current.next();
    setReferenceState('loading');
    try {
      const canonical = await getWeeklyReportReference();
      if (!referenceGate.current.isCurrent(generation)) return;
      setReference(canonical);
      setReferenceState('ready');
      // Prefill only when the user has not already picked a week.
      setPeriodStart((current) => (current ? current : canonical.periodStart));
    } catch {
      if (!referenceGate.current.isCurrent(generation)) return;
      setReferenceState('error');
    }
  }

  async function loadActiveStaff() {
    const generation = gate.current.next();
    setStaffState('loading');
    try {
      const profiles = (await listStaff('active')).filter((profile) => profile.user.isActive);
      if (!gate.current.isCurrent(generation)) return;
      setStaff(profiles); setStaffState('ready');
    } catch {
      if (!gate.current.isCurrent(generation)) return;
      setStaff([]); setStaffState('error');
    }
  }

  useEffect(() => {
    if (isStaff) return;
    void loadActiveStaff();
  // The signed-in identity owns the initial assignee policy.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.id, user.role]);

  useEffect(() => () => { gate.current.next(); referenceGate.current.next(); }, []);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  useEffect(() => {
    void loadReference();
  // Canonical default week is loaded once per mount from the organization calendar.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  // Recurring mode is a manager-only create mode; STAFF never enters it. The
  // server owns both ceilings — these mirrors only prevent an oversized command
  // from leaving the browser.
  const isRecurring = !isStaff && mode === 'recurring';
  const targetCap = isRecurring ? MAX_RECURRENCE_TARGETS : MAX_BULK_TARGETS;
  const activeStaffCount = staff.length;
  const selectedCount = selectedStaffIds.length;

  function togglePreset(key: string, checked: boolean) {
    setSelectedPresetKeys((current) => {
      const next = new Set(current);
      if (checked) next.add(key); else next.delete(key);
      return next;
    });
  }

  function addCustomQuestion() {
    // The key is minted once at add-time against the keys already owned by
    // this screen (preset semantics + existing rows) and never renumbered, so
    // a frozen attempt replays the exact same question keys on an ambiguous
    // retry.
    setCustomQuestions((current) => {
      const key = nextCustomQuestionKey([
        ...WEEKLY_REPORT_PRESET_QUESTIONS.map((preset) => preset.key),
        ...current.map((question) => question.key),
      ]);
      return [...current, { key, prompt: '' }];
    });
  }

  function changeCustomPrompt(key: string, prompt: string) {
    setCustomQuestions((current) => current.map((question) => (
      question.key === key ? { ...question, prompt } : question
    )));
  }

  function removeCustomQuestion(key: string) {
    setCustomQuestions((current) => current.filter((question) => question.key !== key));
  }

  /**
   * Select-all uses only the already-loaded active STAFF list, never invents
   * ids, and stays inside the server command cap. Over the cap the request
   * fails VISIBLY with an explanation instead of pretending everything was
   * selected or silently choosing an arbitrary subset.
   */
  function selectAllStaff() {
    if (activeStaffCount > targetCap) {
      setFieldErrors((current) => ({
        ...current,
        staffUserIds: `Tek işlemde en fazla ${targetCap} personel seçilebilir; `
          + `${activeStaffCount} aktif personel bu sınırın üzerinde. `
          + 'Lütfen personeli elle seçin.',
      }));
      return;
    }
    const ids = staff.map((profile) => profile.user.id);
    setSelectedStaffIds([...new Set(ids)]);
    setFieldErrors((current) => ({ ...current, staffUserIds: undefined }));
  }

  function clearStaffSelection() {
    setSelectedStaffIds([]);
    setFieldErrors((current) => ({ ...current, staffUserIds: undefined }));
  }

  /**
   * Selection is a set: the multi-select can never produce a repeated id, and
   * the server's ceiling is enforced by prevention, so an oversized command can
   * never leave the browser. The notice states explicitly that the extra picks
   * were not added.
   */
  function selectStaff(next: string[]) {
    if (next.length > targetCap) {
      setSelectedStaffIds(next.slice(0, targetCap));
      setFieldErrors((current) => ({
        ...current,
        staffUserIds: `Tek işlemde en fazla ${targetCap} personel seçilebilir; fazlası eklenmedi.`,
      }));
      return;
    }
    setSelectedStaffIds(next);
    setFieldErrors((current) => ({ ...current, staffUserIds: undefined }));
  }

  function collectFieldErrors(): FieldErrors {
    const nextErrors: FieldErrors = {};
    if (!MONDAY_PATTERN.test(periodStart)) nextErrors.periodStart = 'Rapor haftası (Pazartesi) seçin.';
    // Recurring rules may start in the current or a future week only. The
    // comparison uses the canonical organization-local current week supplied by
    // the server — never the device clock — so it matches the server's rule.
    if (isRecurring && reference && MONDAY_PATTERN.test(periodStart)
      && periodStart < reference.periodStart) {
      nextErrors.periodStart = 'Başlangıç haftası geçmişte olamaz.';
    }
    // selectedStaffIds can never exceed the ceiling (selectStaff caps it), so
    // the only remaining rule is the lower bound.
    if (!isStaff && selectedStaffIds.length === 0) {
      nextErrors.staffUserIds = 'Aktif bir sorumlu personel seçin.';
    }
    const questions = collectManagerQuestions(selectedPresetKeys, customQuestions);
    if (questions.length > 50) {
      nextErrors.questions = `En fazla 50 yönetici sorusu eklenebilir.`;
    }
    for (const question of customQuestions) {
      const prompt = question.prompt.trim();
      if (!prompt) nextErrors.questions = 'Özel soru boş olamaz; boş satırı kaldırın.';
      else if (promptCodePoints(prompt) > 500) nextErrors.questions = 'Özel soru en fazla 500 karakter olabilir.';
    }
    return nextErrors;
  }

  /**
   * The frozen question payload: selected presets (canonical order) plus
   * non-empty custom questions (UI order), with stable semantic keys. The same
   * ambiguous retry sends the exact same list because state, not the render,
   * owns it.
   */
  function managerQuestionPayload() {
    const questions = collectManagerQuestions(selectedPresetKeys, customQuestions);
    return questions.length > 0 ? { questions } : {};
  }

  async function sendAttempt(attempt: CreateAttempt) {
    setPending(true); setError(''); setExistingJobId(null);
    try {
      if (attempt.kind === 'single') {
        const created = await createWeeklyReport(attempt.input);
        attemptRef.current = null; setAmbiguous(false);
        onCreated(created.jobCardId);
        return;
      }
      // Recurring mode NEVER sends a one-time request: the rule is the only
      // writer, so choosing the current week cannot create two competing
      // reports. The worker produces the current week's report on its next run.
      if (attempt.kind === 'recurring') {
        const created = await bulkCreateWeeklyReportRecurrences(attempt.input);
        attemptRef.current = null; setAmbiguous(false);
        setRecurrenceResult(created);
        return;
      }
      const result = await bulkRequestWeeklyReports(attempt.input);
      attemptRef.current = null; setAmbiguous(false);
      // Exactly one target behaves like a single request: go straight to the
      // canonical report. Many targets get an outcome summary instead of an
      // arbitrary navigation.
      if (result.items.length === 1) { onCreated(result.items[0]!.jobCardId); return; }
      setBulkResult(result);
    } catch (caught) {
      const definitive = isDefinitiveMutationError(caught);
      if (definitive) { attemptRef.current = null; setAmbiguous(false); }
      else setAmbiguous(true);
      if (caught instanceof ApiError && caught.code === 'WEEKLY_REPORT_ALREADY_EXISTS') {
        const jobId = caught.details?.jobCardId;
        setExistingJobId(typeof jobId === 'string' ? jobId : null);
      }
      setError(caught instanceof Error
        ? caught.message
        : 'Haftalık rapor isteği oluşturulamadı. Tekrar deneyin.');
    } finally { setPending(false); }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    if (ambiguous) { const attempt = attemptRef.current; if (attempt) await sendAttempt(attempt); return; }
    const nextErrors = collectFieldErrors();
    setFieldErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      setError('Raporu oluşturmadan önce işaretli alanları düzeltin.');
      return;
    }
    const trimmedInstructions = instructions.trim();
    const questionPayload = isStaff ? {} : managerQuestionPayload();
    const instructionPayload = trimmedInstructions ? { instructions: trimmedInstructions } : {};
    // Three distinct commands, three distinct payload shapes. No command
    // carries a client due date: the server derives the canonical next-Monday
    // deadline, and a recurring command sends `startPeriodStart` (a rule's
    // first week) and never a one-time request.
    const attempt: CreateAttempt = isStaff
      ? { kind: 'single', input: {
          // STAFF self-create: no command carries a dueDate — the deadline is
          // server-canonical (periodEnd + 1) and the request shapes do not
          // even accept one (also: never questions on a self-create).
          clientActionId: crypto.randomUUID(), periodStart, ...questionPayload, ...instructionPayload,
        } }
      : isRecurring
        ? { kind: 'recurring', input: {
            clientActionId: crypto.randomUUID(),
            staffUserIds: [...selectedStaffIds],
            startPeriodStart: periodStart,
            ...questionPayload,
            ...instructionPayload,
          } }
        : { kind: 'bulk', input: {
            clientActionId: crypto.randomUUID(),
            periodStart,
            ...questionPayload,
            ...instructionPayload,
            staffUserIds: [...selectedStaffIds],
          } };
    attemptRef.current = attempt;
    await sendAttempt(attempt);
  }

  const staffUnavailable = !isStaff && staffState !== 'ready';

  if (recurrenceResult) {
    const nameById = new Map(staff.map((profile) => [profile.user.id, profile.user.name]));
    const created = recurrenceResult.items.filter((item) => item.outcome === 'created').length;
    const existing = recurrenceResult.items.length - created;
    return <main className="task-create">
      <PageHeader eyebrow="Sonuç" description="Otomatik haftalık rapor" fallbackTitle="Yeni iş" />
      <section className="task-form" aria-labelledby="weekly-recurrence-result-title">
        <h2 id="weekly-recurrence-result-title">
          {recurrenceResult.items.length} otomatik kural işlendi
        </h2>
        <p className="field-status" role="status">
          <span id="weekly-recurrence-created">{created} oluşturuldu</span>
          {' · '}
          <span id="weekly-recurrence-existing">{existing} zaten mevcuttu</span>
        </p>
        <p className="form-help">
          Her personel için her hafta otomatik rapor oluşturulur. Başlangıç haftası:{' '}
          {recurrenceResult.startPeriodStart}. Teslim son tarihi, dönemi izleyen Pazartesi&apos;dir.
        </p>
        <ul className="activity-list" id="weekly-recurrence-result-items">
          {recurrenceResult.items.map((item) => (
            <li key={item.recurrenceId}>
              <span className="recurrence-result-name">
                {nameById.get(item.staffUserId) ?? item.staffUserId}
              </span>
              <span className="recurrence-result-outcome">
                {item.outcome === 'created' ? 'Oluşturuldu' : 'Zaten mevcut'}
              </span>
              <span className="recurrence-result-next">
                Sonraki rapor haftası: {item.nextPeriodStart}
              </span>
            </li>
          ))}
        </ul>
        <div className="form-actions">
          <button className="primary-button" type="button" onClick={onCancel}>Kapat</button>
        </div>
      </section>
    </main>;
  }

  if (bulkResult) {
    const nameById = new Map(staff.map((profile) => [profile.user.id, profile.user.name]));
    const created = bulkResult.items.filter((item) => item.outcome === 'created').length;
    const existing = bulkResult.items.length - created;
    return <main className="task-create">
      <PageHeader eyebrow="Sonuç" description="Haftalık rapor" fallbackTitle="Yeni iş" />
      <section className="task-form" aria-labelledby="weekly-bulk-result-title">
        <h2 id="weekly-bulk-result-title">
          {bulkResult.items.length} haftalık rapor isteği işlendi
        </h2>
        <p className="field-status" role="status">
          <span id="weekly-bulk-created">{created} oluşturuldu</span>
          {' · '}
          <span id="weekly-bulk-existing">{existing} zaten mevcuttu</span>
        </p>
        <p className="form-help">
          Her personel için ayrı bir haftalık rapor oluşturuldu. Rapor haftası: {bulkResult.periodStart} – {bulkResult.periodEnd}.
        </p>
        <ul className="activity-list" id="weekly-bulk-result-items">
          {bulkResult.items.map((item) => (
            <li key={item.jobCardId}>
              <span className="bulk-result-name">
                {nameById.get(item.staffUserId) ?? item.staffUserId}
              </span>
              <span className="bulk-result-outcome">
                {item.outcome === 'created' ? 'Oluşturuldu' : 'Zaten mevcut'}
              </span>
              <a href={`/jobs/${encodeURIComponent(item.jobCardId)}`}>Raporu aç</a>
            </li>
          ))}
        </ul>
        <div className="form-actions">
          <button className="primary-button" type="button" onClick={onCancel}>Kapat</button>
        </div>
      </section>
    </main>;
  }

  return <main className="task-create">
    <PageHeader eyebrow="Yeni kayıt" description="Haftalık rapor" fallbackTitle="Yeni iş" />
    <p className="form-intro">{isStaff
      ? 'Kendi haftalık raporunuz için bir istek oluşturun. Rapor haftası Pazartesi başlar; teslim son tarihi dönemi izleyen Pazartesi günüdür.'
      : isRecurring
        ? `Seçilen her personel için her hafta otomatik haftalık rapor oluşturulur (en fazla ${MAX_RECURRENCE_TARGETS} personel). Rapor haftası Pazartesi başlar; teslim son tarihi her hafta dönemi izleyen Pazartesi günüdür.`
        : `Seçilen her personel için ayrı bir haftalık rapor isteği oluşturun (en fazla ${MAX_BULK_TARGETS} personel). Rapor haftası Pazartesi başlar; teslim son tarihi dönemi izleyen Pazartesi günüdür.`}</p>
    {!isStaff && <div className="field-group" role="radiogroup" aria-label="Rapor türü" id="weekly-mode">
      <span className="field-label">Rapor türü</span>
      <div className="mode-switch">
        <button type="button" role="radio" id="weekly-mode-single" aria-checked={mode === 'single'}
          className={mode === 'single' ? 'primary-button' : 'secondary-button'}
          disabled={pending || ambiguous}
          onClick={() => setMode('single')}>Tek seferlik</button>
        <button type="button" role="radio" id="weekly-mode-recurring" aria-checked={mode === 'recurring'}
          className={mode === 'recurring' ? 'primary-button' : 'secondary-button'}
          disabled={pending || ambiguous}
          onClick={() => setMode('recurring')}>Her hafta otomatik</button>
      </div>
      {!isStaff && <p className="form-help" id="weekly-mode-help">
        Tek seferlik rapor oluşturmak mevcut otomatik kuralı kapatmaz; aktif kural
        duraklatılana kadar çalışmayı sürdürür.
      </p>}
    </div>}
    {error && <div className="form-error" role="alert" tabIndex={-1} ref={errorRef}>
      {error}
      {existingJobId && <>{' '}<a href={`/jobs/${encodeURIComponent(existingJobId)}`}>Mevcut rapora git</a></>}
    </div>}
    <form className="task-form" onSubmit={submit} noValidate>
      <fieldset disabled={pending || ambiguous}>
        <div className="field-group">
          <label htmlFor="weekly-period">{isRecurring
            ? 'Başlangıç haftası (Pazartesi)'
            : 'Rapor haftası (Pazartesi)'}</label>
          <input id="weekly-period" name="periodStart" type="date" required value={periodStart}
            aria-invalid={fieldErrors.periodStart ? true : undefined}
            onChange={(event) => setPeriodStart(event.target.value)} />
          {referenceState === 'loading' && <span className="field-status" role="status">Rapor haftası organizasyon takviminden yükleniyor…</span>}
          {referenceState === 'ready' && reference && <span className="field-status" role="status">
            Varsayılan hafta organizasyon takvimine göre belirlendi ({reference.timezone}).
          </span>}
          {referenceState === 'error' && <span className="field-error" role="alert">
            Organizasyon takvimi yüklenemedi; rapor haftasını elle seçin.{' '}
            <button className="inline-action" type="button" onClick={() => void loadReference()}>Tekrar dene</button>
          </span>}
          {fieldErrors.periodStart && <span className="field-error">{fieldErrors.periodStart}</span>}
          {isRecurring && reference && periodStart === reference.periodStart
            && <p className="field-status" role="status" id="weekly-recurring-current-week">
              Bu hafta başlangıç olarak seçildi: bu haftanın raporu otomatik olarak oluşturulacak.
              Ayrıca tek seferlik istek gönderilmez.
            </p>}
        </div>
        {isStaff
          ? <div className="field-group"><span className="field-label">Sorumlu personel</span>
              <p className="fixed-field-value">{user.name}</p></div>
          : <div className="field-group">
              <label htmlFor="weekly-assignees">Sorumlu personel (birden fazla seçilebilir)</label>
              <ServoraSelect
                id="weekly-assignees"
                mode="multiple"
                showSearch
                optionFilterProp="label"
                placeholder="Personel arayın veya seçin"
                value={selectedStaffIds}
                disabled={pending || ambiguous || staffState !== 'ready'}
                maxTagCount={5}
                aria-label="Sorumlu personel"
                aria-invalid={fieldErrors.staffUserIds ? true : undefined}
                options={staff.map((profile) => ({
                  value: profile.user.id, label: profile.user.name,
                }))}
                onChange={(next: string[]) => selectStaff(next)}
              />
              <div className="field-row" id="weekly-staff-bulk-actions">
                <button className="secondary-button" type="button" id="weekly-select-all-staff"
                  disabled={pending || ambiguous || staffState !== 'ready' || activeStaffCount === 0}
                  onClick={selectAllStaff}>Tümünü seç</button>
                <button className="secondary-button" type="button" id="weekly-clear-staff-selection"
                  disabled={pending || ambiguous || staffState !== 'ready' || selectedCount === 0}
                  onClick={clearStaffSelection}>Seçimi temizle</button>
                <span className="field-status" role="status" id="weekly-assignee-count">
                  {selectedCount} personel seçildi
                </span>
              </div>
              {staffState === 'loading' && <span className="field-status" role="status">Personel listesi yükleniyor…</span>}
              {staffState === 'error' && <span className="field-error" role="alert">Personel listesi yüklenemedi.{' '}
                <button className="inline-action" type="button" onClick={() => void loadActiveStaff()}>Tekrar dene</button></span>}
              {fieldErrors.staffUserIds && <span className="field-error">{fieldErrors.staffUserIds}</span>}
            </div>}
        {!isStaff && <WeeklyReportQuestionEditor
          idPrefix="weekly"
          locked={pending || ambiguous}
          selectedPresetKeys={selectedPresetKeys}
          onTogglePreset={togglePreset}
          customQuestions={customQuestions}
          onChangeCustomPrompt={changeCustomPrompt}
          onAddCustom={addCustomQuestion}
          onRemoveCustom={removeCustomQuestion}
          helpText={isRecurring
            ? 'Seçili sorular her personel için ayrı ayrı saklanır ve yalnızca bundan sonra oluşturulacak raporlarda kullanılır.'
            : 'Seçili sorular her personel için ayrı ayrı dondurulur.'}
          error={fieldErrors.questions}
        />}
        <div className="field-group">
          <label htmlFor="weekly-instructions">Talep notu (isteğe bağlı)</label>
          <textarea id="weekly-instructions" name="instructions" rows={3} value={instructions} maxLength={2000}
            onChange={(event) => setInstructions(event.target.value)} />
        </div>
      </fieldset>
      <div className="form-actions">
        <button className="secondary-button" type="button" onClick={onCancel} disabled={pending || ambiguous}>Vazgeç</button>
        {ambiguous && <button className="secondary-button" type="button" disabled={pending}
          onClick={() => { const attempt = attemptRef.current; if (attempt) void sendAttempt(attempt); }}>Özgün isteği tekrar dene</button>}
        <button className="primary-button" type="submit" disabled={pending || ambiguous || staffUnavailable}>
          {pending
            ? (isRecurring ? 'Otomatik kurallar oluşturuluyor…' : 'Rapor isteği gönderiliyor…')
            : isStaff ? 'Raporu oluştur'
              : isRecurring ? 'Otomatik kuralları oluştur'
                : 'Rapor isteklerini oluştur'}
        </button>
      </div>
    </form>
    {!isStaff && <WeeklyReportRecurrenceManager user={user} />}
  </main>;
}
