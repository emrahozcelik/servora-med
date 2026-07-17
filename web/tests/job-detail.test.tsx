/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  JobDetailPanel, JobDetailScreen, prepareMeetingEdit, runStaffJobCommand,
} from '../src/JobDetail';
import { ApiError, type CurrentUser, type DeliveryItem } from '../src/services/api';
import type {
  JobCard, JobLifecycleFacts, JobWorkflowContext, LifecycleCommand, MeetingDetails,
} from '../src/jobs/jobs-api';
import { workflowContext } from './fixtures/job-workflow';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const staffUser: CurrentUser = {
  id: 's1', organizationId: 'org-1', name: 'Ayşe Personel', email: 'a@x',
  role: 'STAFF', mustChangePassword: false, isActive: true, version: 1,
};
const managerUser: CurrentUser = {
  ...staffUser, id: 'm1', name: 'Yönetici', role: 'MANAGER', email: 'm@x',
};

const baseLifecycle: JobLifecycleFacts = {
  createdAt: '2026-07-17T08:00:00.000Z', plannedAt: null,
  startedAt: null, submittedAt: null, submittedBy: null, submissionNote: null,
  approvedAt: null, approvedBy: null, approvalNote: null,
  revisionRequestedAt: null, revisionRequestedBy: null, revisionReason: null,
  cancelledAt: null, cancelledBy: null, cancelReason: null, cancelledFromStatus: null,
};

function contextWith(partial: Partial<JobWorkflowContext> = {}): JobWorkflowContext {
  return {
    ...workflowContext,
    ...partial,
    lifecycle: partial.lifecycle
      ? { ...baseLifecycle, ...partial.lifecycle }
      : (partial.lifecycle === undefined
        ? { ...workflowContext.lifecycle }
        : partial.lifecycle),
    submissionReadiness: partial.submissionReadiness === undefined
      ? workflowContext.submissionReadiness
      : partial.submissionReadiness,
    allowedCommands: partial.allowedCommands ?? workflowContext.allowedCommands,
    allowedActions: partial.allowedActions ?? workflowContext.allowedActions,
  };
}

function staffContext(
  status: JobCard['status'],
  lifecycle: Partial<JobLifecycleFacts> = {},
  extras: Partial<JobWorkflowContext> = {},
): JobWorkflowContext {
  const commandsByStatus: Record<JobCard['status'], LifecycleCommand[]> = {
    NEW: ['PLAN', 'START', 'CANCEL'],
    PLANNED: ['START', 'CANCEL'],
    IN_PROGRESS: ['SUBMIT_FOR_APPROVAL', 'CANCEL'],
    REVISION_REQUESTED: ['RESUME', 'CANCEL'],
    WAITING_APPROVAL: ['WITHDRAW_FROM_APPROVAL', 'CANCEL'],
    COMPLETED: [],
    CANCELLED: [],
  };
  const actionsByStatus: Record<JobCard['status'], JobWorkflowContext['allowedActions']> = {
    NEW: ['EDIT_JOB_FIELDS'],
    PLANNED: ['EDIT_JOB_FIELDS'],
    IN_PROGRESS: [
      'EDIT_JOB_FIELDS', 'VIEW_MEETING_RESULT', 'EDIT_MEETING_RESULT', 'VIEW_NOTES', 'ADD_NOTE',
    ],
    REVISION_REQUESTED: [
      'EDIT_JOB_FIELDS', 'VIEW_MEETING_RESULT', 'EDIT_MEETING_RESULT', 'VIEW_NOTES', 'ADD_NOTE',
    ],
    WAITING_APPROVAL: [
      'WITHDRAW_AND_EDIT_JOB_FIELDS', 'VIEW_MEETING_RESULT', 'VIEW_NOTES',
    ],
    COMPLETED: ['VIEW_MEETING_RESULT', 'VIEW_NOTES'],
    CANCELLED: ['VIEW_MEETING_RESULT', 'VIEW_NOTES'],
  };
  return contextWith({
    allowedCommands: extras.allowedCommands ?? commandsByStatus[status],
    allowedActions: extras.allowedActions ?? actionsByStatus[status],
    lifecycle: { ...baseLifecycle, ...lifecycle },
    submissionReadiness: extras.submissionReadiness === undefined
      ? (status === 'IN_PROGRESS'
        ? {
          evaluatedAt: '2026-07-17T12:00:00.000Z',
          ready: true,
          items: [
            { code: 'MEETING_TIME_VALID', state: 'met' },
            { code: 'MEETING_OUTCOME_VALID', state: 'met' },
            { code: 'MEETING_SUMMARY_PRESENT', state: 'met' },
          ],
        }
        : null)
      : extras.submissionReadiness,
  });
}

