import { useEffect, useRef, useState, type FormEvent, type MouseEvent, type RefObject } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { paths } from './paths';
import { ApiError, type CurrentUser } from './services/api';
import {
  createContact, deleteContact, getContact, getCustomer, makePrimaryContact,
  updateContact, type Contact, type ContactFields,
} from './services/crm-api';
import { createRequestGate } from './services/request-gate';
import { CompactConfirmationAction, ConfirmationAction } from './ui/antd';
import { EmptyState } from './ui/antd/EmptyState';
import { ResultState } from './ui/antd/ResultState';
import { isInteractiveTarget } from './ui/clickable-card';

export type ContactListState =
  | { kind: 'loading' }
  | { kind: 'ready'; contacts: Contact[] }
  | { kind: 'error'; message: string; retryable: boolean };

function openCardIfEmpty(
  event: MouseEvent<HTMLElement>,
  open: ((customerId: string, contactId: string) => void) | undefined,
  customerId: string,
  contactId: string,
) {
  if (!open || isInteractiveTarget(event.target)) return;
  open(customerId, contactId);
}

export function ContactListView({ state, canManage, createButtonRef, onRetry, onCreate, onOpenContact }: {
  state: ContactListState;
  canManage: boolean;
  createButtonRef?: RefObject<HTMLButtonElement | null>;
  onRetry: () => void;
  onCreate: () => void;
  onOpenContact?: (customerId: string, contactId: string) => void;
}) {
  return <section className="contact-section" aria-labelledby="contacts-title">
    <div className="section-heading"><h2 id="contacts-title">İlgili kişiler</h2>
      {canManage && <button className="secondary-button" type="button" ref={createButtonRef} onClick={onCreate}>İlgili kişi ekle</button>}</div>
    {state.kind === 'loading' && <div className="contact-loading" aria-busy="true" aria-live="polite">İlgili kişiler yükleniyor</div>}
    {state.kind === 'error' && <ResultState status="error" title="İlgili kişiler yüklenemedi" description={state.message} headingLevel={3}
      action={state.retryable ? <button className="secondary-button" type="button" onClick={onRetry}>Tekrar dene</button> : undefined}
    />}
    {state.kind === 'ready' && state.contacts.length === 0 && <EmptyState title="Henüz ilgili kişi yok"
      description={canManage ? 'İlk ilgili kişiyi ekleyin.' : undefined} headingLevel={3} />}
    {state.kind === 'ready' && state.contacts.length > 0 && <ul className="contact-list">{state.contacts.map((contact) => <li key={contact.id}>
      <article className="contact-row contact-list-card" data-contact-id={contact.id}
        onClick={(event) => openCardIfEmpty(event, onOpenContact, contact.customerId, contact.id)}>
        <div className="contact-identity">
          <div className="contact-signals">{contact.isPrimary && <span className="status" aria-label="Birincil kişi">Birincil kişi</span>}</div>
          <h3><Link className="contact-title-link" to={paths.contact(contact.customerId, contact.id)}>{contact.name}</Link></h3>
          <p>{contact.title ?? 'Görev belirtilmedi'}</p>
        </div>
      </article>
    </li>)}</ul>}
  </section>;
}

function nullable(data: FormData, name: string) { return String(data.get(name) ?? '').trim() || null; }

export function contactFieldsFromFormData(data: FormData, expectedVersion: number) {
  return { expectedVersion, name: String(data.get('name') ?? '').trim(), title: nullable(data, 'title'),
    phone: nullable(data, 'phone'), email: nullable(data, 'email') };
}

export function contactMutationErrorMessage(error: unknown) {
  if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') return 'Kayıt başka bir kullanıcı tarafından güncellendi; formdaki değişiklikleriniz korunuyor. Devam etmek için güncel değerleri yükleyin.';
  return error instanceof Error ? error.message : 'İşlem tamamlanamadı. Tekrar deneyin.';
}

