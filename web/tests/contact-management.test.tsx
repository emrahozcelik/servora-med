import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { ContactCreateForm, ContactDetailView, ContactListView, confirmContactLifecycle, contactFieldsFromFormData,
  contactMutationErrorMessage } from '../src/ContactManagement';
import { ApiError } from '../src/services/api';
import type { Contact } from '../src/services/crm-api';

const primary: Contact = { id: 'contact-1', organizationId: 'org-1', customerId: 'customer-1', name: 'Dr. Ayşe',
  title: 'Doktor', phone: '05000000000', email: null, isPrimary: true, isActive: true, version: 2 };
const secondary: Contact = { ...primary, id: 'contact-2', name: 'Selin Ak', title: 'Sekreter', isPrimary: false, version: 1 };

describe('Contact management', () => {
  it('renders loading, empty, retryable error, and structured ready states', () => {
    expect(renderToStaticMarkup(<ContactListView state={{ kind: 'loading' }} canManage={false} onRetry={() => {}} onCreate={() => {}} />)).toContain('aria-busy="true"');
    expect(renderToStaticMarkup(<ContactListView state={{ kind: 'ready', contacts: [] }} canManage onRetry={() => {}} onCreate={() => {}} />)).toContain('Henüz ilgili kişi yok');
    const error = renderToStaticMarkup(<ContactListView state={{ kind: 'error', message: 'Yüklenemedi.', retryable: true }} canManage onRetry={() => {}} onCreate={() => {}} />);
    expect(error).toContain('role="alert"'); expect(error).toContain('Tekrar dene');
    const ready = renderToStaticMarkup(<MemoryRouter><ContactListView state={{ kind: 'ready', contacts: [primary, secondary] }} canManage
      onRetry={() => {}} onCreate={() => {}} /></MemoryRouter>);
    expect(ready).toContain('Dr. Ayşe'); expect(ready).toContain('Birincil kişi'); expect(ready).toContain('Selin Ak');
    expect(ready).not.toContain('customer-notes');
  });

  it('separates editable fields from explicit primary and lifecycle commands', () => {
    const html = renderToStaticMarkup(<ContactDetailView contact={secondary} customerName="Demo Klinik" pending={false}
      error="" notice="" onBack={() => {}} onSave={() => {}} onLifecycle={() => {}} onMakePrimary={() => {}} />);
    expect(html).toContain('İlgili kişi bilgileri'); expect(html).toContain('Bilgileri kaydet');
    expect(html).toContain('Birincil kişi yap'); expect(html).toContain('İlgili kişiyi pasifleştir');
    expect(html).not.toMatch(/name="isPrimary"/); expect(html).not.toMatch(/name="isActive"/);
  });

  it('builds Contact PATCH data without lifecycle fields', () => {
    const data = new FormData(); data.set('name', ' Selin Ak '); data.set('title', 'Satın Alma'); data.set('isPrimary', 'true');
    expect(contactFieldsFromFormData(data, 3)).toEqual({ expectedVersion: 3, name: 'Selin Ak', title: 'Satın Alma', phone: null, email: null });
  });

  it('names the Contact in confirmations and maps active-job/version conflicts', () => {
    const confirm = vi.fn().mockReturnValue(true);
    expect(confirmContactLifecycle(secondary, 'deactivate', confirm)).toBe(true);
    expect(confirm.mock.calls[0]![0]).toContain('Selin Ak'); expect(confirm.mock.calls[0]![0]).toContain('iş kartlarında seçilemez');
    expect(contactMutationErrorMessage(new ApiError(409, 'CONTACT_HAS_ACTIVE_JOB_CARDS', 'Açık iş var.'))).toContain('açık iş kartlarında');
    expect(contactMutationErrorMessage(new ApiError(409, 'VERSION_CONFLICT', 'Güncel değil.'))).toContain('formdaki değişiklikleriniz korunuyor');
  });

  it('blocks stale resubmission behind reload and keeps a permanent focus target for make-primary', () => {
    const html = renderToStaticMarkup(<ContactDetailView contact={secondary} customerName="Demo Klinik" pending={false}
      error="Kayıt güncellendi." notice="" conflict onBack={() => {}} onSave={() => {}} onLifecycle={() => {}}
      onMakePrimary={() => {}} onReloadCurrent={() => {}} />);
    expect(html).toContain('value="Selin Ak"'); expect(html).toContain('Güncel değerleri yükle');
    expect(html).toMatch(/class="record-section record-commands"[^>]*tabindex="-1"/);
  });

  it('moves focus into the inline Contact form when it opens', () => {
    const html = renderToStaticMarkup(<ContactCreateForm pending={false} error="" onCancel={() => {}} onSubmit={() => {}} />);
    expect(html).toContain('autofocus=""');
  });
});
