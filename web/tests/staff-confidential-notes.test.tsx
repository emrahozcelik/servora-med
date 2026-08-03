/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StaffConfidentialNotesSection } from '../src/StaffConfidentialNotes';
import { RealtimeProvider, type RealtimeEventSource } from '../src/realtime/RealtimeProvider';
import { ApiError, type CurrentUser } from '../src/services/api';
import type { StaffConfidentialNote, StaffConfidentialNotePage } from '../src/services/staff-confidential-notes-api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const api = vi.hoisted(() => ({
  listStaffConfidentialNotes: vi.fn(),
  createStaffConfidentialNote: vi.fn(),
}));

vi.mock('../src/services/staff-confidential-notes-api', () => api);

const admin: CurrentUser = {
  id: 'admin-1', organizationId: 'org-1', name: 'Admin', email: 'admin@example.com', role: 'ADMIN',
  mustChangePassword: false, isActive: true, version: 1,
  capabilities: { overviewDashboard: true, calendar: false, messaging: false },
  support: { displayLabel: 'Destek', email: null, helpUrl: null },
};
const manager: CurrentUser = { ...admin, id: 'manager-1', role: 'MANAGER' };
const staff: CurrentUser = { ...admin, id: 'staff-1', role: 'STAFF' };

const emptyPage: StaffConfidentialNotePage = { items: [], total: 0, limit: 10, offset: 0 };
const savedNote: StaffConfidentialNote = {
  id: 'note-1', organizationId: 'org-1', staffUserId: 'staff-1', authorUserId: 'admin-1',
  authorName: 'Admin', body: 'Performans takibi sürüyor.', createdAt: '2026-08-03T10:00:00.000Z',
};

class FakeEventSource implements RealtimeEventSource {
  readonly listeners = new Map<string, Set<EventListener>>();
  addEventListener(type: string, listener: EventListener) {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: EventListener) { this.listeners.get(type)?.delete(listener); }
  close() {}
  emit(type: string, data: string) {
    this.listeners.get(type)?.forEach((listener) => listener(new MessageEvent(type, { data })));
  }
}

function change(id: string, resourceKeys: string[]) {
  return JSON.stringify({
    id, type: 'confidential-note.created', entity: { type: 'confidential-note', id: 'note-9' },
    resourceKeys, occurredAt: '2026-08-03T10:00:00.000Z',
  });
}

describe('StaffConfidentialNotesSection visibility', () => {
  it('renders for an ADMIN', () => {
    api.listStaffConfidentialNotes.mockResolvedValue(emptyPage);
    const html = renderToStaticMarkup(<StaffConfidentialNotesSection staffUserId="staff-1" actor={admin} />);
    expect(html).toContain('Gizli yönetim notları');
    expect(html).toContain('yalnız yönetim rolleri');
  });

  it('renders for a MANAGER', () => {
    api.listStaffConfidentialNotes.mockResolvedValue(emptyPage);
    const html = renderToStaticMarkup(<StaffConfidentialNotesSection staffUserId="staff-1" actor={manager} />);
    expect(html).toContain('Gizli yönetim notları');
  });
});

describe('StaffConfidentialNotesSection in profile views', () => {
  it('never mounts the section for STAFF profile detail (no DOM leakage)', async () => {
    const { StaffProfileEditView } = await import('../src/StaffProfiles');
    const profile = {
      id: 'profile-1',
      user: { id: 'staff-1', organizationId: 'org-1', name: 'Ayşe', email: 'staff@example.com', role: 'STAFF',
        mustChangePassword: false, isActive: true, version: 2, lastLoginAt: null, createdAt: '', updatedAt: '' },
      title: null, phone: null, region: null, managerUserId: 'manager-1', managerName: 'Murat', version: 1,
      counters: { open: 0, waitingApproval: 0, revisionRequested: 0, completedThisMonth: 0, overdue: 0 },
    };
    const staffActor = { ...staff };
    const html = renderToStaticMarkup(
      <StaffProfileEditView profile={profile as never} actor={staffActor as never} managers={[]}
        onBack={() => {}} onChanged={() => {}} />,
    );
    expect(html).not.toContain('Gizli yönetim notları');
    expect(html).not.toContain('confidential-note');
    expect(html).not.toContain('confidential-notes');
  });

  it('mounts the section for an ADMIN viewing a staff profile', () => {
    const html = renderToStaticMarkup(
      <StaffConfidentialNotesSection staffUserId="staff-1" actor={admin} />,
    );
    expect(html).toContain('Gizli yönetim notları');
  });
});

