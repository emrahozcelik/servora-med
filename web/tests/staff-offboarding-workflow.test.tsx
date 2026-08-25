/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StaffOffboardingWorkflow } from '../src/people/StaffOffboardingWorkflow';
import { ApiError } from '../src/services/api';
import type {
  ManagedUser,
  StaffOffboardingPlan,
  StaffOffboardingResponse,
  StaffProfile,
} from '../src/services/people-api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const people = vi.hoisted(() => ({
  preview: vi.fn(), listStaff: vi.fn(), execute: vi.fn(),
}));
const context = vi.hoisted(() => ({ getJobCard: vi.fn(), getCustomer: vi.fn(), getCalendarEvent: vi.fn() }));

vi.mock('../src/services/people-api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/services/people-api')>(),
  previewStaffOffboarding: (...args: unknown[]) => people.preview(...args),
  listStaff: (...args: unknown[]) => people.listStaff(...args),
  executeStaffOffboarding: (...args: unknown[]) => people.execute(...args),
}));
vi.mock('../src/jobs/jobs-api', () => ({ getJobCard: (...args: unknown[]) => context.getJobCard(...args) }));
vi.mock('../src/services/crm-api', () => ({ getCustomer: (...args: unknown[]) => context.getCustomer(...args) }));
vi.mock('../src/services/calendar-api', () => ({ getCalendarEvent: (...args: unknown[]) => context.getCalendarEvent(...args) }));

const target: ManagedUser = { id: 'staff-1', organizationId: 'org-1', name: 'Ayşe Yılmaz', email: 'ayse@example.test',
  role: 'STAFF', mustChangePassword: false, isActive: true, version: 3, lastLoginAt: null,
  createdAt: '2026-08-01T08:00:00.000Z', updatedAt: '2026-08-01T08:00:00.000Z' };
const replacement: StaffProfile = { id: 'profile-2', user: { ...target, id: 'staff-2', name: 'Bora Kaya', email: 'bora@example.test' },
  title: 'Saha uzmanı', phone: null, region: null, managerUserId: null, managerName: null, version: 1,
  counters: { open: 0, waitingApproval: 0, revisionRequested: 0, completedThisMonth: 0, overdue: 0 } };
const plan: StaffOffboardingPlan = {
  target: { id: target.id, organizationId: target.organizationId, role: 'STAFF', isActive: true, version: target.version },
  jobs: [{ id: 'job-1', status: 'IN_PROGRESS', version: 2, assignedTo: target.id }],
  customers: [{ id: 'customer-1', assignedStaffUserId: target.id, version: 4 }],
  calendar: [{ id: 'event-1', assignedUserId: target.id, status: 'ACTIVE', version: 1,
    startsAt: '2026-09-01T08:00:00.000Z', endsAt: '2026-09-01T09:00:00.000Z' }],
  followUps: [{ jobCardId: 'job-2', proposedAssignee: target.id, proposedAt: '2026-09-03T08:00:00.000Z', version: 5 }],
  reminders: [{ id: 'reminder-1', recipientUserId: target.id, state: 'PENDING',
    remindAt: '2026-09-01T07:45:00.000Z', nextAttemptAt: '2026-09-01T07:45:00.000Z' }],
  jobConversations: [{ jobCardId: 'job-1', conversationId: 'conversation-1' }],
  sessions: { activeCount: 2 }, planHash: 'a'.repeat(64),
};
const response: StaffOffboardingResponse = { status: 'OFFBOARDED', targetUserId: target.id, planHash: plan.planHash,
  summary: { jobCardsTransferred: 1, customersReassigned: 0, customersUnassigned: 1,
    calendarAssignmentsTransferred: 1, followUpAssignmentsTransferred: 1, remindersHandled: 1 } };
