/** @vitest-environment jsdom */
import { act } from 'react';
import type { ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JobNotes } from '../src/jobs/JobNotes';
import { ApiError } from '../src/services/api';
import type { JobCardNote, Paginated } from '../src/jobs/jobs-api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const emptyPage: Paginated<JobCardNote> = { items: [], total: 0, limit: 25, offset: 0 };
const savedNote: JobCardNote = {
  id: 'note-1', jobCardId: 'job-1', note: 'Klinik tekrar aranacak.',
  author: { id: 'staff-1', name: 'Ayşe Personel' }, createdAt: '2026-07-14T08:00:00.000Z',
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
    expect(load).toHaveBeenCalledWith('job-1', { limit: 25, offset: 0 });
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

  it('returns to and reloads the first page after adding a note from a later page', async () => {
    const older = { ...savedNote, id: 'note-old', note: 'Eski sayfa notu' };
    const firstPage = { items: [{ ...savedNote, id: 'note-first', note: 'İlk sayfa notu' }], total: 30, limit: 25, offset: 0 };
    const secondPage = { items: [older], total: 30, limit: 25, offset: 25 };
    const refreshed = { items: [savedNote], total: 31, limit: 25, offset: 0 };
    const load = vi.fn()
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(secondPage)
      .mockResolvedValueOnce(refreshed);
    await renderNotes({ load });
    const next = Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Sonraki')!;
    await act(async () => { next.click(); await Promise.resolve(); });
    expect(host.textContent).toContain('Eski sayfa notu');

    const textarea = host.querySelector<HTMLTextAreaElement>('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, savedNote.note);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve(); await Promise.resolve();
    });
    expect(load).toHaveBeenLastCalledWith('job-1', { limit: 25, offset: 0 });
    expect(host.textContent).toContain(savedNote.note);
    expect(host.textContent).not.toContain('Eski sayfa notu');
  });
});
