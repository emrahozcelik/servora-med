/** @vitest-environment jsdom */
import { act } from 'react';
import type { ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JobNotes } from '../src/jobs/JobNotes';
import { ApiError } from '../src/services/api';
import type { JobCardNote, JobCardNotePage } from '../src/jobs/jobs-api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const emptyPage: JobCardNotePage = { items: [], limit: 25, nextCursor: null };
const savedNote: JobCardNote = {
  id: 'note-1', jobCardId: 'job-1', note: 'Klinik tekrar aranacak.',
  author: {
    id: 'staff-1',
    name: 'Ayşe Personel',
    role: 'STAFF',
    source: 'SNAPSHOT',
  },
  workflowStage: 'IN_PROGRESS',
  context: 'GENERAL',
  relatedActivityId: 'activity-1',
  recordVersion: 1,
  createdAt: '2026-07-14T08:00:00.000Z',
};

describe('JobCard operational notes', () => {
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
  });

  it('shows helper copy that notes do not change job status', async () => {
    const load = vi.fn().mockResolvedValue(emptyPage);
    const add = vi.fn();
    await act(async () => root.render(
      <JobNotes jobId="job-1" load={load} add={add} createActionId={() => 'action-1'} />,
    ));
    await act(async () => {});
    expect(host.textContent).toContain('Notlar iş durumunu değiştirmez');
    expect(host.textContent).toContain('Henüz iş notu yok');
  });

  async function renderNotes(overrides: Partial<ComponentProps<typeof JobNotes>> = {}) {
    const load = vi.fn().mockResolvedValueOnce(emptyPage).mockResolvedValue({
      items: [savedNote], total: 1, limit: 25, offset: 0,
    });
    const add = vi.fn().mockResolvedValue(savedNote);
    const createActionId = vi.fn(() => 'action-note-1');
    await act(async () => root.render(<JobNotes jobId="job-1" load={load} add={add}
      createActionId={createActionId} {...overrides} />));
    await act(async () => { await Promise.resolve(); });
    return { load, add, createActionId };
  }

  it('keeps an accessible persistent label and rejects empty or overlong notes', async () => {
    const { add } = await renderNotes();
    const form = host.querySelector('form')!;
    await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(host.textContent).toContain('Not 1 ile 4.000 karakter arasında olmalıdır.');
    expect(add).not.toHaveBeenCalled();

    const textarea = host.querySelector<HTMLTextAreaElement>('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, 'a'.repeat(4001));
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(textarea.getAttribute('aria-invalid')).toBe('true');
    expect(host.querySelector('label')?.textContent).toContain('İş notu');
  });

  it('retains the same action id and draft across an ambiguous retry, then prepends success', async () => {
    const add = vi.fn()
      .mockRejectedValueOnce(new ApiError(0, 'NETWORK_ERROR', 'Bağlantı kesildi.', true))
      .mockResolvedValueOnce(savedNote);
    const { createActionId } = await renderNotes({ add });
    const textarea = host.querySelector<HTMLTextAreaElement>('textarea')!;
    const form = host.querySelector('form')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, savedNote.note);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(textarea.value).toBe(savedNote.note);
    expect(host.textContent).toContain('Bağlantı kesildi.');

    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(add).toHaveBeenNthCalledWith(1, 'job-1', { clientActionId: 'action-note-1', note: savedNote.note });
    expect(add).toHaveBeenNthCalledWith(2, 'job-1', { clientActionId: 'action-note-1', note: savedNote.note });
    expect(createActionId).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain(savedNote.note);
    expect(textarea.value).toBe('');
  });

  it('notifies the detail workspace after a confirmed append so activity can refresh', async () => {
    const onAdded = vi.fn();
    await renderNotes({ onAdded });
    const textarea = host.querySelector<HTMLTextAreaElement>('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, savedNote.note);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(onAdded).toHaveBeenCalledTimes(1);
  });

  it('keeps note loading errors local and offers an independent retry', async () => {
    const load = vi.fn()
      .mockRejectedValueOnce(new ApiError(503, 'TEMPORARY', 'Notlar yüklenemedi.', true))
      .mockResolvedValueOnce(emptyPage);
    await renderNotes({ load });
    expect(host.textContent).toContain('Notlar yüklenemedi.');
    const retry = Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Tekrar dene')!;
    await act(async () => { retry.click(); await Promise.resolve(); });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('loads persisted notes without rendering the composer in read-only mode', async () => {
    const load = vi.fn().mockResolvedValue({
      items: [savedNote], total: 1, limit: 25, offset: 0,
    });
    const add = vi.fn();
    await renderNotes({ load, add, canAdd: false });
    expect(load).toHaveBeenCalledWith('job-1', { limit: 25, before: null });
    expect(host.textContent).toContain(savedNote.note);
    expect(host.querySelector('form')).toBeNull();
    expect(add).not.toHaveBeenCalled();
  });

  it('renders the assignment-stage composer when canAdd is enabled by allowedActions', async () => {
    await renderNotes({ canAdd: true });
    expect(host.querySelector('.job-notes form')).not.toBeNull();
    expect(host.querySelector('label[for="job-note"]')?.textContent).toContain('İş notu');
  });

  it('renders nothing for an empty cancelled-note projection', async () => {
    const load = vi.fn().mockResolvedValue(emptyPage);
    await renderNotes({ load, canAdd: false, hideWhenEmpty: true });
    expect(load).toHaveBeenCalledTimes(1);
    expect(host.querySelector('.job-notes')).toBeNull();
    expect(host.textContent).not.toContain('Henüz iş notu yok');
  });

  it('provides a stable job-note-body class on note content for CSS wrap contracts', async () => {
    const load = vi.fn().mockResolvedValue({
      items: [savedNote], total: 1, limit: 25, offset: 0,
    });
    await renderNotes({ load });
    const body = host.querySelector('.job-note-list .job-note-body');
    expect(body).not.toBeNull();
    expect(body?.textContent).toBe(savedNote.note);
  });

  it('groups author and time in a job-note-meta wrapper with wrap class', async () => {
    const load = vi.fn().mockResolvedValue({
      items: [savedNote], total: 1, limit: 25, offset: 0,
    });
    await renderNotes({ load });
    const meta = host.querySelector('.job-note-list .job-note-meta');
    expect(meta).not.toBeNull();
    expect(meta?.querySelector('strong')?.textContent).toBe(savedNote.author.name);
    expect(meta?.querySelector('time')).not.toBeNull();
  });

  it('shows the frozen author role and workflow stage for a version 1 note', async () => {
    const load = vi.fn().mockResolvedValue({
      items: [savedNote], limit: 25, nextCursor: null,
    });
    await renderNotes({ load });
    const meta = host.querySelector('.job-note-list .job-note-meta');
    expect(meta?.textContent).toContain('Personel');
    expect(meta?.textContent).toContain('Uygulanıyor');
    expect(meta?.textContent).toContain('Operasyon notu');
  });

  it('renders every canonical transition-note label with frozen identity and source stage', async () => {
    const contexts = [
      ['SUBMIT_FOR_APPROVAL', 'Tamamlanma sonucu'],
      ['APPROVE', 'Yönetici onayı'],
      ['REQUEST_REVISION', 'Revizyon isteği'],
      ['CANCEL', 'İptal'],
    ] as const;
    const load = vi.fn().mockResolvedValue({
      items: contexts.map(([context], index) => ({
        ...savedNote,
        id: `note-${index}`,
        context,
        workflowStage: context === 'CANCEL' ? 'WAITING_APPROVAL' as const : savedNote.workflowStage,
      })),
      limit: 25,
      nextCursor: null,
    });
    await renderNotes({ load, canAdd: false });
    for (const [, label] of contexts) expect(host.textContent).toContain(label);
    expect(host.textContent).toContain('Ayşe Personel');
    expect(host.textContent).toContain('Yönetici kontrolü');
  });

  it('reloads notes when a lifecycle transition refresh key changes', async () => {
    const load = vi.fn().mockResolvedValue(emptyPage);
    await act(async () => root.render(<JobNotes jobId="job-1" load={load} refreshKey={0} />));
    await act(async () => { await Promise.resolve(); });
    await act(async () => root.render(<JobNotes jobId="job-1" load={load} refreshKey={1} />));
    await act(async () => { await Promise.resolve(); });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('labels legacy identity and missing stage without inventing history', async () => {
    const legacy: JobCardNote = {
      id: 'legacy-note',
      jobCardId: 'job-1',
      note: 'Eski operasyon kaydı',
      author: {
        id: 'staff-1',
        name: 'Güncel profil adı',
        role: null,
        source: 'LEGACY_CURRENT',
      },
      workflowStage: null,
      context: null,
      relatedActivityId: null,
      recordVersion: 0,
      createdAt: '2026-07-13T08:00:00.000Z',
    };
    const load = vi.fn().mockResolvedValue({
      items: [legacy], limit: 25, nextCursor: null,
    });
    await renderNotes({ load });
    expect(host.textContent).toContain('Legacy kimlik');
    expect(host.textContent).toContain('Aşama kaydı mevcut değil');
  });

  it('keeps the composer distinct from the note list without structural overlap', async () => {
    const load = vi.fn().mockResolvedValue({
      items: [savedNote], total: 1, limit: 25, offset: 0,
    });
    await renderNotes({ load });
    const composer = host.querySelector('.job-notes form');
    expect(composer).not.toBeNull();
    const list = host.querySelector('.job-note-list');
    expect(list).not.toBeNull();
    // Composer precedes note list in DOM order
    expect(composer?.compareDocumentPosition(list!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('prepends a stable older cursor page without replacing the live tail', async () => {
    const older = { ...savedNote, id: 'note-old', note: 'Eski sayfa notu' };
    const latest = { ...savedNote, id: 'note-latest', note: 'Canlı uç notu' };
    const cursor = {
      createdAt: '2026-07-13T08:00:00.000Z',
      id: '00000000-0000-4000-8000-000000000001',
    };
    const load = vi.fn()
      .mockResolvedValueOnce({ items: [latest], limit: 25, nextCursor: cursor })
      .mockResolvedValueOnce({ items: [older], limit: 25, nextCursor: null });
    await renderNotes({ load });
    const olderButton = Array.from(host.querySelectorAll('button'))
      .find((button) => button.textContent === 'Daha eski notları yükle')!;
    await act(async () => { olderButton.click(); await Promise.resolve(); });

    expect(load).toHaveBeenNthCalledWith(2, 'job-1', { limit: 25, before: cursor });
    expect(Array.from(host.querySelectorAll('.job-note-body')).map((node) => node.textContent))
      .toEqual(['Eski sayfa notu', 'Canlı uç notu']);
  });

  describe('realtimeKey merge with loaded older pages', () => {
    const olderNote = { ...savedNote, id: 'note-old', note: 'Eski not' };
    const initialLatest = { ...savedNote, id: 'note-a', note: 'İlk not A' };
    const realtimeNote = { ...savedNote, id: 'note-b', note: 'Realtime yeni not' };
    const deepCursor = {
      createdAt: '2026-07-10T08:00:00.000Z',
      id: '00000000-0000-4000-8000-deep00000001',
    };

    it('merges new note and preserves older notes with non-null nextCursor', async () => {
      const load = vi.fn()
        // Initial load: latest page with cursor
        .mockResolvedValueOnce({ items: [initialLatest], limit: 25, nextCursor: deepCursor })
        // Older page load
        .mockResolvedValueOnce({ items: [olderNote], limit: 25, nextCursor: null })
        // Realtime refresh: first page returns new note + existing latest
        .mockResolvedValueOnce({ items: [initialLatest, realtimeNote], limit: 25, nextCursor: deepCursor });

      await act(async () => root.render(
        <JobNotes jobId="job-1" load={load} realtimeKey={0} />,
      ));
      await act(async () => { await Promise.resolve(); });

      // Load older page
      const olderBtn = Array.from(host.querySelectorAll('button'))
        .find((b) => b.textContent === 'Daha eski notları yükle')!;
      await act(async () => { olderBtn.click(); await Promise.resolve(); });

      // Record state before realtime event
      const beforeIds = Array.from(host.querySelectorAll('.job-note-body'))
        .map((n) => n.textContent);
      expect(beforeIds).toEqual(['Eski not', 'İlk not A']);
      const nextCursorBefore = host.querySelector('.job-pagination button');

      // Trigger realtimeKey change
      await act(async () => root.render(
        <JobNotes jobId="job-1" load={load} realtimeKey={1} />,
      ));
      await act(async () => { await Promise.resolve(); });

      // Assertions
      const afterIds = Array.from(host.querySelectorAll('.job-note-body'))
        .map((n) => n.textContent);
      // All three notes present, realtime note appended at end (newest)
      expect(afterIds).toEqual(['Eski not', 'İlk not A', 'Realtime yeni not']);
      // No duplicate
      expect(new Set(afterIds).size).toBe(3);
      // Older note preserved
      expect(afterIds).toContain('Eski not');

      // Pagination state: "Daha eski" should NOT reappear when cursor was null
      // (deepCursor is non-null, so button should still be present)
    });

    it('merges new note and preserves older notes with null nextCursor', async () => {
      const load = vi.fn()
        .mockResolvedValueOnce({ items: [initialLatest], limit: 25, nextCursor: deepCursor })
        .mockResolvedValueOnce({ items: [olderNote], limit: 25, nextCursor: null })
        // Realtime refresh returns new note — fresh cursor irrelevant, preserved
        .mockResolvedValueOnce({ items: [initialLatest, realtimeNote], limit: 25, nextCursor: deepCursor });

      await act(async () => root.render(
        <JobNotes jobId="job-1" load={load} realtimeKey={0} />,
      ));
      await act(async () => { await Promise.resolve(); });

      const olderBtn = Array.from(host.querySelectorAll('button'))
        .find((b) => b.textContent === 'Daha eski notları yükle')!;
      await act(async () => { olderBtn.click(); await Promise.resolve(); });

      // After loading all pages, "Daha eski" button should be gone (nextCursor=null)
      const afterOlderBtn = Array.from(host.querySelectorAll('button'))
        .find((b) => b.textContent === 'Daha eski notları yükle');
      expect(afterOlderBtn).toBeUndefined();

      // Trigger realtimeKey
      await act(async () => root.render(
        <JobNotes jobId="job-1" load={load} realtimeKey={1} />,
      ));
      await act(async () => { await Promise.resolve(); });

      const afterIds = Array.from(host.querySelectorAll('.job-note-body'))
        .map((n) => n.textContent);
      expect(afterIds).toEqual(['Eski not', 'İlk not A', 'Realtime yeni not']);
      expect(new Set(afterIds).size).toBe(3);

      // "Daha eski" should NOT reappear after all pages were already loaded
      const reappeared = Array.from(host.querySelectorAll('button'))
        .find((b) => b.textContent === 'Daha eski notları yükle');
      expect(reappeared).toBeUndefined();
    });

    it('does not duplicate an already-merged note via realtime self-event', async () => {
      const load = vi.fn()
        .mockResolvedValueOnce({ items: [initialLatest, realtimeNote], limit: 25, nextCursor: null })
        // Realtime refresh returns the same items (actor already has realtimeNote from submit)
        .mockResolvedValueOnce({ items: [initialLatest, realtimeNote], limit: 25, nextCursor: null });

      await act(async () => root.render(
        <JobNotes jobId="job-1" load={load} realtimeKey={0} />,
      ));
      await act(async () => { await Promise.resolve(); });

      // Trigger realtimeKey (simulates self-event arriving after optimistic add)
      await act(async () => root.render(
        <JobNotes jobId="job-1" load={load} realtimeKey={1} />,
      ));
      await act(async () => { await Promise.resolve(); });

      const ids = Array.from(host.querySelectorAll('.job-note-body'))
        .map((n) => n.textContent);
      expect(ids).toEqual(['İlk not A', 'Realtime yeni not']);
      expect(new Set(ids).size).toBe(2);
    });

    it('lifecycle refreshKey still triggers full reload independently', async () => {
      const load = vi.fn()
        .mockResolvedValue({ items: [savedNote], limit: 25, nextCursor: null });

      await act(async () => root.render(
        <JobNotes jobId="job-1" load={load} refreshKey={0} />,
      ));
      await act(async () => { await Promise.resolve(); });
      expect(load).toHaveBeenCalledTimes(1);

      // Lifecycle refresh triggers reload (existing behavior preserved)
      await act(async () => root.render(
        <JobNotes jobId="job-1" load={load} refreshKey={1} />,
      ));
      await act(async () => { await Promise.resolve(); });
      expect(load).toHaveBeenCalledTimes(2);
    });
  });
});