const persistedRequest = {
  clientActionId: '00000000-0000-4000-8000-000000000021', planHash: plan.planHash, reasonCode: 'ACCESS_ENDED' as const,
  jobDecisions: [{ jobCardId: 'job-1', replacementUserId: 'staff-2' }],
  customerDecisions: [{ customerId: 'customer-1', action: 'UNASSIGN' as const }],
  calendarDecisions: [{ calendarEventId: 'event-1', replacementUserId: 'staff-2' }],
  followUpDecisions: [{ jobCardId: 'job-2', replacementUserId: 'staff-2' }],
  reminderDecisions: [{ reminderId: 'reminder-1', action: 'CANCEL' as const }],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

function button(container: HTMLElement, label: string) {
  const match = [...container.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === label);
  if (!match) throw new Error(`Button not found: ${label}`);
  return match as HTMLButtonElement;
}

async function choose(container: HTMLElement, name: string, value: string) {
  const select = container.querySelector(`[name="${name}"]`) as HTMLSelectElement;
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function completeDecisions(container: HTMLElement) {
  await choose(container, 'reasonCode', 'ACCESS_ENDED');
  await choose(container, 'job-job-1', 'staff-2');
  await choose(container, 'customer-action-customer-1', 'UNASSIGN');
  await choose(container, 'calendar-event-1', 'staff-2');
  await choose(container, 'follow-up-job-2', 'staff-2');
  await choose(container, 'reminder-action-reminder-1', 'CANCEL');
}

describe('Staff offboarding workflow', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    vi.clearAllMocks();
    window.sessionStorage.clear();
    people.listStaff.mockResolvedValue([replacement]);
    context.getJobCard.mockImplementation((id: string) => Promise.resolve({ id, title: id === 'job-1' ? 'Klinik teslimatı' : 'Kontrol ziyareti', status: 'IN_PROGRESS' }));
    context.getCustomer.mockResolvedValue({ id: 'customer-1', name: 'Mavi Klinik' });
    context.getCalendarEvent.mockResolvedValue({ id: 'event-1', title: 'Ürün kurulumu' });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it('loads the server preview inside the workflow and renders every authoritative responsibility', async () => {
    const pending = deferred<StaffOffboardingPlan>();
    people.preview.mockReturnValue(pending.promise);
    await act(async () => root.render(<StaffOffboardingWorkflow target={target} onCompleted={() => {}} />));

    await act(async () => button(container, 'Personeli devre dışı bırak').click());
    expect(people.preview).toHaveBeenCalledWith(target.id);
    expect(container.textContent).toContain('Sorumluluklar yükleniyor');
    expect(people.execute).not.toHaveBeenCalled();

    await act(async () => { pending.resolve(plan); await pending.promise; });
    expect(container.textContent).toContain('Klinik teslimatı');
    expect(container.textContent).toContain('Mavi Klinik');
    expect(container.textContent).toContain('Ürün kurulumu');
    expect(container.textContent).toContain('Kontrol ziyareti');
    expect(container.textContent).toContain('1 Eylül 2026');
    const summary = [...container.querySelectorAll('.offboarding-intro dl div')].map((item) => item.textContent);
    expect(summary).toEqual(['Aktif oturum2', 'İş konuşması1']);
  });

  it('keeps the drawer closed when an initial preview resolves after dismissal', async () => {
    const pending = deferred<StaffOffboardingPlan>();
    people.preview.mockReturnValue(pending.promise);
    await act(async () => root.render(<StaffOffboardingWorkflow target={target} onCompleted={() => {}} />));
    await act(async () => button(container, 'Personeli devre dışı bırak').click());

    await act(async () => (container.querySelector('.form-drawer-backdrop') as HTMLButtonElement).click());
    expect(container.querySelector('.form-drawer')).toBeNull();

    await act(async () => { pending.resolve(plan); await pending.promise; });
    expect(container.querySelector('.form-drawer')).toBeNull();
    expect(container.textContent).not.toContain('Klinik teslimatı');
  });

  it('does not partially commit a preview when dismissal occurs while context is pending', async () => {
    const pendingContext = deferred<{ id: string; title: string; status: string }>();
    people.preview.mockResolvedValue(plan);
    context.getJobCard.mockReturnValue(pendingContext.promise);
    await act(async () => root.render(<StaffOffboardingWorkflow target={target} onCompleted={() => {}} />));
    await act(async () => button(container, 'Personeli devre dışı bırak').click());
    await act(async () => { await Promise.resolve(); });

    expect(context.getJobCard).toHaveBeenCalled();
    expect(container.textContent).toContain('Sorumluluklar yükleniyor');
    expect(container.textContent).not.toContain('Aktif işler');
    await act(async () => (container.querySelector('.form-drawer-backdrop') as HTMLButtonElement).click());
    expect(container.querySelector('.form-drawer')).toBeNull();

    await act(async () => {
      pendingContext.resolve({ id: 'job-context', title: 'Gecikmiş iş', status: 'IN_PROGRESS' });
      await pendingContext.promise;
    });
    expect(container.querySelector('.form-drawer')).toBeNull();
    expect(container.textContent).not.toContain('Gecikmiş iş');
  });

  it('keeps the newest preview graph, context, and replacement options when an older load resolves late', async () => {
    const pendingA = deferred<StaffOffboardingPlan>();
    const planA = { ...plan, jobs: [{ id: 'job-a', status: 'NEW', version: 1, assignedTo: target.id }],
      customers: [], calendar: [], followUps: [], reminders: [], jobConversations: [], planHash: 'c'.repeat(64) } satisfies StaffOffboardingPlan;
    const planB = { ...plan, jobs: [{ id: 'job-b', status: 'IN_PROGRESS', version: 2, assignedTo: target.id }],
      customers: [], calendar: [], followUps: [], reminders: [], jobConversations: [], planHash: 'd'.repeat(64) } satisfies StaffOffboardingPlan;
    const replacementA = { ...replacement, id: 'profile-a', user: { ...replacement.user, id: 'staff-a', name: 'Eski Personel' } };
    const replacementB = { ...replacement, id: 'profile-b', user: { ...replacement.user, id: 'staff-b', name: 'Güncel Personel' } };
    people.preview.mockReturnValueOnce(pendingA.promise).mockResolvedValueOnce(planB);
    people.listStaff.mockResolvedValueOnce([replacementA]).mockResolvedValueOnce([replacementB]);
    context.getJobCard.mockImplementation((id: string) => Promise.resolve({ id,
      title: id === 'job-a' ? 'Eski iş' : 'Güncel iş', status: 'IN_PROGRESS' }));
    await act(async () => root.render(<StaffOffboardingWorkflow target={target} onCompleted={() => {}} />));

    await act(async () => {
      const trigger = button(container, 'Personeli devre dışı bırak');
      trigger.click();
      trigger.click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('Güncel iş');
    expect(container.textContent).toContain('Güncel Personel');
    expect(container.textContent).not.toContain('Eski Personel');

    await act(async () => { pendingA.resolve(planA); await pendingA.promise; });
    expect(container.textContent).toContain('Güncel iş');
    expect(container.textContent).toContain('Güncel Personel');
    expect(container.textContent).not.toContain('Eski iş');
    expect(container.textContent).not.toContain('Eski Personel');
    expect(container.querySelector('[name="job-job-b"]')).not.toBeNull();
    expect(container.querySelector('[name="job-job-a"]')).toBeNull();
  });

  it('ignores an older preview error after the newer preview becomes authoritative', async () => {
    const pendingA = deferred<StaffOffboardingPlan>();
    const planB = { ...plan, jobs: [{ id: 'job-b', status: 'NEW', version: 1, assignedTo: target.id }],
      customers: [], calendar: [], followUps: [], reminders: [], jobConversations: [], planHash: 'd'.repeat(64) } satisfies StaffOffboardingPlan;
    people.preview.mockReturnValueOnce(pendingA.promise).mockResolvedValueOnce(planB);
    context.getJobCard.mockResolvedValue({ id: 'job-b', title: 'Güncel iş', status: 'NEW' });
    await act(async () => root.render(<StaffOffboardingWorkflow target={target} onCompleted={() => {}} />));

    await act(async () => {
      const trigger = button(container, 'Personeli devre dışı bırak');
      trigger.click();
      trigger.click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('Güncel iş');

    await act(async () => {
      pendingA.reject(new ApiError(503, 'REQUEST_FAILED', 'Eski istek başarısız.', true));
      await pendingA.promise.catch(() => undefined);
    });
    expect(container.textContent).toContain('Güncel iş');
    expect(container.textContent).not.toContain('Sorumluluklar yüklenemedi');
    expect(container.textContent).not.toContain('Eski istek başarısız');
    expect(container.querySelector('[name="job-job-b"]')).not.toBeNull();
  });

  it('keeps a newer preview error authoritative when an older preview succeeds first', async () => {
    const pendingA = deferred<StaffOffboardingPlan>();
    const pendingB = deferred<StaffOffboardingPlan>();
    const planA = { ...plan, jobs: [{ id: 'job-a', status: 'NEW', version: 1, assignedTo: target.id }],
      customers: [], calendar: [], followUps: [], reminders: [], jobConversations: [], planHash: 'c'.repeat(64) } satisfies StaffOffboardingPlan;
    people.preview.mockReturnValueOnce(pendingA.promise).mockReturnValueOnce(pendingB.promise);
    context.getJobCard.mockResolvedValue({ id: 'job-a', title: 'Eski iş', status: 'NEW' });
    await act(async () => root.render(<StaffOffboardingWorkflow target={target} onCompleted={() => {}} />));
    await act(async () => {
      const trigger = button(container, 'Personeli devre dışı bırak');
      trigger.click();
      trigger.click();
    });

    await act(async () => { pendingA.resolve(planA); await pendingA.promise; });
    expect(container.textContent).toContain('Sorumluluklar yükleniyor');
    expect(container.textContent).not.toContain('Eski iş');

    await act(async () => {
      pendingB.reject(new ApiError(503, 'REQUEST_FAILED', 'Güncel istek başarısız.', true));
      await pendingB.promise.catch(() => undefined);
    });
    expect(container.textContent).toContain('Sorumluluklar yüklenemedi');
    expect(container.textContent).toContain('Güncel istek başarısız');
    expect(container.textContent).not.toContain('Eski iş');
  });

  it('shows a bounded recovery action when the authoritative preview fails', async () => {
    people.preview.mockRejectedValue(new ApiError(503, 'REQUEST_FAILED', 'Önizleme alınamadı.', true));
    await act(async () => root.render(<StaffOffboardingWorkflow target={target} onCompleted={() => {}} />));
    await act(async () => button(container, 'Personeli devre dışı bırak').click());
    await act(async () => { await Promise.resolve(); });

    expect(container.textContent).toContain('Sorumluluklar yüklenemedi');
    expect(container.textContent).toContain('Önizleme alınamadı');
    expect(container.textContent).toContain('Güncel durumu yeniden yükle');
    expect(people.execute).not.toHaveBeenCalled();
  });

  it('requires every decision and final confirmation, then waits for authoritative success', async () => {
    people.preview.mockResolvedValue(plan);
    const execute = deferred<StaffOffboardingResponse>();
    people.execute.mockReturnValue(execute.promise);
    const completed = vi.fn();
    const uuid = vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000001');
    await act(async () => root.render(<StaffOffboardingWorkflow target={target} onCompleted={completed} />));
    await act(async () => button(container, 'Personeli devre dışı bırak').click());
    await act(async () => { await Promise.resolve(); });

    expect(container.querySelector('textarea')).toBeNull();
    for (const label of ['Erişim artık gerekli değil', 'Rol veya sorumluluk değişikliği', 'Hesap düzeltmesi', 'Diğer idari neden']) {
      expect(container.textContent).toContain(label);
    }
    const prepare = button(container, 'Kararları onayla');
    expect(prepare.disabled).toBe(true);
    expect(uuid).not.toHaveBeenCalled();

    await completeDecisions(container);
    expect(prepare.disabled).toBe(false);

    await act(async () => prepare.click());
    expect(people.execute).not.toHaveBeenCalled();
    expect(uuid).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Personel devre dışı bırakılsın mı?');

    await act(async () => button(container, 'Erişimi sonlandır').click());
    expect(uuid).toHaveBeenCalledTimes(1);
    expect(people.execute).toHaveBeenCalledTimes(1);
    expect(people.execute.mock.calls[0][1]).toMatchObject({
      clientActionId: '00000000-0000-4000-8000-000000000001', planHash: plan.planHash,
      reasonCode: 'ACCESS_ENDED', customerDecisions: [{ customerId: 'customer-1', action: 'UNASSIGN' }],
      reminderDecisions: [{ reminderId: 'reminder-1', action: 'CANCEL' }],
    });
    expect(container.textContent).not.toContain('Personel devre dışı bırakıldı');
    expect(completed).not.toHaveBeenCalled();

    await act(async () => { execute.resolve(response); await execute.promise; });
    expect(container.textContent).toContain('Personel devre dışı bırakıldı');
    expect(completed).toHaveBeenCalledWith(response);
    expect(window.sessionStorage.getItem('servora:r4b:staff-offboarding-attempt:v1')).toBeNull();
    await act(async () => root.render(<StaffOffboardingWorkflow target={{ ...target, isActive: false }} onCompleted={completed} />));
    expect(container.textContent).toContain('Personel devre dışı bırakıldı');
    expect([...container.querySelectorAll('button')].some((entry) => entry.textContent === 'Personeli devre dışı bırak')).toBe(false);
    await act(async () => button(container, 'Tamam').click());
    expect(container.querySelector('.form-drawer')).toBeNull();
  });

  it('keeps authoritative success visible and leaves a non-executable marker when storage removal fails', async () => {
    people.preview.mockResolvedValue(plan);
    people.execute.mockResolvedValue(response);
    const completed = vi.fn();
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000010');
    vi.spyOn(Object.getPrototypeOf(window.sessionStorage) as Storage, 'removeItem')
      .mockImplementation(() => { throw new Error('storage blocked'); });
    await act(async () => root.render(<StaffOffboardingWorkflow target={target} onCompleted={completed} />));
    await act(async () => button(container, 'Personeli devre dışı bırak').click());
    await act(async () => { await Promise.resolve(); });
    await completeDecisions(container);
    await act(async () => button(container, 'Kararları onayla').click());
    await act(async () => { button(container, 'Erişimi sonlandır').click(); await Promise.resolve(); });

    expect(container.textContent).toContain('Personel devre dışı bırakıldı');
    expect(completed).toHaveBeenCalledWith(response);
    expect(JSON.parse(window.sessionStorage.getItem('servora:r4b:staff-offboarding-attempt:v1') ?? 'null')).toMatchObject({
      schemaVersion: 2,
      status: 'RETIRED',
      request: { clientActionId: '00000000-0000-4000-8000-000000000010' },
    });
    expect(container.textContent).not.toContain('İşlem sonucu henüz kesin değil');
  });

  it('allows confirmation and drawer cancellation before an execute attempt exists', async () => {
    people.preview.mockResolvedValue(plan);
    const uuid = vi.spyOn(globalThis.crypto, 'randomUUID');
    await act(async () => root.render(<StaffOffboardingWorkflow target={target} onCompleted={() => {}} />));
    await act(async () => button(container, 'Personeli devre dışı bırak').click());
    await act(async () => { await Promise.resolve(); });
    await completeDecisions(container);
    await act(async () => button(container, 'Kararları onayla').click());
    await act(async () => button(container.querySelector('.workflow-dialog') as HTMLElement, 'Vazgeç').click());

    expect(uuid).not.toHaveBeenCalled();
    expect(people.execute).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem('servora:r4b:staff-offboarding-attempt:v1')).toBeNull();
    expect(container.querySelector('.form-drawer')).not.toBeNull();

    await act(async () => button(container, 'Vazgeç').click());
    expect(container.querySelector('.form-drawer')).toBeNull();
  });

  it('creates one immutable semantic attempt when final confirmation re-enters before React rerenders', async () => {
    people.preview.mockResolvedValue(plan);
    const execute = deferred<StaffOffboardingResponse>();
    people.execute.mockReturnValue(execute.promise);
    const uuid = vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000011')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000012');
    await act(async () => root.render(<StaffOffboardingWorkflow target={target} onCompleted={() => {}} />));
    await act(async () => button(container, 'Personeli devre dışı bırak').click());
    await act(async () => { await Promise.resolve(); });
    await completeDecisions(container);
    await act(async () => button(container, 'Kararları onayla').click());

    await act(async () => {
      const confirm = button(container, 'Erişimi sonlandır');
      confirm.click();
      confirm.click();
    });

    expect(uuid).toHaveBeenCalledTimes(1);
    expect(people.execute).toHaveBeenCalledTimes(1);
    expect(people.execute.mock.calls[0][1]).toEqual({
      clientActionId: '00000000-0000-4000-8000-000000000011',
      planHash: plan.planHash,
      reasonCode: 'ACCESS_ENDED',
      jobDecisions: [{ jobCardId: 'job-1', replacementUserId: 'staff-2' }],
      customerDecisions: [{ customerId: 'customer-1', action: 'UNASSIGN' }],
      calendarDecisions: [{ calendarEventId: 'event-1', replacementUserId: 'staff-2' }],
      followUpDecisions: [{ jobCardId: 'job-2', replacementUserId: 'staff-2' }],
      reminderDecisions: [{ reminderId: 'reminder-1', action: 'CANCEL' }],
    });
    expect(JSON.parse(window.sessionStorage.getItem('servora:r4b:staff-offboarding-attempt:v1') ?? 'null')).toMatchObject({
      schemaVersion: 2,
      status: 'ACTIVE',
      targetUserId: target.id,
      request: { clientActionId: '00000000-0000-4000-8000-000000000011', planHash: plan.planHash },
    });

    await act(async () => { execute.resolve(response); await execute.promise; });
  });

  it.each([
    new ApiError(0, 'NETWORK_ERROR', 'Bağlantı kesildi.', true),
    new ApiError(504, 'REQUEST_FAILED', 'Zaman aşımı.', true),
    new ApiError(500, 'INTERNAL_ERROR', 'Sunucu yanıt vermedi.', true),
    new ApiError(0, 'INVALID_RESPONSE', 'Yanıt doğrulanamadı.'),
  ])('keeps the exact client action and request while reconciling an ambiguous result', async (ambiguousError) => {
    people.preview.mockResolvedValue(plan);
    people.execute.mockRejectedValueOnce(ambiguousError).mockResolvedValueOnce(response);
    const uuid = vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000002');
    await act(async () => root.render(<StaffOffboardingWorkflow target={target} onCompleted={() => {}} />));
    await act(async () => button(container, 'Personeli devre dışı bırak').click());
    await act(async () => { await Promise.resolve(); });
    await completeDecisions(container);
    await act(async () => button(container, 'Kararları onayla').click());
    await act(async () => { button(container, 'Erişimi sonlandır').click(); await Promise.resolve(); });

    expect(people.execute).toHaveBeenCalledTimes(2);
    expect(people.execute.mock.calls[1]).toEqual(people.execute.mock.calls[0]);
    expect(people.execute.mock.calls[0][1].clientActionId).toBe('00000000-0000-4000-8000-000000000002');
    expect(uuid).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Personel devre dışı bırakıldı');
  });

  it('keeps ACTION_IN_PROGRESS bounded and requires an explicit same-attempt confirmation', async () => {
    people.preview.mockResolvedValue(plan);
    people.execute.mockRejectedValueOnce(new ApiError(409, 'ACTION_IN_PROGRESS', 'İşlem sürüyor.')).mockResolvedValueOnce(response);
    const uuid = vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000003');
    await act(async () => root.render(<StaffOffboardingWorkflow target={target} onCompleted={() => {}} />));
    await act(async () => button(container, 'Personeli devre dışı bırak').click());
    await act(async () => { await Promise.resolve(); });
    await completeDecisions(container);
    await act(async () => button(container, 'Kararları onayla').click());
    await act(async () => { button(container, 'Erişimi sonlandır').click(); await Promise.resolve(); });

    expect(people.execute).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('İşlem sonucu henüz kesin değil');
    await act(async () => button(container, 'Aynı işlemi yeniden doğrula').click());
    expect(people.execute).toHaveBeenCalledTimes(1);
    await act(async () => { button(container, 'Erişimi sonlandır').click(); await Promise.resolve(); });
    expect(people.execute).toHaveBeenCalledTimes(2);
    expect(people.execute.mock.calls[1]).toEqual(people.execute.mock.calls[0]);
    expect(uuid).toHaveBeenCalledTimes(1);
  });

  it('keeps retry-ready attempt persisted when drawer dismissal and retry confirmation cancel are attempted', async () => {
    people.preview.mockResolvedValue(plan);
    people.execute.mockRejectedValueOnce(new ApiError(409, 'ACTION_IN_PROGRESS', 'İşlem sürüyor.')).mockResolvedValueOnce(response);
    const uuid = vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000013');
    await act(async () => root.render(<StaffOffboardingWorkflow target={target} onCompleted={() => {}} />));
    await act(async () => button(container, 'Personeli devre dışı bırak').click());
    await act(async () => { await Promise.resolve(); });
    await completeDecisions(container);
    await act(async () => button(container, 'Kararları onayla').click());
    await act(async () => { button(container, 'Erişimi sonlandır').click(); await Promise.resolve(); });

    const persistedBeforeDismiss = window.sessionStorage.getItem('servora:r4b:staff-offboarding-attempt:v1');
    await act(async () => (container.querySelector('.form-drawer-backdrop') as HTMLButtonElement).click());
    expect(container.querySelector('.form-drawer')).not.toBeNull();
    expect(window.sessionStorage.getItem('servora:r4b:staff-offboarding-attempt:v1')).toBe(persistedBeforeDismiss);
    expect(uuid).toHaveBeenCalledTimes(1);
    expect(people.execute).toHaveBeenCalledTimes(1);

    await act(async () => button(container, 'Aynı işlemi yeniden doğrula').click());
    await act(async () => button(container, 'Vazgeç').click());
    expect(container.querySelector('.form-drawer')).not.toBeNull();
    expect(window.sessionStorage.getItem('servora:r4b:staff-offboarding-attempt:v1')).toBe(persistedBeforeDismiss);

    await act(async () => button(container, 'Aynı işlemi yeniden doğrula').click());
    await act(async () => { button(container, 'Erişimi sonlandır').click(); await Promise.resolve(); });
    expect(people.execute).toHaveBeenCalledTimes(2);
    expect(people.execute.mock.calls[1]).toEqual(people.execute.mock.calls[0]);
    expect(uuid).toHaveBeenCalledTimes(1);
  });

  it('discards stale decisions, refreshes the authoritative graph, and requires a new confirmation', async () => {
    const refreshed = { ...plan,
      jobs: [{ id: 'job-3', status: 'NEW', version: 1, assignedTo: target.id }],
      planHash: 'b'.repeat(64) } satisfies StaffOffboardingPlan;
    people.preview.mockResolvedValueOnce(plan).mockResolvedValueOnce(refreshed);
    people.execute.mockRejectedValueOnce(new ApiError(409, 'STALE_PLAN', 'Plan değişti.'));
    const uuid = vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000004');
    await act(async () => root.render(<StaffOffboardingWorkflow target={target} onCompleted={() => {}} />));
    await act(async () => button(container, 'Personeli devre dışı bırak').click());
    await act(async () => { await Promise.resolve(); });
    await completeDecisions(container);
    await act(async () => button(container, 'Kararları onayla').click());
    await act(async () => { button(container, 'Erişimi sonlandır').click(); await Promise.resolve(); });

    expect(people.preview).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('Sorumluluklar veya uygun personel değişti');
    expect(container.querySelector('[name="job-job-1"]')).toBeNull();
    expect(container.querySelector('[name="job-job-3"]')).not.toBeNull();
    expect(button(container, 'Kararları onayla').disabled).toBe(true);
    expect(container.textContent).not.toContain('Personel devre dışı bırakıldı');
    expect(uuid).toHaveBeenCalledTimes(1);
  });

  it('creates a new id only after a stale attempt is discarded and the refreshed plan is reviewed', async () => {
    const refreshed = { ...plan, planHash: 'b'.repeat(64) } satisfies StaffOffboardingPlan;
    const refreshedResponse = { ...response, planHash: refreshed.planHash } satisfies StaffOffboardingResponse;
    people.preview.mockResolvedValueOnce(plan).mockResolvedValueOnce(refreshed);
    people.execute.mockRejectedValueOnce(new ApiError(409, 'STALE_PLAN', 'Plan değişti.')).mockResolvedValueOnce(refreshedResponse);
    const uuid = vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000031')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000032');
    await act(async () => root.render(<StaffOffboardingWorkflow target={target} onCompleted={() => {}} />));
    await act(async () => button(container, 'Personeli devre dışı bırak').click());
    await act(async () => { await Promise.resolve(); });
    await completeDecisions(container);
    await act(async () => button(container, 'Kararları onayla').click());
    await act(async () => { button(container, 'Erişimi sonlandır').click(); await Promise.resolve(); });

    expect(uuid).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem('servora:r4b:staff-offboarding-attempt:v1')).toBeNull();
    expect(button(container, 'Kararları onayla').disabled).toBe(true);

    await completeDecisions(container);
    await act(async () => button(container, 'Kararları onayla').click());
    expect(uuid).toHaveBeenCalledTimes(1);
    await act(async () => { button(container, 'Erişimi sonlandır').click(); await Promise.resolve(); });

    expect(uuid).toHaveBeenCalledTimes(2);
    expect(people.execute).toHaveBeenCalledTimes(2);
    expect(people.execute.mock.calls[0][1]).toMatchObject({
      clientActionId: '00000000-0000-4000-8000-000000000031', planHash: plan.planHash,
    });
    expect(people.execute.mock.calls[1][1]).toMatchObject({
      clientActionId: '00000000-0000-4000-8000-000000000032', planHash: refreshed.planHash,
    });
  });

  it('retires a stale attempt and fails closed when its local recovery record cannot be removed', async () => {
    people.preview.mockResolvedValue(plan);
    people.execute.mockRejectedValueOnce(new ApiError(409, 'STALE_PLAN', 'Plan değişti.'));
    const uuid = vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000034');
    vi.spyOn(Object.getPrototypeOf(window.sessionStorage) as Storage, 'removeItem')
      .mockImplementation(() => { throw new Error('storage blocked'); });
    await act(async () => root.render(<StaffOffboardingWorkflow target={target} onCompleted={() => {}} />));
    await act(async () => button(container, 'Personeli devre dışı bırak').click());
    await act(async () => { await Promise.resolve(); });
    await completeDecisions(container);
    await act(async () => button(container, 'Kararları onayla').click());
    await act(async () => { button(container, 'Erişimi sonlandır').click(); await Promise.resolve(); });

    expect(JSON.parse(window.sessionStorage.getItem('servora:r4b:staff-offboarding-attempt:v1') ?? 'null')).toMatchObject({
      schemaVersion: 2,
      status: 'RETIRED',
      targetUserId: target.id,
      request: { clientActionId: '00000000-0000-4000-8000-000000000034' },
    });
    expect(container.textContent).toContain('İşlem durumu güvenli biçimde temizlenemedi');
    expect(container.textContent).toContain('Tekrar dene');
    expect(container.textContent).not.toContain('Aynı işlemi yeniden doğrula');
    expect(people.preview).toHaveBeenCalledTimes(1);
    expect(people.execute).toHaveBeenCalledTimes(1);
    expect(uuid).toHaveBeenCalledTimes(1);

    const protectedUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(protectedUnload);
    expect(protectedUnload.defaultPrevented).toBe(true);

    await act(async () => (container.querySelector('.form-drawer-backdrop') as HTMLButtonElement).click());
    expect(container.querySelector('.form-drawer')).not.toBeNull();
    expect(people.preview).toHaveBeenCalledTimes(1);
    expect(people.execute).toHaveBeenCalledTimes(1);
    expect(uuid).toHaveBeenCalledTimes(1);
  });

  it('retries only retired local cleanup before loading a fresh authoritative plan', async () => {
    const refreshed = { ...plan, planHash: 'b'.repeat(64) } satisfies StaffOffboardingPlan;
    people.preview.mockResolvedValueOnce(plan).mockResolvedValueOnce(refreshed);
    people.execute.mockRejectedValueOnce(new ApiError(409, 'STALE_PLAN', 'Plan değişti.'));
    const uuid = vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000035');
    vi.spyOn(Object.getPrototypeOf(window.sessionStorage) as Storage, 'removeItem')
      .mockImplementationOnce(() => { throw new Error('storage blocked'); });
    await act(async () => root.render(<StaffOffboardingWorkflow target={target} onCompleted={() => {}} />));
    await act(async () => button(container, 'Personeli devre dışı bırak').click());
    await act(async () => { await Promise.resolve(); });
    await completeDecisions(container);
    await act(async () => button(container, 'Kararları onayla').click());
    await act(async () => { button(container, 'Erişimi sonlandır').click(); await Promise.resolve(); });

    expect(container.textContent).toContain('İşlem durumu güvenli biçimde temizlenemedi');
    await act(async () => { button(container, 'Tekrar dene').click(); await Promise.resolve(); });

    expect(window.sessionStorage.getItem('servora:r4b:staff-offboarding-attempt:v1')).toBeNull();
    expect(people.preview).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('Sorumluluklar veya uygun personel değişti');
    expect(people.execute).toHaveBeenCalledTimes(1);
    expect(uuid).toHaveBeenCalledTimes(1);
    const unprotectedUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unprotectedUnload);
    expect(unprotectedUnload.defaultPrevented).toBe(false);
  });

  it('creates a distinct active attempt only after retired cleanup and fresh review complete', async () => {
    const refreshed = { ...plan, planHash: 'b'.repeat(64) } satisfies StaffOffboardingPlan;
    const secondExecution = deferred<StaffOffboardingResponse>();
    people.preview.mockResolvedValueOnce(plan).mockResolvedValueOnce(refreshed);
    people.execute.mockRejectedValueOnce(new ApiError(409, 'STALE_PLAN', 'Plan değişti.'))
      .mockReturnValueOnce(secondExecution.promise);
    const uuid = vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000037')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000038');
    vi.spyOn(Object.getPrototypeOf(window.sessionStorage) as Storage, 'removeItem')
      .mockImplementationOnce(() => { throw new Error('storage blocked'); });
    await act(async () => root.render(<StaffOffboardingWorkflow target={target} onCompleted={() => {}} />));
    await act(async () => button(container, 'Personeli devre dışı bırak').click());
    await act(async () => { await Promise.resolve(); });
    await completeDecisions(container);
    await act(async () => button(container, 'Kararları onayla').click());
    await act(async () => { button(container, 'Erişimi sonlandır').click(); await Promise.resolve(); });

    await act(async () => { button(container, 'Tekrar dene').click(); await Promise.resolve(); });
    await completeDecisions(container);
    await act(async () => button(container, 'Kararları onayla').click());
    await act(async () => button(container, 'Erişimi sonlandır').click());

    expect(uuid).toHaveBeenCalledTimes(2);
    expect(people.execute).toHaveBeenCalledTimes(2);
    expect(people.execute.mock.calls.map((call) => call[1].clientActionId)).toEqual([
      '00000000-0000-4000-8000-000000000037',
      '00000000-0000-4000-8000-000000000038',
    ]);
    expect(JSON.parse(window.sessionStorage.getItem('servora:r4b:staff-offboarding-attempt:v1') ?? 'null')).toMatchObject({
      schemaVersion: 2,
      status: 'ACTIVE',
      request: { clientActionId: '00000000-0000-4000-8000-000000000038', planHash: refreshed.planHash },
    });

    await act(async () => { secondExecution.resolve({ ...response, planHash: refreshed.planHash }); await secondExecution.promise; });
  });

  it('keeps semantic ownership retired when writing the retirement marker fails', async () => {
    people.preview.mockResolvedValue(plan);
    people.execute.mockRejectedValueOnce(new ApiError(409, 'INVALID_REPLACEMENT_STAFF', 'Personel artık uygun değil.'));
    const uuid = vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000036');
    const storagePrototype = Object.getPrototypeOf(window.sessionStorage) as Storage;
    const originalSetItem = storagePrototype.setItem;
    vi.spyOn(storagePrototype, 'setItem').mockImplementation(function (key: string, value: string) {
      if (JSON.parse(value).status === 'RETIRED') throw new Error('storage blocked');
      return originalSetItem.call(this, key, value);
    });
    await act(async () => root.render(<StaffOffboardingWorkflow target={target} onCompleted={() => {}} />));
    await act(async () => button(container, 'Personeli devre dışı bırak').click());
    await act(async () => { await Promise.resolve(); });
    await completeDecisions(container);
    await act(async () => button(container, 'Kararları onayla').click());
    await act(async () => { button(container, 'Erişimi sonlandır').click(); await Promise.resolve(); });

    expect(JSON.parse(window.sessionStorage.getItem('servora:r4b:staff-offboarding-attempt:v1') ?? 'null')).toMatchObject({
      schemaVersion: 2,
      status: 'ACTIVE',
      request: { clientActionId: '00000000-0000-4000-8000-000000000036' },
    });
    expect(container.textContent).toContain('İşlem durumu güvenli biçimde temizlenemedi');
    expect(container.textContent).not.toContain('Aynı işlemi yeniden doğrula');
    await act(async () => button(container, 'Tekrar dene').click());
    await act(async () => (container.querySelector('.form-drawer-backdrop') as HTMLButtonElement).click());
    expect(container.querySelector('.form-drawer')).not.toBeNull();
    expect(people.preview).toHaveBeenCalledTimes(1);
    expect(people.execute).toHaveBeenCalledTimes(1);
    expect(uuid).toHaveBeenCalledTimes(1);
    const protectedUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(protectedUnload);
    expect(protectedUnload.defaultPrevented).toBe(true);
  });

  it('refreshes eligible Staff and clears decisions after an invalid replacement conflict', async () => {
    people.preview.mockResolvedValue(plan);
    people.execute.mockRejectedValueOnce(new ApiError(409, 'INVALID_REPLACEMENT_STAFF', 'Personel artık uygun değil.'));
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000033');
    await act(async () => root.render(<StaffOffboardingWorkflow target={target} onCompleted={() => {}} />));
    await act(async () => button(container, 'Personeli devre dışı bırak').click());
    await act(async () => { await Promise.resolve(); });
    await completeDecisions(container);
    await act(async () => button(container, 'Kararları onayla').click());
    await act(async () => { button(container, 'Erişimi sonlandır').click(); await Promise.resolve(); });

    expect(people.preview).toHaveBeenCalledTimes(2);
    expect(people.listStaff).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('Sorumluluklar veya uygun personel değişti');
    expect(button(container, 'Kararları onayla').disabled).toBe(true);
    expect(window.sessionStorage.getItem('servora:r4b:staff-offboarding-attempt:v1')).toBeNull();
    expect(container.textContent).not.toContain('Personel devre dışı bırakıldı');
  });

  it('treats CLIENT_ACTION_REUSED as an integrity conflict and never silently generates another id', async () => {
    people.preview.mockResolvedValue(plan);
    people.execute.mockRejectedValueOnce(new ApiError(409, 'CLIENT_ACTION_REUSED', 'Kimlik tekrar kullanıldı.'));
    const uuid = vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000005');
    await act(async () => root.render(<StaffOffboardingWorkflow target={target} onCompleted={() => {}} />));
    await act(async () => button(container, 'Personeli devre dışı bırak').click());
    await act(async () => { await Promise.resolve(); });
    await completeDecisions(container);
    await act(async () => button(container, 'Kararları onayla').click());
    await act(async () => { button(container, 'Erişimi sonlandır').click(); await Promise.resolve(); });

    expect(people.preview).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('İşlem kimliği sunucu durumuyla eşleşmedi');
    expect(button(container, 'Kararları onayla').disabled).toBe(true);
    expect(uuid).toHaveBeenCalledTimes(1);
    expect(people.execute).toHaveBeenCalledTimes(1);
  });

  it('uses the same non-executable retirement path for CLIENT_ACTION_REUSED cleanup failure', async () => {
    people.preview.mockResolvedValue(plan);
    people.execute.mockRejectedValueOnce(new ApiError(409, 'CLIENT_ACTION_REUSED', 'Kimlik tekrar kullanıldı.'));
    const uuid = vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000039');
    vi.spyOn(Object.getPrototypeOf(window.sessionStorage) as Storage, 'removeItem')
      .mockImplementation(() => { throw new Error('storage blocked'); });
    await act(async () => root.render(<StaffOffboardingWorkflow target={target} onCompleted={() => {}} />));
    await act(async () => button(container, 'Personeli devre dışı bırak').click());
    await act(async () => { await Promise.resolve(); });
    await completeDecisions(container);
    await act(async () => button(container, 'Kararları onayla').click());
    await act(async () => { button(container, 'Erişimi sonlandır').click(); await Promise.resolve(); });

    expect(JSON.parse(window.sessionStorage.getItem('servora:r4b:staff-offboarding-attempt:v1') ?? 'null')).toMatchObject({
      schemaVersion: 2,
      status: 'RETIRED',
      request: { clientActionId: '00000000-0000-4000-8000-000000000039' },
    });
    expect(container.textContent).toContain('İşlem durumu güvenli biçimde temizlenemedi');
    expect(container.textContent).not.toContain('Aynı işlemi yeniden doğrula');
    expect(people.preview).toHaveBeenCalledTimes(1);
    expect(people.execute).toHaveBeenCalledTimes(1);
    expect(uuid).toHaveBeenCalledTimes(1);
  });

  it('uses a newly confirmed id after CLIENT_ACTION_REUSED discards the old persisted attempt', async () => {
    people.preview.mockResolvedValue(plan);
    people.execute.mockRejectedValueOnce(new ApiError(409, 'CLIENT_ACTION_REUSED', 'Kimlik tekrar kullanıldı.')).mockResolvedValueOnce(response);
    const uuid = vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000041')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000042');
    await act(async () => root.render(<StaffOffboardingWorkflow target={target} onCompleted={() => {}} />));
    await act(async () => button(container, 'Personeli devre dışı bırak').click());
    await act(async () => { await Promise.resolve(); });
    await completeDecisions(container);
    await act(async () => button(container, 'Kararları onayla').click());
    await act(async () => { button(container, 'Erişimi sonlandır').click(); await Promise.resolve(); });

    expect(uuid).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem('servora:r4b:staff-offboarding-attempt:v1')).toBeNull();
    await completeDecisions(container);
    await act(async () => button(container, 'Kararları onayla').click());
    expect(uuid).toHaveBeenCalledTimes(1);
    await act(async () => { button(container, 'Erişimi sonlandır').click(); await Promise.resolve(); });

    expect(uuid).toHaveBeenCalledTimes(2);
    expect(people.execute.mock.calls.map((call) => call[1].clientActionId)).toEqual([
      '00000000-0000-4000-8000-000000000041',
      '00000000-0000-4000-8000-000000000042',
    ]);
  });

  it('supports a zero-responsibility preview with only the required neutral reason', async () => {
    people.preview.mockResolvedValue({ ...plan, jobs: [], customers: [], calendar: [], followUps: [], reminders: [] });
    const uuid = vi.spyOn(globalThis.crypto, 'randomUUID');
    await act(async () => root.render(<StaffOffboardingWorkflow target={target} onCompleted={() => {}} />));
    await act(async () => button(container, 'Personeli devre dışı bırak').click());
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toContain('Aktarılması gereken aktif sorumluluk bulunmuyor.');
    expect(container.textContent).toContain('Aktif oturum2');
    expect(container.textContent).toContain('İş konuşması1');
    expect(container.textContent).not.toContain('Aktif işler');
    expect(container.querySelectorAll('select')).toHaveLength(1);
    expect(button(container, 'Kararları onayla').disabled).toBe(true);
    await choose(container, 'reasonCode', 'ACCOUNT_CORRECTION');
    expect(button(container, 'Kararları onayla').disabled).toBe(false);
    await act(async () => button(container, 'Kararları onayla').click());
    expect(container.textContent).toContain('Personel devre dışı bırakılsın mı?');
    expect(uuid).not.toHaveBeenCalled();
  });

  it('requires explicit replacements for customer reassignment and reminder transfer', async () => {
    people.preview.mockResolvedValue(plan);
    await act(async () => root.render(<StaffOffboardingWorkflow target={target} onCompleted={() => {}} />));
    await act(async () => button(container, 'Personeli devre dışı bırak').click());
    await act(async () => { await Promise.resolve(); });
    await choose(container, 'reasonCode', 'ROLE_CHANGED');
    await choose(container, 'job-job-1', 'staff-2');
    await choose(container, 'customer-action-customer-1', 'REASSIGN');
    await choose(container, 'calendar-event-1', 'staff-2');
    await choose(container, 'follow-up-job-2', 'staff-2');
    await choose(container, 'reminder-action-reminder-1', 'TRANSFER');

    expect(button(container, 'Kararları onayla').disabled).toBe(true);
    await choose(container, 'customer-replacement-customer-1', 'staff-2');
    expect(button(container, 'Kararları onayla').disabled).toBe(true);
    await choose(container, 'reminder-replacement-reminder-1', 'staff-2');
    expect(button(container, 'Kararları onayla').disabled).toBe(false);
  });

  it('restores an exact same-target attempt after unmount without previewing or generating a new id', async () => {
    window.sessionStorage.setItem('servora:r4b:staff-offboarding-attempt:v1', JSON.stringify({
      schemaVersion: 2, status: 'ACTIVE', targetUserId: target.id, request: persistedRequest,
      createdAt: '2026-08-25T12:00:00.000Z',
    }));
    people.execute.mockResolvedValue(response);
    const uuid = vi.spyOn(globalThis.crypto, 'randomUUID');

    await act(async () => root.render(<StaffOffboardingWorkflow target={target} onCompleted={() => {}} />));

    expect(container.textContent).toContain('İşlem sonucu henüz kesin değil');
    expect(container.textContent).toContain('Aynı işlemi yeniden doğrula');
    expect(people.preview).not.toHaveBeenCalled();
    expect(people.listStaff).not.toHaveBeenCalled();
    expect(uuid).not.toHaveBeenCalled();

    await act(async () => button(container, 'Aynı işlemi yeniden doğrula').click());
    await act(async () => { button(container, 'Erişimi sonlandır').click(); await Promise.resolve(); });
    expect(people.execute).toHaveBeenCalledWith(target.id, persistedRequest);
    expect(uuid).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem('servora:r4b:staff-offboarding-attempt:v1')).toBeNull();
    expect(container.textContent).toContain('Personel devre dışı bırakıldı');
  });

  it('cleans a hydrated retired attempt without executing it before loading a fresh preview', async () => {
    window.sessionStorage.setItem('servora:r4b:staff-offboarding-attempt:v1', JSON.stringify({
      schemaVersion: 2, status: 'RETIRED', targetUserId: target.id, request: persistedRequest,
      createdAt: '2026-08-25T12:00:00.000Z',
    }));
    people.preview.mockResolvedValue(plan);
    const uuid = vi.spyOn(globalThis.crypto, 'randomUUID');

    await act(async () => root.render(<StaffOffboardingWorkflow target={target} onCompleted={() => {}} />));
    await act(async () => { await Promise.resolve(); });

    expect(window.sessionStorage.getItem('servora:r4b:staff-offboarding-attempt:v1')).toBeNull();
    expect(people.preview).toHaveBeenCalledTimes(1);
    expect(people.listStaff).toHaveBeenCalledTimes(1);
    expect(people.execute).not.toHaveBeenCalled();
    expect(uuid).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('Aynı işlemi yeniden doğrula');
    expect(container.textContent).toContain('Yerel işlem kaydı temizlendi');
    const unprotectedUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unprotectedUnload);
    expect(unprotectedUnload.defaultPrevented).toBe(false);
  });

  it('recovers the same exact request after the workflow is actually unmounted and remounted', async () => {
    people.preview.mockResolvedValue(plan);
    people.execute.mockRejectedValueOnce(new ApiError(409, 'ACTION_IN_PROGRESS', 'İşlem sürüyor.')).mockResolvedValueOnce(response);
    const uuid = vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000024');
    await act(async () => root.render(<StaffOffboardingWorkflow target={target} onCompleted={() => {}} />));
    await act(async () => button(container, 'Personeli devre dışı bırak').click());
    await act(async () => { await Promise.resolve(); });
    await completeDecisions(container);
    await act(async () => button(container, 'Kararları onayla').click());
    await act(async () => { button(container, 'Erişimi sonlandır').click(); await Promise.resolve(); });
    const firstRequest = people.execute.mock.calls[0][1];

    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<StaffOffboardingWorkflow target={target} onCompleted={() => {}} />));

    expect(container.textContent).toContain('aynı kimlik ve kararlarla geri yüklendi');
    expect(people.preview).toHaveBeenCalledTimes(1);
    expect(uuid).toHaveBeenCalledTimes(1);
    await act(async () => button(container, 'Aynı işlemi yeniden doğrula').click());
    await act(async () => { button(container, 'Erişimi sonlandır').click(); await Promise.resolve(); });
    expect(people.execute.mock.calls[1][1]).toEqual(firstRequest);
    expect(uuid).toHaveBeenCalledTimes(1);
  });

  it.each(['ACTIVE', 'RETIRED'] as const)('blocks a second target while another target %s attempt remains in this tab', async (status) => {
    const stored = JSON.stringify({ schemaVersion: 2, status, targetUserId: 'staff-other', request: persistedRequest,
      createdAt: '2026-08-25T12:00:00.000Z' });
    window.sessionStorage.setItem('servora:r4b:staff-offboarding-attempt:v1', stored);
    const uuid = vi.spyOn(globalThis.crypto, 'randomUUID');

    await act(async () => root.render(<StaffOffboardingWorkflow target={target} onCompleted={() => {}} />));

    expect(container.textContent).toContain('Başka bir personel için sonuç bekleniyor');
    expect(button(container, 'Personeli devre dışı bırak').disabled).toBe(true);
    expect(people.preview).not.toHaveBeenCalled();
    expect(people.execute).not.toHaveBeenCalled();
    expect(uuid).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem('servora:r4b:staff-offboarding-attempt:v1')).toBe(stored);
  });

  it('fails closed when the unresolved recovery record is malformed', async () => {
    window.sessionStorage.setItem('servora:r4b:staff-offboarding-attempt:v1', JSON.stringify({
      schemaVersion: 1, targetUserId: target.id, request: { clientActionId: 'incomplete' },
      createdAt: '2026-08-25T12:00:00.000Z',
    }));
    const uuid = vi.spyOn(globalThis.crypto, 'randomUUID');

    await act(async () => root.render(<StaffOffboardingWorkflow target={target} onCompleted={() => {}} />));

    expect(container.textContent).toContain('Önceki işlem güvenle geri yüklenemedi');
    expect(button(container, 'Personeli devre dışı bırak').disabled).toBe(true);
    expect(people.preview).not.toHaveBeenCalled();
    expect(people.execute).not.toHaveBeenCalled();
    expect(uuid).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem('servora:r4b:staff-offboarding-attempt:v1')).not.toBeNull();
  });

  it('does not execute when the semantic attempt cannot be persisted safely', async () => {
    people.preview.mockResolvedValue(plan);
    const uuid = vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000022');
    const storage = vi.spyOn(Object.getPrototypeOf(window.sessionStorage) as Storage, 'setItem')
      .mockImplementation(() => { throw new Error('storage blocked'); });
    await act(async () => root.render(<StaffOffboardingWorkflow target={target} onCompleted={() => {}} />));
    await act(async () => button(container, 'Personeli devre dışı bırak').click());
    await act(async () => { await Promise.resolve(); });
    await completeDecisions(container);
    await act(async () => button(container, 'Kararları onayla').click());
    await act(async () => button(container, 'Erişimi sonlandır').click());

    expect(uuid).toHaveBeenCalledTimes(1);
    expect(storage).toHaveBeenCalledTimes(1);
    expect(people.execute).not.toHaveBeenCalled();
    expect(container.textContent).toContain('İşlem güvenli biçimde başlatılamadı');
    expect(container.textContent).toContain('Sunucuya istek gönderilmedi');
  });

  it('protects document unload only while the persisted attempt remains unresolved', async () => {
    people.preview.mockResolvedValue(plan);
    people.execute.mockRejectedValueOnce(new ApiError(409, 'ACTION_IN_PROGRESS', 'İşlem sürüyor.')).mockResolvedValueOnce(response);
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000023');
    await act(async () => root.render(<StaffOffboardingWorkflow target={target} onCompleted={() => {}} />));
    await act(async () => button(container, 'Personeli devre dışı bırak').click());
    await act(async () => { await Promise.resolve(); });
    await completeDecisions(container);
    await act(async () => button(container, 'Kararları onayla').click());
    await act(async () => { button(container, 'Erişimi sonlandır').click(); await Promise.resolve(); });

    const unresolvedUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unresolvedUnload);
    expect(unresolvedUnload.defaultPrevented).toBe(true);

    await act(async () => button(container, 'Aynı işlemi yeniden doğrula').click());
    await act(async () => { button(container, 'Erişimi sonlandır').click(); await Promise.resolve(); });
    const resolvedUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(resolvedUnload);
    expect(resolvedUnload.defaultPrevented).toBe(false);
  });
});
