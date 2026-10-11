import { useEffect, useRef, useState, type FormEvent } from 'react';

import { CustomerEnrichmentForm } from '../CustomerEnrichmentForm';
import { customerMutationErrorMessage, enrichmentFieldsFromFormData } from '../CustomerDetail';
import { ApiError, type CurrentUser } from '../services/api';
import {
  createEnrichmentContact, enrichCustomer, getCustomer, getCustomerCompleteness,
  getCustomerEnrichmentScope, type CustomerDetail, type CustomerEnrichmentScope, type MissingInfoCode,
} from '../services/crm-api';
import { isTrPhoneMaskComplete, formatTrPhone } from '../ui/phone';
import { PhoneInput } from '../ui/PhoneInput';
import type { JobCard } from './jobs-api';

const missingInfoGuidance: Record<MissingInfoCode, string> = {
  CUSTOMER_PHONE_MISSING: 'Müşterinin telefon numarası eksik.',
  ACTIVE_CONTACT_MISSING: 'Müşterinin aktif ilgili kişisi yok.',
  CONTACT_PHONE_MISSING: 'Aktif ilgili kişilerin telefon numarası eksik.',
};

type ReadyCompletenessState = {
  kind: 'ready'; customerId: string; scope: CustomerEnrichmentScope; missingInfo: MissingInfoCode[];
};
type CompletenessState = ReadyCompletenessState
  | { kind: 'loading'; previous?: ReadyCompletenessState }
  | { kind: 'error'; previous?: ReadyCompletenessState };

/**
 * Slice 3: advisory, capability-gated customer-completeness action shown on a
 * STAFF-owned SALES_MEETING after SUBMIT_FOR_APPROVAL. It never blocks the
 * JobCard: capability loss hides the action; a revoked mid-edit authorization
 * fails closed with a message while the JobCard stays readable.
 */
