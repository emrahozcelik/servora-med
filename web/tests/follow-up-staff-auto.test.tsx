/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JobDetailScreen } from '../src/JobDetail';
import { FollowUpProposalSection } from '../src/jobs/FollowUpProposalSection';
import { SystemSelectedFollowUpNotice } from '../src/jobs/FollowUpContinuity';
import {
  buildStaffFollowUpProposalInput,
  isAutoSchedulableFollowUpType,
} from '../src/jobs/jobs-api';
import { requiresMandatoryFollowUpProposal } from '../src/jobs/job-workflow-presentation';

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
  vi.unstubAllGlobals();
});

describe('Staff AUTO follow-up request contract', () => {
  it('supports automatic scheduling for SALES_MEETING only', () => {
    expect(isAutoSchedulableFollowUpType('SALES_MEETING')).toBe(true);
    expect(isAutoSchedulableFollowUpType('PRODUCT_DELIVERY')).toBe(false);
    expect(isAutoSchedulableFollowUpType('GENERAL_TASK')).toBe(false);
  });

  it('omits an empty scheduledAt instead of sending a blank value', () => {
    expect(buildStaffFollowUpProposalInput({
      scheduledAt: '',
      type: 'SALES_MEETING',
      assignedTo: 's1',
      followUpInstructions: 'Takip: Ziyaret',
    })).toEqual({
      type: 'SALES_MEETING',
      assignedTo: 's1',
      followUpInstructions: 'Takip: Ziyaret',
    });
    expect('scheduledAt' in buildStaffFollowUpProposalInput({
      scheduledAt: '',
      type: 'SALES_MEETING',
      assignedTo: 's1',
      followUpInstructions: 'Takip: Ziyaret',
    })).toBe(false);
  });

  it('keeps an explicitly chosen scheduledAt for the fallback path', () => {
    expect(buildStaffFollowUpProposalInput({
      scheduledAt: '2026-08-09T10:00:00.000Z',
      type: 'SALES_MEETING',
      assignedTo: 's1',
      followUpInstructions: '  Takip: Ziyaret  ',
    })).toEqual({
      scheduledAt: '2026-08-09T10:00:00.000Z',
      type: 'SALES_MEETING',
      assignedTo: 's1',
      followUpInstructions: 'Takip: Ziyaret',
    });
  });

  it('never requires a mandatory proposal outside SALES_MEETING customer visits', () => {
    const meeting = {
      outcome: 'FOLLOW_UP_REQUIRED' as const,
      unsuccessfulReason: 'REQUESTED_LATER' as const,
    };
    const visit = { type: 'PRODUCT_DELIVERY' as const, engagementKind: 'CUSTOMER_VISIT' as const };
    expect(requiresMandatoryFollowUpProposal(visit, meeting)).toBe(false);
    expect(requiresMandatoryFollowUpProposal({ ...visit, type: 'GENERAL_TASK' }, meeting)).toBe(false);
    expect(requiresMandatoryFollowUpProposal({ ...visit, type: 'SALES_MEETING' }, meeting)).toBe(true);
    expect(requiresMandatoryFollowUpProposal({ ...visit, type: 'SALES_MEETING' }, null)).toBe(false);
  });
});

