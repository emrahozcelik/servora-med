/** @vitest-environment jsdom */
import { useState } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  WeeklyReportQuestionEditor,
  collectManagerQuestions,
  nextCustomQuestionKey,
  type CustomQuestionDraft,
} from '../src/jobs/WeeklyReportQuestionEditor';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/**
 * Manager-question editor tests for Weekly Report creation (WR-WEEK D6:
 * presets removed; managers add only report-specific custom questions with
 * stable keys).
 */
function Harness({
  locked = false,
  initialCustomQuestions = [],
}: {
  locked?: boolean;
  initialCustomQuestions?: CustomQuestionDraft[];
}) {
  const [customQuestions, setCustomQuestions] = useState<CustomQuestionDraft[]>(initialCustomQuestions);
  return <WeeklyReportQuestionEditor
    idPrefix="weekly"
    locked={locked}
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
  />;
}

describe('Weekly report manager-question editor', () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
      matches: false, media: '', onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    }));
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  async function render(props: Parameters<typeof Harness>[0] = {}) {
    await act(async () => root.render(<Harness {...props} />));
  }

  it('renders no preset question checkboxes (WR-WEEK D6)', async () => {
    await render();
    expect(host.querySelector('#weekly-preset-questions')).toBeNull();
    expect(host.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    expect(host.querySelector('#weekly-add-custom-question')).not.toBeNull();
  });

  it('adds custom questions with stable collision-free keys', async () => {
    await render();
    const add = host.querySelector<HTMLButtonElement>('#weekly-add-custom-question')!;
    await act(async () => { add.click(); });
    await act(async () => { add.click(); });
    expect(host.querySelector('#weekly-custom-question-custom_1')).not.toBeNull();
    expect(host.querySelector('#weekly-custom-question-custom_2')).not.toBeNull();
  });

  it('disables custom question inputs, remove controls and the add action while locked', async () => {
    await render({
      locked: true,
      initialCustomQuestions: [{ key: 'custom_1', prompt: 'Kilitli soru' }],
    });
    const input = host.querySelector<HTMLInputElement>('#weekly-custom-question-custom_1')!;
    const remove = Array.from(host.querySelectorAll('#weekly-questions .inline-action'))
      .find((button) => button.textContent === 'Kaldır') as HTMLButtonElement;
    const add = host.querySelector<HTMLButtonElement>('#weekly-add-custom-question')!;
    expect(input.disabled).toBe(true);
    expect(remove.disabled).toBe(true);
    expect(add.disabled).toBe(true);
  });

  it('keeps the add-custom action in its own content-width action container', async () => {
    await render();
    const actions = host.querySelectorAll('.weekly-question-actions');
    expect(actions).toHaveLength(1);
    const add = host.querySelector<HTMLButtonElement>('#weekly-add-custom-question')!;
    expect(add.textContent).toBe('+ Özel soru ekle');
    // The action container is the only owner of the button: it is not a
    // direct child of the grid field group, which would stretch it full width.
    expect(add.parentElement?.classList.contains('weekly-question-actions')).toBe(true);
    expect(add.classList.contains('secondary-button')).toBe(true);
  });

  it('edits and removes custom rows without renaming their stable keys', async () => {
    await render({ initialCustomQuestions: [{ key: 'q1', prompt: 'Eski soru' }] });
    const row = host.querySelector<HTMLInputElement>('#weekly-custom-question-q1');
    expect(row).not.toBeNull();
    expect(row!.value).toBe('Eski soru');

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(row!, 'Eski soru (düzenlendi)');
      row!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(host.querySelector<HTMLInputElement>('#weekly-custom-question-q1')!.value)
      .toBe('Eski soru (düzenlendi)');

    const remove = Array.from(host.querySelectorAll('#weekly-questions .inline-action'))
      .find((button) => button.textContent === 'Kaldır') as HTMLButtonElement;
    await act(async () => { remove.dispatchEvent(new Event('click', { bubbles: true })); });
    expect(host.querySelector('#weekly-custom-question-q1')).toBeNull();
  });

  it('collectManagerQuestions trims prompts and omits blank rows while preserving keys', () => {
    expect(collectManagerQuestions([
      { key: 'custom_1', prompt: '  Saha ziyareti notu  ' },
      { key: 'custom_2', prompt: '   ' },
      { key: 'custom_3', prompt: 'Stok durumu?' },
    ])).toEqual([
      { key: 'custom_1', prompt: 'Saha ziyareti notu' },
      { key: 'custom_3', prompt: 'Stok durumu?' },
    ]);
  });
});
