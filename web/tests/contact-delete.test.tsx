/** @vitest-environment jsdom */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ContactDetailView } from '../src/ContactManagement';
import type { CurrentUser } from '../src/services/api';
import type { Contact } from '../src/services/crm-api';

const admin: CurrentUser = { id: 'admin-1', organizationId: 'org-1', name: 'Admin', email: 'a@a.com', role: 'ADMIN', mustChangePassword: false, isActive: true, version: 1, capabilities: { overviewDashboard: true, calendar: true, messaging: true }, support: { displayLabel: 'Destek', email: null, helpUrl: null } };
const manager: CurrentUser = { ...admin, id: 'manager-1', role: 'MANAGER' };
const staff: CurrentUser = { ...admin, id: 'staff-1', role: 'STAFF' };

const baseContact: Contact = { id: 'contact-1', organizationId: 'org-1', customerId: 'customer-1', name: 'Dr. Ayşe', title: 'Doktor', phone: null, email: null, isPrimary: false, isActive: true, version: 1 };

describe('Contact delete UI', () => {
  it('ADMIN pristine shows Kalıcı olarak sil', () => {
    const pristine = { ...baseContact, hasOperationHistory: false };
    const html = renderToStaticMarkup(<ContactDetailView contact={pristine} customerName="Klinik" pending={false} error="" notice="" user={admin} canManage onBack={() => {}} onSave={() => {}} onMakePrimary={() => {}} />);
    expect(html).toContain('Kalıcı olarak sil');
    expect(html).toContain('Kalıcı silme');
  });

  it('ADMIN pristine primary also shows delete', () => {
    const primaryPristine = { ...baseContact, isPrimary: true, hasOperationHistory: false };
    const html = renderToStaticMarkup(<ContactDetailView contact={primaryPristine} customerName="Klinik" pending={false} error="" notice="" user={admin} canManage onBack={() => {}} onSave={() => {}} onMakePrimary={() => {}} />);
    expect(html).toContain('Kalıcı olarak sil');
  });

  it('ADMIN referenced is non-actionable with explanation', () => {
    const referenced = { ...baseContact, hasOperationHistory: true };
    const html = renderToStaticMarkup(<ContactDetailView contact={referenced} customerName="Klinik" pending={false} error="" notice="" user={admin} canManage onBack={() => {}} onSave={() => {}} onMakePrimary={() => {}} />);
    expect(html).toContain('Bu kişi operasyon geçmişinde kullanıldığı');
    // no actionable delete button
    expect(html.match(/Kalıcı olarak sil/g) ?? []).toHaveLength(0);
    // ensure blocked section not showing button
    expect(html).not.toMatch(/<button[^>]*>Kalıcı olarak sil<\/button>/);
  });

  it('MANAGER pristine does not show permanent delete', () => {
    const pristine = { ...baseContact, hasOperationHistory: false };
    const html = renderToStaticMarkup(<ContactDetailView contact={pristine} customerName="Klinik" pending={false} error="" notice="" user={manager} canManage onBack={() => {}} onSave={() => {}} onMakePrimary={() => {}} />);
    expect(html).not.toContain('Kalıcı olarak sil');
  });

  it('STAFF does not show permanent delete', () => {
    const pristine = { ...baseContact, hasOperationHistory: false };
    const html = renderToStaticMarkup(<ContactDetailView contact={pristine} customerName="Klinik" pending={false} error="" notice="" user={staff} canManage={false} onBack={() => {}} onSave={() => {}} onMakePrimary={() => {}} />);
    expect(html).not.toContain('Kalıcı olarak sil');
  });

  it('confirmation copy is correct', () => {
    const pristine = { ...baseContact, hasOperationHistory: false };
    const html = renderToStaticMarkup(<ContactDetailView contact={pristine} customerName="Klinik" pending={false} error="" notice="" user={admin} canManage deletePending={false} deleteConfirmOpen onBack={() => {}} onSave={() => {}} onMakePrimary={() => {}} onDelete={() => {}} onDeleteConfirmOpenChange={() => {}} />);
    // ConfirmationAction renders dialog only when open; check title prop via rendered output?
    // Since ConfirmationAction renders dialog when open, we check that our ContactDetailView includes the confirmation title when open
    // Actually ConfirmationAction is rendered inside ContactDetailView when canDelete true and onDelete present
    expect(html).toContain('İletişim kişisi kalıcı olarak silinsin mi?');
  });
});