const job: JobCard = {
  id: 'job-1', organizationId: 'org-1', type: 'PRODUCT_DELIVERY', status: 'NEW', version: 2,
  title: 'ABC Klinik ürün teslimi', description: null, customerId: 'c1', contactId: null,
  assignedTo: 's1', createdBy: 's1', priority: 'normal', dueDate: null,
  assignee: { id: 's1', name: 'Ayşe Personel' }, customer: { id: 'c1', name: 'ABC Klinik' },
  contact: null,
  workflowContext: staffContext('NEW', { createdAt: '2026-07-17T08:00:00.000Z' }, {
    allowedActions: [],
    submissionReadiness: null,
  }),
};
const item: DeliveryItem = {
  id: 'i1', organizationId: 'org-1', jobCardId: 'job-1', productId: 'p1',
  deliveryPurpose: 'SAMPLE', deliveredAt: '2026-07-11T10:00:00.000Z', quantity: 2, unit: 'adet',
  productNameSnapshot: 'İmplant Seti', productSkuSnapshot: 'S1', productModelSnapshot: null,
  lotNo: null, serialNo: null, expiryDate: null, deliveryNote: null,
};
const generalTask: JobCard = {
  ...job, type: 'GENERAL_TASK', title: 'Teklif dönüşünü takip et',
  description: 'Doktorun kararını öğren ve sonucu karta yaz.', priority: 'high',
  dueDate: '2026-07-20', customerId: 'c1', contactId: 'contact-1',
  assignee: { id: 's1', name: 'Ayşe Personel' },
  customer: { id: 'c1', name: 'Demo Dental Klinik' },
  contact: { id: 'contact-1', name: 'Dr. Deniz' },
};

function inProgressMeeting(lifecycle: Partial<JobLifecycleFacts> = {}): JobCard {
  return {
    ...job,
    type: 'SALES_MEETING',
    status: 'IN_PROGRESS',
    version: 3,
    title: 'Satış görüşmesi detayı',
    dueDate: '2026-07-20',
    workflowContext: staffContext('IN_PROGRESS', {
      startedAt: '2026-07-17T09:00:00.000Z',
      plannedAt: null,
      ...lifecycle,
    }),
  };
}

function revisionRequestedJob(opts: { revisionReason: string }): JobCard {
  return {
    ...job,
    type: 'SALES_MEETING',
    status: 'REVISION_REQUESTED',
    version: 4,
    title: 'Düzeltme bekleyen görüşme',
    dueDate: '2026-07-20',
    workflowContext: staffContext('REVISION_REQUESTED', {
      startedAt: '2026-07-17T09:00:00.000Z',
      plannedAt: '2026-07-17T08:30:00.000Z',
      submittedAt: '2026-07-17T10:00:00.000Z',
      revisionRequestedAt: '2026-07-17T11:00:00.000Z',
      revisionReason: opts.revisionReason,
    }),
  };
}

function cancelledJob(lifecycle: Partial<JobLifecycleFacts>): JobCard {
  return {
    ...job,
    status: 'CANCELLED',
    title: 'İptal edilen teslim',
    workflowContext: staffContext('CANCELLED', {
      startedAt: '2026-07-17T09:00:00.000Z',
      cancelledAt: '2026-07-17T12:00:00.000Z',
      cancelReason: 'Müşteri vazgeçti',
      cancelledFromStatus: 'IN_PROGRESS',
      ...lifecycle,
    }, { allowedActions: [] }),
  };
}

