import { useEffect, useRef, useState } from 'react';

import { ApiError, type CurrentUser } from './services/api';
import { isDefinitiveMutationError } from './jobs/mutation-attempt-error';
import {
  listWeeklyReportRecurrences,
  pauseWeeklyReportRecurrence,
  resumeWeeklyReportRecurrence,
  updateWeeklyReportRecurrenceTemplate,
  type WeeklyReportRecurrence,
  type WeeklyReportRecurrencePauseInput,
  type WeeklyReportRecurrenceResumeInput,
  type WeeklyReportRecurrenceTemplateUpdateInput,
} from './jobs/weekly-report-api';

type LoadState = 'loading' | 'ready' | 'error';

/**
 * A frozen recurrence command. Each variant retains the EXACT request that was
 * sent (including its `clientActionId`) so an ambiguous outcome can only ever
 * be retried verbatim — a retry never mints a new action id.
 */
type RecurrenceOperation =
  | { kind: 'pause'; ruleId: string; input: WeeklyReportRecurrencePauseInput }
  | { kind: 'resume'; ruleId: string; input: WeeklyReportRecurrenceResumeInput }
  | { kind: 'template'; ruleId: string; input: WeeklyReportRecurrenceTemplateUpdateInput };

const DISABLED_REASON_LABELS: Record<string, string> = {
  MANUAL: 'Yönetici duraklattı',
  STAFF_INELIGIBLE: 'Personel artık uygun değil (otomatik duraklatıldı)',
};

const OUTCOME_LABELS: Record<string, string> = {
  created: 'oluşturuldu',
  existing: 'zaten mevcuttu',
};

const MAX_EDIT_QUESTIONS = 5;
const MAX_EDIT_QUESTION_LENGTH = 500;
const MAX_EDIT_INSTRUCTIONS_LENGTH = 2000;

/**
 * Recurrence management surface (V1 Slice 5).
 *
 * MANAGER/ADMIN only — STAFF has no rule they could own, so the component
 * renders nothing for them. Rules are listed with their public lifecycle state
 * and operational outcome; the only mutations are "edit future template",
 * "pause" and "resume". There is deliberately no delete: pause is the
 * reversible lifecycle.
 *
 * Only one command may be in flight at a time. While it is pending — or while
 * its outcome is ambiguous — every rule action is locked so no second command
 * can race the frozen attempt, and the retained request is the only thing the
 * retry button can send.
 */
