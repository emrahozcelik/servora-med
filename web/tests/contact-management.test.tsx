/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ContactCreateForm, ContactDetailView, ContactListView, contactFieldsFromFormData,
  contactMutationErrorMessage } from '../src/ContactManagement';
import { ApiError } from '../src/services/api';
import type { Contact } from '../src/services/crm-api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const primary: Contact = { id: 'contact-1', organizationId: 'org-1', customerId: 'customer-1', name: 'Dr. Ayşe',
  title: 'Doktor', phone: '05000000000', email: null, isPrimary: true, isActive: true, version: 2 };
const secondary: Contact = { ...primary, id: 'contact-2', name: 'Selin Ak', title: 'Sekreter', isPrimary: false, version: 1 };
const inactiveSecondary: Contact = { ...secondary, id: 'contact-3', name: 'Pasif Kişi', isActive: false };

describe('Contact management', () => {
  it('renders loading, empty, retryable error, and structured ready states without open/status chrome', () => {
    expect(renderToStaticMarkup(<ContactListView state={{ kind: 'loading' }} canManage={false} onRetry={() => {}} onCreate={() => {}} />)).toContain('aria-busy="true"');
    expect(renderToStaticMarkup(<ContactListView state={{ kind: 'ready', contacts: [] }} canManage onRetry={() => {}} onCreate={() => {}} />)).toContain('Henüz ilgili kişi yok');
    const error = renderToStaticMarkup(<ContactListView state={{ kind: 'error', message: 'Yüklenemedi.', retryable: true }} canManage onRetry={() => {}} onCreate={() => {}} />);
    expect(error).toContain('role="alert"'); expect(error).toContain('Tekrar dene');
    const ready = renderToStaticMarkup(<MemoryRouter><ContactListView state={{ kind: 'ready', contacts: [primary, secondary] }} canManage
      onRetry={() => {}} onCreate={() => {}} /></MemoryRouter>);
    expect(ready).toContain('Dr. Ayşe'); expect(ready).toContain('Birincil kişi'); expect(ready).toContain('Selin Ak');
    expect(ready).toContain('contact-title-link');
    expect(ready).toContain('contact-list-card');
    expect(ready).not.toContain('Kaydı aç');
    expect(ready).not.toContain('Aktif');
    expect(ready).not.toContain('Pasif');
    expect(ready).not.toContain('customer-notes');
  });

  it('keeps title links for Staff read-only viewers', () => {
    const ready = renderToStaticMarkup(<MemoryRouter><ContactListView state={{ kind: 'ready', contacts: [primary] }} canManage={false}
      onRetry={() => {}} onCreate={() => {}} /></MemoryRouter>);
    expect(ready).toContain('contact-title-link');
    expect(ready).toContain('/customers/customer-1/contacts/contact-1');
    expect(ready).not.toContain('İlgili kişi ekle');
  });

  it('separates editable fields from primary command without lifecycle actions', () => {
    const html = renderToStaticMarkup(<ContactDetailView contact={secondary} customerName="Demo Klinik" pending={false}
      error="" notice="" onBack={() => {}} onSave={() => {}} onMakePrimary={() => {}} />);
    expect(html).toContain('İlgili kişi bilgileri'); expect(html).toContain('Bilgileri kaydet');
    expect(html).toContain('Birincil kişi yap');
    expect(html).not.toContain('İlgili kişiyi pasifleştir');
    expect(html).not.toContain('İlgili kişiyi aktifleştir');
    expect(html).not.toMatch(/name="isPrimary"/); expect(html).not.toMatch(/name="isActive"/);
  });

  it('hides primary command for inactive contacts', () => {
    const html = renderToStaticMarkup(<ContactDetailView contact={inactiveSecondary} customerName="Demo Klinik" pending={false}
      error="" notice="" onBack={() => {}} onSave={() => {}} onMakePrimary={() => {}} />);
    expect(html).not.toContain('Birincil kişi yap');
    expect(html).not.toContain('Birincil kişi</h2>');
  });

  it('builds Contact PATCH data without lifecycle fields', () => {
    const data = new FormData(); data.set('name', ' Selin Ak '); data.set('title', 'Satın Alma'); data.set('isPrimary', 'true');
    expect(contactFieldsFromFormData(data, 3)).toEqual({ expectedVersion: 3, name: 'Selin Ak', title: 'Satın Alma', phone: null, email: null });
  });

  it('maps version conflicts to actionable copy', () => {
    expect(contactMutationErrorMessage(new ApiError(409, 'VERSION_CONFLICT', 'Güncel değil.'))).toContain('formdaki değişiklikleriniz korunuyor');
  });

  it('blocks stale resubmission behind reload and keeps a permanent focus target for make-primary', () => {
    const html = renderToStaticMarkup(<ContactDetailView contact={secondary} customerName="Demo Klinik" pending={false}
      error="Kayıt güncellendi." notice="" conflict onBack={() => {}} onSave={() => {}}
      onMakePrimary={() => {}} onReloadCurrent={() => {}} />);
    expect(html).toContain('value="Selin Ak"'); expect(html).toContain('Güncel değerleri yükle');
    expect(html).toMatch(/class="record-section record-commands"[^>]*tabindex="-1"/);
  });

  it('moves focus into the inline Contact form when it opens', () => {
    const html = renderToStaticMarkup(<ContactCreateForm pending={false} error="" onCancel={() => {}} onSubmit={() => {}} />);
    expect(html).toContain('autofocus=""');
  });
});

describe('Contact list card interaction', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function renderList(canManage: boolean, onOpenContact = vi.fn()) {
    await act(async () => root.render(
      <MemoryRouter>
        <ContactListView
          state={{ kind: 'ready', contacts: [secondary] }}
          canManage={canManage}
          onRetry={() => {}}
          onCreate={() => {}}
          onOpenContact={onOpenContact}
        />
      </MemoryRouter>,
    ));
    return onOpenContact;
  }

  it('opens contact detail from empty card area for managers', async () => {
    const onOpenContact = await renderList(true);
    const card = container.querySelector('.contact-list-card') as HTMLElement;
    const title = container.querySelector('.contact-title-link') as HTMLAnchorElement;
    expect(title.getAttribute('href')).toBe('/customers/customer-1/contacts/contact-2');
    expect(card.getAttribute('tabindex')).toBeNull();

    await act(async () => card.click());
    expect(onOpenContact).toHaveBeenCalledWith('customer-1', 'contact-2');

    onOpenContact.mockClear();
    await act(async () => title.click());
    expect(onOpenContact).not.toHaveBeenCalled();
  });

  it('opens contact detail from empty card area for staff viewers', async () => {
    const onOpenContact = await renderList(false);
    expect(container.querySelector('.contact-title-link')).toBeTruthy();
    await act(async () => (container.querySelector('.contact-list-card') as HTMLElement).click());
    expect(onOpenContact).toHaveBeenCalledWith('customer-1', 'contact-2');
  });
});