describe('FollowUpProposalSection Staff AUTO presentation', () => {
  function renderAuto(props: Record<string, unknown> = {}) {
    document.body.innerHTML = '';
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
      root.render(<FollowUpProposalSection
        mode="staff"
        draft={{
          scheduledAt: '',
          type: 'SALES_MEETING',
          assignedTo: 's1',
          followUpInstructions: 'Takip: Ziyaret',
        }}
        origin={null}
        evaluation={null}
        assigneeName="Ayşe Personel"
        assignees={[]}
        allowTypeEdit={false}
        overrideReason=""
        inlineError={null}
        onChange={() => {}}
        onOverrideReasonChange={() => {}}
        onUseSuggestedAlternative={() => {}}
        autoSupported
        {...props}
      />);
    });
    return { host, root };
  }

  it('hides the manual datetime editor and explains system selection', () => {
    const { host } = renderAuto();
    expect(host.querySelector('#follow-up-proposal-scheduled-at')).toBeNull();
    expect(host.textContent).not.toContain('Tarih ve saati değiştir');
    expect(host.textContent).toContain('sistem tarafından seçilecek');
    expect(host.textContent).toContain('Satış görüşmesi');
    expect(host.textContent).toContain('Ayşe Personel');
  });

  it('exposes an explicit datetime fallback when no automatic slot exists', () => {
    const { host } = renderAuto({ allowExplicitSchedule: true });
    expect(host.textContent).toContain('Uygun otomatik zaman bulunamadı');
    expect(host.querySelector('#follow-up-proposal-scheduled-at')).not.toBeNull();
  });

  it('keeps the legacy manual editor when AUTO is not supported', () => {
    document.body.innerHTML = '';
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
      root.render(<FollowUpProposalSection
        mode="staff"
        draft={{
          scheduledAt: '2026-08-08T10:00:00.000Z',
          type: 'PRODUCT_DELIVERY',
          assignedTo: 's1',
          followUpInstructions: 'Takip: Teslim',
        }}
        origin={null}
        evaluation={null}
        assigneeName="Ayşe Personel"
        assignees={[]}
        allowTypeEdit={false}
        overrideReason=""
        inlineError={null}
        onChange={() => {}}
        onOverrideReasonChange={() => {}}
        onUseSuggestedAlternative={() => {}}
      />);
    });
    expect(host.querySelector('#follow-up-proposal-scheduled-at')).not.toBeNull();
    expect(host.textContent).toContain('Tarih ve saati değiştir');
  });
});

describe('SystemSelectedFollowUpNotice', () => {
  it('renders the server-returned slot, type, and pending-approval note', () => {
    document.body.innerHTML = '';
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
      root.render(<SystemSelectedFollowUpNotice proposal={{
        scheduledAt: '2026-08-08T10:00:00.000Z',
        type: 'SALES_MEETING',
        assignedTo: 's1',
        followUpInstructions: 'Takip: Ziyaret',
        origin: 'SYSTEM',
        proposedBy: { id: 's1', name: 'Ayşe Personel' },
      }} />);
    });
    expect(host.textContent).toContain('SİSTEM SEÇTİ');
    expect(host.textContent).toContain('Satış görüşmesi');
    expect(host.textContent).toContain('60 dakika');
    expect(host.textContent).toContain('Yönetici onayı bekleniyor');
    expect(host.querySelector('time')?.getAttribute('datetime')).toBe('2026-08-08T10:00:00.000Z');
    expect(host.querySelector('[role="status"]')).not.toBeNull();
  });
});

