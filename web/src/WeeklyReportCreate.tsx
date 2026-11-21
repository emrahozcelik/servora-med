import { useEffect, useRef, useState, type FormEvent } from 'react';

import { ApiError, type CurrentUser } from './services/api';
import { listStaff, type StaffProfile } from './services/people-api';
import { createRequestGate } from './services/request-gate';
import { PageHeader } from './ui/PageHeader';
import { ServoraSelect } from './ui/antd';
import {
  addCalendarDays,
  formatCalendarDayWithWeekday,
  formatCalendarRange,
  isMondayDateKey,
} from './ui/calendar-date';
import { isDefinitiveMutationError } from './jobs/mutation-attempt-error';
import {
  MAX_BULK_TARGETS,
  bulkRequestWeeklyReports,
  createWeeklyReport,
  getWeeklyReportReference,
  type WeeklyReportBulkRequestInput,
  type WeeklyReportBulkResult,
  type WeeklyReportCreateInput,
  type WeeklyReportReference,
} from './jobs/weekly-report-api';
import {
  WeeklyReportQuestionEditor,
  collectManagerQuestions,
  nextCustomQuestionKey,
  promptCodePoints,
  type CustomQuestionDraft,
} from './jobs/WeeklyReportQuestionEditor';

type LoadState = 'idle' | 'loading' | 'ready' | 'error';
type WeekChoiceMode = 'this_week' | 'last_week' | 'custom';
type FieldErrors = {
  periodStart?: string; staffUserIds?: string; questions?: string;
};
type ExistingReportNotice = {
  jobCardId: string;
  message: string;
  hint: string;
};
/**
 * A frozen attempt. `single` is the STAFF self-create command; `bulk` is the
 * MANAGER/ADMIN multi-target one-time command. Both retain the exact request
 * that was sent so an ambiguous outcome can only ever be retried verbatim.
 */
type CreateAttempt =
  | { kind: 'single'; input: WeeklyReportCreateInput }
  | { kind: 'bulk'; input: WeeklyReportBulkRequestInput };

const CANCELLED_REPLACE_HINT =
  'İptal edilmiş bir rapor varsa, yalnızca bir Admin kaldırdıktan sonra yerine yeni rapor oluşturulabilir.';

function previewDueDate(periodStart: string, reference: WeeklyReportReference | null): string {
  const mondayDeadline = addCalendarDays(periodStart, 7);
  if (!reference) return mondayDeadline;
  // WR-WEEK D9: max(periodEnd + 2, organization-local creation date).
  return mondayDeadline < reference.today ? reference.today : mondayDeadline;
}

