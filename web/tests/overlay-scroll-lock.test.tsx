/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ResponsiveDrawer } from '../src/ui/antd/ResponsiveDrawer';
import { WheelDateTimeField } from '../src/ui/WheelDateTimeField';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement;
let root: Root;

function renderDrawer(open: boolean): void {
  root.render(
    <ResponsiveDrawer
      open={open}
      title="Filtreler"
      onDismiss={() => {}}
      onApply={() => {}}
      onClear={() => {}}
    >
      <WheelDateTimeField
        mode="date"
        id="job-due-after"
        value="2026-11-25"
        onChange={() => {}}
      />
    </ResponsiveDrawer>,
  );
}

function wheelTrigger(): HTMLButtonElement {
  const element = container.querySelector<HTMLButtonElement>('#job-due-after');
  if (!element) throw new Error('Missing wheel trigger');
  return element;
}

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 390 });
  document.body.style.overflow = '';
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.style.overflow = '';
  Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1024 });
});

describe('nested overlay scroll lock', () => {
  it('restores the page overflow after a drawer and its open wheel sheet both unmount', async () => {
    await act(async () => renderDrawer(true));
    expect(document.body.style.overflow).toBe('hidden');

    await act(async () => wheelTrigger().click());
    expect(container.querySelector('[role="dialog"][aria-modal="true"] .wheel-sheet')).not.toBeNull();
    expect(document.body.style.overflow).toBe('hidden');

    // A route change removes the drawer and the wheel sheet together.
    await act(async () => root.unmount());
    expect(document.body.style.overflow).toBe('');
  });

  it('keeps the drawer lock until the drawer itself closes', async () => {
    await act(async () => renderDrawer(true));
    await act(async () => wheelTrigger().click());

    const cancel = [...container.querySelectorAll<HTMLButtonElement>('.wheel-sheet-actions button')]
      .find((button) => button.textContent === 'Vazgeç');
    await act(async () => cancel!.click());
    expect(container.querySelector('.wheel-sheet')).toBeNull();
    expect(document.body.style.overflow).toBe('hidden');

    await act(async () => renderDrawer(false));
    expect(document.body.style.overflow).toBe('');
  });

  it('restores the previous inline overflow value, not just the default', async () => {
    document.body.style.overflow = 'clip';
    await act(async () => renderDrawer(true));
    await act(async () => wheelTrigger().click());
    expect(document.body.style.overflow).toBe('hidden');

    await act(async () => root.unmount());
    expect(document.body.style.overflow).toBe('clip');
  });
});