export function WeeklyReportRecurrenceManager({ user }: { user: CurrentUser }) {
  const isStaff = user.role === 'STAFF';
  const [rules, setRules] = useState<WeeklyReportRecurrence[]>([]);
  const [loadState, setLoadState] = useState<LoadState>(isStaff ? 'ready' : 'loading');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [ambiguous, setAmbiguous] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editQuestions, setEditQuestions] = useState<string[]>([]);
  const [editInstructions, setEditInstructions] = useState('');
  const [editError, setEditError] = useState('');
  const operationRef = useRef<RecurrenceOperation | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  async function load() {
    if (isStaff) return;
    setLoadState('loading');
    try {
      const result = await listWeeklyReportRecurrences();
      setRules(result.items);
      setLoadState('ready');
    } catch {
      setRules([]);
      setLoadState('error');
    }
  }

  useEffect(() => {
    void load();
  // The signed-in identity owns access to this surface.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.id, user.role]);

  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);

  if (isStaff) return null;

  const locked = pending || ambiguous;

  async function sendOperation(operation: RecurrenceOperation) {
    setPending(true); setError('');
    try {
      if (operation.kind === 'pause') {
        await pauseWeeklyReportRecurrence(operation.ruleId, operation.input);
      } else if (operation.kind === 'resume') {
        await resumeWeeklyReportRecurrence(operation.ruleId, operation.input);
      } else {
        await updateWeeklyReportRecurrenceTemplate(operation.ruleId, operation.input);
      }
      operationRef.current = null; setAmbiguous(false);
      setEditingId(null); setEditError('');
      await load();
    } catch (caught) {
      if (isDefinitiveMutationError(caught)) {
        operationRef.current = null; setAmbiguous(false);
        if (caught instanceof ApiError && caught.code === 'VERSION_CONFLICT') {
          setEditError('Kural başka bir işlem tarafından güncellendi; listeyi yenileyip tekrar deneyin.');
        }
      } else {
        setAmbiguous(true);
      }
      setError(caught instanceof Error
        ? caught.message
        : 'Kural güncellenemedi. Tekrar deneyin.');
    } finally { setPending(false); }
  }

  function runOperation(operation: RecurrenceOperation) {
    operationRef.current = operation;
    void sendOperation(operation);
  }

  function retry() {
    const operation = operationRef.current;
    if (operation) void sendOperation(operation);
  }

  function startEditing(rule: WeeklyReportRecurrence) {
    setEditingId(rule.id);
    setEditQuestions(rule.questions.map((question) => question.prompt));
    setEditInstructions(rule.instructions ?? '');
    setEditError('');
  }

  function cancelEditing() {
    setEditingId(null); setEditError('');
  }

  function setEditQuestion(index: number, prompt: string) {
    setEditQuestions((current) => current.map((entry, position) => (position === index ? prompt : entry)));
  }

  function addEditQuestion() {
    setEditQuestions((current) => (current.length >= MAX_EDIT_QUESTIONS ? current : [...current, '']));
  }

  function removeEditQuestion(index: number) {
    setEditQuestions((current) => current.filter((_, position) => position !== index));
  }

  function saveTemplate(rule: WeeklyReportRecurrence) {
    if (locked) return;
    const prompts = editQuestions.map((prompt) => prompt.trim());
    if (prompts.length > MAX_EDIT_QUESTIONS) {
      setEditError(`En fazla ${MAX_EDIT_QUESTIONS} yönetici sorusu eklenebilir.`); return;
    }
    const blankIndex = prompts.findIndex((prompt) => prompt.length === 0);
    if (blankIndex >= 0) { setEditError(`${blankIndex + 1}. soru boş olamaz.`); return; }
    const tooLongIndex = prompts.findIndex((prompt) => Array.from(prompt).length > MAX_EDIT_QUESTION_LENGTH);
    if (tooLongIndex >= 0) {
      setEditError(`${tooLongIndex + 1}. soru en fazla ${MAX_EDIT_QUESTION_LENGTH} karakter olabilir.`); return;
    }
    setEditError('');
    // Full replacement: both fields are always sent, never a sparse merge.
    const instructions = editInstructions.trim();
    runOperation({
      kind: 'template',
      ruleId: rule.id,
      input: {
        clientActionId: crypto.randomUUID(),
        expectedVersion: rule.version,
        questions: prompts.map((prompt, index) => ({ key: `q${index + 1}`, prompt })),
        instructions: instructions.length > 0 ? instructions : null,
      },
    });
  }

  function pauseRule(rule: WeeklyReportRecurrence) {
    if (locked) return;
    runOperation({
      kind: 'pause', ruleId: rule.id,
      input: { clientActionId: crypto.randomUUID(), expectedVersion: rule.version },
    });
  }

  function resumeRule(rule: WeeklyReportRecurrence) {
    if (locked) return;
    // No periodStart: the server defaults to the current organization-local
    // week, so weeks skipped while paused are never backfilled.
    runOperation({
      kind: 'resume', ruleId: rule.id,
      input: { clientActionId: crypto.randomUUID(), expectedVersion: rule.version },
    });
  }

  return <section className="recurrence-manager" id="recurrence-manager"
    aria-labelledby="recurrence-manager-title">
    <h2 id="recurrence-manager-title">Otomatik haftalık raporlar</h2>
    <p className="form-help">
      Kural aktif olduğu sürece her hafta otomatik rapor oluşturulur; termin dönemi
      izleyen Pazartesi&apos;dir. Şablon değişikliği yalnızca bundan sonraki raporları etkiler.
    </p>
    {error && <div className="form-error" role="alert" tabIndex={-1} ref={errorRef}>{error}</div>}
    {ambiguous && <div className="form-actions">
      <button className="secondary-button" type="button" disabled={pending} onClick={retry}>
        Özgün isteği tekrar dene
      </button>
    </div>}
    {loadState === 'loading' && <span className="field-status" role="status">Kurallar yükleniyor…</span>}
    {loadState === 'error' && <span className="field-error" role="alert">Kurallar yüklenemedi.{' '}
      <button className="inline-action" type="button" onClick={() => void load()}>Tekrar dene</button></span>}
    {loadState === 'ready' && rules.length === 0 && <p className="field-status" role="status" id="recurrence-empty">
      Henüz otomatik rapor kuralı yok.
    </p>}
    {rules.length > 0 && <ul className="activity-list" id="recurrence-list">
      {rules.map((rule) => {
        const editing = editingId === rule.id;
        const reasonLabel = rule.disabledReason ? DISABLED_REASON_LABELS[rule.disabledReason] : null;
        return <li key={rule.id} data-recurrence-id={rule.id}>
          <span className="recurrence-staff">{rule.staffName}</span>
          <span className="recurrence-state" id={`recurrence-state-${rule.id}`}>
            {rule.enabled ? 'Aktif' : 'Duraklatıldı'}
          </span>
          <span className="recurrence-next" id={`recurrence-next-${rule.id}`}>
            Sonraki rapor haftası: {rule.nextPeriodStart}
          </span>
          {rule.lastProcessedPeriodStart && <span className="recurrence-last" id={`recurrence-last-${rule.id}`}>
            Son işlenen hafta: {rule.lastProcessedPeriodStart}
            {rule.lastOutcome ? ` (${OUTCOME_LABELS[rule.lastOutcome] ?? rule.lastOutcome})` : ''}
          </span>}
          {!rule.enabled && reasonLabel && <span className="recurrence-reason" id={`recurrence-reason-${rule.id}`}>
            {reasonLabel}
          </span>}
          <span className="recurrence-questions">{rule.questions.length} yönetici sorusu</span>
          <div className="recurrence-actions">
            <button className="inline-action" type="button" disabled={locked || editing}
              onClick={() => startEditing(rule)}>Şablonu düzenle</button>
            {rule.enabled
              ? <button className="inline-action" type="button" disabled={locked}
                  onClick={() => pauseRule(rule)}>Duraklat</button>
              : <button className="inline-action" type="button" disabled={locked}
                  onClick={() => resumeRule(rule)}>Devam ettir</button>}
          </div>
          {editing && <div className="recurrence-edit" id={`recurrence-edit-${rule.id}`}>
            <span className="field-label">Yönetici soruları (en fazla {MAX_EDIT_QUESTIONS})</span>
            <span className="form-help">Bu değişiklik yalnızca bundan sonra oluşturulacak raporları etkiler.</span>
            {editQuestions.map((prompt, index) => (
              <div className="field-row" key={`edit-question-${index}`}>
                <label htmlFor={`recurrence-edit-question-${rule.id}-${index}`}>{index + 1}. soru</label>
                <input id={`recurrence-edit-question-${rule.id}-${index}`} value={prompt}
                  maxLength={MAX_EDIT_QUESTION_LENGTH} disabled={locked}
                  onChange={(event) => setEditQuestion(index, event.target.value)} />
                <button className="inline-action" type="button" disabled={locked}
                  onClick={() => removeEditQuestion(index)}>Kaldır</button>
              </div>
            ))}
            {editQuestions.length < MAX_EDIT_QUESTIONS && <button className="secondary-button" type="button"
              disabled={locked} onClick={addEditQuestion}>Soru ekle</button>}
            <div className="field-group">
              <label htmlFor={`recurrence-edit-instructions-${rule.id}`}>Talep notu (isteğe bağlı)</label>
              <textarea id={`recurrence-edit-instructions-${rule.id}`} rows={3} disabled={locked}
                maxLength={MAX_EDIT_INSTRUCTIONS_LENGTH} value={editInstructions}
                onChange={(event) => setEditInstructions(event.target.value)} />
            </div>
            {editError && <span className="field-error" role="alert">{editError}</span>}
            <div className="form-actions">
              <button className="secondary-button" type="button" disabled={locked}
                onClick={cancelEditing}>Vazgeç</button>
              <button className="primary-button" type="button" disabled={locked}
                onClick={() => saveTemplate(rule)}>Kaydet</button>
            </div>
          </div>}
        </li>;
      })}
    </ul>}
  </section>;
}
