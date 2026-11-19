/** @vitest-environment jsdom */
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JobDetailPanel } from '../src/JobDetail';
import { ServoraAntProvider } from '../src/ui/antd';
import type {
  JobCard, JobLifecycleFacts, JobWorkflowContext, LifecycleCommand,
} from '../src/jobs/jobs-api';
import type { CurrentUser } from '../src/services/api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const staff: CurrentUser = {
  id: 's1', organizationId: 'org-1', name: 'Ayşe Personel', email: 'a@x',
  role: 'STAFF', mustChangePassword: false, isActive: true, version: 1,
};
const manager: CurrentUser = {
  ...staff, id: 'm1', name: 'Murat Yönetici', role: 'MANAGER', email: 'm@x',
};

const baseLifecycle: JobLifecycleFacts = {
  createdAt: '2026-07-17T08:00:00.000Z', acceptedAt: '2026-07-17T08:30:00.000Z',
  acceptedBy: { id: 's1', name: 'Ayşe Personel' },
  startedAt: '2026-07-17T09:00:00.000Z', submittedAt: null, submittedBy: null,
  submissionNote: null, approvedAt: null, approvedBy: null, approvalNote: null,
  revisionRequestedAt: null, revisionRequestedBy: null, revisionReason: null,
  cancelledAt: null, cancelledBy: null, cancelReason: null, cancelledFromStatus: null,
};

function context(
  status: JobCard['status'],
  commands: LifecycleCommand[],
  lifecycle: Partial<JobLifecycleFacts> = {},
): JobWorkflowContext {
  return {
    allowedCommands: commands,
    allowedActions: ['EDIT_JOB_FIELDS', 'VIEW_NOTES', 'ADD_NOTE'],
    startLocationCaptureEnabled: false,
    submitLocationCaptureEnabled: false,
    lifecycle: { ...baseLifecycle, ...lifecycle },
    submissionReadiness: {
      evaluatedAt: '2026-07-17T12:00:00.000Z',
      ready: true,
      items: [{ code: 'DELIVERY_ITEM_PRESENT', state: 'met' }],
    },
  } as JobWorkflowContext;
}

function jobCard(
  status: JobCard['status'],
  commands: LifecycleCommand[],
  lifecycle: Partial<JobLifecycleFacts> = {},
): JobCard {
  return {
    id: 'job-1', organizationId: 'org-1', type: 'PRODUCT_DELIVERY', status, version: 4,
    engagementKind: null,
    title: 'ABC Klinik ürün teslimi', description: null, customerId: 'c1', contactId: null,
    assignedTo: 's1', createdBy: 's1', priority: 'normal', dueDate: '2026-07-24',
    scheduledAt: '2026-07-20T09:00:00.000Z', scheduledEndsAt: '2026-07-20T09:30:00.000Z',
    assignee: { id: 's1', name: 'Ayşe Personel' },
    customer: { id: 'c1', name: 'ABC Klinik' }, contact: null,
    followUpContext: null,
    workflowContext: context(status, commands, lifecycle),
  };
}

const staffInProgress = jobCard('IN_PROGRESS', ['SUBMIT_FOR_APPROVAL', 'CANCEL']);
const managerWaiting = jobCard(
  'WAITING_APPROVAL',
  ['APPROVE', 'REQUEST_REVISION', 'CANCEL'],
  {
    submittedAt: '2026-07-17T10:00:00.000Z',
    submittedBy: { id: 's1', name: 'Ayşe Personel' },
  },
);
const revisionRequested = jobCard('REVISION_REQUESTED', ['RESUME', 'CANCEL'], {
  submittedAt: '2026-07-17T10:00:00.000Z',
  submittedBy: { id: 's1', name: 'Ayşe Personel' },
  revisionRequestedAt: '2026-07-17T11:00:00.000Z',
  revisionRequestedBy: { id: 'm1', name: 'Murat Yönetici' },
  revisionReason: 'Teslim miktarını düzeltin',
});

