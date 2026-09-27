/** @vitest-environment jsdom */
import { useState } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  WEEKLY_REPORT_PRESET_QUESTIONS,
  WeeklyReportQuestionEditor,
  type CustomQuestionDraft,
} from '../src/jobs/WeeklyReportQuestionEditor';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/**
 * The manager-question editor is shared by Weekly Report creation and by
 * recurrence template editing. These tests drive the editor directly so the
 * preset rows can be asserted on their own contract: owned AntD checkboxes
 * with stable semantic keys, a locked (disabled) surface, and custom rows that
 * keep the key they were given.
 */
function Harness({
  locked = false,
  initialPresetKeys = [],
  initialCustomQuestions = [],
}: {
  locked?: boolean;
  initialPresetKeys?: string[];
  initialCustomQuestions?: CustomQuestionDraft[];
}) {
  const [presetKeys, setPresetKeys] = useState<ReadonlySet<string>>(new Set(initialPresetKeys));
  const [customQuestions, setCustomQuestions] = useState<CustomQuestionDraft[]>(initialCustomQuestions);
  return <WeeklyReportQuestionEditor
    idPrefix="weekly"
    locked={locked}
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

  function presetInputs(): HTMLInputElement[] {
    return Array.from(
      host.querySelectorAll<HTMLInputElement>('#weekly-preset-questions input[type="checkbox"]'),
    );
  }

  it('renders one owned AntD checkbox row per preset, in canonical order', async () => {
    await render();
    const rows = Array.from(host.querySelectorAll('#weekly-preset-questions > .weekly-question-preset'));
    expect(rows).toHaveLength(WEEKLY_REPORT_PRESET_QUESTIONS.length);
    expect(rows).toHaveLength(5);
    const inputs = presetInputs();
    expect(inputs).toHaveLength(5);
    expect(inputs.map((input) => input.id)).toEqual(
      WEEKLY_REPORT_PRESET_QUESTIONS.map((preset) => `weekly-preset-${preset.key}`),
    );
    // Each row hosts exactly one owned AntD checkbox, not a bare native input.
    // Selectors are prefix-agnostic: the owned boundary renders `servora-ant-*`
    // in production, while these suites mount a plain ConfigProvider.
    for (const row of rows) {
      expect(row.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
      expect(row.querySelector('[class*="-checkbox-wrapper"]')).not.toBeNull();
      expect(row.querySelector('[class*="-checkbox-input"]')).not.toBeNull();
    }
  });

  it('keeps the accessible name of every preset checkbox on its prompt', async () => {
    await render();
    for (const preset of WEEKLY_REPORT_PRESET_QUESTIONS) {
      const input = host.querySelector<HTMLInputElement>(`#weekly-preset-${preset.key}`);
      expect(input).not.toBeNull();
      // The AntD wrapper is a <label>, so it is the accessible name owner.
      const label = input!.closest('label');
      expect(label).not.toBeNull();
      expect(label!.textContent?.trim()).toBe(preset.prompt);
      expect(input!.type).toBe('checkbox');
    }
  });

  it('toggles a preset through real checkbox activation and keeps the checked state', async () => {
    await render();
    const highlights = host.querySelector<HTMLInputElement>('#weekly-preset-preset_week_highlights')!;
    const support = host.querySelector<HTMLInputElement>('#weekly-preset-preset_management_support')!;
    expect(highlights.checked).toBe(false);

    await act(async () => { highlights.click(); });
    expect(highlights.checked).toBe(true);
    expect(support.checked).toBe(false);

    await act(async () => { support.click(); });
    expect(highlights.checked).toBe(true);
    expect(support.checked).toBe(true);

    // A second activation unchecks only that row.
    await act(async () => { highlights.click(); });
    expect(highlights.checked).toBe(false);
    expect(support.checked).toBe(true);
  });

  it('reflects a caller-owned selection without letting the editor own the state', async () => {
    await render({ initialPresetKeys: ['preset_field_feedback'] });
    expect(host.querySelector<HTMLInputElement>('#weekly-preset-preset_field_feedback')!.checked).toBe(true);
    expect(presetInputs().filter((input) => input.checked)).toHaveLength(1);
  });

  it('disables every preset checkbox and the add action while locked', async () => {
    await render({ locked: true, initialPresetKeys: ['preset_week_highlights'] });
    const inputs = presetInputs();
    expect(inputs).toHaveLength(5);
    expect(inputs.every((input) => input.disabled)).toBe(true);
    expect(inputs.map((input) => input.matches(':disabled'))).toEqual([true, true, true, true, true]);
    const add = host.querySelector<HTMLButtonElement>('#weekly-add-custom-question')!;
    expect(add.disabled).toBe(true);

    // A locked surface cannot be mutated through the checkbox.
    const highlights = host.querySelector<HTMLInputElement>('#weekly-preset-preset_week_highlights')!;
    await act(async () => { highlights.click(); });
    expect(highlights.checked).toBe(true);
    expect(host.querySelector<HTMLInputElement>('#weekly-preset-preset_incomplete_work')!.checked).toBe(false);
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
});
