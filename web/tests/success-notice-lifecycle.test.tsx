/** @vitest-environment jsdom */
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SUCCESS_NOTICE_DISMISS_MS, useAutoDismissNotice } from '../src/App';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function NoticeHarness() {
  const [notice, setNotice] = useState('Teslim kaydı oluşturuldu.');
  useAutoDismissNotice(notice, () => setNotice(''));
  return <>
    <output>{notice}</output>
    <button type="button" onClick={() => setNotice('Yeni teslim kaydı oluşturuldu.')}>Yeni mesaj</button>
  </>;
}

describe('delivery success notice lifecycle', () => {
  let host: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(async () => {
    if (root) await act(async () => { root?.unmount(); });
    host?.remove();
    host = null;
    root = null;
    vi.useRealTimers();
  });

  async function render() {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => { root?.render(<NoticeHarness />); });
    return host;
  }

  it('shows the delivery success notice before dismissing it after six seconds', async () => {
    vi.useFakeTimers();
    const view = await render();
    expect(view.querySelector('output')?.textContent).toBe('Teslim kaydı oluşturuldu.');

    await act(async () => { await vi.advanceTimersByTimeAsync(SUCCESS_NOTICE_DISMISS_MS); });
    expect(view.querySelector('output')?.textContent).toBe('');
  });

  it('restarts the dismissal window when a new success notice replaces the old one', async () => {
    vi.useFakeTimers();
    const view = await render();
    await act(async () => { await vi.advanceTimersByTimeAsync(SUCCESS_NOTICE_DISMISS_MS - 1_000); });
    await act(async () => { view.querySelector('button')?.click(); });

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(view.querySelector('output')?.textContent).toBe('Yeni teslim kaydı oluşturuldu.');
    await act(async () => { await vi.advanceTimersByTimeAsync(SUCCESS_NOTICE_DISMISS_MS - 1_000); });
    expect(view.querySelector('output')?.textContent).toBe('');
  });

  it('cleans the pending timer on unmount', async () => {
    vi.useFakeTimers();
    const clearTimeout = vi.spyOn(window, 'clearTimeout');
    await render();
    await act(async () => { root?.unmount(); });
    root = null;
    expect(clearTimeout).toHaveBeenCalled();
  });
});
