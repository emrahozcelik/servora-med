/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JobDetailPanel } from '../src/JobDetail';
import {
  canGrantEarlyStartAuthorization,
  EarlyStartAuthorizationSection,
} from '../src/jobs/EarlyStartAuthorization';
import type { JobCard } from '../src/jobs/jobs-api';
import type { CurrentUser } from '../src/services/api';
import { ServoraAntProvider } from '../src/ui/antd';
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

/** Planned start is 11:00Z; the fixed clock keeps eligibility deterministic. */
const NOW = new Date('2026-07-20T09:00:00.000Z');

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
  hasOpenOverdueIncident: false,
  correctionDueAt: null,
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
  beforeEach(() => {
    // The save-time eligibility check reads the real clock; pin it so the grant
    // tests are deterministic (the fixture job is planned for 11:00Z).
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function render(target: JobCard, user: CurrentUser, onGranted = vi.fn(), now = NOW) {
    return act(async () => root.render(
      <EarlyStartAuthorizationSection job={target} user={user} onGranted={onGranted} now={now} />,
    ));
  }

  it('offers the manager the grant action only for an eligible job', async () => {
    await render(job, manager);
    expect(container.querySelector('[data-early-start-authorization="idle"]')).not.toBeNull();
    expect(container.querySelector('[data-early-start-authorization-status="idle"]')?.textContent)
      .toBe('İzin verilmedi');
    expect(buttonByText(container, 'Erken başlamaya izin ver')).toBeDefined();

    await render({ ...job, earlyStartAuthorization: {
      grantedAt: '2026-07-20T08:00:00.000Z', grantedBy: { id: 'manager-1', name: 'Müdür' },
    } }, manager);
    expect(buttonByText(container, 'Erken başlamaya izin ver')).toBeUndefined();
    expect(container.textContent).toContain('Erken başlama izni: Müdür');
  });

  it('keeps the idle state compact until the manager asks for the help and confirm flow', async () => {
    await render(job, manager);
    const reveal = buttonByText(container, 'Erken başlamaya izin ver')!;
    const detail = container.querySelector<HTMLElement>('#early-start-authorization-detail')!;
    expect(reveal.getAttribute('aria-expanded')).toBe('false');
    expect(reveal.getAttribute('aria-controls')).toBe('early-start-authorization-detail');
    expect(detail).not.toBeNull();
    expect(detail.hidden).toBe(true);
    // The help paragraph and the confirm action live inside the collapsed
    // disclosure, not in the visible one-row idle state.
    expect(detail.contains(buttonByText(container, 'Erken başlama iznini kaydet')!)).toBe(true);

    await act(async () => reveal.click());
    expect(reveal.getAttribute('aria-expanded')).toBe('true');
    expect(detail.hidden).toBe(false);
    expect(detail.querySelector('[data-early-start-authorization-help="true"]')?.textContent)
      .toContain('planlanan zamandan önce');
    expect(buttonByText(container, 'Erken başlama iznini kaydet')).toBeDefined();

    // Collapsing hides the detail again without losing the row.
    await act(async () => reveal.click());
    expect(detail.hidden).toBe(true);
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

  it('does not post when the planned start passes while the confirmation is open', async () => {
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return json({ jobCardId: 'job-1', authorizationId: 'auth-1', grantedAt: '2026-07-20T08:00:00.000Z' });
    }));
    const onGranted = vi.fn();
    // Offer rendered while the planned 11:00Z start is still ahead.
    vi.setSystemTime(new Date('2026-07-20T10:59:59.000Z'));
    await render(job, manager, onGranted, new Date('2026-07-20T10:59:59.000Z'));
    await act(async () => buttonByText(container, 'Erken başlamaya izin ver')!.click());
    expect(buttonByText(container, 'Erken başlama iznini kaydet')).toBeDefined();

    // The manager confirms after the planned start has passed.
    vi.setSystemTime(new Date('2026-07-20T11:00:01.000Z'));
    await act(async () => buttonByText(container, 'Erken başlama iznini kaydet')!.click());
    await settleTwice();

    expect(requests).toHaveLength(0);
    expect(onGranted).not.toHaveBeenCalled();
    const expired = container.querySelector('[data-early-start-authorization-status="expired"]')!;
    expect(expired.getAttribute('role')).toBe('status');
    expect(expired.textContent).toContain('Planlanan başlangıç zamanı geçti');
    expect(buttonByText(container, 'Erken başlamaya izin ver')).toBeUndefined();
    // The confirm control unmounts, so keyboard focus lands on the announced
    // status line instead of being dropped to <body>.
    expect(document.activeElement).toBe(expired);
  });

  it('hides the grant offer when the planned start is not in the future', async () => {
    const startedPlannedTime = new Date('2026-07-20T11:00:00.000Z');
    await render(job, manager, vi.fn(), startedPlannedTime);
    expect(container.textContent).toBe('');
    expect(canGrantEarlyStartAuthorization(job, manager, startedPlannedTime)).toBe(false);
    expect(canGrantEarlyStartAuthorization(job, manager, NOW)).toBe(true);

    // A valid authorization already granted stays visible as a status line.
    await render({
      ...job,
      earlyStartAuthorization: {
        grantedAt: '2026-07-20T08:00:00.000Z', grantedBy: { id: 'manager-1', name: 'Müdür' },
      },
    }, staff, vi.fn(), startedPlannedTime);
    expect(container.textContent).toContain('Erken başlama izni: Müdür');
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
    expect(container.querySelector('[data-early-start-authorization="authorized"]')).not.toBeNull();
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
    await act(async () => buttonByText(container, 'Erken başlama iznini kaydet')!.click());
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
    await act(async () => buttonByText(container, 'Erken başlamaya izin ver')!.click());
    expect(buttonByText(container, 'Erken başlama iznini kaydet')!.disabled).toBe(false);
  });

  it('surfaces a server error without hiding the action', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({
      code: 'EARLY_START_ALREADY_AUTHORIZED',
      error: 'Bu iş için geçerli bir erken başlama izni zaten var.',
    }, 409)));
    const onGranted = vi.fn();
    await render(job, manager, onGranted);

    await act(async () => buttonByText(container, 'Erken başlamaya izin ver')!.click());
    await act(async () => buttonByText(container, 'Erken başlama iznini kaydet')!.click());
    await settleTwice();

    expect(container.querySelector('[role="alert"]')?.textContent)
      .toContain('Bu iş için geçerli bir erken başlama izni zaten var.');
    expect(buttonByText(container, 'Erken başlamaya izin ver')).toBeDefined();
    expect(onGranted).not.toHaveBeenCalled();
  });
});