const emptyPage = { items: [], total: 0, limit: 25, offset: 0 };
const meetingDetails: MeetingDetails = {
  jobCardId: 'job-1', meetingAt: '2026-07-16T10:00:00.000Z', outcome: 'POSITIVE',
  meetingSummary: 'Olumlu görüşme', nextFollowUpAt: null, jobCardVersion: 3,
};

function buttonByName(host: ParentNode, name: string) {
  return Array.from(host.querySelectorAll('button'))
    .find((button) => button.textContent?.trim() === name) ?? null;
}

function mockDetailFetch(card: JobCard, options: {
  meeting?: MeetingDetails | null;
  notes?: typeof emptyPage;
} = {}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/delivery-items')) return Response.json({ items: card.type === 'PRODUCT_DELIVERY' ? [item] : [] });
    if (url.endsWith('/meeting-details')) {
      if (options.meeting === null) throw new Error('unexpected meeting-details');
      return Response.json(options.meeting ?? { ...meetingDetails, jobCardVersion: card.version });
    }
    if (url.includes('/notes?')) {
      if (options.notes === undefined && !card.workflowContext.allowedActions.includes('VIEW_NOTES')) {
        throw new Error('unexpected notes');
      }
      return Response.json(options.notes ?? emptyPage);
    }
    if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
    if (url.endsWith(`/api/job-cards/${card.id}`) || url.endsWith('/api/job-cards/job-1')) {
      return Response.json(card);
    }
    throw new Error(`Unexpected request: ${url}`);
  });
}

