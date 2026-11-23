import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import {
  WeeklyReportQuestionEditor,
  nextCustomQuestionKey,
  type CustomQuestionDraft,
} from '../src/jobs/WeeklyReportQuestionEditor';
import { ServoraAntProvider } from '../src/ui/antd';

/**
 * Visual/geometry fixture for the Weekly Report manager question editor
 * (WR-WEEK D6: custom questions only, no presets).
 */
function EditorInstance({ idPrefix }: { idPrefix: string }) {
  const [customQuestions, setCustomQuestions] = useState<CustomQuestionDraft[]>([
    { key: 'custom_1', prompt: 'Klinik ziyaretinde öne çıkan cihaz talepleri nelerdi?' },
  ]);
  return <WeeklyReportQuestionEditor
    idPrefix={idPrefix}
    locked={false}
    customQuestions={customQuestions}
    onChangeCustomPrompt={(key, prompt) => setCustomQuestions((current) => current.map(
      (question) => (question.key === key ? { ...question, prompt } : question),
    ))}
    onAddCustom={() => setCustomQuestions((current) => [
      ...current, { key: nextCustomQuestionKey(current.map((q) => q.key)), prompt: '' },
    ])}
    onRemoveCustom={(key) => setCustomQuestions((current) => (
      current.filter((question) => question.key !== key)
    ))}
    helpText="Eklenen sorular her personel için ayrı ayrı dondurulur."
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