describe('EarlyStartAuthorizationSection placement in JobDetailPanel', () => {
  let container: HTMLDivElement; let root: Root;

  function setViewport(narrow: boolean) {
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('min-width: 64rem') ? !narrow : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
  }

  function precedes(earlier: Element, later: Element) {
    return Boolean(earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  async function renderPanel(target: JobCard) {
    await act(async () => root.render(
      <ServoraAntProvider>
        <JobDetailPanel
          job={target}
          items={[]}
          user={manager}
          pending={false}
          message=""
          onCommand={() => {}}
          earlyStart={<EarlyStartAuthorizationSection
            job={target} user={manager} onGranted={() => {}} now={NOW}
          />}
        />
      </ServoraAntProvider>,
    ));
  }

  beforeEach(() => {
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals();
  });

  it('sits inside the main column directly after the record facts on narrow shells', async () => {
    setViewport(true);
    await renderPanel(job);

    const earlyStart = container.querySelector('[data-early-start-authorization="idle"]')!;
    expect(earlyStart).not.toBeNull();
    const main = container.querySelector('.job-detail-main')!;
    expect(earlyStart.closest('.job-detail-main')).toBe(main);
    const facts = container.querySelector('[data-job-detail-section="facts"]')!;
    expect(precedes(facts, earlyStart)).toBe(true);

    // It is not part of the top stack above the record.
    const heading = container.querySelector('[data-job-detail-section="heading"]')!;
    expect(precedes(earlyStart, heading)).toBe(false);
  });

  it('follows the schedule edit form when the job can still be rescheduled', async () => {
    setViewport(true);
    await renderPanel(job);

    const schedule = container.querySelector('.job-schedule-edit')!;
    const earlyStart = container.querySelector('[data-early-start-authorization="idle"]')!;
    expect(schedule).not.toBeNull();
    expect(precedes(schedule, earlyStart)).toBe(true);
    expect(precedes(earlyStart, container.querySelector('[data-job-detail-block="delivery"]')!))
      .toBe(true);
  });

  it('falls back to the record facts when the panel offers no schedule edit', async () => {
    setViewport(true);
    await renderPanel({
      ...job,
      workflowContext: { ...workflowContext, allowedActions: ['VIEW_NOTES', 'ADD_NOTE'] },
    });

    expect(container.querySelector('.job-schedule-edit')).toBeNull();
    const facts = container.querySelector('[data-job-detail-section="facts"]')!;
    const earlyStart = container.querySelector('[data-early-start-authorization="idle"]')!;
    expect(earlyStart).not.toBeNull();
    expect(precedes(facts, earlyStart)).toBe(true);
  });

  it('keeps the same schedule-adjacent position on desktop', async () => {
    setViewport(false);
    await renderPanel(job);

    const schedule = container.querySelector('.job-schedule-edit')!;
    const earlyStart = container.querySelector('[data-early-start-authorization="idle"]')!;
    expect(earlyStart.closest('.job-detail-main')).not.toBeNull();
    expect(precedes(schedule, earlyStart)).toBe(true);
  });
});
