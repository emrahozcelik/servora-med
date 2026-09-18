/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FollowUpProposalSection } from '../src/jobs/FollowUpProposalSection';
import { JobDetailScreen } from '../src/JobDetail';
import type {
  FollowUpDraft,
} from '../src/jobs/FollowUpProposalSection';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
    matches: false, media: '', onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  }));
});

afterEach(() => {
  document.body.innerHTML = '';
});

const draft: FollowUpDraft = {
  scheduledAt: '2026-08-08T10:00:00.000Z',
  type: 'SALES_MEETING',
  assignedTo: 's1',
  followUpInstructions: 'Takip: Kontrol görüşmesi',
};

function renderSection(props: Partial<Parameters<typeof FollowUpProposalSection>[0]> = {}) {
  document.body.innerHTML = '';
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const onChange = vi.fn();
  const onOverrideReasonChange = vi.fn();
  act(() => {
    root.render(<FollowUpProposalSection
      mode="staff"
      draft={draft}
      origin={null}
      evaluation={null}
      assigneeName="Ayşe Personel"
      assignees={[]}
      allowTypeEdit={false}
      overrideReason=""
      inlineError={null}
      onChange={onChange}
      onOverrideReasonChange={onOverrideReasonChange}
      onUseSuggestedAlternative={() => {}}
      {...props}
    />);
  });
  return { host, root, onChange, onOverrideReasonChange };
}

describe('FollowUpProposalSection', () => {
  it('shows the ÖNERİLEN badge and the suggested summary in the staff flow', () => {
    const { host } = renderSection({
      evaluation: {
        level: 'CLEAR', safeMessage: null, conflicts: [], recentVisit: null,
        suggestedAlternativeAt: null,
      },
    });
    expect(host.textContent).toContain('Takip işi planı');
    expect(host.textContent).toContain('ÖNERİLEN');
    expect(host.textContent).toContain('Satış görüşmesi');
    expect(host.textContent).toContain('Ayşe Personel');
    expect(host.querySelector('#follow-up-proposal-scheduled-at')).not.toBeNull();
  });

  it('surfaces only the safe skip message to Staff without any conflicting Job details', () => {
    const { host } = renderSection({
      evaluation: {
        level: 'WARNING',
        safeMessage: 'Bu müşteri için yakın tarihte başka bir plan bulunduğundan sonraki uygun tarih önerildi.',
        conflicts: [], recentVisit: null, suggestedAlternativeAt: null,
      },
    });
    expect(host.textContent).toContain('sonraki uygun tarih önerildi');
    expect(host.querySelector('.follow-up-conflict-list')).toBeNull();
  });

  it('renders the manager editors, recent visit card, and conflict alternative button', () => {
    const { host } = renderSection({
      mode: 'manager',
      origin: 'STAFF_ADJUSTED',
      assignees: [{ id: 's1', name: 'Ayşe Personel' }, { id: 's2', name: 'Bora Yılmaz' }],
      allowTypeEdit: true,
      evaluation: {
        level: 'CONFLICT',
        safeMessage: 'Bu müşteri için yakın tarihte başka bir iş planlandı.',
        conflicts: [{
          jobCardId: 'job-2', title: 'Başka personelin teslimi',
          scheduledAt: '2026-08-08T09:00:00.000Z', type: 'PRODUCT_DELIVERY',
          status: 'NEW', assignee: { id: 's2', name: 'Bora Yılmaz' },
          jobPath: '/jobs/job-2',
        }],
        recentVisit: {
          occurredAt: '2026-08-04T09:00:00.000Z', jobType: 'PRODUCT_DELIVERY',
          title: 'Ürün teslimi', staffName: 'Bora Yılmaz', resultSummary: 'Teslim edildi.',
        },
        suggestedAlternativeAt: '2026-08-09T10:00:00.000Z',
      },
    });
    expect(host.textContent).toContain('PERSONEL ÖNERİSİ');
    expect(host.querySelector('#follow-up-proposal-assignee')).not.toBeNull();
    expect(host.querySelector('#follow-up-proposal-type')).not.toBeNull();
    expect(host.textContent).toContain('Başka personelin teslimi');
    expect(host.textContent).toContain('Yakın tarihli müşteri ziyareti');
    expect(host.textContent).toContain('Önerilen alternatif zamanı kullan');
  });

  it('shows frequency information without an override field', () => {
    const { host } = renderSection({ mode: 'manager', evaluation: {
      level: 'WARNING', safeMessage: '14 günde 5 saha teması.',
      conflicts: [], recentVisit: null, suggestedAlternativeAt: null,
    } });
    expect(host.textContent).toContain('14 günde 5 saha teması.');
    expect(host.querySelector('#follow-up-override-reason')).toBeNull();
  });

  it('reports a draft-less proposal as needing an explicit date', () => {
    const { host } = renderSection({ draft: null });
    expect(host.textContent).toContain('uygun bir tarih bulunamadı');
  });

  it('R1-7: a null origin in the manager flow renders the ÖNERİLEN badge', () => {
    const { host } = renderSection({
      mode: 'manager',
      origin: null,
      evaluation: {
        level: 'CLEAR', safeMessage: null, conflicts: [], recentVisit: null,
        suggestedAlternativeAt: null,
      },
    });
    expect(host.textContent).toContain('ÖNERİLEN');
    expect(host.textContent).not.toContain('PERSONEL ÖNERİSİ');
  });

  it('R1-6: Staff frequency warning has no override reason field', () => {
    const { host } = renderSection({
      evaluation: {
        level: 'WARNING',
        safeMessage: 'Bu müşteri için ziyaret sıklığı yüksek. Takip planı yönetici onayında ayrıca değerlendirilecek.',
        conflicts: [], recentVisit: null, suggestedAlternativeAt: null,
      },
    });
    expect(host.textContent).toContain('yönetici onayında ayrıca değerlendirilecek');
    expect(host.querySelector('#follow-up-override-reason')).toBeNull();
  });

  it('R2-AP-F1: manager mode shows priority (default normal) and hides due-date for SALES_MEETING', () => {
    const { host } = renderSection({ mode: 'manager', allowTypeEdit: true });
    const priority = host.querySelector<HTMLSelectElement>('#follow-up-proposal-priority');
    expect(priority).not.toBeNull();
    expect(priority!.value).toBe('normal');
    expect(host.textContent).toContain('Öncelik');
    expect(host.querySelector('#follow-up-proposal-due-date')).toBeNull();
  });

  it('R2-AP-F2: manager mode shows optional due-date for GENERAL_TASK and PRODUCT_DELIVERY', () => {
    for (const type of ['GENERAL_TASK', 'PRODUCT_DELIVERY'] as const) {
      const { host } = renderSection({ mode: 'manager', allowTypeEdit: true, draft: { ...draft, type } });
      expect(host.querySelector('#follow-up-proposal-due-date')).not.toBeNull();
      expect(host.textContent).toContain('Son tarih');
    }
  });

  it('R2-AP-F3: staff mode shows neither priority nor due-date', () => {
    const { host } = renderSection({ mode: 'staff' });
    expect(host.querySelector('#follow-up-proposal-priority')).toBeNull();
    expect(host.querySelector('#follow-up-proposal-due-date')).toBeNull();
    expect(host.textContent).not.toContain('Son tarih');
  });
});

