/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeAll, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';

const mockListConversations = vi.fn();
const mockListMessages = vi.fn();
const mockGetUnread = vi.fn();
const mockListRecipients = vi.fn();
const mockCreate = vi.fn();
const mockListJobCards = vi.fn();
const mockListCustomers = vi.fn();

vi.mock('../src/services/messaging-api', () => ({
  listConversations: (...a: any[]) => mockListConversations(...a),
  listMessages: (...a: any[]) => mockListMessages(...a),
  getUnreadCount: (...a: any[]) => mockGetUnread(...a),
  listRecipients: (...a: any[]) => mockListRecipients(...a),
  markRead: vi.fn(),
  sendMessage: vi.fn(),
  createOrGetConversation: (...a: any[]) => mockCreate(...a),
}));

vi.mock('../src/jobs/jobs-api', () => ({
  listJobCards: (...a: any[]) => mockListJobCards(...a),
  getJobCard: vi.fn(),
}));

vi.mock('../src/services/crm-api', () => ({
  listCustomers: (...a: any[]) => mockListCustomers(...a),
}));

vi.mock('../src/realtime/RealtimeProvider', () => ({
  useRealtimeInvalidation() { return () => {}; },
}));

import { MessagingPage } from '../src/messaging/MessagingPage';

beforeAll(() => {
  window.matchMedia = ((q: string) => ({ matches: false, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() {} })) as any;
  (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => { vi.clearAllMocks(); });

const user = { id: 'admin-1', organizationId: 'org-1', name: 'Admin', email: 'a@t.t', role: 'ADMIN' as const, mustChangePassword: false, isActive: true, version: 1, capabilities: { overviewDashboard: true, calendar: true, messaging: true }, support: { displayLabel: '', email: null, helpUrl: null } };
const staffUser = { ...user, id: 'staff-1', name: 'Staff', role: 'STAFF' as const };

function conv(overrides: Partial<ReturnType<typeof base>> & { id: string }) {
  return { ...base(overrides.id), ...overrides };
}
function base(id: string) {
  return {
    id, directKey: 'a:b:GENERAL', contextType: 'GENERAL' as const, jobId: null, jobTitle: null,
    customerId: null, customerName: null, title: null,
    participantName: 'U' + id.slice(0, 4), participantId: 'o', participantIsActive: true,
    participants: [], unreadCount: 0, lastActivityAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
}

function render(userArg = user) {
  const c = document.createElement('div'); document.body.appendChild(c);
  const r = createRoot(c);
  act(() => { r.render(<MemoryRouter initialEntries={['/messages']}><MessagingPage user={userArg} /></MemoryRouter>); });
  return { container: c, root: r, unmount: () => { r.unmount(); c.remove(); } };
}

async function tick(ms = 50) { await act(async () => { await new Promise(r => setTimeout(r, ms)); }); }

const emptyList = { items: [], nextCursor: null };

describe('Messaging M4 context-first creation flow', () => {
  it('1: ADMIN sees "Yeni konuşma" and opening it asks "Ne hakkında konuşacaksınız?"', async () => {
    mockListConversations.mockResolvedValue(emptyList);
    mockGetUnread.mockResolvedValue(0);
    const { container, unmount } = render();
    await tick();
    const newBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Yeni konuşma') as HTMLElement;
    expect(newBtn).toBeDefined();
    await act(async () => { newBtn.click(); await new Promise(r => setTimeout(r, 10)); });
    expect(container.textContent).toContain('Ne hakkında konuşacaksınız?');
    expect(container.textContent).toContain('İş');
    expect(container.textContent).toContain('Müşteri');
    expect(container.textContent).toContain('Genel konu');
    expect(container.textContent).not.toContain('Direkt mesaj');
    unmount();
  });

  it('2: STAFF has no creation action', async () => {
    mockListConversations.mockResolvedValue(emptyList);
    mockGetUnread.mockResolvedValue(0);
    const { container, unmount } = render(staffUser);
    await tick();
    const createButtons = Array.from(container.querySelectorAll('button')).filter(b => b.textContent?.includes('Yeni konuşma'));
    expect(createButtons.length).toBe(0);
    expect(container.textContent).not.toContain('Ne hakkında konuşacaksınız?');
    unmount();
  });

  it('3: JOB flow has a Job selector, no freeform title, and submits jobId + assigned Staff', async () => {
    mockListConversations
      .mockResolvedValueOnce(emptyList)
      .mockResolvedValueOnce({ items: [conv({ id: 'conv-job', contextType: 'JOB', jobId: 'job-1', jobTitle: 'Diş ünitesi teslimi', participants: [{ userId: 'admin-1', name: 'Admin', isActive: true }, { userId: 'staff-2', name: 'Ayşe Yılmaz', isActive: true }] })], nextCursor: null });
    mockGetUnread.mockResolvedValue(0);
    mockListRecipients.mockResolvedValue([]);
    mockListJobCards.mockResolvedValue({ items: [
      { id: 'job-1', title: 'Diş ünitesi teslimi', status: 'ACCEPTED', type: 'GENERAL_TASK', version: 1,
        priority: 'normal', dueDate: null, scheduledAt: null, scheduledEndsAt: null, engagementKind: null,
        createdAt: '', updatedAt: '', staffCompletedAt: null,
        customer: { id: 'cust-1', name: 'Klinik A' }, contact: null,
        assignee: { id: 'staff-2', name: 'Ayşe Yılmaz' }, deliveryItemCount: 0, allowedCommands: [] },
    ], nextCursor: null });
    mockCreate.mockResolvedValue(conv({ id: 'conv-job', contextType: 'JOB', jobId: 'job-1', jobTitle: 'Diş ünitesi teslimi', participants: [{ userId: 'admin-1', name: 'Admin', isActive: true }, { userId: 'staff-2', name: 'Ayşe Yılmaz', isActive: true }] }));
    mockListMessages.mockResolvedValue({ items: [], nextCursor: null });
    const { container, unmount } = render();
    await tick();
    const newBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Yeni konuşma') as HTMLElement;
    await act(async () => { newBtn.click(); await new Promise(r => setTimeout(r, 10)); });

    const titleInputs = Array.from(container.querySelectorAll('input')).filter(i => i.placeholder?.toLowerCase().includes('konu'));
    expect(titleInputs.length).toBe(0);

    await tick();
    const jobOption = Array.from(container.querySelectorAll('.create-option')).find(o => o.textContent?.includes('Diş ünitesi teslimi')) as HTMLElement;
    expect(jobOption).toBeDefined();
    await act(async () => { jobOption.click(); await new Promise(r => setTimeout(r, 10)); });

    const submit = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Konuşmayı başlat') as HTMLElement;
    await act(async () => { submit.click(); await new Promise(r => setTimeout(r, 10)); });

    expect(mockCreate).toHaveBeenCalledWith({
      contextType: 'JOB',
      jobId: 'job-1',
      participantUserIds: ['staff-2'],
    });
    expect(container.textContent).toContain('Diş ünitesi teslimi');
    unmount();
  });

  it('4: JOB flow requires a Job selection', async () => {
    mockListConversations.mockResolvedValue(emptyList);
    mockGetUnread.mockResolvedValue(0);
    mockListJobCards.mockResolvedValue({ items: [], nextCursor: null });
    const { container, unmount } = render();
    await tick();
    const newBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Yeni konuşma') as HTMLElement;
    await act(async () => { newBtn.click(); await new Promise(r => setTimeout(r, 10)); });
    await tick();
    const submit = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Konuşmayı başlat') as HTMLElement;
    await act(async () => { submit.click(); await new Promise(r => setTimeout(r, 10)); });
    expect(container.textContent).toContain('İş seçin');
    expect(mockCreate).not.toHaveBeenCalled();
    unmount();
  });

  it('5: CUSTOMER flow submits customer, title and multiple participants', async () => {
    mockListConversations
      .mockResolvedValueOnce(emptyList)
      .mockResolvedValueOnce({ items: [conv({ id: 'conv-cust', contextType: 'CUSTOMER', customerId: 'cust-1', customerName: 'Klinik A', title: 'Yeni cihaz demo', participants: [{ userId: 'admin-1', name: 'Admin', isActive: true }, { userId: 'staff-2', name: 'Ayşe Yılmaz', isActive: true }, { userId: 'staff-3', name: 'Mehmet Kaya', isActive: true }] })], nextCursor: null });
    mockGetUnread.mockResolvedValue(0);
    mockListRecipients.mockResolvedValue([
      { id: 'staff-2', name: 'Ayşe Yılmaz', role: 'STAFF', isActive: true },
      { id: 'staff-3', name: 'Mehmet Kaya', role: 'STAFF', isActive: true },
    ]);
    mockListCustomers.mockResolvedValue({ items: [{ id: 'cust-1', name: 'Klinik A' }], nextCursor: null });
    mockCreate.mockResolvedValue(conv({ id: 'conv-cust', contextType: 'CUSTOMER', customerId: 'cust-1', customerName: 'Klinik A', title: 'Yeni cihaz demo', participants: [{ userId: 'admin-1', name: 'Admin', isActive: true }, { userId: 'staff-2', name: 'Ayşe Yılmaz', isActive: true }, { userId: 'staff-3', name: 'Mehmet Kaya', isActive: true }] }));
    mockListMessages.mockResolvedValue({ items: [], nextCursor: null });
    const { container, unmount } = render();
    await tick();
    const newBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Yeni konuşma') as HTMLElement;
    await act(async () => { newBtn.click(); await new Promise(r => setTimeout(r, 10)); });

    const ctxButtons = Array.from(container.querySelectorAll('.create-context-option')) as HTMLElement[];
    const customerCtx = ctxButtons.find(b => b.textContent === 'Müşteri') as HTMLElement;
    await act(async () => { customerCtx.click(); await new Promise(r => setTimeout(r, 10)); });
    await tick();

    const custOption = Array.from(container.querySelectorAll('.create-option')).find(o => o.textContent?.includes('Klinik A')) as HTMLElement;
    await act(async () => { custOption.click(); await new Promise(r => setTimeout(r, 10)); });

    const titleInput = Array.from(container.querySelectorAll('input')).find(i => i.placeholder?.includes('Konu')) as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(titleInput, 'Yeni cihaz demo');
      titleInput.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 10));
    });

    await act(async () => { (Array.from(container.querySelectorAll('.participant-option'))[0] as HTMLElement).click(); await new Promise(r => setTimeout(r, 10)); });
    await act(async () => { (Array.from(container.querySelectorAll('.participant-option'))[1] as HTMLElement).click(); await new Promise(r => setTimeout(r, 10)); });

    const submit = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Konuşmayı başlat') as HTMLElement;
    await act(async () => { submit.click(); await new Promise(r => setTimeout(r, 10)); });

    expect(mockCreate).toHaveBeenCalledWith({
      contextType: 'CUSTOMER',
      customerId: 'cust-1',
      title: 'Yeni cihaz demo',
      participantUserIds: ['staff-2', 'staff-3'],
    });
    expect(container.textContent).toContain('Yeni cihaz demo');
    unmount();
  });

  it('6: CUSTOMER flow validates topic and participants', async () => {
    mockListConversations.mockResolvedValue(emptyList);
    mockGetUnread.mockResolvedValue(0);
    mockListRecipients.mockResolvedValue([{ id: 'staff-2', name: 'Ayşe Yılmaz', role: 'STAFF', isActive: true }]);
    mockListCustomers.mockResolvedValue({ items: [{ id: 'cust-1', name: 'Klinik A' }], nextCursor: null });
    const { container, unmount } = render();
    await tick();
    const newBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Yeni konuşma') as HTMLElement;
    await act(async () => { newBtn.click(); await new Promise(r => setTimeout(r, 10)); });
    const customerCtx = Array.from(container.querySelectorAll('.create-context-option')).find(b => b.textContent === 'Müşteri') as HTMLElement;
    await act(async () => { customerCtx.click(); await new Promise(r => setTimeout(r, 10)); });
    await tick();
    const custOption = Array.from(container.querySelectorAll('.create-option')).find(o => o.textContent?.includes('Klinik A')) as HTMLElement;
    await act(async () => { custOption.click(); await new Promise(r => setTimeout(r, 10)); });
    const submit = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Konuşmayı başlat') as HTMLElement;
    await act(async () => { submit.click(); await new Promise(r => setTimeout(r, 10)); });
    expect(container.textContent).toContain('Konu yazın');
    expect(container.textContent).toContain('En az bir katılımcı seçin');
    expect(mockCreate).not.toHaveBeenCalled();
    unmount();
  });

  it('7: GENERAL flow requires topic and submits titled conversation (no titleless path)', async () => {
    mockListConversations.mockResolvedValue(emptyList);
    mockGetUnread.mockResolvedValue(0);
    mockListRecipients.mockResolvedValue([{ id: 'staff-2', name: 'Ayşe Yılmaz', role: 'STAFF', isActive: true }]);
    mockCreate.mockResolvedValue(conv({ id: 'conv-gen', contextType: 'GENERAL', title: 'Ay sonu toplantı', participants: [{ userId: 'admin-1', name: 'Admin', isActive: true }, { userId: 'staff-2', name: 'Ayşe Yılmaz', isActive: true }] }));
    mockListMessages.mockResolvedValue({ items: [], nextCursor: null });
    const { container, unmount } = render();
    await tick();
    const newBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Yeni konuşma') as HTMLElement;
    await act(async () => { newBtn.click(); await new Promise(r => setTimeout(r, 10)); });
    const generalCtx = Array.from(container.querySelectorAll('.create-context-option')).find(b => b.textContent === 'Genel konu') as HTMLElement;
    await act(async () => { generalCtx.click(); await new Promise(r => setTimeout(r, 10)); });
    await tick();

    const submit = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Konuşmayı başlat') as HTMLElement;
    await act(async () => { submit.click(); await new Promise(r => setTimeout(r, 10)); });
    expect(container.textContent).toContain('Konu yazın');
    expect(mockCreate).not.toHaveBeenCalled();

    const titleInput = Array.from(container.querySelectorAll('input')).find(i => i.placeholder?.includes('Konu')) as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(titleInput, 'Ay sonu toplantı');
      titleInput.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 10));
    });
    await act(async () => { (Array.from(container.querySelectorAll('.participant-option'))[0] as HTMLElement).click(); await new Promise(r => setTimeout(r, 10)); });
    await act(async () => { submit.click(); await new Promise(r => setTimeout(r, 10)); });

    expect(mockCreate).toHaveBeenCalledWith({
      contextType: 'GENERAL',
      title: 'Ay sonu toplantı',
      participantUserIds: ['staff-2'],
    });
    unmount();
  });
});
