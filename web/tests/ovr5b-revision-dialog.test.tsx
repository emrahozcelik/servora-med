/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JobDetailScreen } from '../src/JobDetail';
import type { JobCard, JobLifecycleFacts, JobWorkflowContext } from '../src/jobs/jobs-api';
import { defaultCorrectionDueLocalValue, localDateTimeToIso } from '../src/jobs/scheduling';
import type { CurrentUser } from '../src/services/api';
import { workflowContext } from './fixtures/job-workflow';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const manager: CurrentUser = {
  id: 'm1', organizationId: 'org-1', name: 'Murat Yönetici', email: 'm@x',
  role: 'MANAGER', mustChangePassword: false, isActive: true, version: 1,
};

const waitingLifecycle: JobLifecycleFacts = {
  ...workflowContext.lifecycle,
  createdAt: '2026-11-12T06:00:00.000Z',
  startedAt: '2026-11-12T07:00:00.000Z',
  submittedAt: '2026-11-18T09:10:00.000Z',
  submittedBy: { id: 's1', name: 'Ayşe Personel' },
  submissionNote: 'Teslim tamamlandı.',
};

function waitingContext(overrides: Partial<JobWorkflowContext> = {}): JobWorkflowContext {
  return {
    ...workflowContext,
    allowedCommands: ['APPROVE', 'REQUEST_REVISION', 'CANCEL'],
    allowedActions: ['VIEW_NOTES'],
    lifecycle: waitingLifecycle,
    submissionReadiness: { evaluatedAt: '2026-11-18T09:11:00.000Z', ready: true, items: [] },
    ...overrides,
  };
}

function jobCard(overrides: Partial<JobCard> = {}): JobCard {
  return {
    id: 'job-1', organizationId: 'org-1', organizationTimezone: 'Europe/Istanbul',
    type: 'GENERAL_TASK', status: 'WAITING_APPROVAL', version: 3,
    engagementKind: null, title: 'Teklif dönüşünü takip et', description: null,
    customerId: null, contactId: null, assignedTo: 's1', createdBy: 'm1',
    priority: 'normal', dueDate: '2026-11-30', scheduledAt: null,
    assignee: { id: 's1', name: 'Ayşe Personel' }, customer: null, contact: null,
    followUpContext: null, followUpProposal: null,
    earlyStartAuthorization: null, submitLocationComparison: null,
    changeRequest: null, assignmentOffer: null,
    hasOpenOverdueIncident: false, correctionDueAt: null,
    workflowContext: waitingContext(),
    ...overrides,
  };
}

const emptyPage = { items: [], total: 0, limit: 25, offset: 0 };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function buttonByName(host: ParentNode, name: string) {
  return Array.from(host.querySelectorAll('button'))
    .find((button) => button.textContent?.trim() === name) ?? null;
}

function makeFetch(options: {
  card: JobCard;
  revisionResult?: (body: Record<string, unknown>) => Response;
}) {
  const requestBodies: Array<Record<string, unknown>> = [];
  let currentCard = options.card;
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const path = url.split('?')[0] ?? url;
    if (path.endsWith('/notes')) return json(emptyPage);
    if (path.endsWith('/activity')) return json({ ...emptyPage, limit: 50 });
    if (path.endsWith('/overdue-incidents')) return json(emptyPage);
    if (path.endsWith('/follow-ups')) return json(emptyPage);
    if (path.endsWith('/request-revision') && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requestBodies.push(body);
      if (options.revisionResult) return options.revisionResult(body);
      currentCard = {
        ...currentCard,
        status: 'REVISION_REQUESTED',
        version: currentCard.version + 1,
        workflowContext: waitingContext({ allowedCommands: ['RESUME', 'CANCEL'] }),
      };
      return json(currentCard);
    }
    if (path.endsWith('/delivery-items')) return json({ items: [] });
    if (path.endsWith('/api/job-cards/job-1')) return json(currentCard);
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
  return { fetch, requestBodies };
}