describe('StaffConfidentialNotesSection states', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    api.listStaffConfidentialNotes.mockReset();
    api.createStaffConfidentialNote.mockReset();
    api.listStaffConfidentialNotes.mockResolvedValue(emptyPage);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  async function renderSection(actor: CurrentUser = admin) {
    await act(async () => {
      root.render(<StaffConfidentialNotesSection staffUserId="staff-1" actor={actor} />);
    });
    await act(async () => {});
  }

  it('shows loading then empty states', async () => {
    let resolveList: (value: StaffConfidentialNotePage) => void = () => {};
    api.listStaffConfidentialNotes.mockReturnValue(new Promise((resolve) => { resolveList = resolve; }));
    await act(async () => {
      root.render(<StaffConfidentialNotesSection staffUserId="staff-1" actor={admin} />);
    });
    expect(host.textContent).toContain('Gizli notlar yükleniyor');
    await act(async () => { resolveList(emptyPage); });
    await act(async () => {});
    expect(host.textContent).toContain('Not bulunmuyor');
    expect(host.textContent).toContain('henüz gizli yönetim notu yok');
  });

  it('shows error state with retry that recovers', async () => {
    api.listStaffConfidentialNotes
      .mockRejectedValueOnce(new ApiError(500, 'SERVER_ERROR', 'Sunucu hatası.', true))
      .mockResolvedValueOnce({ items: [savedNote], total: 1, limit: 10, offset: 0 });
    await renderSection();
    expect(host.textContent).toContain('Gizli notlar yüklenemedi');
    expect(host.textContent).toContain('Tekrar dene');
    const retry = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Tekrar dene') as HTMLButtonElement;
    await act(async () => retry.click());
    await act(async () => {});
    expect(host.textContent).toContain('Performans takibi sürüyor.');
  });

  it('lists saved notes with author and date', async () => {
    api.listStaffConfidentialNotes.mockResolvedValue({ items: [savedNote], total: 1, limit: 10, offset: 0 });
    await renderSection();
    expect(host.textContent).toContain('Performans takibi sürüyor.');
    expect(host.textContent).toContain('Ekleyen: Admin');
  });

  it('creates a note successfully and refetches the list', async () => {
    api.createStaffConfidentialNote.mockResolvedValue(savedNote);
    const list = api.listStaffConfidentialNotes
      .mockResolvedValueOnce(emptyPage)
      .mockResolvedValueOnce({ items: [savedNote], total: 1, limit: 10, offset: 0 });
    await renderSection();
    const textarea = host.querySelector('textarea') as HTMLTextAreaElement;
    const form = host.querySelector('form') as HTMLFormElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, 'Yeni gizli not');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(api.createStaffConfidentialNote).toHaveBeenCalledWith(
      'staff-1', { clientActionId: expect.any(String), body: 'Yeni gizli not' },
    );
    expect(list).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain('Gizli not eklendi.');
  });

  it('re-enables the form after a successful create and resets body and actionRef', async () => {
    let resolveCreate: (value: StaffConfidentialNote) => void = () => {};
    api.createStaffConfidentialNote.mockReturnValue(new Promise((resolve) => { resolveCreate = resolve; }));
    api.listStaffConfidentialNotes
      .mockResolvedValueOnce(emptyPage)
      .mockResolvedValueOnce({ items: [savedNote], total: 1, limit: 10, offset: 0 });
    await renderSection();
    const textarea = host.querySelector('textarea') as HTMLTextAreaElement;
    const form = host.querySelector('form') as HTMLFormElement;
    const button = host.querySelector('button[type="submit"]') as HTMLButtonElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, 'İlk not');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(button.textContent).toBe('Ekleniyor…');
    expect(textarea.disabled).toBe(true);
    await act(async () => { resolveCreate(savedNote); });
    await act(async () => {});
    expect(button.textContent).toBe('Not ekle');
    expect(button.disabled).toBe(false);
    expect(textarea.disabled).toBe(false);
    expect(textarea.value).toBe('');
    expect(host.textContent).toContain('Gizli not eklendi.');
    expect(host.textContent).toContain('Performans takibi sürüyor.');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, 'İkinci not');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(api.createStaffConfidentialNote).toHaveBeenCalledTimes(2);
    const first = api.createStaffConfidentialNote.mock.calls[0]![1].clientActionId;
    const second = api.createStaffConfidentialNote.mock.calls[1]![1].clientActionId;
    expect(first).not.toBe(second);
  });

  it('does not strand pending state when realtime invalidation arrives before the POST resolves', async () => {
    let resolveCreate: (value: StaffConfidentialNote) => void = () => {};
    api.createStaffConfidentialNote.mockReturnValue(new Promise((resolve) => { resolveCreate = resolve; }));
    const list = api.listStaffConfidentialNotes
      .mockReset()
      .mockResolvedValueOnce(emptyPage)
      .mockResolvedValue({ items: [savedNote], total: 1, limit: 10, offset: 0 });
    const source = new FakeEventSource();
    await act(async () => {
      root.render(
        <RealtimeProvider eventSourceFactory={() => source}>
          <StaffConfidentialNotesSection staffUserId="staff-1" actor={manager} />
        </RealtimeProvider>,
      );
    });
    await act(async () => {});
    const textarea = host.querySelector('textarea') as HTMLTextAreaElement;
    const form = host.querySelector('form') as HTMLFormElement;
    const button = host.querySelector('button[type="submit"]') as HTMLButtonElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, 'Hızlı not');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(button.textContent).toBe('Ekleniyor…');
    expect(button.disabled).toBe(true);
    const callsBeforeInvalidation = list.mock.calls.length;
    await act(async () => {
      source.emit('servora.change', change('1', ['staff-confidential-notes:staff-1']));
    });
    expect(list.mock.calls.length).toBeGreaterThan(callsBeforeInvalidation);
    await act(async () => { resolveCreate(savedNote); });
    await act(async () => {});
    expect(button.textContent).toBe('Not ekle');
    expect(button.disabled).toBe(false);
    expect(textarea.disabled).toBe(false);
    expect(textarea.value).toBe('');
    expect(host.textContent).toContain('Gizli not eklendi.');
    expect(host.textContent).toContain('Performans takibi sürüyor.');
  });

  it('rejects an empty note with validation feedback and no API call', async () => {
    await renderSection();
    const form = host.querySelector('form') as HTMLFormElement;
    await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await act(async () => {});
    expect(api.createStaffConfidentialNote).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Not boş olamaz.');
  });

  it('keeps the same clientActionId across retries, releases the form, and resets after success', async () => {
    const create = api.createStaffConfidentialNote
      .mockRejectedValueOnce(new ApiError(409, 'ACTION_IN_PROGRESS', 'Aynı işlem halen devam ediyor.'))
      .mockResolvedValueOnce(savedNote);
    await renderSection();
    const textarea = host.querySelector('textarea') as HTMLTextAreaElement;
    const form = host.querySelector('form') as HTMLFormElement;
    const button = host.querySelector('button[type="submit"]') as HTMLButtonElement;
    const submit = async () => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, 'tekrar denemeli');
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await Promise.resolve();
      });
    };
    await submit();
    expect(create).toHaveBeenCalledTimes(1);
    expect(button.textContent).toBe('Not ekle');
    expect(button.disabled).toBe(false);
    expect(textarea.disabled).toBe(false);
    expect(host.textContent).toContain('Aynı işlem halen devam ediyor.');
    await submit();
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0]![1].clientActionId).toBe(create.mock.calls[1]![1].clientActionId);
    expect(textarea.value).toBe('');
    expect(host.textContent).toContain('Gizli not eklendi.');
  });

  it('pages through notes with Önceki / Daha fazla göster', async () => {
    const notes = Array.from({ length: 15 }, (_, index) => ({
      ...savedNote, id: `note-${index}`, body: `Not ${index}`,
      createdAt: `2026-08-03T09:${String(index).padStart(2, '0')}:00.000Z`,
    }));
    const list = api.listStaffConfidentialNotes
      .mockReset()
      .mockResolvedValueOnce({ items: notes.slice(0, 10), total: 15, limit: 10, offset: 0 })
      .mockResolvedValueOnce({ items: notes.slice(10), total: 15, limit: 10, offset: 10 })
      .mockResolvedValueOnce({ items: notes.slice(0, 10), total: 15, limit: 10, offset: 0 });
    await renderSection();
    const bodies = () => [...host.querySelectorAll('.confidential-note-body')].map((el) => el.textContent);
    expect(bodies()).toEqual(notes.slice(0, 10).map((note) => note.body));
    const next = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Daha fazla göster') as HTMLButtonElement;
    await act(async () => next.click());
    await act(async () => {});
    expect(list).toHaveBeenCalledWith('staff-1', { limit: 10, offset: 10 });
    expect(bodies()).toEqual(notes.slice(10).map((note) => note.body));
    const previous = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Önceki') as HTMLButtonElement;
    await act(async () => previous.click());
    await act(async () => {});
    expect(list).toHaveBeenCalledWith('staff-1', { limit: 10, offset: 0 });
    expect(bodies()).toEqual(notes.slice(0, 10).map((note) => note.body));
  });

  it('renders long Turkish content without overflow-sensitive markup issues', async () => {
    const longBody = 'İstanbul Anadolu Yakası klinik ziyaretlerinde satış temsilcisinin güncelleme '
      + 'disipliniyle ilgili gözlemler; ürün eğitimi tekrarı önerilir. '.repeat(30);
    api.listStaffConfidentialNotes.mockResolvedValue({
      items: [{ ...savedNote, body: longBody }], total: 1, limit: 10, offset: 0,
    });
    await renderSection();
    const listItem = host.querySelector('.confidential-note-body') as HTMLElement;
    expect(listItem).toBeTruthy();
    expect(listItem.style).toBeTruthy();
    expect(host.textContent).toContain('disipliniyle');
  });

  it('refetches the current page when a confidential-note realtime change arrives', async () => {
    const list = api.listStaffConfidentialNotes
      .mockResolvedValueOnce(emptyPage)
      .mockResolvedValue({ items: [savedNote], total: 1, limit: 10, offset: 0 });
    const source = new FakeEventSource();
    await act(async () => {
      root.render(
        <RealtimeProvider eventSourceFactory={() => source}>
          <StaffConfidentialNotesSection staffUserId="staff-1" actor={manager} />
        </RealtimeProvider>,
      );
    });
    await act(async () => {});
    expect(list).toHaveBeenCalledTimes(1);
    await act(async () => {
      source.emit('servora.change', change('1', ['staff-confidential-notes:staff-1']));
    });
    await act(async () => {});
    expect(list).toHaveBeenCalledTimes(2);
  });
});
