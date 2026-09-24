import { useEffect, useRef, useState, type FormEvent } from 'react';

import { ApiError, type CurrentUser } from './services/api';
import { listStaff, type StaffProfile } from './services/people-api';
import { createRequestGate } from './services/request-gate';
import { PageHeader } from './ui/PageHeader';
import { ServoraSelect } from './ui/antd';
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

type LoadState = 'idle' | 'loading' | 'ready' | 'error';
type FieldErrors = {
  periodStart?: string; staffUserIds?: string; dueDate?: string; questions?: string;
};
/**
 * A frozen attempt. `single` is the STAFF self-create command; `bulk` is the
 * MANAGER/ADMIN multi-target command. Both retain the exact request that was
 * sent so an ambiguous outcome can only ever be retried verbatim.
 */
type CreateAttempt =
  | { kind: 'single'; input: WeeklyReportCreateInput }
  | { kind: 'bulk'; input: WeeklyReportBulkRequestInput };

const MONDAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Pure calendar arithmetic on an already-chosen Monday (periodEnd + 1 day).
 * Deliberately not a timezone calculation: the *default* Monday comes from the
 * organization calendar reference, never from the device clock.
 */
function addDays(dateKey: string, days: number): string | null {
  if (!MONDAY_PATTERN.test(dateKey)) return null;
  const parsed = new Date(`${dateKey}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf())) return null;
  const shifted = new Date(parsed.valueOf() + days * 86_400_000);
  return shifted.toISOString().slice(0, 10);
}

export function WeeklyReportCreateScreen({ user, onCancel, onCreated }: {
  user: CurrentUser;
  onCancel: () => void;
  onCreated: (jobCardId: string) => void;
}) {
  const isStaff = user.role === 'STAFF';
  const [periodStart, setPeriodStart] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [selectedStaffIds, setSelectedStaffIds] = useState<string[]>([]);
  const [questions, setQuestions] = useState<string[]>([]);
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

  // Derived default deadline (periodEnd + 1). Pure calendar arithmetic on the
  // chosen Monday; the server derives the identical value for STAFF self-create.
  const derivedDueDate = addDays(periodStart, 7) ?? '';

  function setQuestion(index: number, prompt: string) {
    setQuestions((current) => current.map((entry, position) => (position === index ? prompt : entry)));
  }

  function addQuestion() {
    setQuestions((current) => (current.length >= 5 ? current : [...current, '']));
  }

  function removeQuestion(index: number) {
    setQuestions((current) => current.filter((_, position) => position !== index));
  }

  /**
   * Selection is a set: the multi-select can never produce a repeated id, and
   * the server's ceiling is enforced by prevention, so an oversized command can
   * never leave the browser. The notice states explicitly that the extra picks
   * were not added.
   */
  function selectStaff(next: string[]) {
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

  function trimmedQuestionList(): string[] {
    return questions.map((prompt) => prompt.trim());
  }

  function collectFieldErrors(): FieldErrors {
    const nextErrors: FieldErrors = {};
    if (!MONDAY_PATTERN.test(periodStart)) nextErrors.periodStart = 'Rapor haftası (Pazartesi) seçin.';
    // selectedStaffIds can never exceed the ceiling (selectStaff caps it), so
    // the only remaining rule is the lower bound.
    if (!isStaff && selectedStaffIds.length === 0) {
      nextErrors.staffUserIds = 'Aktif bir sorumlu personel seçin.';
    }
    if (!isStaff && dueDate && !MONDAY_PATTERN.test(dueDate)) {
      nextErrors.dueDate = 'Termin YYYY-AA-GG biçiminde olmalıdır.';
    }
    const trimmedQuestions = trimmedQuestionList();
    if (trimmedQuestions.length > 5) nextErrors.questions = 'En fazla 5 yönetici sorusu eklenebilir.';
    trimmedQuestions.forEach((prompt, index) => {
      if (!prompt) nextErrors.questions = `${index + 1}. soru boş olamaz.`;
      else if (Array.from(prompt).length > 500) nextErrors.questions = `${index + 1}. soru en fazla 500 karakter olabilir.`;
    });
    return nextErrors;
  }

  function managerQuestionPayload() {
    const trimmedQuestions = trimmedQuestionList();
    return trimmedQuestions.length > 0
      ? { questions: trimmedQuestions.map((prompt, index) => ({ key: `q${index + 1}`, prompt })) }
      : {};
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
    const shared = {
      clientActionId: crypto.randomUUID(),
      periodStart,
      // STAFF deadline authority: the server derives the canonical due date and
      // rejects any client-supplied value, so a self-create never carries one.
      ...(!isStaff && dueDate ? { dueDate } : {}),
      ...(!isStaff ? managerQuestionPayload() : {}),
      ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
    };
    const attempt: CreateAttempt = isStaff
      ? { kind: 'single', input: shared }
      : { kind: 'bulk', input: { ...shared, staffUserIds: [...selectedStaffIds] } };
    attemptRef.current = attempt;
    await sendAttempt(attempt);
  }

  const staffUnavailable = !isStaff && staffState !== 'ready';

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
      ? 'Kendi haftalık raporunuz için bir istek oluşturun. Rapor haftası Pazartesi başlar.'
      : `Seçilen her personel için ayrı bir haftalık rapor isteği oluşturun (en fazla ${MAX_BULK_TARGETS} personel). Rapor haftası Pazartesi başlar.`}</p>
    {error && <div className="form-error" role="alert" tabIndex={-1} ref={errorRef}>
      {error}
      {existingJobId && <>{' '}<a href={`/jobs/${encodeURIComponent(existingJobId)}`}>Mevcut rapora git</a></>}
    </div>}
    <form className="task-form" onSubmit={submit} noValidate>
      <fieldset disabled={pending || ambiguous}>
        <div className="field-group">
          <label htmlFor="weekly-period">Rapor haftası (Pazartesi)</label>
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
              <span className="field-status" role="status" id="weekly-assignee-count">
                {selectedStaffIds.length} personel seçildi
              </span>
              {staffState === 'loading' && <span className="field-status" role="status">Personel listesi yükleniyor…</span>}
              {staffState === 'error' && <span className="field-error" role="alert">Personel listesi yüklenemedi.{' '}
                <button className="inline-action" type="button" onClick={() => void loadActiveStaff()}>Tekrar dene</button></span>}
              {fieldErrors.staffUserIds && <span className="field-error">{fieldErrors.staffUserIds}</span>}
            </div>}
        {isStaff
          ? <div className="field-group">
              <span className="field-label">Termin (dönemi izleyen Pazartesi)</span>
              <p className="fixed-field-value" id="weekly-due-derived">{derivedDueDate || 'Hafta seçilince belirlenir'}</p>
              <span className="form-help">Termin yönetici tarafından belirlenir; personel kendi teslim tarihini değiştiremez.</span>
            </div>
          : <div className="field-group">
              <label htmlFor="weekly-due">Termin (isteğe bağlı, varsayılan: dönemi izleyen Pazartesi{derivedDueDate ? ` ${derivedDueDate}` : ''})</label>
              <input id="weekly-due" name="dueDate" type="date" value={dueDate}
                aria-invalid={fieldErrors.dueDate ? true : undefined}
                onChange={(event) => setDueDate(event.target.value)} />
              {fieldErrors.dueDate && <span className="field-error">{fieldErrors.dueDate}</span>}
            </div>}
        {!isStaff && <div className="field-group">
          <span className="field-label">Yönetici soruları (isteğe bağlı, en fazla 5)</span>
          <span className="form-help">Sorular her personel için ayrı ayrı dondurulur.</span>
          {questions.map((prompt, index) => (
            <div className="field-row" key={`question-${index}`}>
              <label htmlFor={`weekly-question-${index}`}>{index + 1}. soru</label>
              <input id={`weekly-question-${index}`} value={prompt} maxLength={500}
                onChange={(event) => setQuestion(index, event.target.value)} />
              <button className="inline-action" type="button" onClick={() => removeQuestion(index)}>Kaldır</button>
            </div>
          ))}
          {questions.length < 5 && <button className="secondary-button" type="button" onClick={addQuestion}>Soru ekle</button>}
          {fieldErrors.questions && <span className="field-error">{fieldErrors.questions}</span>}
        </div>}
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
