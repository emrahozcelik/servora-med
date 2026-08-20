import { useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { addContact, ContactCreateForm, ContactListView } from './ContactManagement';
import { jobCardStatusLabel, jobTypeLabels } from './jobs/job-labels';
import { paths } from './paths';
import { ApiError, type CurrentUser } from './services/api';
import {
  customerStatusLabels, customerTypeLabels,
  getCustomer, listCustomerJobs, updateCustomer,
  type Customer, type CustomerDetail, type JobHistoryItem, type CustomerType, type Paginated,
} from './services/crm-api';
import { listStaff, type StaffProfile } from './services/people-api';
import { createRequestGate } from './services/request-gate';
import { useRealtimeInvalidation } from './realtime/RealtimeProvider';
import { ResultState } from './ui/antd/ResultState';

function nullable(data: FormData, name: string) { return String(data.get(name) ?? '').trim() || null; }

export function customerFieldsFromFormData(data: FormData, expectedVersion: number) {
  return { expectedVersion, name: String(data.get('name') ?? '').trim(), customerType: String(data.get('customerType')) as CustomerType,
    taxNumber: nullable(data, 'taxNumber'), phone: nullable(data, 'phone'), email: nullable(data, 'email'), city: nullable(data, 'city'),
    district: nullable(data, 'district'), address: nullable(data, 'address'), assignedStaffUserId: nullable(data, 'assignedStaffUserId') };
}

export function customerMutationErrorMessage(error: unknown) {
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
  return <dl className="record-facts"><div><dt>Müşteri türü</dt><dd>{customerTypeLabels[customer.customerType]}</dd></div><div><dt>Vergi numarası</dt><dd>{customer.taxNumber ?? 'Belirtilmedi'}</dd></div>
    <div><dt>Telefon</dt><dd>{customer.phone ?? 'Belirtilmedi'}</dd></div><div><dt>E-posta</dt><dd>{customer.email ?? 'Belirtilmedi'}</dd></div>
    <div><dt>Konum</dt><dd>{[customer.city, customer.district].filter(Boolean).join(', ') || 'Belirtilmedi'}</dd></div><div><dt>Sorumlu personel</dt><dd>{customer.assignedStaffName ?? 'Atanmadı'}</dd></div>
    <div className="record-fact-wide"><dt>Adres</dt><dd>{customer.address ?? 'Belirtilmedi'}</dd></div></dl>;
}

type CustomerHistoryStatus = 'open' | 'completed' | 'all';

function CustomerHistory({
  customer, status, page, loading, error, onStatusChange, onPageChange,
}: {
  customer: CustomerDetail;
  status: CustomerHistoryStatus;
  page: Paginated<JobHistoryItem> | null;
  loading: boolean;
  error: string;
  onStatusChange: (status: CustomerHistoryStatus) => void;
  onPageChange: (offset: number) => void;
}) {
  const tabs: Array<{ value: CustomerHistoryStatus; label: string; count: number }> = [
    { value: 'open', label: 'Açık', count: customer.openJobCount },
    { value: 'completed', label: 'Tamamlanan', count: customer.completedJobCount },
    // The all tab can also contain cancelled cards, so derive its count from
    // the same filtered page rather than adding the two status counters.
    { value: 'all', label: 'Tümü', count: status === 'all' && page ? page.total : customer.openJobCount + customer.completedJobCount },
  ];
  const items = page?.items ?? [];
  const hasPrevious = (page?.offset ?? 0) > 0;
  const hasNext = page ? page.offset + page.items.length < page.total : false;
  return <section className="record-section customer-history" aria-labelledby="customer-history-title">
    <div className="section-heading"><h2 id="customer-history-title">İş geçmişi</h2><span>{page?.total ?? '…'} kayıt</span></div>
    <div className="history-tabs" role="tablist" aria-label="İş geçmişi kapsamı">
      {tabs.map((tab) => <button key={tab.value} type="button" role="tab" aria-selected={status === tab.value}
        className={status === tab.value ? 'secondary-button is-active' : 'secondary-button'} onClick={() => onStatusChange(tab.value)}>
        {tab.label} ({tab.count})
      </button>)}
    </div>
    {loading && <p className="muted-copy" aria-busy="true">İş geçmişi yükleniyor…</p>}
    {!loading && error && <p className="form-error" role="alert">{error}</p>}
    {!loading && !error && items.length === 0 && <p className="muted-copy">Bu müşteri için görüntüleyebileceğiniz iş kaydı bulunmuyor.</p>}
    {!loading && !error && items.length > 0 && <ul className="job-history-list">
      {items.map((job) => <li key={job.id} className="job-history-row">
        <div><Link to={paths.job(job.id)}>{job.title}</Link>{job.followUp && <span className="follow-up-badge">Takip</span>}
          <p>{jobTypeLabels[job.type]} · {jobCardStatusLabel(job.status)} · {job.assignee.name}</p></div>
        <time dateTime={job.completedAt ?? job.scheduledAt ?? job.createdAt}>{new Date(job.completedAt ?? job.scheduledAt ?? job.createdAt).toLocaleDateString('tr-TR')}</time>
      </li>)}
    </ul>}
    {(hasPrevious || hasNext) && <div className="pagination-actions">
      <button type="button" className="secondary-button" disabled={!hasPrevious || loading} onClick={() => onPageChange(Math.max(0, (page?.offset ?? 0) - (page?.limit ?? 20)))}>Önceki</button>
      <button type="button" className="secondary-button" disabled={!hasNext || loading} onClick={() => onPageChange((page?.offset ?? 0) + (page?.limit ?? 20))}>Daha fazla göster</button>
    </div>}
  </section>;
}

function CustomerEditForm({ customer, staff, pending, blocked, onSave, onCancel }: { customer: CustomerDetail; staff: StaffProfile[]; pending: boolean; blocked: boolean; onSave: (event: FormEvent<HTMLFormElement>) => void; onCancel: () => void }) {
  return <form className="record-form" onSubmit={onSave}><label className="field-group" htmlFor="detail-customer-name">Müşteri adı<input id="detail-customer-name" name="name" defaultValue={customer.name} required disabled={pending} /></label>
    <label className="field-group" htmlFor="detail-customer-type">Müşteri türü<select id="detail-customer-type" name="customerType" defaultValue={customer.customerType} disabled={pending}>{Object.entries(customerTypeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    <div className="customer-form-pair"><label className="field-group" htmlFor="detail-customer-tax">Vergi numarası<input id="detail-customer-tax" name="taxNumber" defaultValue={customer.taxNumber ?? ''} disabled={pending} /></label>
      <label className="field-group" htmlFor="detail-customer-phone">Telefon<input id="detail-customer-phone" name="phone" type="tel" defaultValue={customer.phone ?? ''} disabled={pending} /></label></div>
    <label className="field-group" htmlFor="detail-customer-email">E-posta<input id="detail-customer-email" name="email" type="email" defaultValue={customer.email ?? ''} disabled={pending} /></label>
    <div className="customer-form-pair"><label className="field-group" htmlFor="detail-customer-city">Şehir<input id="detail-customer-city" name="city" defaultValue={customer.city ?? ''} disabled={pending} /></label>
      <label className="field-group" htmlFor="detail-customer-district">İlçe<input id="detail-customer-district" name="district" defaultValue={customer.district ?? ''} disabled={pending} /></label></div>
    <label className="field-group" htmlFor="detail-customer-address">Adres<textarea id="detail-customer-address" name="address" rows={3} defaultValue={customer.address ?? ''} disabled={pending} /></label>
    <label className="field-group" htmlFor="detail-customer-staff">Sorumlu personel<select id="detail-customer-staff" name="assignedStaffUserId" defaultValue={customer.assignedStaffUserId ?? ''} disabled={pending}><option value="">Atanmadı</option>
      {customer.assignedStaffUserId && !staff.some((profile) => profile.user.id === customer.assignedStaffUserId) && <option value={customer.assignedStaffUserId}>{customer.assignedStaffName ?? 'Mevcut sorumlu'}</option>}
      {staff.map((profile) => <option key={profile.user.id} value={profile.user.id}>{profile.user.name}</option>)}</select></label>
    <div className="form-actions"><button className="secondary-button" type="button" onClick={onCancel} disabled={pending}>Vazgeç</button>
      <button className="primary-button compact-button" type="submit" disabled={pending || blocked}>Bilgileri kaydet</button></div></form>;
}

export function CustomerDetailView({ customer, user, staff, pending, error, notice, conflict = false, formRevision = 0, historyStatus = 'all', historyPage = null, historyLoading = false, historyError = '', onHistoryStatusChange = () => {}, onHistoryPageChange = () => {}, errorRef, createContactButtonRef, onBack, onSave, onCreateContact, onOpenContact, onReloadCurrent }: {
  customer: CustomerDetail; user: CurrentUser; staff: StaffProfile[]; pending: boolean; error: string; notice: string;
  conflict?: boolean; formRevision?: number;
  historyStatus?: CustomerHistoryStatus; historyPage?: Paginated<JobHistoryItem> | null; historyLoading?: boolean; historyError?: string;
  onHistoryStatusChange?: (status: CustomerHistoryStatus) => void; onHistoryPageChange?: (offset: number) => void;
  errorRef?: RefObject<HTMLDivElement | null>;
  createContactButtonRef?: RefObject<HTMLButtonElement | null>;
  onBack: () => void; onSave: (event: FormEvent<HTMLFormElement>) => void; onCreateContact: () => void;
  onOpenContact?: (customerId: string, contactId: string) => void;
  onReloadCurrent?: () => void;
}) {
  const canManage = user.role !== 'STAFF';
  return <main className="customer-detail"><button className="back-link" type="button" onClick={onBack}>Müşterilere dön</button>
    <div className="detail-heading"><div><p className="eyebrow">Müşteri</p><h1>{customer.name}</h1></div><div className="record-status"><span>{customerStatusLabels[customer.status]}</span><span>{customerTypeLabels[customer.customerType]}</span></div></div>
    {error && <div className="form-error" role="alert" tabIndex={-1} ref={errorRef}>{error}</div>}{notice && <div className="success-message" role="status">{notice}</div>}
    {conflict && <div className="conflict-actions"><p>Sunucudaki güncel kaydı yüklediğinizde bu formdaki değişiklikler sıfırlanır.</p>
      <button className="secondary-button" type="button" disabled={pending} onClick={onReloadCurrent}>Güncel değerleri yükle</button></div>}
    <section className="record-section" aria-labelledby="general-title"><div className="section-heading"><h2 id="general-title">Genel bilgiler</h2><span>Sürüm {customer.version}</span></div>
      {canManage ? <CustomerEditForm key={`${customer.id}:${formRevision}`} customer={customer} staff={staff} pending={pending} blocked={conflict} onSave={onSave} onCancel={onBack} /> : <CustomerFacts customer={customer} />}</section>
    <ContactListView state={{ kind: 'ready', contacts: customer.contacts }} canManage={canManage} createButtonRef={createContactButtonRef}
      onRetry={() => {}} onCreate={onCreateContact} onOpenContact={onOpenContact} />
    <CustomerHistory customer={customer} status={historyStatus} page={historyPage} loading={historyLoading} error={historyError}
      onStatusChange={onHistoryStatusChange} onPageChange={onHistoryPageChange} />
  </main>;
}

export function CustomerDetailScreen({ customerId, user }: { customerId: string; user: CurrentUser }) {
  const navigate = useNavigate(); const [customer, setCustomer] = useState<CustomerDetail | null>(null); const [staff, setStaff] = useState<StaffProfile[]>([]);
  const [loading, setLoading] = useState(true); const [pending, setPending] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState(false); const [formRevision, setFormRevision] = useState(0); const [creatingContact, setCreatingContact] = useState(false); const [contactError, setContactError] = useState('');
  const [historyStatus, setHistoryStatus] = useState<CustomerHistoryStatus>('all'); const [historyPage, setHistoryPage] = useState<Paginated<JobHistoryItem> | null>(null);
  const [historyLoading, setHistoryLoading] = useState(true); const [historyError, setHistoryError] = useState('');
  const errorRef = useRef<HTMLDivElement>(null); const createContactButtonRef = useRef<HTMLButtonElement>(null); const requestGate = useRef(createRequestGate()); const historyGate = useRef(createRequestGate());
  async function load() {
    const generation = requestGate.current.next(); setLoading(true); setCustomer(null); setError(''); setNotice(''); setConflict(false);
    try {
      const [record, profiles] = await Promise.all([getCustomer(customerId), user.role === 'STAFF' ? Promise.resolve([]) : listStaff('active')]);
      if (!requestGate.current.isCurrent(generation)) return;
      setCustomer(record); setStaff(profiles); setFormRevision((revision) => revision + 1);
    } catch (caught) {
      if (requestGate.current.isCurrent(generation)) setError(caught instanceof Error ? caught.message : 'Müşteri yüklenemedi.');
    } finally {
      if (requestGate.current.isCurrent(generation)) setLoading(false);
    }
  }
  async function loadHistory(status: CustomerHistoryStatus = historyStatus, offset = 0) {
    const generation = historyGate.current.next(); setHistoryLoading(true); setHistoryError('');
    try {
      const result = await listCustomerJobs(customerId, { status, limit: 20, offset });
      if (!historyGate.current.isCurrent(generation)) return;
      setHistoryPage(result);
    } catch (caught) {
      if (historyGate.current.isCurrent(generation)) setHistoryError(caught instanceof Error ? caught.message : 'İş geçmişi yüklenemedi.');
    } finally {
      if (historyGate.current.isCurrent(generation)) setHistoryLoading(false);
    }
  }
  useEffect(() => { void load(); return () => { requestGate.current.next(); }; }, [customerId, user.role]);
  useEffect(() => { void loadHistory(historyStatus, 0); return () => { historyGate.current.next(); }; }, [customerId, historyStatus]);
  useRealtimeInvalidation([`customer-detail:${customerId}`], () => { void load(); void loadHistory(historyStatus, historyPage?.offset ?? 0); });
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  if (loading) return <main className="customer-detail" aria-busy="true"><h1>Müşteri detayı yükleniyor</h1></main>;
  if (!customer) return <main className="customer-detail"><ResultState status="error" title="Müşteri yüklenemedi" description={error} headingLevel={1} action={<button className="secondary-button" onClick={() => void load()}>Tekrar dene</button>} /></main>;
  async function save(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (conflict) return;
    const generation = requestGate.current.current(); setPending(true); setError(''); setNotice('');
    try {
      const updated = await updateCustomer(customerId, customerFieldsFromFormData(new FormData(event.currentTarget), customer!.version));
      if (!requestGate.current.isCurrent(generation)) return;
      setCustomer(mergeCustomerDetailUpdate(customer!, updated, staff)); setFormRevision((revision) => revision + 1); setNotice('Müşteri bilgileri güncellendi.');
    } catch (caught) {
      if (!requestGate.current.isCurrent(generation)) return;
      if (caught instanceof ApiError && caught.code === 'VERSION_CONFLICT') setConflict(true);
      setError(customerMutationErrorMessage(caught));
    } finally { if (requestGate.current.isCurrent(generation)) setPending(false); }
  }
  async function createContactRecord(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setPending(true); setContactError('');
    const generation = requestGate.current.current(); setNotice('');
    try {
      const created = await addContact(customerId, new FormData(event.currentTarget));
      if (!requestGate.current.isCurrent(generation)) return;
      setCustomer({ ...customer!, contacts: [...customer!.contacts.map((contact) => created.isPrimary ? { ...contact, isPrimary: false } : contact), created], primaryContact: created.isPrimary ? { id: created.id, name: created.name, title: created.title } : customer!.primaryContact }); setCreatingContact(false); setNotice('İlgili kişi eklendi.'); window.setTimeout(() => createContactButtonRef.current?.focus(), 0);
    } catch (caught) {
      if (requestGate.current.isCurrent(generation)) setContactError(caught instanceof Error ? caught.message : 'İlgili kişi eklenemedi.');
    } finally { if (requestGate.current.isCurrent(generation)) setPending(false); }
  }
  return <><CustomerDetailView customer={customer} user={user} staff={staff} pending={pending} error={error} notice={notice} conflict={conflict} formRevision={formRevision}
    historyStatus={historyStatus} historyPage={historyPage} historyLoading={historyLoading} historyError={historyError}
    onHistoryStatusChange={(next) => { setHistoryStatus(next); setHistoryPage(null); }} onHistoryPageChange={(offset) => { void loadHistory(historyStatus, offset); }}
    errorRef={errorRef} createContactButtonRef={createContactButtonRef}
    onBack={() => navigate(paths.customers)} onSave={(event) => void save(event)} onCreateContact={() => setCreatingContact(true)}
    onOpenContact={(customerIdValue, contactIdValue) => navigate(paths.contact(customerIdValue, contactIdValue))}
    onReloadCurrent={() => void load()} />
    {creatingContact && <div className="customer-detail"><ContactCreateForm pending={pending} error={contactError} onCancel={() => { setCreatingContact(false); window.setTimeout(() => createContactButtonRef.current?.focus(), 0); }} onSubmit={(event) => void createContactRecord(event)} /></div>}</>;
}
