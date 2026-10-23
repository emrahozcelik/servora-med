import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import {
  WeeklyReportQuestionEditor,
  type CustomQuestionDraft,
} from '../src/jobs/WeeklyReportQuestionEditor';
import { ServoraAntProvider } from '../src/ui/antd';

/**
 * Visual/geometry fixture for the Weekly Report manager question editor. It
 * renders the REAL editor inside the real
 * `.task-create > .task-form > fieldset > .field-group` shell (plus the staff
 * bulk-action row), so the browser measures the actual cascade: the editor root
 * is a `.field-group`, which is exactly the condition that used to stretch the
 * native checkbox.
 */
function EditorInstance({ idPrefix }: { idPrefix: string }) {
  const [presetKeys, setPresetKeys] = useState<ReadonlySet<string>>(new Set());
  const [customQuestions, setCustomQuestions] = useState<CustomQuestionDraft[]>([]);
  return <WeeklyReportQuestionEditor
    idPrefix={idPrefix}
    locked={false}
    selectedPresetKeys={presetKeys}
    onTogglePreset={(key, checked) => setPresetKeys((current) => {
      const next = new Set(current);
      if (checked) next.add(key); else next.delete(key);
      return next;
    })}
    customQuestions={customQuestions}
    onChangeCustomPrompt={(key, prompt) => setCustomQuestions((current) => current.map(
      (question) => (question.key === key ? { ...question, prompt } : question),
    ))}
    onAddCustom={() => setCustomQuestions((current) => [
      ...current, { key: `custom_${current.length + 1}`, prompt: '' },
    ])}
    onRemoveCustom={(key) => setCustomQuestions((current) => (
      current.filter((question) => question.key !== key)
    ))}
    helpText="Seçili sorular her personel için ayrı ayrı dondurulur."
  />;
}

function CreateScreenFixture() {
  return <main className="task-create">
    <form className="task-form">
      <fieldset>
        <div className="field-group">
          <label htmlFor="weekly-assignees">Sorumlu personel (birden fazla seçilebilir)</label>
          <div className="weekly-staff-bulk-actions" id="weekly-staff-bulk-actions">
            <button className="secondary-button" type="button" id="weekly-select-all-staff">Tümünü seç</button>
            <button className="secondary-button" type="button" id="weekly-clear-staff-selection" disabled>Seçimi temizle</button>
            <span className="field-status" role="status" id="weekly-assignee-count">0 personel seçildi</span>
          </div>
        </div>
        <EditorInstance idPrefix="weekly" />
      </fieldset>
    </form>
  </main>;
}

/**
 * Commit-gated readiness marker: React 19 commits asynchronously, so the
 * marker must be set from an effect (after the editor is in the DOM) rather
 * than right after `createRoot().render()` returns.
 */
function ReadySignal() {
  useEffect(() => {
    document.documentElement.dataset.weeklyQuestionReady = 'true';
  }, []);
  return null;
}

const createRootNode = document.getElementById('weekly-question-create-root');

if (createRootNode) {
  createRoot(createRootNode).render(
    <ServoraAntProvider>
      <CreateScreenFixture />
      <ReadySignal />
    </ServoraAntProvider>,
  );
}