export function WeeklyReportCreateScreen({ user, onCancel, onCreated, initialPeriodStart, initialStaffUserId }: {
  user: CurrentUser;
  initialPeriodStart?: string;
  initialStaffUserId?: string;
  onCancel: () => void;
  onCreated: (jobCardId: string) => void;
}) {
  const isStaff = user.role === 'STAFF';
  const [periodStart, setPeriodStart] = useState(initialPeriodStart ?? '');
  const [weekMode, setWeekMode] = useState<WeekChoiceMode>(initialPeriodStart ? 'custom' : 'this_week');
  const [selectedStaffIds, setSelectedStaffIds] = useState<string[]>(!isStaff && initialStaffUserId ? [initialStaffUserId] : []);
  const [customQuestions, setCustomQuestions] = useState<CustomQuestionDraft[]>([]);
  const [instructions, setInstructions] = useState('');
  const [staff, setStaff] = useState<StaffProfile[]>([]);
  const [staffState, setStaffState] = useState<LoadState>(isStaff ? 'ready' : 'loading');
  const [reference, setReference] = useState<WeeklyReportReference | null>(null);
  const [referenceState, setReferenceState] = useState<LoadState>('loading');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [existingJobId, setExistingJobId] = useState<string | null>(null);
  const [existingNotice, setExistingNotice] = useState<ExistingReportNotice | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [ambiguous, setAmbiguous] = useState(false);
  const [bulkResult, setBulkResult] = useState<WeeklyReportBulkResult | null>(null);
  const attemptRef = useRef<CreateAttempt | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const existingNoticeRef = useRef<HTMLDivElement>(null);
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
      const lastWeekStart = addCalendarDays(canonical.periodStart, -7);
      // Prefill only when the user has not already picked a week.
      setPeriodStart((current) => {
        if (!current) {
          setWeekMode('this_week');
          return canonical.periodStart;
        }
        if (current === canonical.periodStart) setWeekMode('this_week');
        else if (current === lastWeekStart) setWeekMode('last_week');
        else setWeekMode('custom');
        return current;
      });
    } catch {
      if (!referenceGate.current.isCurrent(generation)) return;
      setReferenceState('error');
      setWeekMode('custom');
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
  useEffect(() => { if (existingNotice) existingNoticeRef.current?.focus(); }, [existingNotice]);
  useEffect(() => {
    void loadReference();
  // Canonical default week is loaded once per mount from the organization calendar.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The server owns the bulk ceiling; this mirror only prevents an oversized
  // command from leaving the browser.
  const activeStaffCount = staff.length;
  const selectedCount = selectedStaffIds.length;

  function selectWeekMode(mode: WeekChoiceMode) {
    setWeekMode(mode);
    setExistingNotice(null);
    setFieldErrors((current) => ({ ...current, periodStart: undefined }));
    if (!reference) return;
    if (mode === 'this_week') setPeriodStart(reference.periodStart);
    else if (mode === 'last_week') setPeriodStart(addCalendarDays(reference.periodStart, -7));
  }

  function addCustomQuestion() {
    // The key is minted once at add-time against the keys already owned by
    // this screen and never renumbered, so a frozen attempt replays the exact
    // same question keys on an ambiguous retry.
    setCustomQuestions((current) => {
      const key = nextCustomQuestionKey(current.map((question) => question.key));
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
    setExistingNotice(null);
    if (activeStaffCount > MAX_BULK_TARGETS) {
      setFieldErrors((current) => ({
        ...current,
        staffUserIds: `Tek işlemde en fazla ${MAX_BULK_TARGETS} personel seçilebilir; `
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
    setExistingNotice(null);
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
    setExistingNotice(null);
    if (next.length > MAX_BULK_TARGETS) {
      setSelectedStaffIds(next.slice(0, MAX_BULK_TARGETS));
      setFieldErrors((current) => ({
        ...current,
        staffUserIds: `Tek işlemde en fazla ${MAX_BULK_TARGETS} personel seçilebilir; fazlası eklenmedi.`,
      }));
      return;
    }
    setSelectedStaffIds(next);
    setFieldErrors((current) => ({ ...current, staffUserIds: undefined }));
  }

  function collectFieldErrors(): FieldErrors {
    const nextErrors: FieldErrors = {};
    if (!periodStart) {
      nextErrors.periodStart = 'Rapor haftası (Pazartesi) seçin.';
    } else if (!isMondayDateKey(periodStart)) {
      nextErrors.periodStart = 'Rapor haftası bir Pazartesi günü başlamalıdır.';
    }
    // selectedStaffIds can never exceed the ceiling (selectStaff caps it), so
    // the only remaining rule is the lower bound.
    if (!isStaff && selectedStaffIds.length === 0) {
      nextErrors.staffUserIds = 'Aktif bir sorumlu personel seçin.';
    }
    const questions = collectManagerQuestions(customQuestions);
    if (questions.length > 50) {
      nextErrors.questions = 'En fazla 50 yönetici sorusu eklenebilir.';
    }
    for (const question of customQuestions) {
      const prompt = question.prompt.trim();
      if (!prompt) nextErrors.questions = 'Özel soru boş olamaz; boş satırı kaldırın.';
      else if (promptCodePoints(prompt) > 500) nextErrors.questions = 'Özel soru en fazla 500 karakter olabilir.';
    }
    return nextErrors;
  }

  /**
   * The frozen question payload: non-empty custom questions (UI order) with
   * stable semantic keys. The same ambiguous retry sends the exact same list
   * because state, not the render, owns it.
   */
  function managerQuestionPayload() {
    const questions = collectManagerQuestions(customQuestions);
    return questions.length > 0 ? { questions } : {};
  }

  async function sendAttempt(attempt: CreateAttempt) {
    setPending(true); setError(''); setExistingJobId(null); setExistingNotice(null);
    try {
      if (attempt.kind === 'single') {
        const created = await createWeeklyReport(attempt.input);
        attemptRef.current = null; setAmbiguous(false);
        onCreated(created.jobCardId);
        return;
      }
      const result = await bulkRequestWeeklyReports(attempt.input);
      attemptRef.current = null; setAmbiguous(false);
      // WR-WEEK D8: navigate only when a single target was newly created.
      if (result.items.length === 1) {
        const item = result.items[0]!;
        if (item.outcome === 'created') {
          onCreated(item.jobCardId);
          return;
        }
        setExistingNotice({
          jobCardId: item.jobCardId,
          message: 'Bu personelin bu hafta için raporu zaten var.',
          hint: CANCELLED_REPLACE_HINT,
        });
        return;
      }
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
    // Two distinct commands, two distinct payload shapes. No command carries a
    // client due date: the server derives the canonical Monday (or max(Monday, today)) deadline.
    const attempt: CreateAttempt = isStaff
      ? { kind: 'single', input: {
          // STAFF self-create: no command carries a dueDate — the deadline is
          // server-canonical and the request shape does not accept one.
          clientActionId: crypto.randomUUID(), periodStart, ...questionPayload, ...instructionPayload,
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
  const showDateInput = weekMode === 'custom' || referenceState === 'error' || !reference;
  const validMondaySelected = isMondayDateKey(periodStart);
  const previewSaturday = validMondaySelected ? addCalendarDays(periodStart, 5) : null;
  const previewDeadline = validMondaySelected ? previewDueDate(periodStart, reference) : null;

  if (bulkResult) {
    const nameById = new Map(staff.map((profile) => [profile.user.id, profile.user.name]));
    const created = bulkResult.items.filter((item) => item.outcome === 'created').length;
    const existing = bulkResult.items.length - created;
    const periodLabel = formatCalendarRange(bulkResult.periodStart, bulkResult.periodEnd);
    const summarySentence = existing === 0
      ? `Seçilen ${created} personel için ayrı haftalık rapor oluşturuldu.`
      : created === 0
        ? `Seçilen ${existing} personel için bu haftaya ait rapor zaten mevcut.`
        : `${created} yeni rapor oluşturuldu, ${existing} personel için mevcut rapor korundu.`;
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
          {summarySentence} Rapor haftası: {periodLabel}.
        </p>
        {existing > 0 && (
          <p className="form-help">{CANCELLED_REPLACE_HINT}</p>
        )}
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

  const thisWeekStart = reference?.periodStart ?? null;
  const thisWeekLabel = thisWeekStart
    ? `Bu hafta · ${formatCalendarRange(thisWeekStart, addCalendarDays(thisWeekStart, 5), { includeYear: false })}`
    : 'Bu hafta';
  const lastWeekStart = thisWeekStart ? addCalendarDays(thisWeekStart, -7) : null;
  const lastWeekLabel = lastWeekStart
    ? `Geçen hafta · ${formatCalendarRange(lastWeekStart, addCalendarDays(lastWeekStart, 5), { includeYear: false })}`
    : 'Geçen hafta';

  return <main className="task-create">
    <PageHeader eyebrow="Yeni kayıt" description="Haftalık rapor" fallbackTitle="Yeni iş" />
    <p className="form-intro">{isStaff
      ? 'Kendi haftalık raporunuz için bir istek oluşturun. Rapor haftası Pazartesi–Cumartesi çalışma haftasını kapsar; teslim son tarihi dönemi izleyen Pazartesi günüdür.'
      : `Seçilen her personel için ayrı bir haftalık rapor isteği oluşturun (en fazla ${MAX_BULK_TARGETS} personel). Rapor haftası Pazartesi–Cumartesi çalışma haftasını kapsar; teslim son tarihi dönemi izleyen Pazartesi günüdür.`}</p>
    {error && <div className="form-error" role="alert" tabIndex={-1} ref={errorRef}>
      {error}
      {existingJobId && <>
        {' '}
        <a href={`/jobs/${encodeURIComponent(existingJobId)}`}>Mevcut rapora git</a>
        {' '}
        <span className="weekly-existing-hint">{CANCELLED_REPLACE_HINT}</span>
      </>}
    </div>}
    {existingNotice && (
      <div
        className="weekly-existing-notice"
        id="weekly-existing-notice"
        role="status"
        tabIndex={-1}
        ref={existingNoticeRef}
      >
        <p className="weekly-existing-notice-message">
          {existingNotice.message}{' '}
          <a href={`/jobs/${encodeURIComponent(existingNotice.jobCardId)}`}>Mevcut rapora git</a>
        </p>
        <p className="weekly-existing-notice-hint">{existingNotice.hint}</p>
      </div>
    )}
    <form className="task-form" onSubmit={submit} noValidate>
      <fieldset disabled={pending || ambiguous}>
        {referenceState === 'ready' && reference && (
          <fieldset className="weekly-period-choice-group" aria-label="Rapor haftası seçimi">
            <legend>Rapor haftası</legend>
            <div className="weekly-period-choices">
              <label className="weekly-period-choice">
                <input
                  type="radio"
                  name="weeklyPeriodChoice"
                  value="this_week"
                  checked={weekMode === 'this_week'}
                  onChange={() => selectWeekMode('this_week')}
                />
                <span>{thisWeekLabel}</span>
              </label>
              <label className="weekly-period-choice">
                <input
                  type="radio"
                  name="weeklyPeriodChoice"
                  value="last_week"
                  checked={weekMode === 'last_week'}
                  onChange={() => selectWeekMode('last_week')}
                />
                <span>{lastWeekLabel}</span>
              </label>
              <label className="weekly-period-choice">
                <input
                  type="radio"
                  name="weeklyPeriodChoice"
                  value="custom"
                  checked={weekMode === 'custom'}
                  onChange={() => selectWeekMode('custom')}
                />
                <span>Başka hafta</span>
              </label>
            </div>
          </fieldset>
        )}
        {showDateInput && (
          <div className="field-group">
            <label htmlFor="weekly-period">Rapor haftası başlangıcı (Pazartesi)</label>
            <input
              id="weekly-period"
              name="periodStart"
              type="date"
              required
              value={periodStart}
              aria-invalid={fieldErrors.periodStart ? true : undefined}
              onChange={(event) => {
                setExistingNotice(null);
                setPeriodStart(event.target.value);
                setFieldErrors((current) => ({ ...current, periodStart: undefined }));
              }}
            />
          </div>
        )}
        <div className="weekly-period-meta">
          {validMondaySelected && previewSaturday && previewDeadline && (
            <p className="weekly-period-preview" id="weekly-period-preview" role="status">
              {`Dönem ${formatCalendarRange(periodStart, previewSaturday)} · Son teslim ${formatCalendarDayWithWeekday(previewDeadline)}`}
            </p>
          )}
          {referenceState === 'loading' && <span className="field-status" role="status">Rapor haftası organizasyon takviminden yükleniyor…</span>}
          {referenceState === 'ready' && reference && <span className="field-status" role="status">
            Varsayılan hafta organizasyon takvimine göre belirlendi ({reference.timezone}).
          </span>}
          {referenceState === 'error' && <span className="field-error" role="alert">
            Organizasyon takvimi yüklenemedi; rapor haftasını elle seçin.{' '}
            <button className="inline-action" type="button" onClick={() => void loadReference()}>Tekrar dene</button>
          </span>}
          {fieldErrors.periodStart && <span className="field-error">{fieldErrors.periodStart}</span>}
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
              <div className="weekly-staff-bulk-actions" id="weekly-staff-bulk-actions">
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
          customQuestions={customQuestions}
          onChangeCustomPrompt={changeCustomPrompt}
          onAddCustom={addCustomQuestion}
          onRemoveCustom={removeCustomQuestion}
          helpText="Eklenen sorular her personel için ayrı ayrı dondurulur."
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
            ? 'Rapor isteği gönderiliyor…'
            : isStaff ? 'Raporu oluştur' : 'Rapor isteklerini oluştur'}
        </button>
      </div>
    </form>
  </main>;
}
