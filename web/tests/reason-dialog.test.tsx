/** @vitest-environment jsdom */
import { act, useState, type ReactNode, type RefObject } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ReasonDialog } from '../src/ui/antd/ReasonDialog';
import { ServoraAntProvider } from '../src/ui/antd';
import { JobWorkflowDialog } from '../src/jobs/JobWorkflowDialog';

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
    confirmDisabled?: boolean;
    description?: ReactNode;
    onConfirm?: (reason: string) => void;
    onCancel?: () => void;
    confirmLabel?: string;
    prelude?: ReactNode;
    validatePrelude?: () => string | null;
    initialFocusRef?: RefObject<HTMLElement | null>;
    initialFocusReady?: boolean;
    returnFocusRef?: RefObject<HTMLElement | null>;
  } = {}) {
    await act(async () => {
      root.render(
        <ServoraAntProvider>
          <ReasonDialog
            open={props.open ?? true}
            title="Düzeltme için geri gönder"
            description={props.description ?? 'Personelin neyi düzeltmesi gerektiğini açıklayın.'}
            reasonLabel="Düzeltme nedeni"
            confirmLabel={props.confirmLabel ?? 'Gönder'}
            maxLength={2000}
            required
            pending={props.pending ?? false}
            confirmDisabled={props.confirmDisabled}
            onConfirm={props.onConfirm ?? (() => {})}
            onCancel={props.onCancel ?? (() => {})}
            returnFocusRef={props.returnFocusRef ?? { current: trigger }}
            prelude={props.prelude}
            validatePrelude={props.validatePrelude}
            initialFocusRef={props.initialFocusRef}
            initialFocusReady={props.initialFocusReady}
          />
        </ServoraAntProvider>,
      );
      await new Promise((resolve) => requestAnimationFrame(resolve));
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

  it('focuses the meaningful field and rehomes focus when an async prelude appears', async () => {
    const firstPreludeField = { current: null } as RefObject<HTMLElement | null>;
    const returnFocusRef = { current: trigger } as RefObject<HTMLElement | null>;
    await renderReason({
      initialFocusRef: firstPreludeField,
      initialFocusReady: false,
      returnFocusRef,
    });
    expect(document.activeElement?.textContent).toBe('Vazgeç');

    await act(async () => {
      root.render(
        <ServoraAntProvider>
          <ReasonDialog
            open
            title="Düzeltme için geri gönder"
            description="Personelin neyi düzeltmesi gerektiğini açıklayın."
            reasonLabel="Düzeltme nedeni"
            confirmLabel="Gönder"
            maxLength={2000}
            required
            pending={false}
            onConfirm={() => {}}
            onCancel={() => {}}
            returnFocusRef={returnFocusRef}
            prelude={<input ref={firstPreludeField} aria-label="Takip tarihi" />}
            initialFocusRef={firstPreludeField}
            initialFocusReady
          />
        </ServoraAntProvider>,
      );
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(document.activeElement).toBe(firstPreludeField.current);
  });

  it('does not steal focus or draft input when the user interacts before async readiness', async () => {
    const firstPreludeField = { current: null } as RefObject<HTMLElement | null>;
    const returnFocusRef = { current: trigger } as RefObject<HTMLElement | null>;
    await renderReason({
      initialFocusRef: firstPreludeField,
      initialFocusReady: false,
      returnFocusRef,
      prelude: <input ref={firstPreludeField} aria-label="Takip tarihi" />,
    });

    const textarea = host.querySelector('textarea')!;
    typeInTextarea(textarea, 'Yönetici notu korunmalı');
    textarea.focus();

    await act(async () => {
      root.render(
        <ServoraAntProvider>
          <ReasonDialog
            open
            title="Düzeltme için geri gönder"
            description="Personelin neyi düzeltmesi gerektiğini açıklayın."
            reasonLabel="Düzeltme nedeni"
            confirmLabel="Gönder"
            maxLength={2000}
            required
            pending={false}
            onConfirm={() => {}}
            onCancel={() => {}}
            returnFocusRef={returnFocusRef}
            prelude={<input ref={firstPreludeField} aria-label="Takip tarihi" />}
            initialFocusRef={firstPreludeField}
            initialFocusReady
          />
        </ServoraAntProvider>,
      );
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });

    expect(document.activeElement).toBe(textarea);
    expect(textarea.value).toBe('Yönetici notu korunmalı');
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
    expect(textarea.getAttribute('aria-describedby')?.split(' ')).toContain(alert?.id);
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

  it('enforces the 2,000 Unicode code-point limit', async () => {
    const onConfirm = vi.fn();
    await renderReason({ onConfirm });
    const textarea = host.querySelector('textarea')!;
    await act(async () => { typeInTextarea(textarea, '😀'.repeat(2_001)); });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('en fazla 2.000 karakter');
    const submit = Array.from(host.querySelectorAll('button'))
      .find((b) => b.textContent === 'Gönder') as HTMLButtonElement;
    await act(async () => { submit.click(); });
    expect(onConfirm).not.toHaveBeenCalled();
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

  it('hides the counter above 500 remaining and reveals it within the threshold', async () => {
    const { textarea, counter } = await renderAndGetCounter();
    expect(counter).toBeNull();
    const setDraft = async (value: string) => {
      const prototype = HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(textarea, value);
      await act(async () => {
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        await Promise.resolve();
      });
    };
    await setDraft('a'.repeat(1_500));
    expect(host.querySelector('[data-reason-counter]')).not.toBeNull();
    expect(host.querySelector('[data-reason-counter]')!.textContent).toContain('500 karakter kaldı');
    await setDraft('a'.repeat(1_900));
    expect(host.querySelector('[data-reason-counter]')!.getAttribute('data-counter-state'))
      .toBe('attention');
  });

  async function renderAndGetCounter() {
    await renderReason();
    return {
      textarea: host.querySelector<HTMLTextAreaElement>('textarea')!,
      counter: host.querySelector('[data-reason-counter]'),
    };
  }

  it('runs validatePrelude before required textarea validation and prevents bottom textarea focus or error', async () => {
    const onConfirm = vi.fn();
    const validatePrelude = vi.fn(() => 'Önce üstteki alanı seçin.');
    await renderReason({
      onConfirm,
      validatePrelude,
      prelude: <select aria-label="Neden seçimi"><option value="">Seçin</option></select>,
    });

    const submit = Array.from(host.querySelectorAll('button'))
      .find((b) => b.textContent === 'Gönder') as HTMLButtonElement;
    submit.focus();
    await act(async () => { submit.click(); });
    await act(async () => { await new Promise((r) => requestAnimationFrame(r)); });

    expect(validatePrelude).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    const textarea = host.querySelector('textarea')!;
    expect(textarea.getAttribute('aria-invalid')).toBeNull();
    expect(host.querySelector('p.field-error')).toBeNull();
    expect(document.activeElement).not.toBe(textarea);
  });

  it('disables the confirm button when confirmDisabled is true', async () => {
    const onConfirm = vi.fn();
    await renderReason({ confirmDisabled: true, onConfirm });
    const cancel = Array.from(host.querySelectorAll('button'))
      .find((b) => b.textContent === 'Vazgeç') as HTMLButtonElement;
    const submit = Array.from(host.querySelectorAll('button'))
      .find((b) => b.textContent === 'Gönder') as HTMLButtonElement;
    expect(cancel.disabled).toBe(false);
    expect(submit.disabled).toBe(true);
    await act(async () => { submit.click(); });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('renders multiple <p> elements for newline-separated descriptions and keeps single-line <p>', async () => {
    await renderReason({
      description: 'İlk paragraf.\n\n  İkinci paragraf.  \n',
    });
    const wrapper = host.querySelector('.reason-dialog-description');
    expect(wrapper).not.toBeNull();
    const paragraphs = Array.from(wrapper!.querySelectorAll('p')).map((p) => p.textContent);
    expect(paragraphs).toEqual(['İlk paragraf.', 'İkinci paragraf.']);

    await renderReason({ description: 'Tek satır açıklama.' });
    expect(host.querySelector('.reason-dialog-description')).toBeNull();
    expect(host.querySelector('[role="dialog"] > p')?.textContent).toBe('Tek satır açıklama.');
  });
});

describe('JobWorkflowDialog Dilim 3 enhancements', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
  });

  it('renders submit confirmation title and details, plus follow-up loading/error states', async () => {
    await act(async () => {
      root.render(
        <ServoraAntProvider>
          <JobWorkflowDialog
            dialog={{
              kind: 'submit',
              presentation: {
                command: 'SUBMIT_FOR_APPROVAL',
                label: 'Kontrole gönder',
                consequence: 'İş yönetici kontrolüne geçecek.',
                successMessage: 'Gönderildi.',
                confirmation: {
                  title: 'İşi kontrole göndermek üzeresiniz',
                  details: [
                    'İş “Yönetici kontrolünde” durumuna geçer',
                    'İş geçmişine kayıt ekler',
                  ],
                  confirmLabel: 'Kontrole gönder',
                },
              },
            }}
            pending={false}
            loadingFollowUp
            followUpLoadError="Takip önerisi alınamadı."
            onClose={() => {}}
            onConfirm={() => {}}
          />
        </ServoraAntProvider>,
      );
    });

    const dialog = host.querySelector('[role="dialog"]')!;
    expect(dialog.querySelector('h2')?.textContent).toBe('İşi kontrole göndermek üzeresiniz');
    const detailItems = Array.from(dialog.querySelectorAll('.workflow-dialog-details li'))
      .map((li) => li.textContent);
    expect(detailItems).toEqual([
      'İş “Yönetici kontrolünde” durumuna geçer',
      'İş geçmişine kayıt ekler',
    ]);
    expect(dialog.querySelector('p.field-status[role="status"]')?.textContent)
      .toBe('Takip önerisi yükleniyor…');
    expect(dialog.querySelector('p.form-error[role="alert"]')?.textContent)
      .toBe('Takip önerisi alınamadı.');
    const submit = Array.from(dialog.querySelectorAll('button'))
      .find((b) => b.textContent === 'Kontrole gönder') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });

  it('splits decline and cancel descriptions into separate paragraphs', async () => {
    await act(async () => {
      root.render(
        <ServoraAntProvider>
          <JobWorkflowDialog
            dialog={{
              kind: 'decline',
              presentation: {
                command: 'DECLINE_ASSIGNMENT',
                label: 'Görevi reddet',
                consequence: 'Görev yöneticinin listesine düşer.',
                successMessage: 'Reddedildi.',
              },
            }}
            pending={false}
            onClose={() => {}}
            onConfirm={() => {}}
          />
        </ServoraAntProvider>,
      );
    });

    const declineParagraphs = Array.from(host.querySelectorAll('.reason-dialog-description p'))
      .map((p) => p.textContent);
    expect(declineParagraphs).toEqual([
      'Görev yöneticinin listesine düşer.',
      'Seçtiğiniz neden ve açıklama yöneticiye iletilir.',
    ]);

    await act(async () => {
      root.render(
        <ServoraAntProvider>
          <JobWorkflowDialog
            dialog={{
              kind: 'cancel',
              presentation: {
                command: 'CANCEL',
                label: 'İşi iptal et',
                consequence: 'İptal edilen iş yeniden açılamaz.',
                successMessage: 'İptal edildi.',
              },
            }}
            pending={false}
            onClose={() => {}}
            onConfirm={() => {}}
          />
        </ServoraAntProvider>,
      );
    });

    const cancelParagraphs = Array.from(host.querySelectorAll('.reason-dialog-description p'))
      .map((p) => p.textContent);
    expect(cancelParagraphs).toEqual([
      'İptal edilen iş yeniden açılamaz.',
      'İptal nedenini iş geçmişine ekleyin.',
    ]);
  });
});
