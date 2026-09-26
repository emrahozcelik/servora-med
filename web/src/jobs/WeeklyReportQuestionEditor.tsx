import { useState } from 'react';

/**
 * Canonical preset manager questions (V1 field-test remediation). The five
 * texts are product wording, not user-typed data: each carries a stable
 * semantic key that never depends on list position, so an ambiguous create
 * retry freezes the identical question list, and an already-created report is
 * immune to later preset wording changes.
 */
export const WEEKLY_REPORT_PRESET_QUESTIONS = [
  { key: 'preset_week_highlights', prompt: 'Bu hafta öne çıkan çalışmaların ve sonuçların nelerdi?' },
  { key: 'preset_incomplete_work', prompt: 'Planlanıp tamamlanamayan işler oldu mu? Neden?' },
  { key: 'preset_field_feedback', prompt: 'Müşterilerden veya sahadan önemli bir geri bildirim var mı?' },
  { key: 'preset_next_week_priorities', prompt: 'Gelecek hafta öncelikli çalışmaların neler?' },
  { key: 'preset_management_support', prompt: 'Yönetimden ihtiyaç duyduğun destek veya karar var mı?' },
] as const;

/**
 * One editable custom question row. The key is minted once at add-time from
 * the keys already owned (persisted customs + rows added in this session) and
 * is never renumbered, so removals, reorders and ambiguous retries all keep
 * the exact same question identity. Persisted non-preset keys (including
 * legacy keys such as `q1`) are preserved verbatim while editing.
 */
export type CustomQuestionDraft = { key: string; prompt: string };

/**
 * Mints one collision-free `custom_N` key that is not owned by any of the
 * given keys. Call it ONCE when a custom row is added; the returned key is
 * then owned by the row and must never be derived again from position.
 */
export function nextCustomQuestionKey(ownedKeys: Iterable<string>): string {
  const taken = new Set(ownedKeys);
  let counter = 1;
  while (taken.has(`custom_${counter}`)) counter += 1;
  return `custom_${counter}`;
}

export type ManagerQuestionPayload = { key: string; prompt: string };

/**
 * The editor's current selection. Presets keep their semantic keys; custom
 * questions keep the stable key stored on their draft (minted once at
 * add-time, or the verbatim persisted key when editing a recurrence
 * template), so the same ambiguous request retry sends the exact same keys
 * and prompts. Keys are never synthesized from array position here.
 */
export function collectManagerQuestions(
  selectedPresetKeys: ReadonlySet<string>,
  customQuestions: readonly CustomQuestionDraft[],
): ManagerQuestionPayload[] {
  const presets = WEEKLY_REPORT_PRESET_QUESTIONS
    .filter((preset) => selectedPresetKeys.has(preset.key))
    .map((preset) => ({ key: preset.key, prompt: preset.prompt }));
  const custom = customQuestions.map((question) => ({
    key: question.key,
    prompt: question.prompt.trim(),
  }));
  // Selected presets in canonical preset order, then custom questions in UI
  // order. Blank custom prompts are not sent.
  return [...presets, ...custom.filter((question) => question.prompt.length > 0)];
}

export const MAX_QUESTION_PROMPT_CODE_POINTS = 500;

export function promptCodePoints(prompt: string): number {
  return Array.from(prompt).length;
}

/**
 * Reusable manager-question editor for Weekly Report creation AND recurrence
 * template editing (one editor, not two unrelated ones; deliberately not a
 * generic dynamic-form framework). Renders the five canonical presets as
 * checkable options followed by free-text custom questions. Nothing is
 * selected by default; state lives in the caller so the frozen attempt can be
 * replayed verbatim on an ambiguous retry.
 */
export function WeeklyReportQuestionEditor({
  selectedPresetKeys,
  onTogglePreset,
  customQuestions,
  onChangeCustomPrompt,
  onAddCustom,
  onRemoveCustom,
  locked,
  idPrefix,
  helpText,
  error,
}: {
  selectedPresetKeys: ReadonlySet<string>;
  onTogglePreset: (key: string, checked: boolean) => void;
  customQuestions: readonly CustomQuestionDraft[];
  onChangeCustomPrompt: (key: string, prompt: string) => void;
  onAddCustom: () => void;
  onRemoveCustom: (key: string) => void;
  locked: boolean;
  idPrefix: string;
  helpText?: string;
  error?: string | null;
}) {
  return <div className="field-group" id={`${idPrefix}-questions`}>
    <span className="field-label">Yönetici soruları (isteğe bağlı)</span>
    {helpText && <span className="form-help">{helpText}</span>}
    <div className="weekly-question-presets" role="group" aria-label="Hazır yönetici soruları"
      id={`${idPrefix}-preset-questions`}>
      {WEEKLY_REPORT_PRESET_QUESTIONS.map((preset) => (
        <label className="weekly-question-preset" key={preset.key}>
          <input
            type="checkbox"
            id={`${idPrefix}-preset-${preset.key}`}
            checked={selectedPresetKeys.has(preset.key)}
            disabled={locked}
            onChange={(event) => onTogglePreset(preset.key, event.target.checked)}
          />
          <span>{preset.prompt}</span>
        </label>
      ))}
    </div>
    {customQuestions.map((question, index) => (
      <div className="field-row" key={question.key}>
        <label htmlFor={`${idPrefix}-custom-question-${question.key}`}>
          Özel soru {index + 1}
        </label>
        <input
          id={`${idPrefix}-custom-question-${question.key}`}
          value={question.prompt}
          disabled={locked}
          onChange={(event) => onChangeCustomPrompt(question.key, event.target.value)}
        />
        <button className="inline-action" type="button" disabled={locked}
          onClick={() => onRemoveCustom(question.key)}>Kaldır</button>
      </div>
    ))}
    <button className="secondary-button" type="button" id={`${idPrefix}-add-custom-question`}
      disabled={locked} onClick={onAddCustom}>+ Özel soru ekle</button>
    {error && <span className="field-error" role="alert">{error}</span>}
  </div>;
}
