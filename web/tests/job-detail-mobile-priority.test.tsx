/** @vitest-environment jsdom */
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JobDetailPanel } from '../src/JobDetail';
import { JobWorkflowDialog } from '../src/jobs/JobWorkflowDialog';
import { deriveJobWorkflowPresentation } from '../src/jobs/job-workflow-presentation';
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
    hasOpenOverdueIncident: false, correctionDueAt: null,
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
    message?: string;
    overdueHistory?: ReactNode;
    invalidationAction?: ReactNode;
    notes?: ReactNode;
    messagingAction?: ReactNode;
    children?: ReactNode;
  } = {}) {
    await act(async () => {
      root.render(<ServoraAntProvider>
        <JobDetailPanel
          job={job}
          items={[]}
          user={user}
          pending={false}
          message={extra.message ?? ''}
          onCommand={() => {}}
          overdueHistory={extra.overdueHistory}
          invalidationAction={extra.invalidationAction}
          notes={extra.notes}
          messagingAction={extra.messagingAction}
        >
          {extra.children}
        </JobDetailPanel>
      </ServoraAntProvider>);
    });
  }

  function section(name: string) {
    return host.querySelector(`[data-job-detail-section="${name}"]`);
  }

  /** Direct children of <main>, in DOM order, with their section name. */
  function topLevelSections(): string[] {
    const main = host.querySelector('main.job-detail');
    expect(main, 'main.job-detail').not.toBeNull();
    return Array.from(main!.children)
      .map((element) => element.getAttribute('data-job-detail-section'))
      .filter((name): name is string => name !== null);
  }

  function precedes(earlier: Element, later: Element) {
    return Boolean(earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  it('keeps the lifecycle strip as the immediate section after the heading, before feedback', async () => {
    function expectStripImmediatelyAfterHeading() {
      // The owner decision puts the strip directly below the heading, so no
      // feedback/notice/warning surface may intervene — not just "after it".
      expect(section('heading')!.nextElementSibling).toBe(section('lifecycle'));
      expect(topLevelSections().slice(0, 3)).toEqual(['heading', 'lifecycle', 'feedback']);
    }
    // matchMedia stubs do not emit changes, so each viewport gets a fresh mount.
    async function remount() {
      await act(async () => root.unmount());
      host.remove();
      host = document.createElement('div');
      document.body.append(host);
      root = createRoot(host);
    }

    setViewport(true);
    await render(staffInProgress, staff, { message: 'İş kontrole gönderildi.' });
    expectStripImmediatelyAfterHeading();

    await remount();
    setViewport(false);
    await render(staffInProgress, staff, { message: 'İş kontrole gönderildi.' });
    expectStripImmediatelyAfterHeading();
  });

  it('puts the compact lifecycle strip directly below the heading, then the staff primary command', async () => {
    setViewport(true);
    await render(staffInProgress, staff);

    const responsibility = section('responsibility')!;
    const actions = section('actions')!;
    const lifecycle = section('lifecycle')!;
    const facts = section('facts')!;

    expect(lifecycle).not.toBeNull();
    expect(responsibility).not.toBeNull();
    expect(actions).not.toBeNull();
    expect(precedes(section('heading')!, lifecycle)).toBe(true);
    expect(precedes(lifecycle, responsibility)).toBe(true);
    expect(precedes(responsibility, actions)).toBe(true);
    expect(precedes(actions, facts)).toBe(true);

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

  it('renders the compact phase strip as five markers joined in one row', async () => {
    setViewport(true);
    await render(staffInProgress, staff);

    const stages = host.querySelector<HTMLElement>('[data-workflow-stages="true"]')!;
    expect(stages).not.toBeNull();
    expect(stages.getAttribute('aria-hidden')).toBe('true');
    const markers = Array.from(stages.querySelectorAll('[data-stage-state]'))
      .map((marker) => marker.getAttribute('data-stage-state'));
    expect(markers).toEqual(['complete', 'complete', 'current', 'upcoming', 'upcoming']);
    // Complete is a filled check glyph; the current phase is a ring, not a fill.
    expect(stages.querySelectorAll('.servora-workflow-stage--complete svg')).toHaveLength(2);
    expect(stages.querySelector('.servora-workflow-stage--current svg')).toBeNull();
    // The ordered list keeps the text and current-step semantics (UI-005).
    const list = host.querySelector('ol[aria-label="İş süreci"]')!;
    expect(list.querySelector('[aria-current="step"]')?.textContent).toBe('Uygulanıyor: Şu an');
  });

  it('marks an attention phase with Delay Amber text and an icon in the strip', async () => {
    setViewport(true);
    await render(revisionRequested, staff);

    const summary = host.querySelector('[data-workflow-compact="true"] summary')!;
    expect(summary.textContent).toContain('3 / 5 · Dikkat gerekiyor');
    expect(summary.classList.contains('servora-workflow-steps-summary--attention')).toBe(true);
    const attention = host.querySelector('[data-workflow-stages="true"] [data-stage-state="attention"]')!;
    expect(attention.querySelector('.servora-workflow-stage-attention-glyph')?.textContent).toBe('!');
    // The worded attention state and its icon stay in the expanded stepper and
    // in the always-present ordered list.
    expect(host.querySelector('ol[aria-label="İş süreci"] [aria-current="step"]')?.textContent)
      .toBe('Uygulanıyor: Dikkat gerekiyor');
    expect(host.querySelector('.servora-ant-steps-item-error')).toBeNull();
  });

  it('puts the manager decision below the lifecycle strip and the responsibility panel', async () => {
    setViewport(true);
    await render(managerWaiting, manager);

    expect(section('responsibility')!.textContent).toContain('Yönetici kontrolü');
    expect(precedes(section('lifecycle')!, section('responsibility')!)).toBe(true);
    expect(precedes(section('responsibility')!, section('actions')!)).toBe(true);
    const primary = host.querySelector<HTMLButtonElement>(
      '[data-job-decision-panel="true"] .primary-button',
    )!;
    expect(primary.textContent).toBe('Kontrolü tamamla ve işi kapat');
    expect(primary.closest('.job-detail-work-rail')).toBeNull();
  });

  it('keeps the desktop structure: lifecycle directly below the heading, then the rail decision', async () => {
    setViewport(false);
    await render(staffInProgress, staff);

    expect(precedes(section('heading')!, section('lifecycle')!)).toBe(true);
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

  it('keeps manager lateness history above the workflow but below the lifecycle strip on desktop', async () => {
    setViewport(false);
    const history = <section data-overdue-history="ready" data-test-history>Gecikme kaydı</section>;
    await render(managerWaiting, manager, { overdueHistory: history });

    expect(section('lateness-history')).toBeNull();
    const rendered = host.querySelector('[data-test-history]')!;
    expect(precedes(section('lifecycle')!, rendered)).toBe(true);
    expect(precedes(section('heading')!, rendered)).toBe(true);
    expect(precedes(rendered, section('responsibility')!)).toBe(true);
  });

  it('keeps the revision responsibility ahead of the revision details on narrow shells', async () => {
    setViewport(true);
    await render(revisionRequested, staff);

    expect(section('responsibility')!.textContent).toContain('Düzeltme gerekiyor');
    expect(host.querySelector('#revision-loop-title')?.textContent).toBe('Düzeltme notu');
    expect(host.querySelector('[data-revision-context="expected-role"]')?.textContent)
      .toBe('Düzeltmeye başlamanız bekleniyor.');
    expect(precedes(section('lifecycle')!, section('responsibility')!)).toBe(true);
    expect(precedes(section('responsibility')!, section('actions')!)).toBe(true);
    expect(precedes(section('actions')!, section('revision')!)).toBe(true);
    expect(host.querySelector('[data-job-decision-panel="true"]')?.textContent)
      .toContain('Düzeltmeye başla');
 
    // Management reads the same panel in the third person.
    await render(revisionRequested, manager);
    expect(host.querySelector('[data-revision-context="expected-role"]')?.textContent)
      .toBe('Personelin düzeltmeyi başlatması bekleniyor.');
    expect(host.querySelector('[data-revision-context="next-action"]')?.textContent)
      .toBe('Personel kayıtları güncelleyip işi yeniden kontrole gönderecek.');
  });

  it('deduplicates manager review headings/submission facts and places invalidation below notes in rail', async () => {
    setViewport(false);
    await render(managerWaiting, manager, {
      messagingAction: <div data-test-messaging="true">Mesaj</div>,
      notes: <section data-test-notes="true">Notlar</section>,
      invalidationAction: <section data-invalidation-action="true">Kaydı geçersiz kıl</section>,
    });

    expect(host.querySelector('#workflow-responsibility-title')?.textContent).toBe('Yönetici kontrolü');
    expect(host.querySelector('#approval-review-title')?.textContent).toBe('Yönetici kontrolü özeti');
    expect(host.querySelector('.workflow-responsibility-submission')).toBeNull();

    const rail = host.querySelector('.job-detail-work-rail')!;
    const messaging = rail.querySelector('[data-test-messaging]')!;
    const notes = rail.querySelector('[data-test-notes]')!;
    const invalidation = rail.querySelector('[data-invalidation-action]')!;
    expect(precedes(messaging, notes)).toBe(true);
    expect(precedes(notes, invalidation)).toBe(true);

    // Staff WAITING_APPROVAL keeps submission facts in CurrentResponsibilityPanel and shows submitted checklist copy.
    await render(
      jobCard('WAITING_APPROVAL', ['WITHDRAW_FROM_APPROVAL', 'CANCEL'], {
        submittedAt: '2026-07-17T10:00:00.000Z',
        submittedBy: { id: 's1', name: 'Ayşe Personel' },
      }),
      staff,
    );
    expect(host.querySelector('.workflow-responsibility-submission')).not.toBeNull();
    expect(host.querySelector('#workflow-requirements-title')?.textContent).toBe('Gönderilen kayıt özeti');

    // Resumed revision in IN_PROGRESS updates revision loop context copy.
    await render(
      jobCard('IN_PROGRESS', ['SUBMIT_FOR_APPROVAL', 'CANCEL'], {
        revisionRequestedAt: '2026-07-17T11:00:00.000Z',
        revisionRequestedBy: { id: 'm1', name: 'Murat Yönetici' },
        revisionReason: 'Teslim miktarını düzeltin',
      }),
      staff,
    );
    expect(host.querySelector('[data-revision-context="expected-role"]')?.textContent)
      .toBe('Düzeltme üzerinde çalışıyorsunuz.');
    expect(host.querySelector('[data-revision-context="next-action"]')?.textContent)
      .toBe('Yönetici notunu giderip kayıtları güncelledikten sonra yeniden kontrole gönderin.');
  });
});

const admin: CurrentUser = {
  ...manager, id: 'a1', name: 'Sistem yöneticisi', role: 'ADMIN',
};

const submitted: Partial<JobLifecycleFacts> = {
  submittedAt: '2026-07-17T10:00:00.000Z',
  submittedBy: { id: 's1', name: 'Ayşe Personel' },
};

type MatrixRow = {
  name: string;
  job: JobCard;
  user: CurrentUser;
  /** Commands the backend capability set produces for this role/state today. */
  anchors: string[];
  invalidation?: boolean;
};

const matrixRows: MatrixRow[] = [
  {
    name: 'STAFF NEW',
    job: jobCard('NEW', ['ACCEPT_ASSIGNMENT', 'CANCEL'], { acceptedAt: null, acceptedBy: null, startedAt: null }),
    user: staff,
    anchors: ['İşi kabul et', 'İşi iptal et'],
  },
  {
    name: 'STAFF ACCEPTED',
    job: jobCard('ACCEPTED', ['START', 'CANCEL'], { startedAt: null }),
    user: staff,
    anchors: ['İşi başlat', 'İşi iptal et'],
  },
  {
    name: 'STAFF IN_PROGRESS',
    job: staffInProgress,
    user: staff,
    anchors: ['Kontrole gönder', 'İşi iptal et'],
  },
  {
    name: 'STAFF WAITING_APPROVAL withdraw',
    job: jobCard('WAITING_APPROVAL', ['WITHDRAW_FROM_APPROVAL', 'CANCEL'], submitted),
    user: staff,
    anchors: ['Kontrolden geri çek ve düzenle', 'İşi iptal et'],
  },
  {
    name: 'STAFF REVISION_REQUESTED',
    job: revisionRequested,
    user: staff,
    anchors: ['Düzeltmeye başla', 'İşi iptal et'],
  },
  {
    name: 'MANAGER IN_PROGRESS secondary only',
    job: jobCard('IN_PROGRESS', ['CANCEL'], { startedAt: '2026-07-17T09:00:00.000Z' }),
    user: manager,
    anchors: ['İşi iptal et'],
  },
  {
    name: 'MANAGER WAITING_APPROVAL',
    job: managerWaiting,
    user: manager,
    anchors: ['Kontrolü tamamla ve işi kapat', 'Düzeltme için personele geri gönder', 'İşi iptal et'],
  },
  {
    name: 'MANAGER NEW record edit',
    job: jobCard('NEW', ['CANCEL'], { acceptedAt: null, acceptedBy: null, startedAt: null }),
    user: manager,
    anchors: ['Sorumlu personeli değiştir', 'İşi iptal et'],
  },
  {
    name: 'ADMIN WAITING_APPROVAL with invalidation',
    job: managerWaiting,
    user: admin,
    anchors: ['Kontrolü tamamla ve işi kapat', 'Düzeltme için personele geri gönder', 'İşi iptal et'],
    invalidation: true,
  },
  {
    name: 'MANAGER COMPLETED',
    job: jobCard('COMPLETED', [], {
      ...submitted,
      approvedAt: '2026-07-17T12:00:00.000Z',
      approvedBy: { id: 'm1', name: 'Murat Yönetici' },
    }),
    user: manager,
    anchors: [],
  },
  {
    name: 'STAFF CANCELLED',
    job: jobCard('CANCELLED', [], {
      cancelledAt: '2026-07-17T12:00:00.000Z',
      cancelReason: 'Müşteri vazgeçti',
      cancelledFromStatus: 'IN_PROGRESS',
    }),
    user: staff,
    anchors: [],
  },
];

function expectedDecisionLabels(job: JobCard, user: CurrentUser): string[] {
  const presentation = deriveJobWorkflowPresentation({
    job,
    user,
    workflowContext: job.workflowContext,
    deliveryItems: [],
    meetingDetails: null,
  });
  return [
    ...(presentation.primaryTransition ? [presentation.primaryTransition.label] : []),
    ...presentation.secondaryTransitions.map((transition) => transition.label),
    ...(presentation.recordEditAction ? [presentation.recordEditAction.label] : []),
  ];
}

describe.each([
  { layout: 'narrow', narrow: true },
  { layout: 'desktop', narrow: false },
])('lifecycle commands by role and state at $layout width', ({ narrow }) => {
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

  async function renderRow(row: MatrixRow) {
    setViewport(narrow);
    await act(async () => {
      root.render(<ServoraAntProvider>
        <JobDetailPanel
          job={row.job}
          items={[]}
          user={row.user}
          pending={false}
          message=""
          onCommand={() => {}}
          invalidationAction={row.invalidation
            ? <section data-invalidation-action="true">Geçersiz kılma</section>
            : undefined}
        />
      </ServoraAntProvider>);
    });
  }

  it.each(matrixRows)('$name renders exactly the presentation commands', async (row) => {
    await renderRow(row);
    const expected = expectedDecisionLabels(row.job, row.user);
    const panel = host.querySelector<HTMLElement>('[data-job-decision-panel="true"]');
    const buttonTexts = Array.from(host.querySelectorAll('button'))
      .map((button) => button.textContent?.trim() ?? '');

    if (expected.length === 0) {
      expect(panel).toBeNull();
    } else {
      expect(panel).not.toBeNull();
      // Nothing is invented and nothing is lost: the rendered labels are exactly
      // the capability-derived presentation labels.
      const labels = Array.from(panel!.querySelectorAll('button'))
        .map((button) => button.textContent?.trim() ?? '');
      expect([...labels].sort()).toEqual([...expected].sort());
      expect(new Set(labels).size).toBe(labels.length);
      for (const label of expected) {
        expect(buttonTexts.filter((text) => text === label)).toHaveLength(1);
      }
      // Placement follows the viewport contract without duplicating the group.
      expect(panel!.closest('.job-detail-work-rail') !== null).toBe(!narrow);
      if (narrow) {
        expect(panel!.closest('[data-job-detail-section="actions"]')).not.toBeNull();
      }
      expect(host.querySelectorAll('[data-job-decision-panel="true"]')).toHaveLength(1);
    }

    // Anchor commands from the domain capability set (not just self-consistency).
    for (const anchor of row.anchors) {
      expect(buttonTexts).toContain(anchor);
    }

    if (row.invalidation) {
      expect(host.querySelectorAll('[data-invalidation-action="true"]')).toHaveLength(1);
      expect(host.querySelector('[data-invalidation-action="true"]')!
        .closest('[data-job-decision-panel="true"]')).toBeNull();
    }
  });
});

describe('viewport changes while a workflow dialog is open', () => {
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

  function setControllableViewport(initialNarrow: boolean) {
    // Listeners are tracked per media query: a breakpoint change must not also
    // fire the reduced-motion query the Ant provider listens to (that would swap
    // the theme and remount the subtree for reasons unrelated to this contract).
    const listeners = new Set<{ query: string; listener: (event: MediaQueryListEvent) => void }>();
    let desktop = !initialNarrow;
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
      get matches() {
        return query.includes('min-width: 64rem') ? desktop : false;
      },
      media: query,
      onchange: null,
      addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
        listeners.add({ query, listener });
      },
      removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
        for (const entry of listeners) {
          if (entry.listener === listener) listeners.delete(entry);
        }
      },
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })));
    return {
      setDesktop(next: boolean) {
        desktop = next;
        for (const { query, listener } of listeners) {
          listener({ matches: query.includes('min-width: 64rem') ? next : false } as MediaQueryListEvent);
        }
      },
    };
  }

  it('keeps an open JobWorkflowDialog and its typed reason across the 64rem breakpoint', async () => {
    const viewport = setControllableViewport(true);
    const presentation = deriveJobWorkflowPresentation({
      job: managerWaiting,
      user: manager,
      workflowContext: managerWaiting.workflowContext,
      deliveryItems: [],
      meetingDetails: null,
    });
    const revision = presentation.secondaryTransitions
      .find((transition) => transition.command === 'REQUEST_REVISION')!;
    expect(revision).toBeDefined();

    await act(async () => {
      root.render(<ServoraAntProvider>
        <JobDetailPanel
          job={managerWaiting}
          items={[]}
          user={manager}
          pending={false}
          message=""
          onCommand={() => {}}
        >
          <JobWorkflowDialog
            dialog={{ kind: 'revision', presentation: revision }}
            pending={false}
            onClose={() => {}}
            onConfirm={() => {}}
          />
        </JobDetailPanel>
      </ServoraAntProvider>);
    });

    const dialog = host.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    const reason = dialog!.querySelector<HTMLTextAreaElement>('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
        ?.set?.call(reason, 'Miktarı düzeltin');
      reason.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // Narrow → desktop: the composition flips, the dialog must not remount.
    await act(async () => { viewport.setDesktop(true); });
    expect(host.querySelector('[role="dialog"]')).toBe(dialog);
    expect(host.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')!.value)
      .toBe('Miktarı düzeltin');
    expect(host.querySelector('[data-workflow-compact="true"]')).toBeNull();
    expect(host.querySelector('[data-job-decision-panel="true"]')!.closest('.job-detail-work-rail'))
      .not.toBeNull();

    // Desktop → narrow: still the same dialog with the same draft.
    await act(async () => { viewport.setDesktop(false); });
    expect(host.querySelector('[role="dialog"]')).toBe(dialog);
    expect(host.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')!.value)
      .toBe('Miktarı düzeltin');
    expect(host.querySelector('[data-workflow-compact="true"]')).not.toBeNull();
  });
});
