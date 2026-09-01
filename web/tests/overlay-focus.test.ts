/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';

import { focusableElements, trapTabKey } from '../src/ui/antd/overlay-focus';

describe('overlay focus ordering', () => {
  it('treats a native summary as a focusable Staff follow-up target', () => {
    const dialog = document.createElement('div');
    dialog.innerHTML = '<summary>Tarih ve saati değiştir</summary><button type="button">Kapat</button>';
    document.body.append(dialog);
    const summary = dialog.querySelector('summary')!;
    const close = dialog.querySelector('button')!;

    expect(focusableElements(dialog)).toEqual([summary, close]);
    summary.focus();
    const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true });
    trapTabKey(event, dialog);
    expect(document.activeElement).toBe(close);
    dialog.remove();
  });
});