function setViewport(narrow: boolean) {
  // JobDetailPanel uses !(min-width: 64rem).matches for the narrow composition.
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

describe('mobile job work priority (DECISIONS.md UI-005)', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  async function render(job: JobCard, user: CurrentUser, extra: {
    overdueHistory?: ReactNode;
  } = {}) {
    await act(async () => {
      root.render(<ServoraAntProvider>
        <JobDetailPanel
          job={job}
          items={[]}
          user={user}
          pending={false}
          message=""
          onCommand={() => {}}
          overdueHistory={extra.overdueHistory}
        />
      </ServoraAntProvider>);
    });
  }

  function section(name: string) {
    return host.querySelector(`[data-job-detail-section="${name}"]`);
  }

  function precedes(earlier: Element, later: Element) {
    return Boolean(earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  it('puts the staff primary command above the compact lifecycle summary', async () => {
    setViewport(true);
    await render(staffInProgress, staff);

    const responsibility = section('responsibility')!;
    const actions = section('actions')!;
    const lifecycle = section('lifecycle')!;
    const facts = section('facts')!;

    expect(responsibility).not.toBeNull();
    expect(actions).not.toBeNull();
    expect(precedes(responsibility, actions)).toBe(true);
    expect(precedes(actions, lifecycle)).toBe(true);
    expect(precedes(lifecycle, facts)).toBe(true);

    const decisionPanels = host.querySelectorAll('[data-job-decision-panel="true"]');
    expect(decisionPanels).toHaveLength(1);
    expect(actions.contains(decisionPanels[0]!)).toBe(true);
    expect(actions.textContent).toContain('Kontrole gönder');
    // The rail keeps requirements only; it never repeats the command group.
    expect(host.querySelector('.job-detail-work-rail [data-job-decision-panel="true"]')).toBeNull();

    const disclosure = host.querySelector('[data-workflow-compact="true"]');
    expect(disclosure).not.toBeNull();
    const summary = disclosure!.querySelector('summary')!;
    expect(summary.textContent).toContain('3 / 5');
    expect(summary.textContent).toContain('Uygulanıyor');
    expect(disclosure!.hasAttribute('open')).toBe(false);
  });

  it('puts the manager decision above the compact lifecycle summary', async () => {
    setViewport(true);
    await render(managerWaiting, manager);

    expect(section('responsibility')!.textContent).toContain('Yönetici kontrolü');
    expect(precedes(section('responsibility')!, section('actions')!)).toBe(true);
    expect(precedes(section('actions')!, section('lifecycle')!)).toBe(true);
    const primary = host.querySelector<HTMLButtonElement>(
      '[data-job-decision-panel="true"] .primary-button',
    )!;
    expect(primary.textContent).toBe('Kontrolü tamamla ve işi kapat');
    expect(primary.closest('.job-detail-work-rail')).toBeNull();
  });

  it('keeps the desktop structure: lifecycle, then rail decision', async () => {
    setViewport(false);
    await render(staffInProgress, staff);

    expect(precedes(section('lifecycle')!, section('responsibility')!)).toBe(true);
    const rail = host.querySelector('.job-detail-work-rail')!;
    expect(rail.querySelector('[data-job-decision-panel="true"]')).not.toBeNull();
    expect(section('actions')!.closest('.job-detail-work-rail')).toBe(rail);
    // No compact summary on desktop: the horizontal stepper is always visible.
    expect(host.querySelector('[data-workflow-compact="true"]')).toBeNull();
    expect(host.querySelector('.servora-workflow-steps .servora-ant-steps')).not.toBeNull();
  });

  it('renders manager lateness history as a collapsed disclosure below the record details', async () => {
    setViewport(true);
    const history = <section data-overdue-history="ready" data-test-history>Gecikme kaydı</section>;
    await render(managerWaiting, manager, { overdueHistory: history });

    const lateness = section('lateness-history')!;
    expect(lateness).not.toBeNull();
    expect(precedes(section('facts')!, lateness)).toBe(true);
    expect(precedes(host.querySelector('.job-detail-content')!, lateness)).toBe(true);
    expect(lateness.contains(host.querySelector('[data-test-history]'))).toBe(true);
  });

  it('keeps the manager lateness history above the workflow on desktop', async () => {
    setViewport(false);
    const history = <section data-overdue-history="ready" data-test-history>Gecikme kaydı</section>;
    await render(managerWaiting, manager, { overdueHistory: history });

    expect(section('lateness-history')).toBeNull();
    const rendered = host.querySelector('[data-test-history]')!;
    expect(precedes(rendered, section('lifecycle')!)).toBe(true);
  });

  it('keeps the revision responsibility ahead of the revision details on narrow shells', async () => {
    setViewport(true);
    await render(revisionRequested, staff);

    expect(section('responsibility')!.textContent).toContain('Düzeltme gerekiyor');
    expect(precedes(section('responsibility')!, section('actions')!)).toBe(true);
    expect(precedes(section('actions')!, section('lifecycle')!)).toBe(true);
    expect(precedes(section('lifecycle')!, section('revision')!)).toBe(true);
    expect(host.querySelector('[data-job-decision-panel="true"]')?.textContent)
      .toContain('Düzeltmeye başla');
  });
});
