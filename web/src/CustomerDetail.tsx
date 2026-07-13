import { useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { addContact, ContactCreateForm, ContactListView } from './ContactManagement';
import { paths } from './paths';
import { ApiError, type CurrentUser } from './services/api';
import {
  activateCustomer, deactivateCustomer, getCustomer, updateCustomer,
  type Customer, type CustomerDetail, type CustomerJobSummary, type CustomerType,
} from './services/crm-api';
import { listStaff, type StaffProfile } from './services/people-api';
import { createRequestGate } from './services/request-gate';

const typeLabels: Record<CustomerType, string> = { clinic: 'Klinik', hospital: 'Hastane', dealer: 'Bayi', company: 'Firma', other: 'Diğer' };
const statusLabels = { prospect: 'Aday', active: 'Aktif', inactive: 'Pasif' } as const;
const jobStatusLabels = { NEW: 'Yeni', PLANNED: 'Planlandı', IN_PROGRESS: 'Devam ediyor', WAITING_APPROVAL: 'Onay bekliyor', REVISION_REQUESTED: 'Düzeltme istendi', COMPLETED: 'Tamamlandı', CANCELLED: 'İptal edildi' } as const;

function nullable(data: FormData, name: string) { return String(data.get(name) ?? '').trim() || null; }

export function customerFieldsFromFormData(data: FormData, expectedVersion: number) {
  return { expectedVersion, name: String(data.get('name') ?? '').trim(), customerType: String(data.get('customerType')) as CustomerType,
    taxNumber: nullable(data, 'taxNumber'), phone: nullable(data, 'phone'), email: nullable(data, 'email'), city: nullable(data, 'city'),
    district: nullable(data, 'district'), address: nullable(data, 'address'), assignedStaffUserId: nullable(data, 'assignedStaffUserId') };
}

export function confirmCustomerLifecycle(customer: CustomerDetail, action: 'activate' | 'deactivate', confirm: (message: string) => boolean = window.confirm) {
  const message = action === 'deactivate'
    ? `${customer.name} pasifleştirilsin mi? Açık işler varsa işlem engellenir; pasif kayıtta yeni iş ve ilgili kişi işlemleri yapılamaz.`
    : `${customer.name} yeniden aktifleştirilsin mi? Mevcut ilgili kişiler otomatik olarak aktifleştirilmez.`;
  return confirm(message);
}

export function customerMutationErrorMessage(error: unknown) {
  if (error instanceof ApiError && error.code === 'CUSTOMER_HAS_ACTIVE_JOB_CARDS') return 'Müşterinin açık işleri bulunduğu için kayıt pasifleştirilemez. Önce bu işleri tamamlayın veya iptal edin.';
  if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') return 'Müşteri başka bir kullanıcı tarafından güncellendi; formdaki değişiklikleriniz korunuyor. Devam etmek için güncel değerleri yükleyin.';
  return error instanceof Error ? error.message : 'İşlem tamamlanamadı. Tekrar deneyin.';
}

export function mergeCustomerDetailUpdate(current: CustomerDetail, updated: Customer, staff: StaffProfile[]): CustomerDetail {
  const assignedStaffName = updated.assignedStaffUserId
    ? staff.find((profile) => profile.user.id === updated.assignedStaffUserId)?.user.name
      ?? (updated.assignedStaffUserId === current.assignedStaffUserId ? current.assignedStaffName : null)
    : null;
  return { ...current, ...updated, assignedStaffName };
}

function CustomerFacts({ customer }: { customer: CustomerDetail }) {
  return <dl className="record-facts"><div><dt>Müşteri türü</dt><dd>{typeLabels[customer.customerType]}</dd></div><div><dt>Vergi numarası</dt><dd>{customer.taxNumber ?? 'Belirtilmedi'}</dd></div>
    <div><dt>Telefon</dt><dd>{customer.phone ?? 'Belirtilmedi'}</dd></div><div><dt>E-posta</dt><dd>{customer.email ?? 'Belirtilmedi'}</dd></div>
    <div><dt>Konum</dt><dd>{[customer.city, customer.district].filter(Boolean).join(', ') || 'Belirtilmedi'}</dd></div><div><dt>Sorumlu personel</dt><dd>{customer.assignedStaffName ?? 'Atanmadı'}</dd></div>
    <div className="record-fact-wide"><dt>Adres</dt><dd>{customer.address ?? 'Belirtilmedi'}</dd></div></dl>;
}

function JobSummaries({ title, jobs }: { title: string; jobs: CustomerJobSummary[] }) {
  const visible = jobs.slice(0, 5);
  const titleId = title === 'Açık işler' ? 'open-jobs-title' : 'completed-jobs-title';
  return <section className="record-section job-summaries" aria-labelledby={titleId}><h2 id={titleId}>{title}</h2>
    {visible.length === 0 ? <p className="muted-copy">Bu kapsamda iş kartı yok.</p> : <ul>{visible.map((job) => <li key={job.id}><Link to={paths.job(job.id)}>{job.title}</Link>
      <span>{jobStatusLabels[job.status]}</span>{job.dueDate && <time dateTime={job.dueDate}>{job.dueDate}</time>}</li>)}</ul>}
  </section>;
}

function CustomerEditForm({ customer, staff, pending, blocked, onSave }: { customer: CustomerDetail; staff: StaffProfile[]; pending: boolean; blocked: boolean; onSave: (event: FormEvent<HTMLFormElement>) => void }) {
  return <form className="record-form" onSubmit={onSave}><label className="field-group" htmlFor="detail-customer-name">Müşteri adı<input id="detail-customer-name" name="name" defaultValue={customer.name} required disabled={pending} /></label>
    <label className="field-group" htmlFor="detail-customer-type">Müşteri türü<select id="detail-customer-type" name="customerType" defaultValue={customer.customerType} disabled={pending}>{Object.entries(typeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    <div className="customer-form-pair"><label className="field-group" htmlFor="detail-customer-tax">Vergi numarası<input id="detail-customer-tax" name="taxNumber" defaultValue={customer.taxNumber ?? ''} disabled={pending} /></label>
      <label className="field-group" htmlFor="detail-customer-phone">Telefon<input id="detail-customer-phone" name="phone" type="tel" defaultValue={customer.phone ?? ''} disabled={pending} /></label></div>
    <label className="field-group" htmlFor="detail-customer-email">E-posta<input id="detail-customer-email" name="email" type="email" defaultValue={customer.email ?? ''} disabled={pending} /></label>
    <div className="customer-form-pair"><label className="field-group" htmlFor="detail-customer-city">Şehir<input id="detail-customer-city" name="city" defaultValue={customer.city ?? ''} disabled={pending} /></label>
      <label className="field-group" htmlFor="detail-customer-district">İlçe<input id="detail-customer-district" name="district" defaultValue={customer.district ?? ''} disabled={pending} /></label></div>
    <label className="field-group" htmlFor="detail-customer-address">Adres<textarea id="detail-customer-address" name="address" rows={3} defaultValue={customer.address ?? ''} disabled={pending} /></label>
    <label className="field-group" htmlFor="detail-customer-staff">Sorumlu personel<select id="detail-customer-staff" name="assignedStaffUserId" defaultValue={customer.assignedStaffUserId ?? ''} disabled={pending}><option value="">Atanmadı</option>
      {customer.assignedStaffUserId && !staff.some((profile) => profile.user.id === customer.assignedStaffUserId) && <option value={customer.assignedStaffUserId}>{customer.assignedStaffName ?? 'Mevcut sorumlu'}</option>}
      {staff.map((profile) => <option key={profile.user.id} value={profile.user.id}>{profile.user.name}</option>)}</select></label>
    <button className="primary-button compact-button" disabled={pending || blocked}>Bilgileri kaydet</button></form>;
}

export function CustomerDetailView({ customer, user, staff, pending, error, notice, conflict = false, errorRef, onBack, onSave, onLifecycle, onCreateContact, onReloadCurrent }: {
  customer: CustomerDetail; user: CurrentUser; staff: StaffProfile[]; pending: boolean; error: string; notice: string;
  conflict?: boolean;
  errorRef?: RefObject<HTMLDivElement | null>;
  onBack: () => void; onSave: (event: FormEvent<HTMLFormElement>) => void; onLifecycle: (action: 'activate' | 'deactivate', trigger?: HTMLButtonElement) => void; onCreateContact: () => void;
  onReloadCurrent?: () => void;
}) {
  const canManage = user.role !== 'STAFF';
  return <main className="customer-detail"><button className="back-link" type="button" onClick={onBack}>Müşterilere dön</button>
    <div className="detail-heading"><div><p className="eyebrow">Müşteri</p><h1>{customer.name}</h1></div><div className="record-status"><span>{statusLabels[customer.status]}</span><span>{typeLabels[customer.customerType]}</span></div></div>
    {error && <div className="form-error" role="alert" tabIndex={-1} ref={errorRef}>{error}</div>}{notice && <div className="success-message" role="status">{notice}</div>}
    {conflict && <div className="conflict-actions"><p>Sunucudaki güncel kaydı yüklediğinizde bu formdaki değişiklikler sıfırlanır.</p>
      <button className="secondary-button" type="button" disabled={pending} onClick={onReloadCurrent}>Güncel değerleri yükle</button></div>}
    <section className="record-section" aria-labelledby="general-title"><div className="section-heading"><h2 id="general-title">Genel bilgiler</h2><span>Sürüm {customer.version}</span></div>
      {canManage ? <CustomerEditForm key={customer.version} customer={customer} staff={staff} pending={pending} blocked={conflict} onSave={onSave} /> : <CustomerFacts customer={customer} />}</section>
    {canManage && <section className="record-section record-commands" aria-labelledby="customer-status-title"><h2 id="customer-status-title">Müşteri durumu</h2><p>Durum değişikliği iş ve ilgili kişi oluşturma kurallarını etkiler.</p>
      <button className="secondary-button" type="button" disabled={pending || conflict} onClick={(event) => onLifecycle(customer.status === 'inactive' ? 'activate' : 'deactivate', event.currentTarget)}>
        {customer.status === 'inactive' ? 'Müşteriyi aktifleştir' : 'Müşteriyi pasifleştir'}</button></section>}
    <ContactListView state={{ kind: 'ready', contacts: customer.contacts }} canManage={canManage} onRetry={() => {}} onCreate={onCreateContact} />
    <div className="job-summary-grid"><JobSummaries title="Açık işler" jobs={customer.openJobs} /><JobSummaries title="Tamamlanan işler" jobs={customer.completedJobs} /></div>
  </main>;
}

export function CustomerDetailScreen({ customerId, user }: { customerId: string; user: CurrentUser }) {
  const navigate = useNavigate(); const [customer, setCustomer] = useState<CustomerDetail | null>(null); const [staff, setStaff] = useState<StaffProfile[]>([]);
  const [loading, setLoading] = useState(true); const [pending, setPending] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState(false); const [creatingContact, setCreatingContact] = useState(false); const [contactError, setContactError] = useState('');
  const errorRef = useRef<HTMLDivElement>(null); const requestGate = useRef(createRequestGate());
  async function load() {
    const generation = requestGate.current.next(); setLoading(true); setCustomer(null); setError(''); setNotice(''); setConflict(false);
    try {
      const [record, profiles] = await Promise.all([getCustomer(customerId), user.role === 'STAFF' ? Promise.resolve([]) : listStaff('active')]);
      if (!requestGate.current.isCurrent(generation)) return;
      setCustomer(record); setStaff(profiles);
    } catch (caught) {
      if (requestGate.current.isCurrent(generation)) setError(caught instanceof Error ? caught.message : 'Müşteri yüklenemedi.');
    } finally {
      if (requestGate.current.isCurrent(generation)) setLoading(false);
    }
  }
  useEffect(() => { void load(); return () => { requestGate.current.next(); }; }, [customerId, user.role]);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  if (loading) return <main className="customer-detail" aria-busy="true"><h1>Müşteri detayı yükleniyor</h1></main>;
  if (!customer) return <main className="customer-detail"><div className="workspace-message" role="alert"><h1>Müşteri yüklenemedi</h1><p>{error}</p><button className="secondary-button" onClick={() => void load()}>Tekrar dene</button></div></main>;
  async function save(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (conflict) return;
    const generation = requestGate.current.current(); setPending(true); setError(''); setNotice('');
    try {
      const updated = await updateCustomer(customerId, customerFieldsFromFormData(new FormData(event.currentTarget), customer!.version));
      if (!requestGate.current.isCurrent(generation)) return;
      setCustomer(mergeCustomerDetailUpdate(customer!, updated, staff)); setNotice('Müşteri bilgileri güncellendi.');
    } catch (caught) {
      if (!requestGate.current.isCurrent(generation)) return;
      if (caught instanceof ApiError && caught.code === 'VERSION_CONFLICT') setConflict(true);
      setError(customerMutationErrorMessage(caught));
    } finally { if (requestGate.current.isCurrent(generation)) setPending(false); }
  }
  async function lifecycle(action: 'activate' | 'deactivate', trigger?: HTMLButtonElement) {
    if (conflict || !confirmCustomerLifecycle(customer!, action)) { trigger?.focus(); return; }
    const generation = requestGate.current.current(); setPending(true); setError(''); setNotice('');
    try {
      const updated = action === 'activate' ? await activateCustomer(customerId, customer!.version) : await deactivateCustomer(customerId, customer!.version);
      if (!requestGate.current.isCurrent(generation)) return;
      setCustomer(mergeCustomerDetailUpdate(customer!, updated, staff)); setNotice(action === 'activate' ? 'Müşteri aktifleştirildi.' : 'Müşteri pasifleştirildi.');
    } catch (caught) {
      if (!requestGate.current.isCurrent(generation)) return;
      if (caught instanceof ApiError && caught.code === 'VERSION_CONFLICT') setConflict(true);
      setError(customerMutationErrorMessage(caught));
    } finally { if (requestGate.current.isCurrent(generation)) { setPending(false); trigger?.focus(); } }
  }
  async function createContactRecord(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setPending(true); setContactError('');
    const generation = requestGate.current.current(); setNotice('');
    try {
      const created = await addContact(customerId, new FormData(event.currentTarget));
      if (!requestGate.current.isCurrent(generation)) return;
      setCustomer({ ...customer!, contacts: [...customer!.contacts.map((contact) => created.isPrimary ? { ...contact, isPrimary: false } : contact), created], primaryContact: created.isPrimary ? { id: created.id, name: created.name, title: created.title } : customer!.primaryContact }); setCreatingContact(false); setNotice('İlgili kişi eklendi.');
    } catch (caught) {
      if (requestGate.current.isCurrent(generation)) setContactError(caught instanceof Error ? caught.message : 'İlgili kişi eklenemedi.');
    } finally { if (requestGate.current.isCurrent(generation)) setPending(false); }
  }
  return <><CustomerDetailView customer={customer} user={user} staff={staff} pending={pending} error={error} notice={notice} conflict={conflict} errorRef={errorRef}
    onBack={() => navigate(paths.customers)} onSave={(event) => void save(event)} onLifecycle={(action, trigger) => void lifecycle(action, trigger)} onCreateContact={() => setCreatingContact(true)}
    onReloadCurrent={() => void load()} />
    {creatingContact && <div className="customer-detail"><ContactCreateForm pending={pending} error={contactError} onCancel={() => setCreatingContact(false)} onSubmit={(event) => void createContactRecord(event)} /></div>}</>;
}