describe('Staff JobCard detail', () => {
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

  async function renderDetail(card: JobCard, user: CurrentUser = staffUser) {
    await act(async () => {
      root.render(<JobDetailPanel
        job={card}
        items={card.type === 'PRODUCT_DELIVERY' ? [item] : []}
        user={user}
        pending={false}
        message=""
        onBack={() => {}}
        onCommand={() => {}}
      />);
    });
  }

  async function renderScreen(card: JobCard, user: CurrentUser = staffUser, fetch = mockDetailFetch(card)) {
    vi.stubGlobal('fetch', fetch);
    await act(async () => {
      root.render(<JobDetailScreen jobId={card.id} user={user} onBack={() => {}} onChanged={() => {}} />);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    return fetch;
  }

  it('renders skipped planning and staff responsibility before structured records', async () => {
    const card = inProgressMeeting({ plannedAt: null, startedAt: '2026-07-17T09:00:00.000Z' });
    await renderDetail(card);
    expect(host.querySelector('h1')?.textContent).toBe(card.title);
    const steps = host.querySelector('[aria-label="İş süreci"]');
    expect(steps?.getAttribute('role') ?? steps?.tagName.toLowerCase()).toMatch(/list|ol/);
    expect(steps?.textContent).toContain('Planlama atlandı');
    const current = steps?.querySelector('[aria-current="step"]');
    expect(current?.textContent).toContain('Uygulanıyor');
    expect(host.querySelector('h2')?.textContent === 'Şimdi sizden beklenen'
      || Array.from(host.querySelectorAll('h2')).some((el) => el.textContent === 'Şimdi sizden beklenen')).toBe(true);
    expect(host.textContent).toContain(
      'İş yönetici kontrolüne geçecek ve kontrol sona erene kadar kayıtlar düzenlenemeyecektir.',
    );
    expect(buttonByName(host, 'Kontrole gönder')).not.toBeNull();
    const stepsEl = host.querySelector('.job-lifecycle-steps');
    const responsibilityEl = Array.from(host.querySelectorAll('h2'))
      .find((el) => el.textContent === 'Şimdi sizden beklenen');
    const deliveryOrMeeting = Array.from(host.querySelectorAll('h2'))
      .find((el) => el.textContent === 'Teslim bilgileri' || el.textContent === 'Görüşme sonucu');
    expect(stepsEl).not.toBeNull();
    expect(responsibilityEl).not.toBeNull();
    expect(
      (stepsEl?.compareDocumentPosition(responsibilityEl!) ?? 0)
        & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    if (deliveryOrMeeting) {
      expect(
        (responsibilityEl!.compareDocumentPosition(deliveryOrMeeting)
          & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
      ).toBe(true);
    }
  });

  it('shows revision reason and separates resuming from resubmitting', async () => {
    await renderDetail(revisionRequestedJob({ revisionReason: 'Miktarı düzeltin' }));
    expect(Array.from(host.querySelectorAll('h2'))
      .some((el) => el.textContent === 'Düzeltme gerekiyor')).toBe(true);
    expect(host.textContent).toContain('Miktarı düzeltin');
    expect(buttonByName(host, 'Düzeltmeye başla')).not.toBeNull();
    expect(buttonByName(host, 'Yeniden kontrole gönder')).toBeNull();
    expect(buttonByName(host, 'Kontrole gönder')).toBeNull();
  });

  it('does not mount hidden Sales Meeting resources in new and planned states', async () => {
    for (const status of ['NEW', 'PLANNED'] as const) {
      await act(async () => root.unmount());
      host.remove();
      host = document.createElement('div');
      document.body.append(host);
      root = createRoot(host);

      const newMeetingJob: JobCard = {
        ...job,
        type: 'SALES_MEETING',
        status,
        title: `Planlanan görüşme ${status}`,
        dueDate: '2026-07-20',
        workflowContext: staffContext(status),
      };
      const fetch = await renderScreen(newMeetingJob);
      expect(host.textContent).toContain(newMeetingJob.title);
      expect(fetch.mock.calls.some(([url]) => String(url).includes('/meeting-details'))).toBe(false);
      expect(fetch.mock.calls.some(([url]) => String(url).includes('/notes'))).toBe(false);
      expect(host.textContent).not.toContain('Görüşme sonucu');
      expect(Array.from(host.querySelectorAll('h2')).some((el) => el.textContent === 'Notlar')).toBe(false);
    }
  });

  it('shows read-only notes affordance for waiting and completed review states', async () => {
    for (const status of ['WAITING_APPROVAL', 'COMPLETED'] as const) {
      await act(async () => root.unmount());
      host.remove();
      host = document.createElement('div');
      document.body.append(host);
      root = createRoot(host);

      const card: JobCard = {
        ...inProgressMeeting(),
        status,
        version: 5,
        workflowContext: staffContext(status, {
          startedAt: '2026-07-17T09:00:00.000Z',
          submittedAt: '2026-07-17T10:00:00.000Z',
          ...(status === 'COMPLETED'
            ? { approvedAt: '2026-07-17T11:00:00.000Z' }
            : {}),
        }),
      };
      await renderScreen(card, staffUser, mockDetailFetch(card, {
        notes: {
          items: [{
            id: 'note-1', jobCardId: 'job-1', note: 'Kayıtlı not',
            author: { id: 's1', name: 'Ayşe' }, createdAt: '2026-07-17T09:30:00.000Z',
          }],
          total: 1, limit: 25, offset: 0,
        },
      }));
      expect(host.textContent).toContain('Kayıtlı not');
      expect(host.querySelector('.job-notes form')).toBeNull();
    }
  });

  it('suppresses the empty notes section for cancelled jobs', async () => {
    const card: JobCard = {
      ...inProgressMeeting(),
      status: 'CANCELLED',
      workflowContext: staffContext('CANCELLED', {
        startedAt: '2026-07-17T09:00:00.000Z',
        cancelledAt: '2026-07-17T12:00:00.000Z',
        cancelReason: 'İptal',
        cancelledFromStatus: 'IN_PROGRESS',
      }),
    };
    await renderScreen(card, staffUser, mockDetailFetch(card, { notes: emptyPage }));
    expect(host.querySelector('.job-notes')).toBeNull();
    expect(host.textContent).not.toContain('Henüz iş notu yok');
  });

  it('renders terminal cancellation facts without inventing missing history', async () => {
    await renderDetail(cancelledJob({
      cancelledFromStatus: 'IN_PROGRESS',
      cancelledAt: '2026-07-17T12:00:00.000Z',
      cancelReason: 'Müşteri vazgeçti',
    }));
    expect(host.textContent).toContain('İptal edildi');
    expect(host.textContent).toContain('Müşteri vazgeçti');
    expect(host.textContent).toMatch(/Uygulanıyor|İncelem/);

    await act(async () => {
      root.render(<JobDetailPanel
        job={cancelledJob({
          cancelledFromStatus: null, cancelledAt: null, cancelReason: null,
        })}
        items={[item]}
        user={staffUser}
        pending={false}
        message=""
        onBack={() => {}}
        onCommand={() => {}}
      />);
    });
    expect(host.textContent?.match(/Bilgi kaydedilmemiş/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('hides Staff primary lifecycle actions when the viewer is not the assignee', async () => {
    const card = {
      ...inProgressMeeting(),
      // Backend omits staff lifecycle commands for non-assignees; presentation never invents them.
      workflowContext: staffContext('IN_PROGRESS', {
        startedAt: '2026-07-17T09:00:00.000Z',
        plannedAt: null,
      }, {
        allowedCommands: [],
        allowedActions: ['VIEW_MEETING_RESULT', 'VIEW_NOTES'],
      }),
    };
    await renderDetail(card, { ...staffUser, id: 'other-staff' });
    expect(buttonByName(host, 'Kontrole gönder')).toBeNull();
    expect(buttonByName(host, 'İşi başlat')).toBeNull();
    expect(buttonByName(host, 'İşi iptal et')).toBeNull();
  });

  it('labels direct and waiting Sales Meeting editing explicitly', () => {
    const directCtx = staffContext('IN_PROGRESS', {
      startedAt: '2026-07-17T09:00:00.000Z',
    });
    const waitingCtx = staffContext('WAITING_APPROVAL', {
      startedAt: '2026-07-17T09:00:00.000Z',
      submittedAt: '2026-07-17T10:00:00.000Z',
    });
    const direct = renderToStaticMarkup(<JobDetailPanel
      job={{ ...job, type: 'SALES_MEETING', status: 'IN_PROGRESS', workflowContext: directCtx }}
      items={[]} user={staffUser} pending={false} message="" onBack={() => {}} onCommand={() => {}} />);
    const waiting = renderToStaticMarkup(<JobDetailPanel
      job={{ ...job, type: 'SALES_MEETING', status: 'WAITING_APPROVAL', workflowContext: waitingCtx }}
      items={[]} user={staffUser} pending={false} message="" onBack={() => {}} onCommand={() => {}} />);
    expect(direct).toContain('Görüşmeyi düzenle');
    expect(direct).toContain('İşi iptal et');
    expect(waiting).toContain('Kontrolden geri çek ve düzenle');
    expect(waiting).toContain('İşi iptal et');
  });

  it('withdraws a waiting Sales Meeting before edit mode opens', async () => {
    const waiting = {
      ...job, type: 'SALES_MEETING' as const, status: 'WAITING_APPROVAL' as const, version: 5,
    };
    const withdraw = vi.fn().mockResolvedValue({ ...waiting, status: 'IN_PROGRESS', version: 6 });
    await expect(prepareMeetingEdit(waiting, 'edit-action-1', withdraw)).resolves.toMatchObject({
      status: 'IN_PROGRESS', version: 6,
    });
    expect(withdraw).toHaveBeenCalledWith(waiting.id, {
      clientActionId: 'edit-action-1', expectedVersion: 5,
    });
  });

  it('renders immutable delivery facts and the next valid command', () => {
    const html = renderToStaticMarkup(<JobDetailPanel
      job={job} items={[item]} user={staffUser} pending={false} message=""
      onBack={() => {}} onCommand={() => {}} />);
    expect(html).toContain('ABC Klinik ürün teslimi');
    expect(html).not.toContain('Sürüm 2');
    expect(html).toContain('İmplant Seti');
    expect(html).toContain('Numune');
    expect(html).toContain('2 adet');
    expect(html).toContain('İşi başlat');
    expect(html).toContain('Planla');
    expect(html.match(/primary-button/g)?.length ?? 0).toBe(1);
  });

  it('renders quantity without a fabricated unit when the Product unit is null', () => {
    const html = renderToStaticMarkup(<JobDetailPanel
      job={job} items={[{ ...item, quantity: 3, unit: null }]} user={staffUser}
      pending={false} message="" onBack={() => {}} onCommand={() => {}} />);
    expect(html).toContain('<dd>3</dd>');
    expect(html).not.toContain('3 adet');
    expect(html).not.toContain('3 null');
  });

  it('renders shared General Task facts and no Product Delivery section', () => {
    const html = renderToStaticMarkup(<JobDetailPanel job={generalTask} items={[]} user={staffUser}
      pending={false} message="" onBack={() => {}} onCommand={() => {}}>
      <section>Notlar ve zaman çizelgesi</section>
    </JobDetailPanel>);

    expect(html).toContain('Genel görev');
    expect(html).toContain('Teklif dönüşünü takip et');
    expect(html).toContain('Doktorun kararını öğren ve sonucu karta yaz.');
    expect(html).toContain('Ayşe Personel');
    expect(html).toContain('Demo Dental Klinik');
    expect(html).toContain('Dr. Deniz');
    expect(html).toContain('Yüksek');
    expect(html).toContain('2026-07-20');
    expect(html).toContain('Notlar ve zaman çizelgesi');
    expect(html).not.toContain('Teslim bilgileri');
    expect(html).not.toContain('Ürün teslimi');
  });

  it('uses exactly one structured subresource for each canonical type', () => {
    const source = readFileSync(`${process.cwd()}/src/JobDetail.tsx`, 'utf8');

    expect(source).toContain("if (job.type === 'PRODUCT_DELIVERY')");
    expect(source).toContain("if (job.type === 'GENERAL_TASK')");
    expect(source).toContain('VIEW_MEETING_RESULT');
    expect(source).toContain('listDeliveryItems');
    expect(source).toContain('getMeetingDetails');
    expect(source).toContain('className="delivery-lines"');
  });

  it('shows submit only after the backend status is IN_PROGRESS', () => {
    const inProgress = {
      ...job,
      status: 'IN_PROGRESS' as const,
      version: 3,
      workflowContext: staffContext('IN_PROGRESS', {
        startedAt: '2026-07-17T09:00:00.000Z',
      }, {
        allowedActions: [],
        submissionReadiness: {
          evaluatedAt: '2026-07-17T12:00:00.000Z', ready: true,
          items: [{ code: 'DELIVERY_ITEM_PRESENT', state: 'met' }],
        },
      }),
    };
    const html = renderToStaticMarkup(<JobDetailPanel job={inProgress} items={[item]}
      user={staffUser} pending={false} message="" onBack={() => {}} onCommand={() => {}} />);
    expect(html).toContain('Kontrole gönder');
    expect(html).not.toContain('İşi başlat');
  });

  it('uses the current backend version for start and submit', async () => {
    const start = vi.fn().mockResolvedValue({ ...job, status: 'IN_PROGRESS', version: 3 });
    const submit = vi.fn().mockResolvedValue({ ...job, status: 'WAITING_APPROVAL', version: 4 });
    const refresh = vi.fn();
    await runStaffJobCommand(job, 'start', { start, submit, refresh, createActionId: () => 'action-1' });
    await runStaffJobCommand({ ...job, status: 'IN_PROGRESS', version: 3 }, 'submit', {
      start, submit, refresh, createActionId: () => 'action-2',
    });
    expect(start).toHaveBeenCalledWith('job-1', { clientActionId: 'action-1', expectedVersion: 2 });
    expect(submit).toHaveBeenCalledWith('job-1', { clientActionId: 'action-2', expectedVersion: 3 });
  });

  it('refetches and explains a stale-version conflict', async () => {
    const refreshed = { ...job, status: 'IN_PROGRESS' as const, version: 3 };
    const refresh = vi.fn().mockResolvedValue(refreshed);
    const result = await runStaffJobCommand(job, 'start', {
      start: vi.fn().mockRejectedValue(new ApiError(409, 'VERSION_CONFLICT', 'Kart güncellendi.')),
      submit: vi.fn(), refresh, createActionId: () => 'action-1',
    });
    expect(result).toEqual({ kind: 'conflict', job: refreshed });
    expect(refresh).toHaveBeenCalledWith('job-1');
  });

  it('does not re-derive permissions from local capability helpers', () => {
    const source = readFileSync(`${process.cwd()}/src/JobDetail.tsx`, 'utf8');
    expect(source).not.toContain('jobCapabilities');
    expect(source).not.toContain('availableLifecycleCommands');
    expect(source).not.toContain('primaryLifecycleCommand');
    expect(source).toContain('deriveJobWorkflowPresentation');
  });

  it('uses presentation successMessage only — no generic command label concatenation', () => {
    const source = readFileSync(`${process.cwd()}/src/JobDetail.tsx`, 'utf8');
    expect(source).toContain('transition.successMessage');
    expect(source).not.toContain('işlemi tamamlandı');
    expect(source).not.toMatch(/\$\{transition\?\.label/);
  });

  it.each([
    {
      command: 'SUBMIT_FOR_APPROVAL' as const,
      expected: 'İş yönetici kontrolüne gönderildi. Kontrol tamamlanana veya iş geri çekilene kadar kayıtlar düzenlenemez.',
      setup: () => {
        const card = {
          ...job,
          status: 'IN_PROGRESS' as const,
          version: 3,
          workflowContext: staffContext('IN_PROGRESS', {
            startedAt: '2026-07-17T09:00:00.000Z',
          }, {
            allowedActions: [],
            submissionReadiness: {
              evaluatedAt: '2026-07-17T12:00:00.000Z', ready: true,
              items: [{ code: 'DELIVERY_ITEM_PRESENT' as const, state: 'met' as const }],
            },
          }),
        };
        return {
          card,
          user: staffUser,
          trigger: 'Kontrole gönder',
          endpoint: '/submit-for-approval',
          next: {
            ...card,
            status: 'WAITING_APPROVAL' as const,
            version: 4,
            workflowContext: staffContext('WAITING_APPROVAL', {
              startedAt: '2026-07-17T09:00:00.000Z',
              submittedAt: '2026-07-17T12:00:00.000Z',
            }, { allowedActions: [] }),
          },
          needsDialog: false as const,
        };
      },
    },
    {
      command: 'APPROVE' as const,
      expected: 'İş tamamlandı ve aktif işlerden çıkarıldı.',
      setup: () => {
        const card = {
          ...job,
          status: 'WAITING_APPROVAL' as const,
          version: 4,
          workflowContext: contextWith({
            allowedCommands: ['APPROVE', 'REQUEST_REVISION', 'CANCEL'],
            allowedActions: ['VIEW_NOTES'],
            lifecycle: {
              ...baseLifecycle,
              startedAt: '2026-07-17T09:00:00.000Z',
              submittedAt: '2026-07-17T10:00:00.000Z',
              submittedBy: { id: 's1', name: 'Ayşe Personel' },
            },
            submissionReadiness: null,
          }),
        };
        return {
          card,
          user: managerUser,
          trigger: 'Kontrolü tamamla ve işi kapat',
          confirm: 'İşi tamamla',
          endpoint: '/approve',
          next: {
            ...card,
            status: 'COMPLETED' as const,
            version: 5,
            workflowContext: contextWith({
              allowedCommands: [],
              allowedActions: ['VIEW_NOTES'],
              lifecycle: {
                ...baseLifecycle,
                startedAt: '2026-07-17T09:00:00.000Z',
                submittedAt: '2026-07-17T10:00:00.000Z',
                approvedAt: '2026-07-17T11:00:00.000Z',
              },
              submissionReadiness: null,
            }),
          },
          needsDialog: true as const,
        };
      },
    },
    {
      command: 'REQUEST_REVISION' as const,
      expected: 'İş düzeltme için personele geri gönderildi.',
      setup: () => {
        const card = {
          ...job,
          status: 'WAITING_APPROVAL' as const,
          version: 4,
          workflowContext: contextWith({
            allowedCommands: ['APPROVE', 'REQUEST_REVISION', 'CANCEL'],
            allowedActions: ['VIEW_NOTES'],
            lifecycle: {
              ...baseLifecycle,
              startedAt: '2026-07-17T09:00:00.000Z',
              submittedAt: '2026-07-17T10:00:00.000Z',
              submittedBy: { id: 's1', name: 'Ayşe Personel' },
            },
            submissionReadiness: null,
          }),
        };
        return {
          card,
          user: managerUser,
          trigger: 'Düzeltme için personele geri gönder',
          confirm: 'Düzeltme için geri gönder',
          reason: 'Miktarı düzeltin',
          endpoint: '/request-revision',
          next: {
            ...card,
            status: 'REVISION_REQUESTED' as const,
            version: 5,
            workflowContext: contextWith({
              allowedCommands: [],
              allowedActions: ['VIEW_NOTES'],
              lifecycle: {
                ...baseLifecycle,
                startedAt: '2026-07-17T09:00:00.000Z',
                submittedAt: '2026-07-17T10:00:00.000Z',
                revisionRequestedAt: '2026-07-17T11:00:00.000Z',
                revisionReason: 'Miktarı düzeltin',
              },
              submissionReadiness: null,
            }),
          },
          needsDialog: true as const,
        };
      },
    },
    {
      command: 'RESUME' as const,
      expected: 'İş yeniden düzenlemeye açıldı. Tamamladığınızda tekrar kontrole gönderin.',
      setup: () => {
        const card = revisionRequestedJob({ revisionReason: 'Miktarı düzeltin' });
        return {
          card,
          user: staffUser,
          trigger: 'Düzeltmeye başla',
          endpoint: '/resume',
          next: {
            ...card,
            status: 'IN_PROGRESS' as const,
            version: card.version + 1,
            workflowContext: staffContext('IN_PROGRESS', {
              startedAt: '2026-07-17T09:00:00.000Z',
              plannedAt: '2026-07-17T08:30:00.000Z',
              submittedAt: '2026-07-17T10:00:00.000Z',
              revisionRequestedAt: '2026-07-17T11:00:00.000Z',
              revisionReason: 'Miktarı düzeltin',
            }),
          },
          needsDialog: false as const,
        };
      },
    },
  ])('uses presentation success copy for $command', async ({ expected, setup }) => {
    const scenario = setup();
    const flush = async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/delivery-items')) {
        return Response.json({ items: scenario.card.type === 'PRODUCT_DELIVERY' ? [item] : [] });
      }
      if (url.endsWith('/meeting-details')) {
        return Response.json({ ...meetingDetails, jobCardVersion: scenario.card.version });
      }
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.endsWith(scenario.endpoint) && init?.method === 'POST') {
        return Response.json(scenario.next);
      }
      if (url.endsWith(`/api/job-cards/${scenario.card.id}`)) {
        return Response.json(scenario.card);
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    await act(async () => {
      root.render(<JobDetailScreen
        jobId={scenario.card.id}
        user={scenario.user}
        onBack={() => {}}
        onChanged={() => {}}
      />);
      await flush();
    });

    const trigger = buttonByName(host, scenario.trigger)!;
    expect(trigger).not.toBeNull();
    await act(async () => { trigger.click(); await flush(); });

    if (scenario.needsDialog) {
      const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
      expect(dialog).not.toBeNull();
      if ('reason' in scenario && scenario.reason) {
        const textarea = dialog.querySelector<HTMLTextAreaElement>('textarea')!;
        await act(async () => {
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
            ?.set?.call(textarea, scenario.reason);
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
        });
      }
      await act(async () => {
        buttonByName(dialog, scenario.confirm!)!.click();
        await flush();
      });
    }

    const feedback = host.querySelector<HTMLElement>('[role="status"]');
    expect(feedback?.textContent).toBe(expected);
  });
});