export function CustomerCompletenessAction({ job, user, disabled = false }: {
  job: JobCard; user: CurrentUser; disabled?: boolean;
}) {
  const customerId = job.customerId;
  const applicable = job.type === 'SALES_MEETING' && job.status === 'WAITING_APPROVAL'
    && user.role === 'STAFF' && customerId !== null;
  const [state, setState] = useState<CompletenessState>({ kind: 'loading' });
  const [loadKey, setLoadKey] = useState(0);
  const [editing, setEditing] = useState(false);
  const [customer, setCustomer] = useState<CustomerDetail | null>(null);
  const [editorLoading, setEditorLoading] = useState(false);
  const [editorError, setEditorError] = useState('');
  const [editorNotice, setEditorNotice] = useState('');
  const [pending, setPending] = useState(false);
  const [contactPending, setContactPending] = useState(false);
  const [contactError, setContactError] = useState('');
  const contactCreateRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!applicable || customerId === null) return;
    let cancelled = false;
    setState((current) => {
      const previous = current.kind === 'ready' ? current : current.previous;
      return { kind: 'loading', previous: previous?.customerId === customerId ? previous : undefined };
    });
    Promise.all([
      getCustomerEnrichmentScope(customerId),
      getCustomerCompleteness(customerId),
    ]).then(([scope, completeness]) => {
      if (cancelled) return;
      setState({ kind: 'ready', customerId, scope, missingInfo: completeness.missingInfo });
    }).catch(() => {
      if (!cancelled) setState((current) => ({
        kind: 'error', previous: current.kind === 'ready' ? current : current.previous,
      }));
    });
    return () => { cancelled = true; };
  }, [applicable, customerId, loadKey]);

  if (!applicable) return null;

  function revokeScope() {
    setState((current) => current.kind === 'ready'
      ? { ...current, scope: { canEnrich: false, canCreateContact: false } }
      : current);
  }

  async function openEditor() {
    if (customerId === null || editorLoading) return;
    setEditing(true); setEditorError(''); setEditorNotice(''); setEditorLoading(true);
    try {
      setCustomer(await getCustomer(customerId));
    } catch (caught) {
      setEditorError(caught instanceof Error ? caught.message : 'Müşteri bilgileri yüklenemedi.');
    } finally {
      setEditorLoading(false);
    }
  }

  function closeEditor() {
    setEditing(false); setEditorError(''); setEditorNotice(''); setContactError('');
  }

  async function saveEnrichment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (customerId === null || customer === null || pending
      || state.kind !== 'ready' || state.customerId !== customerId || customer.id !== customerId
      || !state.scope.canEnrich) return;
    setPending(true); setEditorError(''); setEditorNotice('');
    try {
      const updated = await enrichCustomer(customerId,
        enrichmentFieldsFromFormData(new FormData(event.currentTarget), customer.version));
      setCustomer({ ...customer, ...updated });
      setEditorNotice('İletişim bilgileri kaydedildi.');
      setLoadKey((value) => value + 1);
    } catch (caught) {
      if (caught instanceof ApiError && (caught.status === 403 || caught.code === 'FORBIDDEN')) {
        setEditorError('Bu işlem için yetkiniz bulunmuyor.');
        revokeScope();
      } else {
        setEditorError(customerMutationErrorMessage(caught));
        if (caught instanceof ApiError && caught.code === 'VERSION_CONFLICT') {
          try { setCustomer(await getCustomer(customerId)); } catch { /* keep the conflict message */ }
          setLoadKey((value) => value + 1);
        }
      }
    } finally {
      setPending(false);
    }
  }

  async function createContact() {
    if (customerId === null || customer === null || contactPending
      || state.kind !== 'ready' || state.customerId !== customerId || customer.id !== customerId
      || !state.scope.canCreateContact) return;
    const read = (id: string) => contactCreateRef.current
      ?.querySelector<HTMLInputElement>(`#${id}`)?.value.trim() ?? '';
    const name = read('job-completeness-contact-name');
    if (!name) { setContactError('Ad soyad zorunludur.'); return; }
    setContactPending(true); setContactError('');
    try {
      const result = await createEnrichmentContact(customerId, {
        name,
        title: read('job-completeness-contact-title') || null,
        phone: read('job-completeness-contact-phone') || null,
        email: read('job-completeness-contact-email').toLowerCase() || null,
        expectedVersion: customer.version,
      });
      setCustomer((current) => current === null
        ? current
        : {
            ...current, ...result.customer,
            contacts: [...current.contacts, result.contact],
          });
      setEditorNotice('İlgili kişi eklendi.');
      setLoadKey((value) => value + 1);
    } catch (caught) {
      if (caught instanceof ApiError && (caught.status === 403 || caught.code === 'FORBIDDEN')) {
        setContactError('Bu işlem için yetkiniz bulunmuyor.');
        revokeScope();
      } else {
        setContactError(customerMutationErrorMessage(caught));
        if (caught instanceof ApiError && caught.code === 'VERSION_CONFLICT' && customerId !== null) {
          try { setCustomer(await getCustomer(customerId)); } catch { /* keep the conflict message */ }
          setLoadKey((value) => value + 1);
        }
      }
    } finally {
      setContactPending(false);
    }
  }

  const guidance = state.kind === 'ready' && state.missingInfo.length > 0
    ? <ul className="job-completeness-guidance">
        {state.missingInfo.map((code) => <li key={code}>{missingInfoGuidance[code]}</li>)}
      </ul>
    : null;

  if (!editing) {
    if (state.kind === 'loading') {
      return <section className="record-section job-completeness" aria-label="Müşteri bilgileri kontrolü">
        <p className="field-status">Müşteri bilgileri kontrol ediliyor…</p>
      </section>;
    }
    if (state.kind === 'error') {
      return <section className="record-section job-completeness" aria-label="Müşteri bilgileri kontrolü">
        <div className="form-error" role="alert">Müşteri bilgileri durumu alınamadı.
          <button className="secondary-button compact-button" type="button" disabled={disabled}
            onClick={() => setLoadKey((value) => value + 1)}>Tekrar dene</button></div>
      </section>;
    }
    const actionable = (state.scope.canEnrich || state.scope.canCreateContact)
      && state.missingInfo.length > 0;
    if (!actionable) return null;
    return <section className="record-section job-completeness" aria-labelledby="job-completeness-title">
      <h2 id="job-completeness-title">Müşteri bilgilerini tamamla</h2>
      {guidance}
      <button className="primary-button compact-button" type="button" disabled={disabled}
        onClick={() => { void openEditor(); }}>Müşteri bilgilerini tamamla</button>
    </section>;
  }

  const activeContactsWithoutPhone = customer === null ? [] : customer.contacts.filter((contact) =>
    contact.isActive && !isTrPhoneMaskComplete(formatTrPhone(contact.phone)));
  const showContactList = state.kind === 'ready'
    && state.missingInfo.includes('CONTACT_PHONE_MISSING');
  // Retain mounted drafts during GET refresh; only fresh ready scope authorizes a POST.
  const editorScope = state.kind === 'ready' ? state.scope : state.previous?.scope;
  const showEnrichmentForm = customer !== null && customer.id === customerId && editorScope?.canEnrich;

  return <section className="record-section job-completeness" aria-labelledby="job-completeness-title">
    <h2 id="job-completeness-title">Müşteri bilgilerini tamamla</h2>
    {guidance}
    {editorLoading && <p className="field-status">Müşteri bilgileri yükleniyor…</p>}
    {editorError && <div className="form-error" role="alert">{editorError}</div>}
    {editorNotice && <div className="detail-feedback" role="status">{editorNotice}</div>}
    {state.kind === 'loading' && <p className="field-status" role="status">Müşteri bilgileri kontrol ediliyor…</p>}
    {state.kind === 'error' && <div className="form-error" role="alert">Müşteri bilgileri durumu alınamadı.
      <button className="secondary-button compact-button" type="button" disabled={disabled}
        onClick={() => setLoadKey((value) => value + 1)}>Tekrar dene</button></div>}
    {showContactList && activeContactsWithoutPhone.length > 0 && (
      <div className="job-completeness-contacts">
        <h3>Telefonu bulunmayan aktif ilgili kişiler</h3>
        <ul>
          {activeContactsWithoutPhone.map((contact) => (
            <li key={contact.id}>{contact.name}{contact.title ? ` — ${contact.title}` : ''}</li>
          ))}
        </ul>
      </div>
    )}
    {customer !== null && showEnrichmentForm && (
      <CustomerEnrichmentForm
        key={`${customer.id}:${customer.version}`}
        customer={customer}
        pending={pending}
        blocked={state.kind !== 'ready'}
        unavailable={state.kind !== 'ready'}
        onSave={(event) => { void saveEnrichment(event); }}
        onCancel={closeEditor}
      />
    )}
    {customer !== null && customer.id === customerId && editorScope?.canCreateContact && (
      <div className="job-completeness-contact-create" ref={contactCreateRef}
        role="group" aria-label="Yeni ilgili kişi ekle">
        <h3>Yeni ilgili kişi ekle</h3>
        <fieldset disabled={contactPending || state.kind !== 'ready'}
          onKeyDown={(event) => {
            if (event.key === 'Enter') { event.preventDefault(); void createContact(); }
          }}>
          <label className="field-group" htmlFor="job-completeness-contact-name">Ad soyad
            <input id="job-completeness-contact-name" autoComplete="name" /></label>
          <label className="field-group" htmlFor="job-completeness-contact-title">Ünvan
            <input id="job-completeness-contact-title" /></label>
          <label className="field-group" htmlFor="job-completeness-contact-phone">Telefon
            <PhoneInput id="job-completeness-contact-phone" name="job-completeness-contact-phone" /></label>
          <label className="field-group" htmlFor="job-completeness-contact-email">E-posta
            <input id="job-completeness-contact-email" type="email" autoComplete="email" /></label>
        </fieldset>
        {contactError && <div className="form-error" role="alert">{contactError}</div>}
        <div className="form-actions">
          <button className="secondary-button compact-button" type="button" disabled={contactPending || state.kind !== 'ready'}
            onClick={() => { setContactError(''); void createContact(); }}>
            {contactPending ? 'Ekleniyor…' : 'İlgili kişiyi ekle'}
          </button>
        </div>
      </div>
    )}
    {state.kind === 'ready' && !state.scope.canEnrich && !state.scope.canCreateContact && (
      <div className="form-error" role="alert">Bu işlem için yetkiniz bulunmuyor.</div>
    )}
    {!showEnrichmentForm && (
      <div className="form-actions">
        <button className="secondary-button compact-button" type="button" onClick={closeEditor}>Kapat</button>
      </div>
    )}
  </section>;
}
