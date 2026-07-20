/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RealtimeProvider, type RealtimeEventSource } from '../src/realtime/RealtimeProvider';
import { ApprovalReport } from '../src/reports/ApprovalReport';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

class FakeRealtimeEventSource implements RealtimeEventSource {
  private readonly listeners = new Map<string, Set<EventListener>>();

  addEventListener(type: string, listener: EventListener) {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener) {
    this.listeners.get(type)?.delete(listener);
  }

  close() {}

  emitApprovalInvalidation() {
    const event = new MessageEvent('servora.change', { data: JSON.stringify({
      id: '1', type: 'job.submitted_for_approval', entity: { type: 'job-card', id: 'job-1' },
      resourceKeys: ['approval-queue'], occurredAt: '2026-07-20T10:00:00.000Z',
    }) });
    this.listeners.get('servora.change')?.forEach((listener) => listener(event));
  }
}

const report = {
  summary: {
    pendingCount: 0, oldestWaitingMinutes: null, averageWaitingMinutes: null,
    under2Hours: 0, between2And8Hours: 0, between8And24Hours: 0, over24Hours: 0,
  },
  items: [], total: 0, limit: 50, offset: 0,
};

describe('realtime report consumers', () => {
  let host: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(async () => {
    if (root) await act(async () => { root?.unmount(); });
    host?.remove();
    host = null;
    root = null;
    vi.unstubAllGlobals();
  });

  it('reloads the mounted approval queue from its existing REST loader', async () => {
    const source = new FakeRealtimeEventSource();
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(Response.json(report)));
    vi.stubGlobal('fetch', fetch);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);

    await act(async () => {
      root?.render(<MemoryRouter><RealtimeProvider eventSourceFactory={() => source}>
        <ApprovalReport />
      </RealtimeProvider></MemoryRouter>);
      await Promise.resolve();
    });
    expect(fetch).toHaveBeenCalledTimes(1);

    await act(async () => { source.emitApprovalInvalidation(); await Promise.resolve(); });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain('Onay bekleyen iş bulunmuyor.');
  });
});
