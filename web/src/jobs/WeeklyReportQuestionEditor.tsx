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
 * Collects non-empty custom manager questions in UI order while preserving the
 * stable keys minted at add-time so ambiguous retries replay identical payloads.
 */
export function collectManagerQuestions(
  customQuestions: readonly CustomQuestionDraft[],
): ManagerQuestionPayload[] {
  return customQuestions
    .map((question) => ({
      key: question.key,
      prompt: question.prompt.trim(),
    }))
    .filter((question) => question.prompt.length > 0);
}

export const MAX_QUESTION_PROMPT_CODE_POINTS = 500;

export function promptCodePoints(prompt: string): number {
  return Array.from(prompt).length;
}

/**
 * Manager-defined custom questions for Weekly Report creation (WR-WEEK D6:
 * preset questions removed; managers add only report-specific custom questions).
 */
export function WeeklyReportQuestionEditor({
  customQuestions,
  onChangeCustomPrompt,
  onAddCustom,
  onRemoveCustom,
  locked,
  idPrefix,
  helpText,
  error,
}: {
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
    <div className="weekly-question-actions">
      <button className="secondary-button" type="button" id={`${idPrefix}-add-custom-question`}
        disabled={locked} onClick={onAddCustom}>+ Özel soru ekle</button>
    </div>
    {error && <span className="field-error" role="alert">{error}</span>}
  </div>;
}
