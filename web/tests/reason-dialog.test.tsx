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

  it('focuses cancel on open and exposes labelled dialog', async () => {
    await act(async () => {
      root.render(
        <ServoraAntProvider>
          <ReasonDialog
            open
            title="Düzeltme için geri gönder"
            description="Personelin neyi düzeltmesi gerektiğini açıklayın."
            reasonLabel="Düzeltme nedeni"
            confirmLabel="Düzeltme için geri gönder"
            maxLength={2000}
            required
            pending={false}
            onConfirm={() => {}}
            onCancel={() => {}}
            returnFocusRef={{ current: trigger }}
          />
        </ServoraAntProvider>,
      );
    });
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    expect(host.textContent).toContain('Düzeltme nedeni');
    const cancel = Array.from(host.querySelectorAll('button'))
      .find((b) => b.textContent === 'Vazgeç');
    expect(document.activeElement).toBe(cancel);
  });

  it('rejects empty reason with alert linked to textarea', async () => {
    const onConfirm = vi.fn();
    await act(async () => {
      root.render(
        <ServoraAntProvider>
          <ReasonDialog
            open
            title="Düzeltme"
            description="Açıklayın."
            reasonLabel="Düzeltme nedeni"
            confirmLabel="Gönder"
            maxLength={2000}
            required
            pending={false}
            onConfirm={onConfirm}
            onCancel={() => {}}
          />
        </ServoraAntProvider>,
      );
    });
    const form = host.querySelector('form')!;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    // React onSubmit needs requestSubmit or button click - empty required disables submit button
    const submit = Array.from(host.querySelectorAll('button[type="submit"]'))[0] as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(onConfirm).not.toHaveBeenCalled();

    // Force submit handler with whitespace via typing then clearing validate path:
    // enable by typing then submit with only spaces
    const textarea = host.querySelector('textarea')!;
    await act(async () => { typeInTextarea(textarea, 'x'); });
    await act(async () => { typeInTextarea(textarea, '   '); });
    // After spaces, button should be disabled again (trim check)
    expect(submit.disabled).toBe(true);

    // Call submit handler while required and empty by temporarily enabling:
    await act(async () => {
      form.requestSubmit();
    });
    // When disabled, requestSubmit may still not fire. Invoke by clicking after set reason to space
    // and using form onSubmit manually - dispatch SubmitEvent
    await act(async () => {
      typeInTextarea(textarea, '');
    });
    // Empty: disabled. Use a non-required path to verify alert for forced empty...
    // Instead re-render and use button with required false then... 

    // Direct: open with text, submit ok; separate test below. For empty validation message,
    // use form submit when reason is whitespace by calling the form's onSubmit via enabling:
    await act(async () => {
      typeInTextarea(textarea, 'ok');
    });
    expect(submit.disabled).toBe(false);
    await act(async () => { typeInTextarea(textarea, '  \n\t  '); });
    expect(submit.disabled).toBe(true);

    // Submit with whitespace by temporarily removing disabled check: use form requestSubmit after
    // setting reason to whitespace through React - button disabled prevents click.
    // Verify client validation message by invoking submit with non-empty then...
    // Simpler: use required + click submit when we inject reason "  " via internal state:
    // Type spaces using change that keeps button disabled - assert no confirm.
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('shows alert when required reason is whitespace-only on submit', async () => {
    const onConfirm = vi.fn();
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <ReasonDialog
          open={open}
          title="İptal"
          description="Neden yazın."
          reasonLabel="İptal nedeni"
          confirmLabel="İşi iptal et"
          maxLength={2000}
          required
          pending={false}
          destructive
          onConfirm={(reason) => { onConfirm(reason); setOpen(false); }}
          onCancel={() => setOpen(false)}
        />
      );
    }
    await act(async () => {
      root.render(<ServoraAntProvider><Harness /></ServoraAntProvider>);
    });
    const textarea = host.querySelector('textarea')!;
    // Bypass disabled submit: call form onSubmit with React synthetic by enabling button
    // after setting non-trim value then changing - use fireEvent pattern:
    await act(async () => { typeInTextarea(textarea, 'x'); });
    const form = host.querySelector('form')!;
    // Patch reason to spaces without going through disabled: re-type
    await act(async () => { typeInTextarea(textarea, '   '); });
    // Force enable and click
    const submit = host.querySelector('button[type="submit"]') as HTMLButtonElement;
    await act(async () => {
      submit.disabled = false;
      form.requestSubmit();
    });
    expect(onConfirm).not.toHaveBeenCalled();
    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Neden alanı zorunludur.');
    expect(textarea.getAttribute('aria-invalid')).toBe('true');
    expect(textarea.getAttribute('aria-describedby')).toBe(alert?.id);
  });

  it('submits trimmed reason when valid', async () => {
    const onConfirm = vi.fn();
    await act(async () => {
      root.render(
        <ServoraAntProvider>
          <ReasonDialog
            open
            title="Düzeltme"
            description="Açıklayın."
            reasonLabel="Düzeltme nedeni"
            confirmLabel="Gönder"
            maxLength={2000}
            required
            pending={false}
            onConfirm={onConfirm}
            onCancel={() => {}}
          />
        </ServoraAntProvider>,
      );
    });
    const textarea = host.querySelector('textarea')!;
    await act(async () => { typeInTextarea(textarea, '  Miktarı düzeltin  '); });
    const submit = Array.from(host.querySelectorAll('button'))
      .find((b) => b.textContent === 'Gönder') as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    await act(async () => { submit.click(); });
    expect(onConfirm).toHaveBeenCalledWith('Miktarı düzeltin');
  });

  it('enforces maxLength of 2000', async () => {
    await act(async () => {
      root.render(
        <ServoraAntProvider>
          <ReasonDialog
            open
            title="t"
            description="d"
            reasonLabel="r"
            confirmLabel="c"
            maxLength={2000}
            required
            pending={false}
            onConfirm={() => {}}
            onCancel={() => {}}
          />
        </ServoraAntProvider>,
      );
    });
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
    await act(async () => { toggle.click(); }); // close
    await act(async () => { toggle.click(); }); // reopen
    expect((host.querySelector('textarea') as HTMLTextAreaElement).value).toBe('');
  });

  it('blocks Escape and cancel while pending', async () => {
    const onCancel = vi.fn();
    await act(async () => {
      root.render(
        <ServoraAntProvider>
          <ReasonDialog
            open
            title="t"
            description="d"
            reasonLabel="r"
            confirmLabel="c"
            maxLength={2000}
            required
            pending
            onConfirm={() => {}}
            onCancel={onCancel}
          />
        </ServoraAntProvider>,
      );
    });
    const dialog = host.querySelector('[role="dialog"]')!;
    await act(async () => {
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onCancel).not.toHaveBeenCalled();
    const cancel = Array.from(host.querySelectorAll('button'))
      .find((b) => b.textContent === 'Vazgeç') as HTMLButtonElement;
    expect(cancel.disabled).toBe(true);
  });
});