export function ContactCreateForm({ pending, error, onCancel, onSubmit }: {
  pending: boolean; error: string; onCancel: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return <section className="inline-record-form" aria-labelledby="new-contact-title"><h2 id="new-contact-title">İlgili kişi ekle</h2>
    {error && <div className="form-error" role="alert">{error}</div>}
    <form onSubmit={onSubmit}><label className="field-group" htmlFor="new-contact-name">Ad soyad<input id="new-contact-name" name="name" required disabled={pending} autoFocus /></label>
      <label className="field-group" htmlFor="new-contact-title-field">Görev veya unvan<input id="new-contact-title-field" name="title" disabled={pending} /></label>
      <div className="customer-form-pair"><label className="field-group" htmlFor="new-contact-phone">Telefon<input id="new-contact-phone" name="phone" type="tel" disabled={pending} /></label>
        <label className="field-group" htmlFor="new-contact-email">E-posta<input id="new-contact-email" name="email" type="email" disabled={pending} /></label></div>
      <div className="form-actions"><button className="secondary-button" type="button" onClick={onCancel} disabled={pending}>Vazgeç</button>
        <button className="primary-button compact-button" disabled={pending}>{pending ? 'Ekleniyor…' : 'İlgili kişiyi ekle'}</button></div></form>
  </section>;
}

export function ContactDetailView({ contact, customerName, pending, error, notice, conflict = false, formRevision = 0, canManage = true, user, deletePending = false, deleteConfirmOpen = false, onDeleteConfirmOpenChange, onDelete, deleteTriggerRef, errorRef, commandsRef, onBack, onSave, onMakePrimary, onReloadCurrent }: {
  contact: Contact; customerName: string; pending: boolean; error: string; notice: string;
  conflict?: boolean; formRevision?: number;
  canManage?: boolean;
  user?: CurrentUser;
  deletePending?: boolean;
  deleteConfirmOpen?: boolean;
  onDeleteConfirmOpenChange?: (open: boolean) => void;
  onDelete?: () => void;
  deleteTriggerRef?: RefObject<HTMLButtonElement | null>;
  errorRef?: RefObject<HTMLDivElement | null>;
  commandsRef?: RefObject<HTMLElement | null>;
  onBack: () => void; onSave: (event: FormEvent<HTMLFormElement>) => void;
  onMakePrimary: (trigger: HTMLButtonElement) => void;
  onReloadCurrent?: () => void;
}) {
  const canDelete = user?.role === 'ADMIN' && contact.hasOperationHistory === false;
  const isReferenced = contact.hasOperationHistory === true;
  return <main className="customer-detail"><button className="back-link" type="button" onClick={onBack}>{customerName} kaydına dön</button>
    <div className="detail-heading"><div><p className="eyebrow">İlgili kişi</p><h1>{contact.name}</h1></div>
      <div className="record-status">{contact.isPrimary && <span className="status" aria-label="Birincil kişi">Birincil kişi</span>}</div></div>
    {error && <div className="form-error" role="alert" tabIndex={-1} ref={errorRef}>{error}</div>}{notice && <div className="success-message" role="status">{notice}</div>}
    {conflict && <div className="conflict-actions"><p>Sunucudaki güncel kaydı yüklediğinizde bu formdaki değişiklikler sıfırlanır.</p>
      <button className="secondary-button" type="button" disabled={pending} onClick={onReloadCurrent}>Güncel değerleri yükle</button></div>}
    <section className="record-section" aria-labelledby="contact-fields-title"><h2 id="contact-fields-title">İlgili kişi bilgileri</h2>
        {canManage ? <form className="record-form" key={`${contact.id}:${formRevision}`} onSubmit={onSave}><label className="field-group" htmlFor="contact-name">Ad soyad<input id="contact-name" name="name" defaultValue={contact.name} required disabled={pending} /></label>
        <label className="field-group" htmlFor="contact-title">Görev veya unvan<input id="contact-title" name="title" defaultValue={contact.title ?? ''} disabled={pending} /></label>
        <div className="customer-form-pair"><label className="field-group" htmlFor="contact-phone">Telefon<input id="contact-phone" name="phone" type="tel" defaultValue={contact.phone ?? ''} disabled={pending} /></label>
          <label className="field-group" htmlFor="contact-email">E-posta<input id="contact-email" name="email" type="email" defaultValue={contact.email ?? ''} disabled={pending} /></label></div>
        <div className="form-actions"><button className="secondary-button" type="button" onClick={onBack} disabled={pending}>Vazgeç</button>
          <button className="primary-button compact-button" type="submit" disabled={pending || conflict}>Bilgileri kaydet</button></div></form>
        : <dl className="record-facts"><div><dt>Ad soyad</dt><dd>{contact.name}</dd></div><div><dt>Görev veya unvan</dt><dd>{contact.title ?? 'Belirtilmedi'}</dd></div>
          <div><dt>Telefon</dt><dd>{contact.phone ?? 'Belirtilmedi'}</dd></div><div><dt>E-posta</dt><dd>{contact.email ?? 'Belirtilmedi'}</dd></div></dl>}
    </section>
    {canManage && contact.isActive && <section className="record-section record-commands" ref={commandsRef} tabIndex={-1} aria-labelledby="contact-commands-title"><h2 id="contact-commands-title">Birincil kişi</h2>
      {contact.isPrimary
        ? <p>Bu kayıt müşterinin varsayılan ilgili kişisidir.</p>
        : <><p>Bu komut müşterinin varsayılan ilgili kişisini değiştirir.</p>
          <div><CompactConfirmationAction
            title="Birincil kişi değiştirilsin mi?"
            description="Bu kayıt müşterinin varsayılan ilgili kişisi olur."
            triggerLabel="Birincil kişi yap"
            confirmLabel="Birincil kişi yap"
            pending={pending}
            disabled={conflict}
            onConfirm={onMakePrimary}
          /></div></>}
    </section>}
    {user?.role === 'ADMIN' && canDelete && <section className="record-section record-commands" aria-labelledby="contact-delete-title"><h2 id="contact-delete-title">Kalıcı silme</h2>
      <p>Yanlışlıkla oluşturulan kişi kaydı kalıcı olarak silinebilir. Sadece hiç kullanılmamış kişiler silinebilir.</p>
      <div><button ref={deleteTriggerRef} className="destructive-button" type="button" onClick={() => onDeleteConfirmOpenChange?.(true)} disabled={pending || deletePending}>Kalıcı olarak sil</button></div>
      {onDelete && <ConfirmationAction
        title="İletişim kişisi kalıcı olarak silinsin mi?"
        description="Bu işlem geri alınamaz. Yalnız operasyon geçmişinde kullanılmamış kişiler silinebilir."
        confirmLabel="Kalıcı olarak sil"
        pending={deletePending}
        open={deleteConfirmOpen}
        destructive
        onConfirm={onDelete}
        onCancel={() => onDeleteConfirmOpenChange?.(false)}
        returnFocusRef={deleteTriggerRef}
      />}</section>}
    {user?.role === 'ADMIN' && isReferenced && <section className="record-section" aria-labelledby="contact-delete-blocked-title"><h2 id="contact-delete-blocked-title">Kalıcı silme</h2>
      <p>Bu kişi operasyon geçmişinde kullanıldığı için kalıcı olarak silinemez. Kişiyi devre dışı bırakabilirsiniz.</p>
    </section>}
  </main>;
}

export function ContactDetailScreen({ customerId, contactId, user, canManage }: { customerId: string; contactId: string; user: CurrentUser; canManage: boolean }) {
  const navigate = useNavigate(); const [contact, setContact] = useState<Contact | null>(null); const [customerName, setCustomerName] = useState('Müşteri'); const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [conflict, setConflict] = useState(false); const [formRevision, setFormRevision] = useState(0);
  const [deletePending, setDeletePending] = useState(false); const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null); const commandsRef = useRef<HTMLElement>(null); const deleteTriggerRef = useRef<HTMLButtonElement>(null); const requestGate = useRef(createRequestGate());
  async function load() {
    const generation = requestGate.current.next(); setLoading(true); setContact(null); setError(''); setNotice(''); setConflict(false);
    try {
      const [nextContact, customer] = await Promise.all([getContact(customerId, contactId), getCustomer(customerId)]);
      if (!requestGate.current.isCurrent(generation)) return;
      setContact(nextContact); setCustomerName(customer.name); setFormRevision((revision) => revision + 1);
    } catch (caught) {
      if (requestGate.current.isCurrent(generation)) setError(caught instanceof Error ? caught.message : 'İlgili kişi yüklenemedi.');
    } finally {
      if (requestGate.current.isCurrent(generation)) setLoading(false);
    }
  }
  useEffect(() => { void load(); return () => { requestGate.current.next(); }; }, [customerId, contactId]);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  if (loading) return <main className="customer-detail" aria-busy="true"><h1>İlgili kişi yükleniyor</h1></main>;
  if (!contact) return <main className="customer-detail"><ResultState status="error" title="İlgili kişi yüklenemedi" description={error} headingLevel={1} action={<button className="secondary-button" onClick={() => void load()}>Tekrar dene</button>} /></main>;
  async function save(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (conflict) return;
    const generation = requestGate.current.current(); setPending(true); setError(''); setNotice('');
    try {
      const updated = await updateContact(customerId, contactId, contactFieldsFromFormData(new FormData(event.currentTarget), contact!.version));
      if (!requestGate.current.isCurrent(generation)) return;
      setContact(updated); setFormRevision((revision) => revision + 1); setNotice('İlgili kişi bilgileri güncellendi.');
    } catch (caught) {
      if (!requestGate.current.isCurrent(generation)) return;
      if (caught instanceof ApiError && caught.code === 'VERSION_CONFLICT') setConflict(true);
      setError(contactMutationErrorMessage(caught));
    } finally { if (requestGate.current.isCurrent(generation)) setPending(false); }
  }
  async function makePrimary(trigger: HTMLButtonElement) {
    if (conflict) return;
    const generation = requestGate.current.current(); let completed = false; setPending(true); setError(''); setNotice('');
    try {
      const result = await makePrimaryContact(customerId, contactId, contact!.version);
      if (!requestGate.current.isCurrent(generation)) return;
      setContact(result.contact); setNotice('Birincil ilgili kişi güncellendi.'); completed = true;
    } catch (caught) {
      if (!requestGate.current.isCurrent(generation)) return;
      if (caught instanceof ApiError && caught.code === 'VERSION_CONFLICT') setConflict(true);
      setError(contactMutationErrorMessage(caught));
    } finally {
      if (requestGate.current.isCurrent(generation)) {
        setPending(false);
        if (completed) window.setTimeout(() => commandsRef.current?.focus(), 0); else trigger.focus();
      }
    }
  }
  async function handleDelete() {
    if (deletePending) return;
    const generation = requestGate.current.current(); setDeletePending(true); setError(''); setNotice('');
    try {
      await deleteContact(customerId, contactId, contact!.version);
      setNotice('İlgili kişi kalıcı olarak silindi.');
      setDeleteConfirmOpen(false);
      navigate(paths.customer(customerId));
    } catch (caught) {
      if (!requestGate.current.isCurrent(generation)) return;
      const err = caught as ApiError;
      if (err.code === 'CONTACT_HAS_OPERATION_HISTORY') {
        setError('Bu kişi operasyon geçmişinde kullanıldığı için kalıcı olarak silinemez.');
        setContact((prev) => prev ? { ...prev, hasOperationHistory: true } : prev);
        setDeleteConfirmOpen(false);
      } else if (err.code === 'VERSION_CONFLICT') {
        setConflict(true);
        setError('İlgili kişi başka bir kullanıcı tarafından güncellendi.');
        setDeleteConfirmOpen(false);
        void load();
      } else {
        setError(err.message ?? 'İlgili kişi silinemedi.');
      }
    } finally {
      if (requestGate.current.isCurrent(generation)) setDeletePending(false);
    }
  }
  return <ContactDetailView contact={contact} customerName={customerName} pending={pending} error={error} notice={notice} conflict={conflict} formRevision={formRevision} canManage={canManage} user={user} deletePending={deletePending} deleteConfirmOpen={deleteConfirmOpen} onDeleteConfirmOpenChange={setDeleteConfirmOpen} onDelete={() => void handleDelete()} deleteTriggerRef={deleteTriggerRef} errorRef={errorRef} commandsRef={commandsRef}
    onBack={() => navigate(paths.customer(customerId))} onSave={(event) => void save(event)} onMakePrimary={(trigger) => void makePrimary(trigger)}
    onReloadCurrent={() => void load()} />;
}

export async function addContact(customerId: string, data: FormData) {
  const fields: ContactFields = { name: String(data.get('name') ?? '').trim(), title: nullable(data, 'title'), phone: nullable(data, 'phone'), email: nullable(data, 'email') };
  return createContact(customerId, fields);
}
