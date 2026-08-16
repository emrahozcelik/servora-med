/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AvailableSlotsNotice } from '../src/jobs/AvailableSlotsNotice';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const styles = readFileSync(resolve(__dirname, '../src/styles.css'), 'utf8');

describe('AvailableSlotsNotice', () => {
  let root: Root;
  let container: HTMLDivElement;

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
  });

  it('renders selectable minimal slot labels without conflict details', async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const onSelect = vi.fn();

    await act(async () => root.render(<AvailableSlotsNotice
      searched
      searching={false}
      slots={[{ startsAt: '2026-08-17T10:00:00.000Z', endsAt: '2026-08-17T11:00:00.000Z' }]}
      error={null}
      featureDisabled={false}
      onSelect={onSelect}
    />));

    expect(container.textContent).toContain('Ortak uygun saatler');
    expect(container.textContent).not.toContain('müşteri');
    const button = container.querySelector('button[data-available-slot]') as HTMLButtonElement;
    expect(button).toBeTruthy();
    expect(button.type).toBe('button');
    expect(button.tabIndex).toBe(0);
    await act(async () => button.focus());
    expect(document.activeElement).toBe(button);
    await act(async () => button.click());
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(onSelect).toHaveBeenCalledWith({
      startsAt: '2026-08-17T10:00:00.000Z',
      endsAt: '2026-08-17T11:00:00.000Z',
    });
  });

  it('renders each candidate with separate date and time hierarchy in source order', async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root.render(<AvailableSlotsNotice
      searched
      searching={false}
      slots={[
        { startsAt: '2026-08-17T10:00:00.000Z', endsAt: '2026-08-17T11:00:00.000Z' },
        { startsAt: '2026-08-18T12:30:00.000Z', endsAt: '2026-08-18T13:00:00.000Z' },
      ]}
      error={null}
      featureDisabled={false}
      onSelect={() => {}}
    />));

    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('button[data-available-slot]'));
    const formatTime = (value: string) => new Intl.DateTimeFormat('tr-TR', {
      hour: '2-digit', minute: '2-digit',
    }).format(new Date(value));
    const expectedFirstTime = `${formatTime('2026-08-17T10:00:00.000Z')}–${formatTime('2026-08-17T11:00:00.000Z')}`;
    const expectedSecondTime = `${formatTime('2026-08-18T12:30:00.000Z')}–${formatTime('2026-08-18T13:00:00.000Z')}`;
    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.querySelector('.available-slots-slot-date')?.textContent).not.toContain(':');
    expect(buttons[0]?.querySelector('.available-slots-slot-time')?.textContent)
      .toMatch(/\d{2}:\d{2}–\d{2}:\d{2}/);
    expect(buttons[1]?.querySelector('.available-slots-slot-time')?.textContent)
      .toBe(expectedSecondTime);
    expect(buttons[0]?.getAttribute('aria-label')).toContain(expectedFirstTime);
    expect(buttons[1]?.getAttribute('aria-label')).toContain(expectedSecondTime);
  });

  it('reveals more candidates without fetching and keeps the selected option explicit', async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const onSelect = vi.fn();
    const slots = Array.from({ length: 7 }, (_, index) => ({
      startsAt: `2026-08-${String(17 + index).padStart(2, '0')}T10:00:00.000Z`,
      endsAt: `2026-08-${String(17 + index).padStart(2, '0')}T11:00:00.000Z`,
    }));

    await act(async () => root.render(<AvailableSlotsNotice
      searched
      searching={false}
      slots={slots}
      error={null}
      featureDisabled={false}
      onSelect={onSelect}
    />));

    expect(container.querySelectorAll('button[data-available-slot]')).toHaveLength(6);
    const toggle = () => container.querySelector<HTMLButtonElement>('.available-slots-toggle')!;
    expect(toggle().textContent).toBe('Daha fazla göster');
    await act(async () => toggle().click());
    expect(container.querySelectorAll('button[data-available-slot]')).toHaveLength(7);
    expect(toggle().textContent).toBe('Daha az göster');
    expect(onSelect).not.toHaveBeenCalled();

    const last = container.querySelectorAll<HTMLButtonElement>('button[data-available-slot]')[6];
    await act(async () => last.click());
    expect(onSelect).toHaveBeenCalledWith(slots[6]);
    expect(last.getAttribute('aria-pressed')).toBe('true');

    await act(async () => toggle().click());
    expect(container.querySelectorAll('button[data-available-slot]')).toHaveLength(6);
  });

  it('uses a responsive equal-column grid with a readable selected state', () => {
    expect(styles).toMatch(/\.available-slots-list\s*\{[^}]*display:\s*grid/s);
    expect(styles).toMatch(/\.available-slots-list\s*\{[^}]*grid-template-columns:\s*repeat\(3,/s);
    expect(styles).toMatch(/\.available-slot-option\s*\{[^}]*min-height:/s);
    expect(styles).toMatch(/\.available-slots-slot-time\s*\{[^}]*white-space:\s*nowrap/s);
    expect(styles).toMatch(/\.available-slot-option--selected\s*\{[^}]*background:\s*var\(--accent-soft\)/s);
    expect(styles).toMatch(/@media\s*\(max-width:\s*56rem\)[\s\S]*\.available-slots-list[^}]*grid-template-columns:\s*repeat\(2,/s);
    expect(styles).toMatch(/@media\s*\(max-width:\s*40rem\)[\s\S]*\.available-slots-list[^}]*grid-template-columns:\s*1fr/s);
  });
});