describe('JobDetail suggestion failure semantics', () => {
  const staffCard = {
    id: 'job-1', organizationId: 'org-1', type: 'SALES_MEETING', status: 'IN_PROGRESS',
    version: 3, title: 'Klinik ziyareti', description: null, customerId: 'c1', contactId: null,
    assignedTo: 's1', createdBy: 's1', priority: 'normal', dueDate: null,
    scheduledAt: '2026-08-01T10:00:00.000Z', scheduledEndsAt: '2026-08-01T11:00:00.000Z',
    engagementKind: 'CUSTOMER_VISIT',
    assignee: { id: 's1', name: 'Ayşe Personel' },
    customer: { id: 'c1', name: 'ABC Klinik' }, contact: null,
    workflowContext: {
      allowedCommands: ['SUBMIT_FOR_APPROVAL', 'CANCEL'],
      allowedActions: ['VIEW_MEETING_RESULT', 'EDIT_MEETING_RESULT', 'VIEW_NOTES', 'ADD_NOTE'],
      startLocationCaptureEnabled: false,
      lifecycle: {
        createdAt: '2026-08-01T09:00:00.000Z',
        acceptedAt: '2026-08-01T09:05:00.000Z', acceptedBy: { id: 's1', name: 'Ayşe Personel' },
        startedAt: '2026-08-01T10:00:00.000Z',
        submittedAt: null, submittedBy: null, submissionNote: null,
        approvedAt: null, approvedBy: null, approvalNote: null,
        revisionRequestedAt: null, revisionRequestedBy: null, revisionReason: null,
        cancelledAt: null, cancelledBy: null, cancelReason: null, cancelledFromStatus: null,
      },
      submissionReadiness: null,
    },
    followUpContext: null,
    followUpProposal: null,
  };

  const staff = {
    id: 's1', organizationId: 'org-1', name: 'Ayşe Personel',
    email: 'ayse@test.local', role: 'STAFF', mustChangePassword: false,
    isActive: true, version: 1,
  };

  const meeting = {
    jobCardId: 'job-1', meetingAt: '2026-08-01T10:00:00.000Z',
    outcome: 'FOLLOW_UP_REQUIRED', unsuccessfulReason: 'REQUESTED_LATER',
    meetingSummary: 'Ziyaret tamamlandı', nextFollowUpAt: null, jobCardVersion: 3,
  };

  const suggestionBox: { mode: 'slot' | 'no-slot' | 'network' | 'forbidden' | 'server' | 'malformed' } = { mode: 'slot' };

  function stubSuggestionFetch() {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/delivery-items')) return Response.json({ items: [] });
      if (url.includes('/notes?')) return Response.json({ items: [], total: 0, limit: 25, nextCursor: null });
      if (url.includes('/activity?')) return Response.json({ items: [], total: 0, limit: 50, offset: 0 });
      if (url.includes('/meeting-details') && method === 'GET') return Response.json(meeting);
      if (url.includes('/follow-up-suggestion')) {
        if (suggestionBox.mode === 'network') throw new TypeError('fetch failed');
        if (suggestionBox.mode === 'forbidden') {
          return Response.json({ code: 'FORBIDDEN', error: 'Bu işlem için yetkiniz bulunmuyor.' }, { status: 403 });
        }
        if (suggestionBox.mode === 'server') {
          return Response.json({ code: 'REQUEST_FAILED', error: 'İşlem tamamlanamadı. Lütfen tekrar deneyin.' }, { status: 500 });
        }
        if (suggestionBox.mode === 'malformed') return Response.json({ unexpected: true });
        return Response.json({
          scheduledAt: suggestionBox.mode === 'no-slot' ? null : '2026-08-08T10:00:00.000Z',
          type: 'SALES_MEETING',
          assignedTo: 's1',
          followUpInstructions: 'Takip: Ziyaret',
          evaluation: {
            level: 'CLEAR', safeMessage: null, conflicts: [], recentVisit: null,
            suggestedAlternativeAt: null,
          },
        });
      }
      if (url.endsWith('/api/job-cards/job-1')) return Response.json(staffCard);
      throw new Error(`Unexpected request: ${method} ${url}`);
    }));
  }

  async function flush() {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  async function openSubmitDialog(host: HTMLElement) {
    const submit = Array.from(host.querySelectorAll('button'))
      .find((button) => button.textContent === 'Kontrole gönder')!;
    await act(async () => { submit.click(); await flush(); await flush(); });
    return host.querySelector<HTMLElement>('[role="dialog"]')!;
  }

  it.each([
    ['network failure', 'network'],
    ['auth/forbidden failure', 'forbidden'],
    ['server failure', 'server'],
    ['malformed response', 'malformed'],
  ] as const)('%s shows a retryable load error, never a no-slot fallback', async (_label, mode) => {
    suggestionBox.mode = mode;
    stubSuggestionFetch();
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => {
        root.render(<JobDetailScreen jobId="job-1" user={staff as never} onBack={() => {}} onChanged={() => {}} />);
        await flush(); await flush();
      });
      const dialog = await openSubmitDialog(host);
      expect(dialog.textContent).not.toContain('Uygun otomatik zaman bulunamadı');
      expect(dialog.querySelector('#follow-up-proposal-scheduled-at')).toBeNull();
      expect(dialog.querySelector('#follow-up-proposal-instructions')).toBeNull();
      const retry = Array.from(dialog.querySelectorAll('button'))
        .find((button) => button.textContent === 'Tekrar dene');
      expect(retry).not.toBeUndefined();
      // Retry recovers into the normal AUTO flow once the backend responds.
      suggestionBox.mode = 'slot';
      await act(async () => { retry!.click(); await flush(); await flush(); });
      expect(dialog.textContent).toContain('sistem tarafından seçilecek');
      expect(dialog.querySelector('#follow-up-proposal-scheduled-at')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it('does not leak explicit fallback state across dialog reopen', async () => {
    suggestionBox.mode = 'no-slot';
    stubSuggestionFetch();
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => {
        root.render(<JobDetailScreen jobId="job-1" user={staff as never} onBack={() => {}} onChanged={() => {}} />);
        await flush(); await flush();
      });
      let dialog = await openSubmitDialog(host);
      expect(dialog.querySelector('#follow-up-proposal-scheduled-at')).not.toBeNull();
      const cancel = Array.from(dialog.querySelectorAll('button'))
        .find((button) => button.textContent === 'Vazgeç')!;
      await act(async () => { cancel.click(); await flush(); });
      expect(host.querySelector('[role="dialog"]')).toBeNull();
      suggestionBox.mode = 'slot';
      dialog = await openSubmitDialog(host);
      expect(dialog.querySelector('#follow-up-proposal-scheduled-at')).toBeNull();
      expect(dialog.textContent).toContain('sistem tarafından seçilecek');
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});

describe('JobDetail Staff AUTO submit integration', () => {
  const staffCard = {
    id: 'job-1', organizationId: 'org-1', type: 'SALES_MEETING', status: 'IN_PROGRESS',
    version: 3, title: 'Klinik ziyareti', description: null, customerId: 'c1', contactId: null,
    assignedTo: 's1', createdBy: 's1', priority: 'normal', dueDate: null,
    scheduledAt: '2026-08-01T10:00:00.000Z', scheduledEndsAt: '2026-08-01T11:00:00.000Z',
    engagementKind: 'CUSTOMER_VISIT',
    assignee: { id: 's1', name: 'Ayşe Personel' },
    customer: { id: 'c1', name: 'ABC Klinik' }, contact: null,
    workflowContext: {
      allowedCommands: ['SUBMIT_FOR_APPROVAL', 'CANCEL'],
      allowedActions: ['VIEW_MEETING_RESULT', 'EDIT_MEETING_RESULT', 'VIEW_NOTES', 'ADD_NOTE'],
      startLocationCaptureEnabled: false,
      lifecycle: {
        createdAt: '2026-08-01T09:00:00.000Z',
        acceptedAt: '2026-08-01T09:05:00.000Z', acceptedBy: { id: 's1', name: 'Ayşe Personel' },
        startedAt: '2026-08-01T10:00:00.000Z',
        submittedAt: null, submittedBy: null, submissionNote: null,
        approvedAt: null, approvedBy: null, approvalNote: null,
        revisionRequestedAt: null, revisionRequestedBy: null, revisionReason: null,
        cancelledAt: null, cancelledBy: null, cancelReason: null, cancelledFromStatus: null,
      },
      submissionReadiness: null,
    },
    followUpContext: null,
    followUpProposal: null,
  };

  const staff = {
    id: 's1', organizationId: 'org-1', name: 'Ayşe Personel',
    email: 'ayse@test.local', role: 'STAFF', mustChangePassword: false,
    isActive: true, version: 1,
  };

  const meeting = {
    jobCardId: 'job-1', meetingAt: '2026-08-01T10:00:00.000Z',
    outcome: 'FOLLOW_UP_REQUIRED', unsuccessfulReason: 'REQUESTED_LATER',
    meetingSummary: 'Ziyaret tamamlandı', nextFollowUpAt: null, jobCardVersion: 3,
  };

  function stubFetch(overrides: {
    suggestionScheduledAt?: string | null;
    submitResult?: Record<string, unknown>;
    submitFailure?: { status: number; code: string; message: string };
  } = {}) {
    const {
      suggestionScheduledAt = '2026-08-08T10:00:00.000Z', submitResult, submitFailure,
    } = overrides;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/delivery-items')) return Response.json({ items: [] });
      if (url.includes('/notes?')) return Response.json({ items: [], total: 0, limit: 25, nextCursor: null });
      if (url.includes('/activity?')) return Response.json({ items: [], total: 0, limit: 50, offset: 0 });
      if (url.includes('/meeting-details') && method === 'GET') return Response.json(meeting);
      if (url.includes('/follow-up-suggestion')) {
        return Response.json({
          scheduledAt: suggestionScheduledAt,
          type: 'SALES_MEETING',
          assignedTo: 's1',
          followUpInstructions: 'Takip: Ziyaret',
          evaluation: {
            level: 'CLEAR', safeMessage: null, conflicts: [], recentVisit: null,
            suggestedAlternativeAt: null,
          },
        });
      }
      if (url.endsWith('/submit-for-approval') && method === 'POST') {
        if (submitFailure) {
          return Response.json(
            { code: submitFailure.code, error: submitFailure.message },
            { status: submitFailure.status },
          );
        }
        return Response.json(submitResult ?? { ...staffCard, status: 'WAITING_APPROVAL', version: 4 });
      }
      if (url.endsWith('/api/job-cards/job-1')) return Response.json(staffCard);
      throw new Error(`Unexpected request: ${method} ${url}`);
    }));
  }

  async function flush() {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  async function openSubmitDialog(host: HTMLElement) {
    const submit = Array.from(host.querySelectorAll('button'))
      .find((button) => button.textContent === 'Kontrole gönder')!;
    await act(async () => { submit.click(); await flush(); await flush(); });
    return host.querySelector<HTMLElement>('[role="dialog"]')!;
  }

  async function fillReason(dialog: HTMLElement) {
    const reason = dialog.querySelector<HTMLTextAreaElement>('form textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(reason.constructor.prototype, 'value')
        ?.set?.call(reason, 'Ziyaret tamamlandı, takip gerekli.');
      reason.dispatchEvent(new Event('input', { bubbles: true }));
      await flush();
    });
  }

  async function confirm(dialog: HTMLElement) {
    const confirmButton = Array.from(dialog.querySelectorAll('button'))
      .find((button) => button.textContent === 'Tamamla ve yönetici onayına gönder')!;
    await act(async () => { confirmButton.click(); await flush(); await flush(); });
  }

  function submitBody() {
    const call = vi.mocked(fetch).mock.calls.find(([url, init]) => (
      String(url).endsWith('/submit-for-approval') && (init as RequestInit | undefined)?.method === 'POST'
    ));
    return call ? JSON.parse(String((call[1] as RequestInit).body)) : null;
  }

  it('submits the Staff AUTO request without scheduledAt and without a planning editor', async () => {
    stubFetch();
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => {
        root.render(<JobDetailScreen jobId="job-1" user={staff as never} onBack={() => {}} onChanged={() => {}} />);
        await flush(); await flush();
      });
      const dialog = await openSubmitDialog(host);
      expect(dialog.querySelector('#follow-up-proposal-scheduled-at')).toBeNull();
      expect(dialog.textContent).not.toContain('Tarih ve saati değiştir');
      expect(dialog.textContent).toContain('sistem tarafından seçilecek');
      await fillReason(dialog);
      await confirm(dialog);
      const body = submitBody();
      expect(body).not.toBeNull();
      expect(body.followUpProposal).toMatchObject({
        type: 'SALES_MEETING',
        assignedTo: 's1',
        followUpInstructions: 'Takip: Ziyaret',
      });
      expect('scheduledAt' in body.followUpProposal).toBe(false);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it('shows the system-selected info box after an automatic submit', async () => {
    stubFetch({
      submitResult: {
        ...staffCard,
        status: 'WAITING_APPROVAL',
        version: 4,
        followUpProposal: {
          scheduledAt: '2026-08-08T10:00:00.000Z',
          type: 'SALES_MEETING',
          assignedTo: 's1',
          followUpInstructions: 'Takip: Ziyaret',
          origin: 'SYSTEM',
          proposedBy: { id: 's1', name: 'Ayşe Personel' },
        },
      },
    });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => {
        root.render(<JobDetailScreen jobId="job-1" user={staff as never} onBack={() => {}} onChanged={() => {}} />);
        await flush(); await flush();
      });
      const dialog = await openSubmitDialog(host);
      await fillReason(dialog);
      await confirm(dialog);
      expect(submitBody()).not.toBeNull();
      expect(host.textContent).toContain('SİSTEM SEÇTİ');
      expect(host.textContent).toContain('Yönetici onayı bekleniyor');
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it.each([
    ['minimum-lead validation', { status: 400, code: 'FOLLOW_UP_PROPOSAL_INVALID', message: 'Takip işi planı için en az 15 dakika sonrası seçilmelidir.' }],
    ['canonical no-slot validation', { status: 409, code: 'FOLLOW_UP_PROPOSAL_INVALID', message: 'Otomatik takip zamanı bulunamadı. Lütfen tarihi manuel seçin.' }],
    ['unsupported-type validation', { status: 400, code: 'FOLLOW_UP_PROPOSAL_INVALID', message: 'Müşteri ziyareti takip işi Sales Meeting olmalıdır.' }],
  ])('POST %s shows the server error without auto-opening manual fallback', async (_label, submitFailure) => {
    stubFetch({ submitFailure });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => {
        root.render(<JobDetailScreen jobId="job-1" user={staff as never} onBack={() => {}} onChanged={() => {}} />);
        await flush(); await flush();
      });
      const dialog = await openSubmitDialog(host);
      await fillReason(dialog);
      await confirm(dialog);
      // Server validation stays visible; no silent fallback, dialog stays open.
      expect(dialog.textContent).toContain(submitFailure.message);
      expect(dialog.querySelector('#follow-up-proposal-scheduled-at')).toBeNull();
      expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it('guides empty instructions to the collapsed scope field', async () => {
    stubFetch({ suggestionScheduledAt: '2026-08-08T10:00:00.000Z' });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => {
        root.render(<JobDetailScreen jobId="job-1" user={staff as never} onBack={() => {}} onChanged={() => {}} />);
        await flush(); await flush();
      });
      const dialog = await openSubmitDialog(host);
      // Empty the scope field, then submit.
      const scope = dialog.querySelector<HTMLTextAreaElement>('#follow-up-proposal-instructions')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(scope.constructor.prototype, 'value')
          ?.set?.call(scope, '   ');
        scope.dispatchEvent(new Event('input', { bubbles: true }));
        await flush();
      });
      await fillReason(dialog);
      await confirm(dialog);
      expect(submitBody()).toBeNull();
      expect(dialog.textContent).toContain('Takip kapsamını düzenle');
      expect(dialog.querySelector('details[open]')).not.toBeNull();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it('offers an actionable explicit-date fallback when no automatic slot exists', async () => {
    stubFetch({ suggestionScheduledAt: null });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => {
        root.render(<JobDetailScreen jobId="job-1" user={staff as never} onBack={() => {}} onChanged={() => {}} />);
        await flush(); await flush();
      });
      const dialog = await openSubmitDialog(host);
      expect(dialog.textContent).toContain('Uygun otomatik zaman bulunamadı');
      expect(dialog.querySelector('#follow-up-proposal-scheduled-at')).not.toBeNull();
      await fillReason(dialog);
      await confirm(dialog);
      // Explicit date still required on the fallback path: no silent request.
      expect(dialog.textContent).toContain('Takip tarihi ve saati zorunludur.');
      expect(submitBody()).toBeNull();
      const dateInput = dialog.querySelector<HTMLInputElement>('#follow-up-proposal-scheduled-at')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(dateInput.constructor.prototype, 'value')
          ?.set?.call(dateInput, '2026-08-09T10:00');
        dateInput.dispatchEvent(new Event('input', { bubbles: true }));
        await flush();
      });
      await confirm(dialog);
      const body = submitBody();
      expect(body).not.toBeNull();
      expect(typeof body.followUpProposal.scheduledAt).toBe('string');
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});
