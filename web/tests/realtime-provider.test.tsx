/** @vitest-environment jsdom */
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  RealtimeProvider,
  type RealtimeEventSource,
  useRealtimeInvalidation,
} from '../src/realtime/RealtimeProvider';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

class FakeEventSource implements RealtimeEventSource {
  readonly listeners = new Map<string, Set<EventListener>>();
  closed = false;

  addEventListener(type: string, listener: EventListener) {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener) {
    this.listeners.get(type)?.delete(listener);
  }

  close() { this.closed = true; }

  emit(type: string, data?: string) {
    const event = data === undefined ? new Event(type) : new MessageEvent(type, { data });
    this.listeners.get(type)?.forEach((listener) => listener(event));
  }
}

function Subscription({ resourceKey }: { resourceKey: string }) {
  const [count, setCount] = useState(0);
  useRealtimeInvalidation([resourceKey], () => setCount((value) => value + 1));
  return <output data-resource={resourceKey}>{count}</output>;
}

function change(id: string, resourceKeys: string[]) {
  return JSON.stringify({
    id,
    type: 'job.updated',
    entity: { type: 'job-card', id: 'job-1' },
    resourceKeys,
    occurredAt: '2026-07-20T10:00:00.000Z',
  });
}

describe('RealtimeProvider', () => {
  let host: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(async () => {
    if (root) await act(async () => { root?.unmount(); });
    host?.remove();
    host = null;
    root = null;
    vi.useRealTimers();
  });

  async function render(source: FakeEventSource, children = <Subscription resourceKey="job-list" />) {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(<RealtimeProvider eventSourceFactory={() => source}>{children}</RealtimeProvider>);
    });
    return host;
  }

  it('opens one named stream and closes it during cleanup', async () => {
    const source = new FakeEventSource();
    await render(source);

    expect(source.listeners.get('servora.change')?.size).toBe(1);
    expect(source.closed).toBe(false);

    await act(async () => { root?.unmount(); });
    root = null;
    expect(source.closed).toBe(true);
  });

  it('routes valid named events once by resource key and ignores malformed, unknown, and duplicate cursors', async () => {
    const source = new FakeEventSource();
    const view = await render(source, <>
      <Subscription resourceKey="job-list" />
      <Subscription resourceKey="approval-queue" />
    </>);

    await act(async () => {
      source.emit('servora.change', '{not json');
      source.emit('servora.change', JSON.stringify({ id: '1', type: 'unknown', resourceKeys: ['job-list'], occurredAt: '2026-07-20T10:00:00.000Z' }));
      source.emit('servora.change', change('2', ['approval-queue']));
      source.emit('servora.change', change('3', ['job-list']));
      source.emit('servora.change', change('3', ['job-list']));
      await Promise.resolve();
    });

    expect(Array.from(view.querySelectorAll('output')).map((item) => item.textContent)).toEqual(['1', '1']);
  });

  it('coalesces a workspace sync marker and reconciles every mounted resource once', async () => {
    const source = new FakeEventSource();
    const view = await render(source, <>
      <Subscription resourceKey="job-list" />
      <Subscription resourceKey="job-board" />
    </>);

    await act(async () => {
      source.emit('servora.change', JSON.stringify({
        id: '4', type: 'sync.required', resourceKeys: ['workspace'], occurredAt: '2026-07-20T10:00:00.000Z',
      }));
      source.emit('servora.change', JSON.stringify({
        id: '5', type: 'sync.required', resourceKeys: ['workspace'], occurredAt: '2026-07-20T10:00:01.000Z',
      }));
      await Promise.resolve();
    });

    expect(Array.from(view.querySelectorAll('output')).map((item) => item.textContent)).toEqual(['1', '1']);
  });

  it('reconciles with fallback polling only while the stream is disconnected', async () => {
    vi.useFakeTimers();
    const source = new FakeEventSource();
    const view = await render(source);

    await act(async () => { source.emit('error'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(view.querySelector('output')?.textContent).toBe('1');

    await act(async () => { source.emit('open'); await Promise.resolve(); });
    expect(view.querySelector('output')?.textContent).toBe('2');
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(view.querySelector('output')?.textContent).toBe('2');
  });

  it('reconciles active resources when the page becomes visible, focused, or online', async () => {
    const source = new FakeEventSource();
    const view = await render(source);
    const originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await Promise.resolve(); });
    expect(view.querySelector('output')?.textContent).toBe('0');

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await Promise.resolve(); });
    await act(async () => { window.dispatchEvent(new Event('focus')); await Promise.resolve(); });
    await act(async () => { window.dispatchEvent(new Event('online')); await Promise.resolve(); });
    expect(view.querySelector('output')?.textContent).toBe('3');

    if (originalVisibility) Object.defineProperty(document, 'visibilityState', originalVisibility);
  });
});