describe('JobDetail follow-up proposal integration', () => {
  function stubFetch(overrides: {
    card: Record<string, unknown>;
    suggestion?: Record<string, unknown>;
    approveResult?: Record<string, unknown>;
    approveError?: {
      status: number;
      code: string;
      message: string;
      details?: { conflicts: Array<Record<string, unknown>> };
    };
    approveErrors?: Array<{
      status: number;
      code: string;
      message: string;
      details?: { conflicts: Array<Record<string, unknown>> };
    }>;
    frequency?: boolean;
  }) {
    const { card, suggestion, approveResult, approveError, frequency } = overrides;
    let remainingApproveErrors = [...(overrides.approveErrors ?? [])];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/delivery-items')) return Response.json({ items: [] });
      if (url.includes('/notes?')) return Response.json({ items: [], total: 0, limit: 25, nextCursor: null });
      if (url.includes('/activity?')) return Response.json({ items: [], total: 0, limit: 50, offset: 0 });
      if (url.includes('/follow-up-suggestion')) {
        return Response.json(suggestion ?? {
          scheduledAt: '2026-08-08T10:00:00.000Z',
          type: 'SALES_MEETING',
          assignedTo: 's1',
          followUpInstructions: 'Takip: Klinik teslimi',
          evaluation: {
            level: frequency ? 'WARNING' : 'CLEAR',
            safeMessage: frequency ? '14 günde 5 saha teması.' : null,
            conflicts: [],
            recentVisit: null,
            suggestedAlternativeAt: null,
          },
        });
      }
      if (url.endsWith('/api/calendar/assignees')) {
        return Response.json({ items: [{ id: 's1', name: 'Ayşe Personel' }] });
      }
      if (url.endsWith('/approve') && method === 'POST') {
        const nextApproveError = remainingApproveErrors.shift() ?? approveError;
        if (nextApproveError) {
          return new Response(JSON.stringify({
            error: nextApproveError.message,
            code: nextApproveError.code,
            details: nextApproveError.details ?? { conflicts: [] },
          }), {
            status: nextApproveError.status, headers: { 'content-type': 'application/json' },
          });
        }
        return Response.json(approveResult ?? {
          ...card, status: 'COMPLETED', version: 5, followUpJobCardId: 'child-1',
        });
      }
      if (url.endsWith('/submit-for-approval') && method === 'POST') {
        return Response.json({ ...card, status: 'WAITING_APPROVAL', version: 4 });
      }
      if (url.endsWith('/api/job-cards/job-1')) return Response.json(card);
      throw new Error(`Unexpected request: ${method} ${url}`);
    }));
  }

  const managerCard = {
    id: 'job-1', organizationId: 'org-1', type: 'PRODUCT_DELIVERY', status: 'WAITING_APPROVAL',
    version: 4, title: 'Klinik teslimi', description: null, customerId: 'c1', contactId: null,
    assignedTo: 's1', createdBy: 's1', priority: 'normal', dueDate: null,
    scheduledAt: null, scheduledEndsAt: null, engagementKind: null,
    assignee: { id: 's1', name: 'Ayşe Personel' },
    customer: { id: 'c1', name: 'ABC Klinik' }, contact: null,
    workflowContext: {
      allowedCommands: ['APPROVE', 'REQUEST_REVISION', 'CANCEL'],
      allowedActions: ['VIEW_NOTES'],
      startLocationCaptureEnabled: false,
      lifecycle: {
        createdAt: '2026-07-31T10:00:00.000Z',
        acceptedAt: null, acceptedBy: null,
        startedAt: '2026-07-31T11:00:00.000Z',
        submittedAt: '2026-08-01T10:00:00.000Z',
        submittedBy: { id: 's1', name: 'Ayşe Personel' },
        submissionNote: 'Teslim tamamlandı',
        approvedAt: null, approvedBy: null, approvalNote: null,
        revisionRequestedAt: null, revisionRequestedBy: null, revisionReason: null,
        cancelledAt: null, cancelledBy: null, cancelReason: null, cancelledFromStatus: null,
      },
      submissionReadiness: null,
    },
    followUpContext: null,
    followUpProposal: {
      scheduledAt: '2026-08-08T10:00:00.000Z',
      type: 'SALES_MEETING',
      assignedTo: 's1',
      followUpInstructions: 'Takip: Klinik teslimi',
      origin: 'SYSTEM',
      proposedBy: { id: 's1', name: 'Ayşe Personel' },
    },
  };

  const manager = {
    id: 'manager-1', organizationId: 'org-1', name: 'Yönetici',
    email: 'manager@test.local', role: 'MANAGER', mustChangePassword: false,
    isActive: true, version: 1,
  };

  async function flush() {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it('Manager approves with the persisted proposal and receives the linked child id', async () => {
    stubFetch({ card: managerCard });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => {
        root.render(<JobDetailScreen jobId="job-1" user={manager} onBack={() => {}} onChanged={() => {}} />);
        await flush();
      });
      const approve = Array.from(host.querySelectorAll('button'))
        .find((button) => button.textContent === 'Kontrolü tamamla ve işi kapat')!;
      await act(async () => { approve.click(); await flush(); });
      const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
      expect(dialog.textContent).toContain('Takip işi');
      expect(dialog.textContent).toContain('ÖNERİLEN');
      const confirm = Array.from(dialog.querySelectorAll('button'))
        .find((button) => button.textContent === 'İşi onayla ve takip işini planla')!;
      await act(async () => { confirm.click(); await flush(); });
      const approveCall = vi.mocked(fetch).mock.calls.find(([url, init]) => (
        String(url).endsWith('/approve') && (init as RequestInit | undefined)?.method === 'POST'
      ));
      const body = JSON.parse(String((approveCall?.[1] as RequestInit).body));
      expect(body.followUp).toMatchObject({
        scheduledAt: '2026-08-08T10:00:00.000Z',
        type: 'SALES_MEETING',
        assignedTo: 's1',
        followUpInstructions: 'Takip: Klinik teslimi',
      });
      expect(host.textContent).toContain('İş tamamlandı ve takip işi planlandı.');
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it('Manager sees no conflict list or alternative CTA for an advisory follow-up suggestion', async () => {
    // The suggestion endpoint only emits CLEAR/WARNING advisories: no
    // conflicts, no alternative time. The approval still proceeds.
    stubFetch({ card: managerCard, frequency: true });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => {
        root.render(<JobDetailScreen jobId="job-1" user={manager} onBack={() => {}} onChanged={() => {}} />);
        await flush();
      });
      const approve = Array.from(host.querySelectorAll('button'))
        .find((button) => button.textContent === 'Kontrolü tamamla ve işi kapat')!;
      await act(async () => { approve.click(); await flush(); });
      const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
      expect(dialog.querySelector('.follow-up-conflict-list')).toBeNull();
      expect(dialog.textContent).not.toContain('Önerilen alternatif zamanı kullan');
      expect(dialog.textContent).toContain('14 günde 5 saha teması.');
      const confirm = Array.from(dialog.querySelectorAll('button'))
        .find((button) => button.textContent === 'İşi onayla ve takip işini planla')!;
      await act(async () => { confirm.click(); await flush(); });
      expect(host.textContent).toContain('İş tamamlandı ve takip işi planlandı.');
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it('Manager approves frequent contact without override reason', async () => {
    stubFetch({ card: managerCard, frequency: true });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => {
        root.render(<JobDetailScreen jobId="job-1" user={manager} onBack={() => {}} onChanged={() => {}} />);
        await flush();
      });
      const approve = Array.from(host.querySelectorAll('button'))
        .find((button) => button.textContent === 'Kontrolü tamamla ve işi kapat')!;
      await act(async () => { approve.click(); await flush(); });
      const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
      expect(dialog.textContent).toContain('14 günde 5 saha teması.');
      const confirm = Array.from(dialog.querySelectorAll('button'))
        .find((button) => button.textContent === 'İşi onayla ve takip işini planla')!;
      await act(async () => { confirm.click(); await flush(); });
      expect(dialog.querySelector('#follow-up-override-reason')).toBeNull();
      const approveCall = vi.mocked(fetch).mock.calls.find(([url, init]) => (
        String(url).endsWith('/approve') && (init as RequestInit | undefined)?.method === 'POST'
      ));
      const body = JSON.parse(String((approveCall?.[1] as RequestInit).body));
      expect(body.followUp).not.toHaveProperty('overrideReason');
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it('R2-AP-F4: approval payload carries priority and dueDate (defaults normal/null)', async () => {
    stubFetch({ card: managerCard });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => {
        root.render(<JobDetailScreen jobId="job-1" user={manager} onBack={() => {}} onChanged={() => {}} />);
        await flush();
      });
      const approve = Array.from(host.querySelectorAll('button'))
        .find((button) => button.textContent === 'Kontrolü tamamla ve işi kapat')!;
      await act(async () => { approve.click(); await flush(); });
      const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
      const confirm = Array.from(dialog.querySelectorAll('button'))
        .find((button) => button.textContent === 'İşi onayla ve takip işini planla')!;
      await act(async () => { confirm.click(); await flush(); });
      const approveCall = vi.mocked(fetch).mock.calls.find(([url, init]) => (
        String(url).endsWith('/approve') && (init as RequestInit | undefined)?.method === 'POST'
      ));
      const body = JSON.parse(String((approveCall?.[1] as RequestInit).body));
      expect(body.followUp).toMatchObject({ priority: 'normal', dueDate: null });
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it('renders a follow-up approval duplicate inside the open dialog, not on the page', async () => {
    const duplicateMessage = 'Aynı müşteri, personel ve ziyaret türü için bu saat aralığında zaten bir plan bulunuyor.';
    stubFetch({ card: managerCard, approveError: { status: 409, code: 'CUSTOMER_VISIT_DUPLICATE', message: duplicateMessage } });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => {
        root.render(<JobDetailScreen jobId="job-1" user={manager} onBack={() => {}} onChanged={() => {}} />);
        await flush();
      });
      const approve = Array.from(host.querySelectorAll('button'))
        .find((button) => button.textContent === 'Kontrolü tamamla ve işi kapat')!;
      await act(async () => { approve.click(); await flush(); });
      const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
      const confirm = Array.from(dialog.querySelectorAll('button'))
        .find((button) => button.textContent === 'İşi onayla ve takip işini planla')!;
      await act(async () => { confirm.click(); await flush(); });
      // Dialog stays open with the duplicate in its inline error region...
      expect(host.querySelector('[role="dialog"]')).not.toBeNull();
      expect(dialog.textContent).toContain(duplicateMessage);
      // ...and the background page error region must not present it.
      const pageError = host.querySelector('.detail-feedback-error');
      expect(pageError === null || !pageError.textContent?.includes(duplicateMessage)).toBe(true);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it('renders a follow-up approval calendar conflict inside the open dialog, not on the page', async () => {
    const calendarMessage = 'Seçilen personelin bu zaman aralığında başka bir planı bulunuyor.';
    stubFetch({
      card: managerCard,
      approveErrors: [{
        status: 409,
        code: 'CALENDAR_CONFLICT',
        message: calendarMessage,
        details: {
          conflicts: [{
            source: 'JOB',
            id: 'job-existing',
            title: 'Aynı personelin mevcut planı',
            startsAt: '2026-08-08T10:00:00.000Z',
            endsAt: '2026-08-08T11:00:00.000Z',
            assignedUser: { id: 's1', name: 'Ayşe Personel' },
            relatedJobPath: '/jobs/job-existing',
          }],
        },
      }],
    });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => {
        root.render(<JobDetailScreen jobId="job-1" user={manager} onBack={() => {}} onChanged={() => {}} />);
        await flush();
      });
      const approve = Array.from(host.querySelectorAll('button'))
        .find((button) => button.textContent === 'Kontrolü tamamla ve işi kapat')!;
      await act(async () => { approve.click(); await flush(); });
      const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
      const confirm = Array.from(dialog.querySelectorAll('button'))
        .find((button) => button.textContent === 'İşi onayla ve takip işini planla')!;
      await act(async () => { confirm.click(); await flush(); });

      expect(host.querySelector('[role="dialog"]')).not.toBeNull();
      expect(dialog.textContent).toContain(calendarMessage);
      expect(Array.from(dialog.querySelectorAll('[role="alert"]'))
        .some((alert) => alert.textContent?.includes(calendarMessage))).toBe(true);
      const pageError = host.querySelector('.detail-feedback-error');
      expect(pageError === null || !pageError.textContent?.includes(calendarMessage)).toBe(true);
      expect(host.textContent).not.toContain('İş tamamlandı ve takip işi planlandı.');
      expect(dialog.querySelector('#follow-up-proposal-scheduled-at')?.hasAttribute('disabled')).toBe(false);
      expect(dialog.contains(document.activeElement)).toBe(true);

      const firstApproveCall = vi.mocked(fetch).mock.calls.find(([url, init]) => (
        String(url).endsWith('/approve') && (init as RequestInit | undefined)?.method === 'POST'
      ));
      expect(firstApproveCall).toBeDefined();
      const firstBody = JSON.parse(String((firstApproveCall?.[1] as RequestInit).body));
      const scheduledAt = dialog.querySelector<HTMLInputElement>('#follow-up-proposal-scheduled-at')!;
      await act(async () => {
        const setNativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        setNativeValue.call(scheduledAt, '2026-08-08T12:00');
        scheduledAt.dispatchEvent(new Event('input', { bubbles: true }));
        await flush();
      });
      await act(async () => { confirm.click(); await flush(); });
      const approveCalls = vi.mocked(fetch).mock.calls.filter(([url, init]) => (
        String(url).endsWith('/approve') && (init as RequestInit | undefined)?.method === 'POST'
      ));
      expect(approveCalls).toHaveLength(2);
      const secondBody = JSON.parse(String((approveCalls[1][1] as RequestInit).body));
      expect(secondBody.clientActionId).not.toBe(firstBody.clientActionId);
      expect(secondBody.followUp.scheduledAt).not.toBe(firstBody.followUp.scheduledAt);
      expect(host.textContent).toContain('İş tamamlandı ve takip işi planlandı.');
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it('keeps an assignee-not-found approval failure inside the open dialog', async () => {
    const assigneeMessage = 'Takip işi sorumlusu bulunamadı.';
    stubFetch({
      card: managerCard,
      approveError: { status: 404, code: 'ASSIGNEE_NOT_FOUND', message: assigneeMessage },
    });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => {
        root.render(<JobDetailScreen jobId="job-1" user={manager} onBack={() => {}} onChanged={() => {}} />);
        await flush();
      });
      const approve = Array.from(host.querySelectorAll('button'))
        .find((button) => button.textContent === 'Kontrolü tamamla ve işi kapat')!;
      await act(async () => { approve.click(); await flush(); });
      const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
      const confirm = Array.from(dialog.querySelectorAll('button'))
        .find((button) => button.textContent === 'İşi onayla ve takip işini planla')!;
      await act(async () => { confirm.click(); await flush(); });
      expect(host.querySelector('[role="dialog"]')).not.toBeNull();
      expect(dialog.textContent).toContain(assigneeMessage);
      const pageError = host.querySelector('.detail-feedback-error');
      expect(pageError === null || !pageError.textContent?.includes(assigneeMessage)).toBe(true);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});
