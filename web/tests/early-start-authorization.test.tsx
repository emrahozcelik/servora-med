/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EarlyStartAuthorizationSection } from '../src/jobs/EarlyStartAuthorization';
import type { JobCard } from '../src/jobs/jobs-api';
import type { CurrentUser } from '../src/services/api';
import { workflowContext } from './fixtures/job-workflow';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const manager: CurrentUser = {
  id: 'manager-1', organizationId: 'org-1', name: 'Müdür', email: 'm@x', role: 'MANAGER',
  mustChangePassword: false, isActive: true, version: 1,
};
const staff: CurrentUser = {
  id: 'staff-1', organizationId: 'org-1', name: 'Ayşe', email: 'a@x', role: 'STAFF',
  mustChangePassword: false, isActive: true, version: 1,
};

const job = {
  id: 'job-1', organizationId: 'org-1', type: 'PRODUCT_DELIVERY', status: 'ACCEPTED', version: 4,
  title: 'Klinik teslimi', description: null, customerId: 'c1', contactId: null, assignedTo: 'staff-1',
  createdBy: 'manager-1', priority: 'normal', dueDate: null,
  scheduledAt: '2026-07-20T11:00:00.000Z', scheduledEndsAt: '2026-07-20T11:30:00.000Z',
  engagementKind: null, invalidatedAt: null, invalidatedBy: null, invalidationReasonCode: null,
  assignee: { id: 'staff-1', name: 'Ayşe' }, customer: { id: 'c1', name: 'Klinik' },
  contact: null, workflowContext, followUpContext: null, followUpProposal: null,
  submitLocationComparison: null,
  earlyStartAuthorization: null,
} as JobCard;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

async function settle() { await act(async () => { await Promise.resolve(); }); }
async function settleTwice() { await settle(); await settle(); }
function buttonByText(container: HTMLElement, text: string) {
  return Array.from(container.querySelectorAll('button')).find((button) => button.textContent === text);
}

describe('EarlyStartAuthorizationSection', () => {
  let root: Root; let container: HTMLDivElement;
  beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

  function render(target: JobCard, user: CurrentUser, onGranted = vi.fn()) {
    return act(async () => root.render(
      <EarlyStartAuthorizationSection job={target} user={user} onGranted={onGranted} />,
    ));
  }

  it('offers the manager the grant action only for an eligible job', async () => {
    await render(job, manager);
    expect(buttonByText(container, 'Erken başlamaya izin ver')).toBeDefined();
    expect(container.querySelector('[data-early-start-authorization="idle"]')).not.toBeNull();

    await render({ ...job, earlyStartAuthorization: {
      grantedAt: '2026-07-20T08:00:00.000Z', grantedBy: { id: 'manager-1', name: 'Müdür' },
    } }, manager);
    expect(buttonByText(container, 'Erken başlamaya izin ver')).toBeUndefined();
    expect(container.textContent).toContain('Erken başlama izni: Müdür');
  });

  it('hides the action from Staff and from jobs that are not eligible', async () => {
    await render(job, staff);
    expect(container.textContent).toBe('');

    for (const target of [
      { ...job, type: 'GENERAL_TASK' as const },
      { ...job, status: 'IN_PROGRESS' as const },
      { ...job, scheduledAt: null },
    ]) {
      await render(target, manager);
      expect(container.textContent).toBe('');
    }
  });

  it('shows the authorization status line to the assigned Staff member', async () => {
    await render({
      ...job,
      earlyStartAuthorization: {
        grantedAt: '2026-07-20T08:00:00.000Z', grantedBy: { id: 'manager-1', name: 'Müdür' },
      },
    }, staff);
    expect(container.textContent).toContain('Erken başlama izni: Müdür');
    expect(container.textContent).toMatch(/20 Tem 2026|20.07.2026|20 Tem/);
    expect(buttonByText(container, 'Erken başlamaya izin ver')).toBeUndefined();
  });

  it('posts the grant, shows the pending and success states, and refreshes the detail', async () => {
    const requests: Array<[string, RequestInit | undefined]> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push([String(input), init]);
      return json({ jobCardId: 'job-1', authorizationId: 'auth-1', grantedAt: '2026-07-20T08:00:00.000Z' });
    }));
    const onGranted = vi.fn();
    await render(job, manager, onGranted);

    await act(async () => buttonByText(container, 'Erken başlamaya izin ver')!.click());
    await settleTwice();

    expect(requests).toHaveLength(1);
    expect(requests[0]![0]).toBe('/api/job-cards/job-1/early-start-authorization');
    expect(requests[0]![1]?.method).toBe('POST');
    expect(JSON.parse(String(requests[0]![1]?.body))).toMatchObject({ expectedVersion: 4 });
    expect(onGranted).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Erken başlama izni kaydedildi.');

    // A later version without an authorization (e.g. a reschedule voided it)
    // must re-enable the action instead of keeping the stale success state.
    await render({ ...job, version: job.version + 2 }, manager, onGranted);
    expect(container.textContent).not.toContain('Erken başlama izni kaydedildi.');
    expect(buttonByText(container, 'Erken başlamaya izin ver')!.disabled).toBe(false);
  });

  it('surfaces a server error without hiding the action', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({
      code: 'EARLY_START_ALREADY_AUTHORIZED',
      error: 'Bu iş için geçerli bir erken başlama izni zaten var.',
    }, 409)));
    const onGranted = vi.fn();
    await render(job, manager, onGranted);

    await act(async () => buttonByText(container, 'Erken başlamaya izin ver')!.click());
    await settleTwice();

    expect(container.querySelector('[role="alert"]')?.textContent)
      .toContain('Bu iş için geçerli bir erken başlama izni zaten var.');
    expect(buttonByText(container, 'Erken başlamaya izin ver')).toBeDefined();
    expect(onGranted).not.toHaveBeenCalled();
  });
});
