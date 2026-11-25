/** @vitest-environment jsdom */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AssignmentReasonSection, EMPTY_ASSIGNMENT_REASON } from '../src/jobs/AssignmentOffer';
import { FollowUpCancelContinuitySection } from '../src/jobs/FollowUpCancelContinuitySection';
import { RevisionCorrectionDueField } from '../src/jobs/RevisionCorrectionDueField';
import { ReportDateRangeForm } from '../src/reports/report-shell';
import type { FormEvent, ReactNode, RefObject } from 'react';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const NATIVE_DATE_INPUT = /<input[^>]*\stype="(?:datetime-local|date|time)"/;

function sourceFiles(directory: string): string[] {
  const entries: string[] = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) entries.push(...sourceFiles(path));
    else if (name.endsWith('.tsx')) entries.push(path);
  }
  return entries;
}

function resizeTo(width: number): void {
  Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: width });
  window.dispatchEvent(new Event('resize'));
}

let container: HTMLDivElement;
let root: Root;

async function render(node: ReactNode): Promise<void> {
  await act(async () => root.render(node));
}

function trigger(id?: string): HTMLButtonElement {
  const element = id
    ? container.querySelector<HTMLButtonElement>(`#${id}`)
    : container.querySelector<HTMLButtonElement>('.wheel-field-trigger');
  if (!element) throw new Error('Missing wheel trigger');
  return element;
}

async function commitWheel(): Promise<void> {
  const ok = [...container.querySelectorAll<HTMLButtonElement>('.wheel-sheet-actions button')]
    .find((button) => button.textContent === 'Tamam');
  if (!ok) throw new Error('Missing Tamam');
  await act(async () => ok.click());
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('date/time field adoption', () => {
  it('keeps no native date/time input in application source', () => {
    const offenders = sourceFiles(join(process.cwd(), 'src'))
      .filter((path) => NATIVE_DATE_INPUT.test(readFileSync(path, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('renders compact report range triggers and submits through the hidden carrier', async () => {
    resizeTo(390);
    let submittedFrom: FormDataEntryValue | null = null;
    const errorRef: RefObject<HTMLDivElement | null> = { current: null };
    const onSubmit = (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      submittedFrom = new FormData(event.currentTarget).get('from');
    };
    await render(<ReportDateRangeForm
      formKey="2026-11-25:2026-11-25"
      from=""
      to=""
      filterError=""
      errorRef={errorRef}
      onSubmit={onSubmit}
    />);

    const triggers = container.querySelectorAll<HTMLButtonElement>('.wheel-field-trigger');
    expect(triggers).toHaveLength(2);
    const label = container.querySelector('label[for="report-range-from"]')!;
    expect(label).not.toBeNull();
    expect(label.contains(triggers[0]!)).toBe(false);
    expect(container.querySelector('.wheel-field-proxy')?.getAttribute('name')).toBe('from');
    await act(async () => triggers[0]!.click());
    await commitWheel();
    expect(triggers[0]!.textContent).not.toContain('Seçin');

    await act(async () => (container.querySelector('form') as HTMLFormElement).requestSubmit());
    expect(submittedFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('renders compact correction deadline and commits the wheel value', async () => {
    resizeTo(390);
    const onChange = vi.fn();
    await render(<RevisionCorrectionDueField
      draft={{ value: '', fieldError: null }}
      onChange={onChange}
    />);
    expect(trigger('revision-correction-due-at').className).toContain('wheel-field-trigger');
    await act(async () => trigger('revision-correction-due-at').click());
    await commitWheel();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![0].value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });

  it('renders compact assignment proposal and commits the wheel value', async () => {
    resizeTo(390);
    const onChange = vi.fn();
    await render(<AssignmentReasonSection
      draft={{ ...EMPTY_ASSIGNMENT_REASON, code: 'SCHEDULE_CONFLICT' }}
      inlineError={null}
      scheduleError={null}
      onChange={onChange}
    />);
    expect(trigger('assignment-proposed-at').className).toContain('wheel-field-trigger');
    await act(async () => trigger('assignment-proposed-at').click());
    await commitWheel();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![0].proposedScheduledLocal)
      .toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });

  it('renders compact follow-up reschedule and commits the wheel value', async () => {
    resizeTo(390);
    const onChange = vi.fn();
    await render(<FollowUpCancelContinuitySection
      draft={{ decision: 'RESCHEDULE', scheduledLocal: '', endReason: '' }}
      inlineError={null}
      onChange={onChange}
    />);
    expect(trigger('follow-up-cancel-scheduled-at').className).toContain('wheel-field-trigger');
    await act(async () => trigger('follow-up-cancel-scheduled-at').click());
    await commitWheel();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![0].scheduledLocal)
      .toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });
});
