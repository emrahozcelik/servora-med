/** @vitest-environment jsdom */
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ReasonDialog } from '../src/ui/antd/ReasonDialog';
import { ServoraAntProvider } from '../src/ui/antd';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function typeInTextarea(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('ReasonDialog', () => {
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

  async function renderReason(props: {
    open?: boolean;
    pending?: boolean;
    onConfirm?: (reason: string) => void;
    onCancel?: () => void;
    confirmLabel?: string;
  } = {}) {
    await act(async () => {
      root.render(
        <ServoraAntProvider>
          <ReasonDialog
            open={props.open ?? true}
            title="Düzeltme için geri gönder"
            description="Personelin neyi düzeltmesi gerektiğini açıklayın."
            reasonLabel="Düzeltme nedeni"
            confirmLabel={props.confirmLabel ?? 'Gönder'}
            maxLength={2000}
            required
            pending={props.pending ?? false}
            onConfirm={props.onConfirm ?? (() => {})}
            onCancel={props.onCancel ?? (() => {})}
            returnFocusRef={{ current: trigger }}
          />
        </ServoraAntProvider>,
      );
    });
  }

  it('focuses cancel on open and exposes labelled dialog', async () => {
    await renderReason();
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    expect(host.textContent).toContain('Düzeltme nedeni');
    const cancel = Array.from(host.querySelectorAll('button'))
      .find((b) => b.textContent === 'Vazgeç');
    expect(document.activeElement).toBe(cancel);
  });

  it('shows required reason error on real empty submit click', async () => {
    const onConfirm = vi.fn();
    await renderReason({ onConfirm });
    const submit = Array.from(host.querySelectorAll('button'))
      .find((b) => b.textContent === 'Gönder') as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    await act(async () => { submit.click(); });
    await act(async () => { await new Promise((r) => requestAnimationFrame(r)); });
    expect(onConfirm).not.toHaveBeenCalled();
    const alert = host.querySelector('[role="alert"]');
    const textarea = host.querySelector('textarea')!;
    expect(alert?.textContent).toContain('Neden alanı zorunludur.');
    expect(textarea.getAttribute('aria-invalid')).toBe('true');
    expect(textarea.getAttribute('aria-describedby')).toBe(alert?.id);
    expect(document.activeElement).toBe(textarea);
  });

  it('shows required reason error on real whitespace-only submit click', async () => {
    const onConfirm = vi.fn();
    await renderReason({ onConfirm });
    const textarea = host.querySelector('textarea')!;
    await act(async () => { typeInTextarea(textarea, '   \n\t  '); });
    const submit = Array.from(host.querySelectorAll('button'))
      .find((b) => b.textContent === 'Gönder') as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    await act(async () => { submit.click(); });
    await act(async () => { await new Promise((r) => requestAnimationFrame(r)); });
    expect(onConfirm).not.toHaveBeenCalled();
    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Neden alanı zorunludur.');
    expect(textarea.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(textarea);
  });

  it('submits trimmed reason when valid', async () => {
    const onConfirm = vi.fn();
    await renderReason({ onConfirm });
    const textarea = host.querySelector('textarea')!;
    await act(async () => { typeInTextarea(textarea, '  Miktarı düzeltin  '); });
    const submit = Array.from(host.querySelectorAll('button'))
      .find((b) => b.textContent === 'Gönder') as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    await act(async () => { submit.click(); });
    expect(onConfirm).toHaveBeenCalledWith('Miktarı düzeltin');
  });

  it('enforces maxLength of 2000', async () => {
    await renderReason();
    expect(host.querySelector('textarea')?.getAttribute('maxLength')).toBe('2000');
  });

  it('clears draft when reopened', async () => {
    function ToggleHarness() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setOpen((v) => !v)}>toggle</button>
          <ReasonDialog
            open={open}
            title="t"
            description="d"
            reasonLabel="r"
            confirmLabel="c"
            maxLength={2000}
            required
            pending={false}
            onConfirm={() => {}}
            onCancel={() => setOpen(false)}
          />
        </>
      );
    }
    await act(async () => {
      root.render(<ServoraAntProvider><ToggleHarness /></ServoraAntProvider>);
    });
    const textarea = host.querySelector('textarea')!;
    await act(async () => { typeInTextarea(textarea, 'eski neden'); });
    expect(textarea.value).toBe('eski neden');
    const toggle = Array.from(host.querySelectorAll('button'))
      .find((b) => b.textContent === 'toggle')!;
    await act(async () => { toggle.click(); });
    await act(async () => { toggle.click(); });
    expect((host.querySelector('textarea') as HTMLTextAreaElement).value).toBe('');
  });

  it('blocks Escape and cancel while pending and keeps focus inside dialog', async () => {
    const onCancel = vi.fn();
    await renderReason({ pending: true, onCancel });
    const dialog = host.querySelector('[role="dialog"]')!;
    expect(dialog.contains(document.activeElement)).toBe(true);
    await act(async () => {
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onCancel).not.toHaveBeenCalled();
    const cancel = Array.from(host.querySelectorAll('button'))
      .find((b) => b.textContent === 'Vazgeç') as HTMLButtonElement;
    expect(cancel.disabled).toBe(true);
  });

  it('keeps focus inside dialog when opened while pending', async () => {
    await renderReason({ pending: true });
    const dialog = host.querySelector('[role="dialog"]')!;
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(dialog);
  });
});
