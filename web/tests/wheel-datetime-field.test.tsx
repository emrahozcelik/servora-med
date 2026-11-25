/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WheelDateTimeField, type WheelDateTimeFieldProps } from '../src/ui/WheelDateTimeField';
import {
  isWithinWheelBounds,
  parseWheelBounds,
  parseWheelValue,
  type WheelMode,
} from '../src/ui/wheel-datetime';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement;
let root: Root;
let onChange: ReturnType<typeof vi.fn>;

function resizeTo(width: number): void {
  Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: width });
  window.dispatchEvent(new Event('resize'));
}

function setReactValue(element: HTMLInputElement, value: string): void {
  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, 'value',
  )?.set;
  nativeSetter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

async function renderField(props: Omit<WheelDateTimeFieldProps, 'onChange'>): Promise<void> {
  await act(async () => {
    root.render(<WheelDateTimeField {...props} onChange={onChange} />);
  });
}

async function click(element: Element | null | undefined): Promise<void> {
  if (!element) throw new Error('Missing click target');
  await act(async () => {
    (element as HTMLElement).click();
  });
}

async function press(element: Element | null, key: string): Promise<void> {
  if (!element) throw new Error('Missing key target');
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

function dialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="dialog"]');
}

function column(label: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[role="spinbutton"][aria-label="${label}"]`);
  if (!element) throw new Error(`Missing ${label} column`);
  return element;
}

function action(label: string): HTMLButtonElement {
  const element = [...document.querySelectorAll<HTMLButtonElement>('.wheel-sheet-actions button')]
    .find((button) => button.textContent === label);
  if (!element) throw new Error(`Missing ${label} action`);
  return element;
}

function trigger(): HTMLButtonElement {
  const element = container.querySelector<HTMLButtonElement>('.wheel-field-trigger');
  if (!element) throw new Error('Missing trigger');
  return element;
}

beforeEach(async () => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  onChange = vi.fn();
  // Release any first-invalid focus claim from the previous test.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  document.body.style.overflow = '';
  vi.useRealTimers();
});

describe('desktop native input', () => {
  it('renders the same native datetime-local contract as today', async () => {
    resizeTo(1280);
    await renderField({
      mode: 'datetime',
      id: 'scheduled',
      name: 'scheduledAt',
      value: '2026-11-26T10:30',
      min: '2026-11-25T09:00',
      max: '2026-11-30T18:00',
      required: true,
      label: 'Planlanan zaman',
    });

    const input = container.querySelector('input');
    expect(input).not.toBeNull();
    expect(input!.type).toBe('datetime-local');
    expect(input!.id).toBe('scheduled');
    expect(input!.name).toBe('scheduledAt');
    expect(input!.value).toBe('2026-11-26T10:30');
    expect(input!.min).toBe('2026-11-25T09:00');
    expect(input!.max).toBe('2026-11-30T18:00');
    expect(input!.required).toBe(true);
    expect(container.querySelector('.wheel-field-trigger')).toBeNull();
    expect(container.querySelector('label')?.getAttribute('for')).toBe('scheduled');

    await act(async () => { setReactValue(input!, '2026-11-27T09:00'); });
    expect(onChange).toHaveBeenCalledWith('2026-11-27T09:00');
  });

  it('renders date and time modes as their native inputs', async () => {
    resizeTo(1280);
    await renderField({ mode: 'date', id: 'due', name: 'dueDate', value: '2026-11-26' });
    expect(container.querySelector('input')?.type).toBe('date');
    expect(container.querySelector('input')?.value).toBe('2026-11-26');
    await renderField({ mode: 'time', id: 'at', name: 'scheduleTime', value: '10:30' });
    expect(container.querySelector('input')?.type).toBe('time');
    expect(container.querySelector('input')?.value).toBe('10:30');
  });
});

describe('compact wheel sheet', () => {
  it('shows the formatted value and opens the sheet from the trigger', async () => {
    resizeTo(390);
    await renderField({
      mode: 'datetime',
      id: 'scheduled',
      name: 'scheduledAt',
      value: '2026-11-26T10:30',
      label: 'Planlanan zaman',
    });

    expect(container.querySelector('.wheel-field-trigger')?.tagName).toBe('BUTTON');
    expect(container.querySelector('.wheel-field-proxy')).not.toBeNull();
    expect(trigger().textContent).toContain('Per 26 Kas · 10:30');
    expect(trigger().getAttribute('aria-haspopup')).toBe('dialog');
    expect(trigger().getAttribute('aria-expanded')).toBe('false');

    await click(trigger());
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(dialog()).not.toBeNull();
    expect(dialog()!.getAttribute('aria-modal')).toBe('true');
    expect(dialog()!.textContent).toContain('Planlanan zaman');
    expect(document.querySelectorAll('[role="spinbutton"]')).toHaveLength(3);
  });

  it('changes hour and minute with the keyboard and commits with Tamam', async () => {
    resizeTo(390);
    await renderField({
      mode: 'datetime',
      id: 'scheduled',
      name: 'scheduledAt',
      value: '2026-11-26T10:30',
    });
    await click(trigger());
    expect(trigger().getAttribute('aria-label')).toBe('Tarih ve saat: Per 26 Kas · 10:30');

    const hour = column('Saat');
    expect(hour.getAttribute('aria-valuetext')).toBe('10');
    expect(hour.getAttribute('tabindex')).toBe('0');

    await press(hour, 'ArrowUp');
    expect(hour.getAttribute('aria-valuetext')).toBe('11');
    await press(column('Dakika'), 'ArrowUp');
    expect(column('Dakika').getAttribute('aria-valuetext')).toBe('35');
    await press(column('Dakika'), 'PageUp');
    expect(column('Dakika').getAttribute('aria-valuetext')).toBe('55');
    await press(column('Saat'), 'End');
    expect(column('Saat').getAttribute('aria-valuetext')).toBe('23');
    await press(column('Saat'), 'Home');
    expect(column('Saat').getAttribute('aria-valuetext')).toBe('00');

    await click(action('Tamam'));
    expect(onChange).toHaveBeenCalledWith('2026-11-26T00:55');
    expect(dialog()).toBeNull();
  });

  it('discards the draft with Vazgeç and restores trigger focus', async () => {
    resizeTo(390);
    await renderField({
      mode: 'datetime',
      id: 'scheduled',
      name: 'scheduledAt',
      value: '2026-11-26T10:30',
    });
    await click(trigger());
    await press(column('Saat'), 'ArrowDown');
    await click(action('Vazgeç'));

    expect(onChange).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
    expect(trigger().textContent).toContain('10:30');
    await act(async () => { await Promise.resolve(); });
    expect(document.activeElement).toBe(trigger());
  });

  it('closes on Escape without committing', async () => {
    resizeTo(390);
    await renderField({
      mode: 'datetime', id: 'scheduled', name: 'scheduledAt', value: '2026-11-26T10:30',
    });
    await click(trigger());
    await press(column('Saat'), 'ArrowDown');
    await press(column('Saat'), 'Escape');

    expect(dialog()).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('starts an empty value at now rounded up and clamped', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 25, 10, 2, 30));
    resizeTo(390);
    await renderField({
      mode: 'datetime',
      id: 'scheduled',
      name: 'scheduledAt',
      value: '',
      minuteStep: 5,
      min: '2026-11-20T08:00',
      max: '2026-11-30T18:00',
    });
    expect(trigger().textContent).toContain('Seçin');

    await click(trigger());
    expect(column('Saat').getAttribute('aria-valuetext')).toBe('10');
    expect(column('Dakika').getAttribute('aria-valuetext')).toBe('05');
    await click(action('Tamam'));
    expect(onChange).toHaveBeenCalledWith('2026-11-25T10:05');
  });

  it('clamps an out-of-range stored value into min/max', async () => {
    resizeTo(390);
    await renderField({
      mode: 'datetime',
      id: 'scheduled',
      name: 'scheduledAt',
      value: '2026-12-05T08:00',
      min: '2026-11-25T09:00',
      max: '2026-11-30T18:00',
    });
    await click(trigger());
    expect(column('Gün').getAttribute('aria-valuetext')).toContain('30 Kas');
    expect(column('Saat').getAttribute('aria-valuetext')).toBe('18');
    expect(column('Dakika').getAttribute('aria-valuetext')).toBe('00');

    const hours = document.querySelectorAll('[data-wheel-column="Saat"] .wheel-column-item');
    expect(hours[19]?.getAttribute('data-wheel-disabled')).toBe('true');
    expect(hours[18]?.getAttribute('data-wheel-disabled')).toBeNull();

    await click(action('Tamam'));
    expect(onChange).toHaveBeenCalledWith('2026-11-30T18:00');
  });

  it('keeps the date contract in date mode and clamps the day on month change', async () => {
    resizeTo(390);
    await renderField({ mode: 'date', id: 'due', name: 'dueDate', value: '2026-01-31' });
    expect(trigger().textContent).toContain('Cmt 31 Oca 2026');

    await click(trigger());
    expect(column('Gün').getAttribute('aria-valuetext')).toBe('31');
    expect(column('Ay').getAttribute('aria-valuetext')).toBe('Ocak');
    expect(column('Yıl').getAttribute('aria-valuetext')).toBe('2026');

    await press(column('Ay'), 'ArrowUp');
    expect(column('Ay').getAttribute('aria-valuetext')).toBe('Şubat');
    expect(column('Gün').getAttribute('aria-valuetext')).toBe('28');

    await click(action('Tamam'));
    expect(onChange).toHaveBeenCalledWith('2026-02-28');
  });

  it('keeps the time contract in time mode', async () => {
    resizeTo(390);
    await renderField({ mode: 'time', id: 'at', name: 'scheduleTime', value: '10:30' });
    expect(trigger().textContent).toContain('10:30');

    await click(trigger());
    expect(document.querySelectorAll('[role="spinbutton"]')).toHaveLength(2);
    expect(column('Saat').getAttribute('aria-valuetext')).toBe('10');
    await press(column('Dakika'), 'ArrowUp');
    expect(column('Dakika').getAttribute('aria-valuetext')).toBe('35');
    await click(action('Tamam'));
    expect(onChange).toHaveBeenCalledWith('10:35');
  });

  it('commits the centered item after a scroll settles', async () => {
    vi.useFakeTimers();
    resizeTo(390);
    await renderField({
      mode: 'datetime', id: 'scheduled', name: 'scheduledAt', value: '2026-11-26T10:30',
    });
    await click(trigger());
    const scroller = document.querySelector<HTMLElement>(
      '[data-wheel-column="Saat"] .wheel-column-scroller',
    );
    expect(scroller).not.toBeNull();

    await act(async () => {
      scroller!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      scroller!.scrollTop = 11 * 44;
      scroller!.dispatchEvent(new Event('scroll'));
      vi.advanceTimersByTime(200);
    });

    expect(column('Saat').getAttribute('aria-valuetext')).toBe('11');
    await click(action('Tamam'));
    expect(onChange).toHaveBeenCalledWith('2026-11-26T11:30');
  });

  it('commits the centered row when Tamam is pressed before the settle timer', async () => {
    resizeTo(390);
    await renderField({
      mode: 'datetime', id: 'scheduled', name: 'scheduledAt', value: '2026-11-26T10:30',
    });
    await click(trigger());
    const scroller = document.querySelector<HTMLElement>(
      '[data-wheel-column="Saat"] .wheel-column-scroller',
    );
    expect(scroller).not.toBeNull();
    await act(async () => { scroller!.scrollTop = 11 * 44; });

    // No scrollend and no settle timeout: Tamam must read the centered row.
    await click(action('Tamam'));
    expect(onChange).toHaveBeenCalledWith('2026-11-26T11:30');
  });

  it('selects a tapped wheel item and centers it', async () => {
    resizeTo(390);
    await renderField({
      mode: 'datetime', id: 'scheduled', name: 'scheduledAt', value: '2026-11-26T10:30',
    });
    await click(trigger());
    const items = [...document.querySelectorAll<HTMLButtonElement>(
      '[data-wheel-column="Saat"] .wheel-column-item',
    )];
    await click(items.find((item) => item.textContent === '15'));

    expect(column('Saat').getAttribute('aria-valuetext')).toBe('15');
    expect(document.activeElement).toBe(column('Saat'));
    await click(action('Tamam'));
    expect(onChange).toHaveBeenCalledWith('2026-11-26T15:30');
  });

  it('participates in form data and required validation on mobile', async () => {
    resizeTo(390);
    await act(async () => {
      root.render(
        <form>
          <WheelDateTimeField
            mode="datetime"
            id="scheduled"
            name="when"
            value=""
            required
            onChange={onChange}
          />
        </form>,
      );
    });
    const form = container.querySelector('form');
    expect(form).not.toBeNull();
    expect(new FormData(form!).get('when')).toBe('');
    expect(form!.checkValidity()).toBe(false);

    await act(async () => {
      root.render(
        <form>
          <WheelDateTimeField
            mode="datetime"
            id="scheduled"
            name="when"
            value="2026-11-26T10:30"
            required
            onChange={onChange}
          />
        </form>,
      );
    });
    expect(new FormData(form!).get('when')).toBe('2026-11-26T10:30');
    expect(form!.checkValidity()).toBe(true);
    expect(container.querySelector('.wheel-field-proxy')?.getAttribute('type')).toBe('datetime-local');
    expect(trigger().id).toBe('scheduled');
    expect(document.querySelectorAll('#scheduled')).toHaveLength(1);
  });

  it('clears an optional value with Temizle', async () => {
    resizeTo(390);
    await renderField({ mode: 'date', id: 'due', name: 'dueDate', value: '2026-11-26' });
    await click(trigger());
    const clear = [...document.querySelectorAll<HTMLButtonElement>('.wheel-sheet-header button')]
      .find((button) => button.textContent === 'Temizle');
    expect(clear).toBeDefined();
    await click(clear);
    expect(onChange).toHaveBeenCalledWith('');
    expect(dialog()).toBeNull();
  });

  it('does not offer Temizle on a required field', async () => {
    resizeTo(390);
    await renderField({
      mode: 'date', id: 'due', name: 'dueDate', value: '2026-11-26', required: true,
    });
    await click(trigger());
    const clear = [...document.querySelectorAll('.wheel-sheet-header button')]
      .some((button) => button.textContent === 'Temizle');
    expect(clear).toBe(false);
  });

  it('keeps an enclosing dialog open when Escape closes the picker', async () => {
    resizeTo(390);
    const parentKeydown = vi.fn();
    container.addEventListener('keydown', parentKeydown);
    await renderField({
      mode: 'datetime', id: 'scheduled', name: 'scheduledAt', value: '2026-11-26T10:30',
    });
    await click(trigger());
    await press(column('Saat'), 'Escape');

    expect(dialog()).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(parentKeydown).not.toHaveBeenCalled();
    await act(async () => { await Promise.resolve(); });
    expect(document.activeElement).toBe(trigger());
    container.removeEventListener('keydown', parentKeydown);
  });

  it('moves the day wheel to the true min/max on Home and End', async () => {
    resizeTo(390);
    await renderField({
      mode: 'datetime',
      id: 'scheduled',
      name: 'scheduledAt',
      value: '2026-11-25T10:00',
      min: '2020-01-01T00:00',
      max: '2026-11-25T23:59',
    });
    await click(trigger());
    const day = column('Gün');
    await press(day, 'Home');
    expect(day.getAttribute('aria-valuetext')).toContain('1 Oca');
    await press(day, 'End');
    expect(day.getAttribute('aria-valuetext')).toMatch(/Bugün|25 Kas/);
    await press(day, 'Home');

    await click(action('Tamam'));
    expect(onChange).toHaveBeenCalledWith('2020-01-01T10:00');
  });

  it('clamps a fast day change in one pass (the old minute cannot win)', async () => {
    resizeTo(390);
    await renderField({
      mode: 'datetime',
      id: 'scheduled',
      name: 'scheduledAt',
      value: '2026-11-26T07:50',
      min: '2026-11-25T09:43',
      max: '2026-11-27T18:00',
    });
    await click(trigger());
    const dayScroller = document.querySelector<HTMLElement>(
      '[data-wheel-column="Gün"] .wheel-column-scroller',
    );
    expect(dayScroller).not.toBeNull();
    await act(async () => { dayScroller!.scrollTop = 0; });

    await click(action('Tamam'));
    expect(onChange).toHaveBeenCalledWith('2026-11-25T09:43');
  });

  it('commits the same clamped value after the day scroll settles', async () => {
    vi.useFakeTimers();
    resizeTo(390);
    await renderField({
      mode: 'datetime',
      id: 'scheduled',
      name: 'scheduledAt',
      value: '2026-11-26T07:50',
      min: '2026-11-25T09:43',
      max: '2026-11-27T18:00',
    });
    await click(trigger());
    const dayScroller = document.querySelector<HTMLElement>(
      '[data-wheel-column="Gün"] .wheel-column-scroller',
    );
    expect(dayScroller).not.toBeNull();
    await act(async () => {
      dayScroller!.scrollTop = 0;
      dayScroller!.dispatchEvent(new Event('scroll', { bubbles: true }));
      vi.advanceTimersByTime(200);
    });

    await click(action('Tamam'));
    expect(onChange).toHaveBeenLastCalledWith('2026-11-25T09:43');
  });

  it('shows a visible required error and focuses the trigger on submit', async () => {
    resizeTo(390);
    await act(async () => {
      root.render(
        <form>
          <WheelDateTimeField
            mode="datetime"
            id="scheduled"
            name="when"
            value=""
            required
            onChange={onChange}
          />
        </form>,
      );
    });
    const form = container.querySelector('form');
    expect(form).not.toBeNull();
    expect(trigger().getAttribute('aria-invalid')).toBeNull();

    await act(async () => { form!.requestSubmit(); });

    const error = container.querySelector('.field-error');
    const proxy = container.querySelector<HTMLInputElement>('.wheel-field-proxy');
    expect(error?.textContent).toBe('Tarih ve saat seçin.');
    expect(trigger().getAttribute('aria-invalid')).toBe('true');
    expect(trigger().getAttribute('aria-describedby')).toBe(error?.id);
    expect(document.activeElement).toBe(trigger());
    expect(document.activeElement).not.toBe(proxy);
    expect(proxy?.tabIndex).toBe(-1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('clears the required error when Tamam commits a value', async () => {
    resizeTo(390);
    await act(async () => {
      root.render(
        <form>
          <WheelDateTimeField
            mode="datetime"
            id="scheduled"
            name="when"
            value=""
            required
            onChange={onChange}
          />
        </form>,
      );
    });
    await act(async () => { container.querySelector('form')!.requestSubmit(); });
    expect(container.querySelector('.field-error')).not.toBeNull();

    await click(trigger());
    await click(action('Tamam'));

    expect(onChange).toHaveBeenCalled();
    expect(container.querySelector('.field-error')).toBeNull();
    expect(trigger().getAttribute('aria-invalid')).toBeNull();
    expect(trigger().getAttribute('aria-describedby')).toBeNull();
  });

  it('commits the same resolved value for immediate and settled column changes', async () => {
    vi.useFakeTimers();
    resizeTo(390);

    type ColumnCase = {
      mode: WheelMode;
      value: string;
      min?: string;
      max?: string;
      minuteStep?: number;
      column: 'Gün' | 'Saat';
      index: number;
      expected: string;
    };
    const cases: ColumnCase[] = [
      {
        mode: 'time', value: '01:30', min: '22:00', max: '02:00',
        column: 'Saat', index: 2, expected: '02:00',
      },
      {
        mode: 'time', value: '10:30', min: '09:43', max: '18:00',
        column: 'Saat', index: 9, expected: '09:43',
      },
      {
        mode: 'time', value: '10:30', min: '09:43', max: '18:00', minuteStep: 15,
        column: 'Saat', index: 9, expected: '09:43',
      },
      {
        mode: 'time', value: '10:50', min: '09:00', max: '17:43',
        column: 'Saat', index: 17, expected: '17:43',
      },
      {
        mode: 'datetime', value: '2026-11-26T07:50',
        min: '2026-11-25T09:43', max: '2026-11-27T18:00',
        column: 'Gün', index: 0, expected: '2026-11-25T09:43',
      },
      {
        mode: 'datetime', value: '2026-11-26T10:30',
        min: '2026-11-25T09:00', max: '2026-11-27T18:00',
        column: 'Gün', index: 0, expected: '2026-11-25T10:30',
      },
      {
        mode: 'time', value: '22:30', min: '22:00', max: '02:00',
        column: 'Saat', index: 1, expected: '01:30',
      },
      {
        mode: 'date', value: '2026-11-26', min: '2026-11-25', max: '2026-11-27',
        column: 'Gün', index: 24, expected: '2026-11-25',
      },
    ];

    async function runCase(
      testCase: ColumnCase,
      settle: boolean,
      key: string,
    ): Promise<string | undefined> {
      onChange.mockClear();
      await act(async () => {
        root.render(
          <WheelDateTimeField
            key={key}
            mode={testCase.mode}
            id="scheduled"
            name="scheduledAt"
            value={testCase.value}
            min={testCase.min}
            max={testCase.max}
            minuteStep={testCase.minuteStep}
            onChange={onChange}
          />,
        );
      });
      await click(trigger());
      const scroller = document.querySelector<HTMLElement>(
        `[data-wheel-column="${testCase.column}"] .wheel-column-scroller`,
      );
      expect(scroller).not.toBeNull();
      await act(async () => {
        scroller!.scrollTop = testCase.index * 44;
        if (settle) {
          scroller!.dispatchEvent(new Event('scroll', { bubbles: true }));
          vi.advanceTimersByTime(300);
        }
      });
      await click(action('Tamam'));
      return onChange.mock.calls.at(-1)?.[0] as string | undefined;
    }

    for (const [index, testCase] of cases.entries()) {
      const immediate = await runCase(testCase, false, `immediate-${index}`);
      const settled = await runCase(testCase, true, `settled-${index}`);
      expect(immediate, `${testCase.mode} ${testCase.column} immediate`).toBe(testCase.expected);
      expect(settled, `${testCase.mode} ${testCase.column} settled`).toBe(testCase.expected);
      expect(immediate).toBe(settled);

      const parsed = parseWheelValue(testCase.mode, immediate!);
      expect(parsed).not.toBeNull();
      expect(isWithinWheelBounds(
        parsed!,
        parseWheelBounds(testCase.mode, testCase.min, testCase.max),
      )).toBe(true);
    }
  });

  it('shows the earliest bound for a range underflow', async () => {
    resizeTo(390);
    await act(async () => {
      root.render(
        <form>
          <WheelDateTimeField
            mode="date"
            id="due"
            name="due"
            value="2026-11-24"
            min="2026-11-25"
            onChange={onChange}
          />
        </form>,
      );
    });
    await act(async () => { container.querySelector('form')!.requestSubmit(); });
    expect(container.querySelector('.field-error')?.textContent)
      .toBe('En erken: Çar 25 Kas 2026');
  });

  it('shows the latest bound for a range overflow', async () => {
    resizeTo(390);
    await act(async () => {
      root.render(
        <form>
          <WheelDateTimeField
            mode="datetime"
            id="scheduled"
            name="scheduledAt"
            value="2026-11-28T10:00"
            max="2026-11-27T18:00"
            onChange={onChange}
          />
        </form>,
      );
    });
    await act(async () => { container.querySelector('form')!.requestSubmit(); });
    expect(container.querySelector('.field-error')?.textContent)
      .toBe('En geç: Cum 27 Kas · 18:00');
  });

  it('focuses only the first invalid field in a compact form', async () => {
    resizeTo(390);
    await act(async () => {
      root.render(
        <form>
          <WheelDateTimeField
            mode="date" id="first" name="first" value="" required onChange={onChange}
          />
          <WheelDateTimeField
            mode="date" id="second" name="second" value="" required onChange={onChange}
          />
        </form>,
      );
    });
    await act(async () => { container.querySelector('form')!.requestSubmit(); });

    const triggers = container.querySelectorAll('.wheel-field-trigger');
    expect(container.querySelectorAll('.field-error')).toHaveLength(2);
    expect(document.activeElement).toBe(triggers[0]);
    expect(document.activeElement).not.toBe(triggers[1]);
  });

  it('offers the off-grid minimum minute in the minute wheel', async () => {
    resizeTo(390);
    await renderField({
      mode: 'time', id: 'at', name: 'scheduleTime',
      value: '09:50', min: '09:43', max: '18:00',
    });
    await click(trigger());
    const items = [...document.querySelectorAll<HTMLElement>(
      '[data-wheel-column="Dakika"] .wheel-column-item',
    )];
    const bound = items.find((item) => item.textContent === '43');
    expect(bound).toBeDefined();
    expect(bound?.getAttribute('data-wheel-disabled')).toBeNull();
    expect(column('Dakika').getAttribute('aria-valuetext')).toBe('50');
  });

  it('enables an off-grid bound hour and Home selects its bound minute', async () => {
    resizeTo(390);
    await renderField({
      mode: 'time', id: 'at', name: 'scheduleTime',
      value: '10:30', min: '09:58', max: '18:00',
    });
    await click(trigger());
    const hour = column('Saat');
    const hourItems = [...document.querySelectorAll<HTMLElement>(
      '[data-wheel-column="Saat"] .wheel-column-item',
    )];
    expect(hourItems[9]?.getAttribute('data-wheel-disabled')).toBeNull();
    expect(hourItems[8]?.getAttribute('data-wheel-disabled')).toBe('true');

    await press(hour, 'Home');
    expect(hour.getAttribute('aria-valuetext')).toBe('09');
    expect(column('Dakika').getAttribute('aria-valuetext')).toBe('58');
    await click(action('Tamam'));
    expect(onChange).toHaveBeenCalledWith('09:58');
  });

  it('keeps focus on the first invalid field across a microtask checkpoint', async () => {
    resizeTo(390);
    await act(async () => {
      root.render(
        <form>
          <WheelDateTimeField
            mode="date" id="first" name="first" value="" required onChange={onChange}
          />
          <WheelDateTimeField
            mode="date" id="second" name="second" value="" required onChange={onChange}
          />
        </form>,
      );
    });
    const first = container.querySelector<HTMLButtonElement>('#first');
    const second = container.querySelector<HTMLButtonElement>('#second');
    const proxies = container.querySelectorAll<HTMLInputElement>('.wheel-field-proxy');
    expect(proxies).toHaveLength(2);

    // A browser may run a microtask checkpoint between the two invalid events.
    await act(async () => {
      proxies[0]!.dispatchEvent(new Event('invalid', { cancelable: true }));
      await Promise.resolve();
      proxies[1]!.dispatchEvent(new Event('invalid', { cancelable: true }));
    });

    expect(document.activeElement).toBe(first);
    expect(document.activeElement).not.toBe(second);
  });

  it('does not open while disabled', async () => {
    resizeTo(390);
    await renderField({
      mode: 'datetime',
      id: 'scheduled',
      name: 'scheduledAt',
      value: '2026-11-26T10:30',
      disabled: true,
    });
    expect(trigger().disabled).toBe(true);
    await click(trigger());
    expect(dialog()).toBeNull();
  });
});
