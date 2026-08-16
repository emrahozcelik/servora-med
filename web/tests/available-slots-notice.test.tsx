/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AvailableSlotsNotice } from '../src/jobs/AvailableSlotsNotice';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

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
    await act(async () => button.click());
    expect(onSelect).toHaveBeenCalledWith({
      startsAt: '2026-08-17T10:00:00.000Z',
      endsAt: '2026-08-17T11:00:00.000Z',
    });
  });
});
