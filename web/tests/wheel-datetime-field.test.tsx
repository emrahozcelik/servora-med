/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WheelDateTimeField, type WheelDateTimeFieldProps } from '../src/ui/WheelDateTimeField';

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

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  onChange = vi.fn();
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
