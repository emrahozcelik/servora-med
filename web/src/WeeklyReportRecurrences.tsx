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
import {
  WEEKLY_REPORT_PRESET_QUESTIONS,
  WeeklyReportQuestionEditor,
  collectManagerQuestions,
  nextCustomQuestionKey,
  promptCodePoints,
  type CustomQuestionDraft,
  type ManagerQuestionPayload,
} from './jobs/WeeklyReportQuestionEditor';

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

const MAX_QUESTIONS = 50;
const MAX_EDIT_QUESTION_LENGTH = 500;
const MAX_EDIT_INSTRUCTIONS_LENGTH = 2000;

/** Stable semantic keys of the canonical presets, for round-trip editing. */
const PRESET_KEYS: ReadonlySet<string> = new Set(
  WEEKLY_REPORT_PRESET_QUESTIONS.map((preset) => preset.key),
);

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
  const [editPresetKeys, setEditPresetKeys] = useState<ReadonlySet<string>>(new Set());
  const [editCustomQuestions, setEditCustomQuestions] = useState<CustomQuestionDraft[]>([]);
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

  function toggleEditPreset(key: string, checked: boolean) {
    setEditPresetKeys((current) => {
      const next = new Set(current);
      if (checked) next.add(key); else next.delete(key);
      return next;
    });
  }

  function addEditCustomQuestion() {
    // The key is minted once at add-time against every key already owned by
    // this edit (preset semantics, persisted custom keys — including legacy
    // ones — and rows added in this session) and never renumbered, so a
    // frozen attempt replays the exact same question keys on an ambiguous
    // retry.
    setEditCustomQuestions((current) => {
      const key = nextCustomQuestionKey([
        ...WEEKLY_REPORT_PRESET_QUESTIONS.map((preset) => preset.key),
        ...current.map((question) => question.key),
      ]);
      return [...current, { key, prompt: '' }];
    });
  }

  function changeEditCustomPrompt(key: string, prompt: string) {
    setEditCustomQuestions((current) => current.map((question) => (
      question.key === key ? { ...question, prompt } : question
    )));
  }

  function removeEditCustomQuestion(key: string) {
    setEditCustomQuestions((current) => current.filter((question) => question.key !== key));
  }

  /**
   * Start editing from the rule's frozen question list. A persisted question
   * whose key matches a preset stays that preset's checkbox (so wording stays
   * canonical); anything else is a custom question that KEEPS ITS PERSISTED
   * KEY verbatim — legacy keys such as `q1` included. Keys are identifiers,
   * never positions, so opening and saving without changes cannot rewrite a
   * persisted key, and a new custom key is minted only when a row is added.
   * Editing affects FUTURE reports only — existing reports and immutable
   * submissions never change.
   */
  function startEditing(rule: WeeklyReportRecurrence) {
    setEditingId(rule.id);
    const presetKeys = new Set<string>();
    const custom: CustomQuestionDraft[] = [];
    rule.questions.forEach((question) => {
      if (PRESET_KEYS.has(question.key)) presetKeys.add(question.key);
      else custom.push({ key: question.key, prompt: question.prompt });
    });
    setEditPresetKeys(presetKeys);
    setEditCustomQuestions(custom);
    setEditInstructions(rule.instructions ?? '');
    setEditError('');
  }

  function cancelEditing() {
    setEditingId(null); setEditError('');
  }

  function editQuestionsPayload(): ManagerQuestionPayload[] {
    return collectManagerQuestions(editPresetKeys, editCustomQuestions);
  }

  function saveTemplate(rule: WeeklyReportRecurrence) {
    if (locked) return;
    const questions = editQuestionsPayload();
    if (questions.length > MAX_QUESTIONS) {
      setEditError(`En fazla ${MAX_QUESTIONS} yönetici sorusu eklenebilir.`); return;
    }
    const blankCustom = editCustomQuestions.find((question) => question.prompt.trim().length === 0);
    if (blankCustom) { setEditError('Özel soru boş olamaz; boş satırı kaldırın.'); return; }
    const tooLong = editCustomQuestions.find(
      (question) => promptCodePoints(question.prompt.trim()) > MAX_EDIT_QUESTION_LENGTH,
    );
    if (tooLong) {
      setEditError(`Özel soru en fazla ${MAX_EDIT_QUESTION_LENGTH} karakter olabilir.`); return;
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
        questions,
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
      Kural aktif olduğu sürece her hafta otomatik rapor oluşturulur; teslim son
      tarihi dönemi izleyen Pazartesi&apos;dir. Şablon değişikliği yalnızca bundan
      sonraki raporları etkiler.
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
                  onClick={() => pauseRule(rule)}>Otomatiği durdur</button>
              : <button className="inline-action" type="button" disabled={locked}
                  onClick={() => resumeRule(rule)}>Devam ettir</button>}
          </div>
          {editing && <div className="recurrence-edit" id={`recurrence-edit-${rule.id}`}>
            <span className="form-help">Bu değişiklik yalnızca bundan sonra oluşturulacak raporları etkiler.</span>
            <WeeklyReportQuestionEditor
              idPrefix={`recurrence-edit-${rule.id}`}
              locked={locked}
              selectedPresetKeys={editPresetKeys}
              onTogglePreset={toggleEditPreset}
              customQuestions={editCustomQuestions}
              onChangeCustomPrompt={changeEditCustomPrompt}
              onAddCustom={addEditCustomQuestion}
              onRemoveCustom={removeEditCustomQuestion}
            />
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
