/** @vitest-environment jsdom */
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfirmationAction } from '../src/ui/antd/ConfirmationAction';
import { ServoraAntProvider } from '../src/ui/antd';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('ConfirmationAction', () => {
  let host: HTMLDivElement;
  let root: Root;
  let trigger: HTMLButtonElement;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.textContent = 'Open';
    document.body.append(trigger);
    trigger.focus();
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
    trigger.remove();
  });

  async function render(props: Partial<Parameters<typeof ConfirmationAction>[0]> & {
    open: boolean;
    onConfirm?: () => void;
    onCancel?: () => void;
  }) {
    const returnFocusRef = { current: trigger };
    await act(async () => {
      root.render(
        <ServoraAntProvider>
          <ConfirmationAction
            open={props.open}
            title={props.title ?? 'Sil'}
            description={props.description ?? 'Geri alınamaz.'}
            details={props.details}
            confirmLabel={props.confirmLabel ?? 'Sil'}
            cancelLabel={props.cancelLabel}
            pending={props.pending ?? false}
            pendingLabel={props.pendingLabel}
            destructive={props.destructive ?? true}
            onConfirm={props.onConfirm ?? (() => {})}
            onCancel={props.onCancel ?? (() => {})}
            returnFocusRef={returnFocusRef}
          />
        </ServoraAntProvider>,
      );
    });
    return returnFocusRef;
  }

  it('renders modal dialog with title and focuses cancel', async () => {
    await render({ open: true });
    const dialog = host.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(host.textContent).toContain('Sil');
    expect(host.textContent).toContain('Geri alınamaz.');
    const cancel = Array.from(host.querySelectorAll('button'))
      .find((b) => b.textContent === 'Vazgeç');
    expect(document.activeElement).toBe(cancel);
  });

  it('lists optional consequence details', async () => {
    await render({ open: true, details: ['Kayıt kilitlenir', 'Personel bilgilendirilir'] });
    expect(host.textContent).toContain('Kayıt kilitlenir');
    expect(host.textContent).toContain('Personel bilgilendirilir');
  });

  it('Escape cancels when not pending and does nothing when pending', async () => {
    const onCancel = vi.fn();
    await render({ open: true, onCancel, pending: false });
    const dialog = host.querySelector('[role="dialog"]')!;
    await act(async () => {
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onCancel).toHaveBeenCalledTimes(1);

    onCancel.mockClear();
    await render({ open: true, onCancel, pending: true });
    const dialogPending = host.querySelector('[role="dialog"]')!;
    await act(async () => {
      dialogPending.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('prevents double confirm while pending', async () => {
    const onConfirm = vi.fn();
    await render({ open: true, pending: true, onConfirm, pendingLabel: 'Siliniyor…' });
    const confirm = Array.from(host.querySelectorAll('button'))
      .find((b) => b.textContent === 'Siliniyor…')!;
    expect(confirm.disabled).toBe(true);
    await act(async () => { confirm.click(); });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('calls onConfirm once when enabled', async () => {
    const onConfirm = vi.fn();
    await render({ open: true, pending: false, onConfirm });
    const confirm = Array.from(host.querySelectorAll('button'))
      .find((b) => b.textContent === 'Sil')!;
    await act(async () => { confirm.click(); });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('restores focus to returnFocusRef when closed', async () => {
    await render({ open: true });
    expect(document.activeElement).not.toBe(trigger);
    await render({ open: false });
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(trigger);
  });

  it('keeps focus inside dialog when opened while pending', async () => {
    await render({ open: true, pending: true, pendingLabel: 'Siliniyor…' });
    const dialog = host.querySelector('[role="dialog"]')!;
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(dialog);
  });

  it('moves focus into dialog when pending disables the focused control', async () => {
    function PendingHarness() {
      const [pending, setPending] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setPending(true)}>start</button>
          <ConfirmationAction
            open
            title="Sil"
            description="Geri alınamaz."
            confirmLabel="Sil"
            pending={pending}
            pendingLabel="Siliniyor…"
            destructive
            onConfirm={() => {}}
            onCancel={() => {}}
            returnFocusRef={{ current: trigger }}
          />
        </>
      );
    }
    await act(async () => {
      root.render(<ServoraAntProvider><PendingHarness /></ServoraAntProvider>);
    });
    const confirm = Array.from(host.querySelectorAll('button'))
      .find((b) => b.textContent === 'Sil')!;
    await act(async () => { confirm.focus(); });
    expect(document.activeElement).toBe(confirm);
    const start = Array.from(host.querySelectorAll('button'))
      .find((b) => b.textContent === 'start')!;
    await act(async () => { start.click(); });
    const dialog = host.querySelector('[role="dialog"]')!;
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('traps Tab while pending so focus cannot leave the overlay', async () => {
    await render({ open: true, pending: true });
    const dialog = host.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.contains(document.activeElement)).toBe(true);
    await act(async () => {
      dialog.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Tab', bubbles: true, cancelable: true,
      }));
    });
    expect(dialog.contains(document.activeElement)).toBe(true);
    await act(async () => {
      dialog.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Tab', bubbles: true, cancelable: true, shiftKey: true,
      }));
    });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('does not import or render Popconfirm semantics', async () => {
    await render({ open: true });
    expect(host.querySelector('.servora-ant-popover')).toBeNull();
    expect(host.querySelector('[role="tooltip"]')).toBeNull();
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
  });
});