describe('OVR-5 revision correction deadline dialog', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
      matches: false, media: '', onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    }));
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  async function render(harness: ReturnType<typeof makeFetch>) {
    vi.stubGlobal('fetch', harness.fetch);
    await act(async () => {
      root.render(<JobDetailScreen jobId="job-1" user={manager} onBack={() => {}}
        onChanged={() => {}} />);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  async function settle() {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  function openRevisionDialog() {
    const trigger = buttonByName(host, 'Düzeltme için personele geri gönder');
    expect(trigger).not.toBeNull();
    return act(async () => { trigger!.click(); await Promise.resolve(); });
  }

  function typeReason(dialog: HTMLElement, value: string) {
    const textarea = dialog.querySelector<HTMLTextAreaElement>('textarea')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
      ?.set?.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }

  it('prefills now + 24 h, sends correctionDueAt and shows the 1 h–14 d hint', async () => {
    const harness = makeFetch({ card: jobCard() });
    await render(harness);
    await openRevisionDialog();

    const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
    const picker = dialog.querySelector<HTMLInputElement>('#revision-correction-due-at')!;
    expect(picker).not.toBeNull();
    expect(dialog.textContent).toContain('Düzeltme son tarihi');
    expect(dialog.textContent).toContain('En az 1 saat, en fazla 14 gün sonrası');
    expect(picker.value).toBe(defaultCorrectionDueLocalValue());

    typeReason(dialog, 'Lot numarasını doğrulayın.');
    await act(async () => {
      buttonByName(dialog, 'Düzeltme için geri gönder')!.click();
      await settle();
    });

    expect(harness.requestBodies).toHaveLength(1);
    expect(harness.requestBodies[0]).toMatchObject({
      revisionReason: 'Lot numarasını doğrulayın.',
      correctionDueAt: localDateTimeToIso(picker.value),
    });
  });

  it('hides the picker and sends nothing when the job has no original deadline', async () => {
    const harness = makeFetch({ card: jobCard({ dueDate: null, scheduledAt: null }) });
    await render(harness);
    await openRevisionDialog();

    const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.querySelector('#revision-correction-due-at')).toBeNull();
    expect(dialog.textContent).not.toContain('Düzeltme son tarihi');

    typeReason(dialog, 'Açıklamayı tamamlayın.');
    await act(async () => {
      buttonByName(dialog, 'Düzeltme için geri gönder')!.click();
      await settle();
    });

    expect(harness.requestBodies).toHaveLength(1);
    expect(harness.requestBodies[0]).not.toHaveProperty('correctionDueAt');
  });

  it('keeps the dialog open and shows fieldErrors.correctionDueAt', async () => {
    const harness = makeFetch({
      card: jobCard(),
      revisionResult: () => json({
        error: 'Düzeltme son tarihi en az 1 saat, en fazla 14 gün sonrası olmalı.',
        code: 'VALIDATION_ERROR',
        details: {
          fieldErrors: {
            correctionDueAt: 'Düzeltme son tarihi en az 1 saat, en fazla 14 gün sonrası olmalı.',
          },
        },
      }, 400),
    });
    await render(harness);
    await openRevisionDialog();

    const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
    typeReason(dialog, 'Lot numarasını doğrulayın.');
    await act(async () => {
      buttonByName(dialog, 'Düzeltme için geri gönder')!.click();
      await settle();
    });

    const stillOpen = host.querySelector<HTMLElement>('[role="dialog"]');
    expect(stillOpen).not.toBeNull();
    expect(stillOpen!.textContent)
      .toContain('Düzeltme son tarihi en az 1 saat, en fazla 14 gün sonrası olmalı.');
    expect(stillOpen!.querySelector<HTMLTextAreaElement>('textarea')?.value)
      .toBe('Lot numarasını doğrulayın.');
  });

  it('shows the effective correction deadline on the job detail', async () => {
    const harness = makeFetch({
      card: jobCard({ status: 'REVISION_REQUESTED', correctionDueAt: '2026-11-24T10:00:00.000Z' }),
    });
    await render(harness);
    expect(host.textContent).toContain('Düzeltme son tarihi');
    expect(host.querySelector('time[datetime="2026-11-24T10:00:00.000Z"]')).not.toBeNull();
  });
});
