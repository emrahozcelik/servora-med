import { useEffect, useRef, useState, type FormEvent } from 'react';

import { listContacts, listCustomers, type Contact, type CustomerSummary } from '../services/crm-api';
import { listStaff, type StaffProfile } from '../services/people-api';
import type { CurrentUser } from '../services/api';
import { createRequestGate } from '../services/request-gate';
import type { JobCard, JobCardPriority, PatchJobCardInput } from './jobs-api';

type LoadState = 'loading' | 'ready' | 'error';
type FieldErrors = Partial<Record<'title' | 'customerId' | 'assignedTo', string>>;

async function loadAllCustomers() {
  const result: CustomerSummary[] = []; let offset = 0;
  while (true) {
    const page = await listCustomers({ status: 'active', limit: 200, offset });
    result.push(...page.items);
    if (result.length >= page.total || page.items.length === 0) return result;
    offset += page.items.length;
  }
}

async function loadAllContacts(customerId: string) {
  const result: Contact[] = []; let offset = 0;
  while (true) {
    const page = await listContacts(customerId, { status: 'active', limit: 200, offset });
    result.push(...page.items);
    if (result.length >= page.total || page.items.length === 0) return result;
    offset += page.items.length;
  }
}

export function SalesMeetingEditForm({ job, user, pending, onCancel, onSave }: {
  job: JobCard & { type: 'SALES_MEETING' }; user: CurrentUser; pending: boolean;
  onCancel: () => void; onSave: (input: PatchJobCardInput) => Promise<void>;
}) {
  const [title, setTitle] = useState(job.title);
  const [description, setDescription] = useState(job.description ?? '');
  const [priority, setPriority] = useState<JobCardPriority>(job.priority);
  const [customerId, setCustomerId] = useState(job.customerId ?? '');
  const [contactId, setContactId] = useState(job.contactId ?? '');
  const [assignedTo, setAssignedTo] = useState(job.assignedTo);
  const [customers, setCustomers] = useState<CustomerSummary[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [staff, setStaff] = useState<StaffProfile[]>([]);
  const [customerState, setCustomerState] = useState<LoadState>('loading');
  const [contactState, setContactState] = useState<LoadState>('loading');
  const [staffState, setStaffState] = useState<LoadState>(user.role === 'STAFF' ? 'ready' : 'loading');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState('');
  const errorRef = useRef<HTMLDivElement>(null);
  const contactGate = useRef(createRequestGate());

  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  useEffect(() => () => { contactGate.current.next(); }, []);
  useEffect(() => {
    void loadAllCustomers().then((items) => { setCustomers(items); setCustomerState('ready'); })
      .catch(() => { setCustomers([]); setCustomerState('error'); });
  }, []);
  useEffect(() => {
    if (user.role === 'STAFF') return;
    void listStaff('active').then((items) => {
      setStaff(items.filter((item) => item.user.isActive)); setStaffState('ready');
    }).catch(() => { setStaff([]); setStaffState('error'); });
  }, [user.role]);
  useEffect(() => {
    const generation = contactGate.current.next();
    if (!job.customerId) { setContacts([]); setContactState('ready'); return; }
    void loadAllContacts(job.customerId).then((items) => {
      if (!contactGate.current.isCurrent(generation)) return;
      setContacts(items); setContactState('ready');
    }).catch(() => {
      if (!contactGate.current.isCurrent(generation)) return;
      setContacts([]); setContactState('error');
    });
  }, [job.customerId]);

  function changeCustomer(nextCustomerId: string) {
    setCustomerId(nextCustomerId); setContactId(''); setContacts([]);
    const generation = contactGate.current.next();
    if (!nextCustomerId) { setContactState('ready'); return; }
    setContactState('loading');
    void loadAllContacts(nextCustomerId).then((items) => {
      if (!contactGate.current.isCurrent(generation)) return;
      setContacts(items); setContactState('ready');
    }).catch(() => {
      if (!contactGate.current.isCurrent(generation)) return;
      setContacts([]); setContactState('error');
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (pending) return;
    const normalizedTitle = title.trim();
    const nextErrors: FieldErrors = {};
    if (!normalizedTitle || Array.from(normalizedTitle).length > 255) {
      nextErrors.title = 'Başlık 1 ile 255 karakter arasında olmalıdır.';
    }
    if (!customerId) nextErrors.customerId = 'Aktif bir müşteri seçin.';
    if (user.role !== 'STAFF' && !assignedTo) nextErrors.assignedTo = 'Aktif bir sorumlu personel seçin.';
    setFieldErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      setError('Görüşmeyi kaydetmeden önce işaretli alanları düzeltin.'); return;
    }
    setError('');
    await onSave({
      expectedVersion: job.version, title: normalizedTitle,
      description: description.trim() || null, customerId, contactId: contactId || null,
      assignedTo: user.role === 'STAFF' ? job.assignedTo : assignedTo,
      priority,
    });
  }

  const referencesLoading = customerState !== 'ready'
    || contactState === 'loading' || (user.role !== 'STAFF' && staffState !== 'ready');
  return <section className="meeting-details" aria-labelledby="meeting-edit-title-heading">
    <h2 id="meeting-edit-title-heading">Görüşmeyi düzenle</h2>
    {error && <div ref={errorRef} className="form-error" role="alert" tabIndex={-1}>{error}</div>}
    {customerState === 'error' && <p className="field-error" role="alert">Müşteriler yüklenemedi.</p>}
    {contactState === 'error' && <p className="field-error" role="alert">İlgili kişiler yüklenemedi.</p>}
    {staffState === 'error' && <p className="field-error" role="alert">Personel listesi yüklenemedi.</p>}
    <form className="task-form" onSubmit={submit} noValidate><fieldset disabled={pending}>
      <div className="field-group"><label htmlFor="meeting-edit-title">Başlık</label>
        <input id="meeting-edit-title" value={title} maxLength={255}
          aria-invalid={fieldErrors.title ? true : undefined}
          aria-describedby={fieldErrors.title ? 'meeting-edit-title-error' : undefined}
          onChange={(event) => setTitle(event.target.value)} />
        {fieldErrors.title && <span id="meeting-edit-title-error" className="field-error">{fieldErrors.title}</span>}</div>
      <div className="field-group"><label htmlFor="meeting-edit-description">Açıklama (isteğe bağlı)</label>
        <textarea id="meeting-edit-description" rows={4} value={description}
          onChange={(event) => setDescription(event.target.value)} /></div>
      <div className="field-group"><label htmlFor="meeting-edit-customer">Müşteri</label>
        <select id="meeting-edit-customer" value={customerId} disabled={customerState !== 'ready'}
          aria-invalid={fieldErrors.customerId ? true : undefined}
          aria-describedby={fieldErrors.customerId ? 'meeting-edit-customer-error' : undefined}
          onChange={(event) => changeCustomer(event.target.value)}>
          <option value="">Seçin</option>{customers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
        {fieldErrors.customerId && <span id="meeting-edit-customer-error" className="field-error">{fieldErrors.customerId}</span>}</div>
      <div className="field-group"><label htmlFor="meeting-edit-contact">İlgili kişi (isteğe bağlı)</label>
        <select id="meeting-edit-contact" value={contactId} disabled={!customerId || contactState !== 'ready'}
          onChange={(event) => setContactId(event.target.value)}>
          <option value="">İlgili kişi seçilmedi</option>{contacts.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
      {user.role !== 'STAFF' && <div className="field-group"><label htmlFor="meeting-edit-assignee">Sorumlu personel</label>
        <select id="meeting-edit-assignee" value={assignedTo} disabled={staffState !== 'ready'}
          aria-invalid={fieldErrors.assignedTo ? true : undefined}
          aria-describedby={fieldErrors.assignedTo ? 'meeting-edit-assignee-error' : undefined}
          onChange={(event) => setAssignedTo(event.target.value)}>
          <option value="">Seçin</option>{staff.map((item) => <option key={item.user.id} value={item.user.id}>{item.user.name}</option>)}</select>
        {fieldErrors.assignedTo && <span id="meeting-edit-assignee-error" className="field-error">{fieldErrors.assignedTo}</span>}</div>}
      <div className="field-group"><label htmlFor="meeting-edit-priority">Öncelik</label>
        <select id="meeting-edit-priority" value={priority}
          onChange={(event) => setPriority(event.target.value as JobCardPriority)}>
          <option value="low">Düşük</option><option value="normal">Normal</option>
          <option value="high">Yüksek</option><option value="urgent">Acil</option></select></div>
    </fieldset><div className="review-buttons">
      <button data-cancel-meeting-edit className="secondary-button" type="button" disabled={pending} onClick={onCancel}>Vazgeç</button>
      <button className="primary-button compact-button" type="submit" disabled={pending || referencesLoading}>
        {pending ? 'Kaydediliyor…' : 'Değişiklikleri kaydet'}</button>
    </div></form>
  </section>;
}
