import { useEffect, useRef, useState, type FormEvent } from 'react';

import {
  addDeliveryItem,
  createJobCard,
  listReferenceCustomers,
  type CurrentUser,
  type DeliveryPurpose,
  type ReferenceCustomer,
} from './services/api';
import { ProductSelect } from './ProductSelect';
import { defaultScheduledLocalValue, localDateTimeToIso } from './jobs/scheduling';
import { getCustomer, type Contact, type CustomerDetail } from './services/crm-api';
import { listStaff, type StaffProfile } from './services/people-api';
import type { Product } from './services/products-api';
import { createRequestGate } from './services/request-gate';

export type DeliveryFormValues = {
  customerId: string;
  customerName: string;
  contactId: string | null;
  assignedTo: string;
  productId: string;
  deliveryPurpose: DeliveryPurpose;
  quantity: number;
  /** Device-local `YYYY-MM-DDTHH:mm` planned time for the JobCard. */
  scheduledAt: string;
  deliveryNote?: string;
};

export function deliveryDefaultsForCustomer(customer: CustomerDetail, activeStaffIds: Set<string>) {
  const contacts = customer.contacts.filter((contact) => contact.isActive);
  return {
    contacts,
    contactId: contacts.find((contact) => contact.isPrimary)?.id ?? '',
    assignedTo: customer.assignedStaffUserId && activeStaffIds.has(customer.assignedStaffUserId) ? customer.assignedStaffUserId : '',
  };
}

type FlowDependencies = {
  createJob: (input: Parameters<typeof createJobCard>[0]) => Promise<{ id: string; version: number }>;
  addItem: (jobId: string, input: Parameters<typeof addDeliveryItem>[1]) => Promise<{ jobCardVersion: number }>;
  createActionId: () => string;
};

const defaultDependencies: FlowDependencies = {
  createJob: createJobCard,
  addItem: addDeliveryItem,
  createActionId: () => crypto.randomUUID(),
};

export async function createProductDelivery(
  user: CurrentUser,
  values: DeliveryFormValues,
  dependencies: FlowDependencies = defaultDependencies,
) {
  const job = await dependencies.createJob({
    clientActionId: dependencies.createActionId(),
    type: 'PRODUCT_DELIVERY',
    title: `${values.customerName} ürün teslimi`,
    customerId: values.customerId,
    contactId: values.contactId,
    assignedTo: user.role === 'STAFF' ? user.id : values.assignedTo,
    priority: 'normal',
    scheduledAt: localDateTimeToIso(values.scheduledAt),
  });
  const delivery = await dependencies.addItem(job.id, {
    clientActionId: dependencies.createActionId(),
    expectedVersion: job.version,
    productId: values.productId,
    deliveryPurpose: values.deliveryPurpose,
    deliveredAt: null,
    quantity: values.quantity,
    deliveryNote: values.deliveryNote?.trim() || null,
  });
  return { jobCardId: job.id, version: delivery.jobCardVersion };
}

export function DeliveryCreateView({ user, onCancel, onCreated }: {
  user: CurrentUser;
  onCancel: () => void;
  onCreated: (result: { jobCardId: string; version: number }) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [customers, setCustomers] = useState<ReferenceCustomer[]>([]);
  const [customerState, setCustomerState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [customerId, setCustomerId] = useState('');
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactId, setContactId] = useState('');
  const [contactState, setContactState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [contactError, setContactError] = useState('');
  const [staff, setStaff] = useState<StaffProfile[]>([]);
  const [staffState, setStaffState] = useState<'loading' | 'ready' | 'error'>(user.role === 'STAFF' ? 'ready' : 'loading');
  const [assignedTo, setAssignedTo] = useState(user.role === 'STAFF' ? user.id : '');
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [scheduledLocal, setScheduledLocal] = useState(
    () => defaultScheduledLocalValue(new Date()),
  );
  const errorRef = useRef<HTMLDivElement>(null);
  const customerGate = useRef(createRequestGate());
  const activeStaffIds = useRef(new Set<string>());
  const responsibleStaffId = useRef<string | null>(null);
  const assigneeModified = useRef(false);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  async function loadCustomers() {
    setCustomerState('loading');
    try {
      setCustomers(await listReferenceCustomers());
      setCustomerState('ready');
    } catch {
      setCustomers([]);
      setCustomerState('error');
    }
  }
  useEffect(() => { void loadCustomers(); }, []);
  useEffect(() => {
    if (user.role === 'STAFF') return;
    let active = true; setStaffState('loading');
    listStaff('active').then((profiles) => {
      if (!active) return;
      setStaff(profiles); activeStaffIds.current = new Set(profiles.map((profile) => profile.user.id)); setStaffState('ready');
      if (!assigneeModified.current && responsibleStaffId.current && activeStaffIds.current.has(responsibleStaffId.current)) {
        setAssignedTo(responsibleStaffId.current);
      }
    }).catch(() => { if (active) setStaffState('error'); });
    return () => { active = false; };
  }, [user.role]);
  useEffect(() => () => { customerGate.current.next(); }, []);

  async function changeCustomer(nextCustomerId: string) {
    setCustomerId(nextCustomerId); setContacts([]); setContactId(''); setContactError(''); responsibleStaffId.current = null;
    assigneeModified.current = false; if (user.role !== 'STAFF') setAssignedTo('');
    const generation = customerGate.current.next();
    if (!nextCustomerId) { setContactState('idle'); return; }
    setContactState('loading');
    try {
      const detail = await getCustomer(nextCustomerId);
      if (!customerGate.current.isCurrent(generation)) return;
      const defaults = deliveryDefaultsForCustomer(detail, activeStaffIds.current);
      setContacts(defaults.contacts); setContactId(defaults.contactId); setContactState('ready'); responsibleStaffId.current = detail.assignedStaffUserId;
      if (user.role !== 'STAFF' && !assigneeModified.current) setAssignedTo(defaults.assignedTo);
    } catch (caught) {
      if (!customerGate.current.isCurrent(generation)) return;
      setContactState('error'); setContactError(caught instanceof Error ? caught.message : 'İlgili kişiler yüklenemedi.');
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setError('');
    const data = new FormData(event.currentTarget);
    const selectedCustomerId = String(data.get('customerId') ?? '');
    const customer = customers.find((item) => item.id === selectedCustomerId && item.status !== 'inactive');
    try {
      if (!customer) throw new Error('Geçerli bir müşteri seçin.');
      if (!selectedProduct) throw new Error('Geçerli bir ürün seçin.');
      if (!scheduledLocal) throw new Error('Planlanan teslim zamanını seçin.');
      const selectedAssignee = user.role === 'STAFF' ? user.id : String(data.get('assignedTo') ?? '');
      if (!selectedAssignee) throw new Error('Geçerli bir sorumlu personel seçin.');
      const result = await createProductDelivery(user, {
        customerId: selectedCustomerId,
        customerName: customer.name,
        contactId: String(data.get('contactId') ?? '') || null,
        assignedTo: selectedAssignee,
        productId: selectedProduct.id,
        deliveryPurpose: String(data.get('deliveryPurpose') ?? '') as DeliveryPurpose,
        quantity: Number(data.get('quantity')),
        scheduledAt: scheduledLocal,
        deliveryNote: String(data.get('deliveryNote') ?? ''),
      });
      onCreated(result);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Teslim kaydı oluşturulamadı. Tekrar deneyin.');
      setPending(false);
    }
  }

  const availableCustomers = customers.filter((customer) => customer.status !== 'inactive');
  const unavailable = customerState === 'ready' && availableCustomers.length === 0;
  const referencesPending = customerState === 'loading' || contactState === 'loading' || staffState === 'loading';
  const submitDisabled = pending || unavailable || customerState !== 'ready' || !selectedProduct || referencesPending || (user.role !== 'STAFF' && !assignedTo);
  return <main className="delivery-create">
    <div className="delivery-heading"><div><p className="eyebrow">Yeni kayıt</p><h1>Ürün teslimi</h1></div>
      <button className="secondary-button" type="button" onClick={onCancel} disabled={pending}>Vazgeç</button></div>
    <p className="form-intro">Teslim edilen ürünü ve işlem amacını kaydedin. İlgili kişi ve teslim notu isteğe bağlıdır.</p>
    {error && <div className="form-error" role="alert" tabIndex={-1} ref={errorRef}>{error}</div>}
    {customerState === 'loading' && <p className="field-status" role="status">Müşteriler yükleniyor…</p>}
    {customerState === 'error' && <p className="field-error" role="alert">Müşteriler yüklenemedi.{' '}
      <button data-retry-customers className="inline-action" type="button" onClick={() => void loadCustomers()}>Tekrar dene</button></p>}
    {unavailable && <div className="form-error" role="status">Teslim oluşturmak için aktif müşteri kaydı gereklidir.</div>}
    <form className="delivery-form" onSubmit={submit}>
      <div className="field-group"><label htmlFor="delivery-customer">Müşteri</label>
        <select id="delivery-customer" name="customerId" required disabled={pending || unavailable || customerState !== 'ready'} value={customerId} onChange={(event) => void changeCustomer(event.target.value)}>
          <option value="" disabled>Seçin</option>{availableCustomers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></div>
      <div className="field-group"><label htmlFor="delivery-contact">İlgili kişi</label>
        <select id="delivery-contact" name="contactId" disabled={pending || !customerId || contactState === 'loading' || contactState === 'error'} value={contactId} onChange={(event) => setContactId(event.target.value)}>
          <option value="">İlgili kişi seçilmedi</option>{contacts.map((contact) => <option key={contact.id} value={contact.id}>{contact.name}{contact.title ? ` — ${contact.title}` : ''}</option>)}
        </select>
        {contactState === 'loading' && <span className="field-status" role="status">İlgili kişiler yükleniyor…</span>}
        {contactState === 'error' && <span className="field-error" role="alert">{contactError}</span>}
      </div>
      {user.role !== 'STAFF' && <div className="field-group"><label htmlFor="delivery-assignee">Sorumlu personel</label>
        <select id="delivery-assignee" name="assignedTo" required disabled={pending || staffState !== 'ready'} value={assignedTo}
          onChange={(event) => { assigneeModified.current = true; setAssignedTo(event.target.value); }}>
          <option value="">Seçin</option>{staff.map((profile) => <option key={profile.user.id} value={profile.user.id}>{profile.user.name}</option>)}
        </select>
        {staffState === 'loading' && <span className="field-status" role="status">Personel listesi yükleniyor…</span>}
        {staffState === 'error' && <span className="field-error" role="alert">Personel listesi yüklenemedi. Sayfayı yenileyip tekrar deneyin.</span>}
      </div>}
      <ProductSelect selected={selectedProduct} onChange={setSelectedProduct} disabled={pending || unavailable} />
      <div className="delivery-pair">
        <div className="field-group"><label htmlFor="delivery-purpose">Teslim amacı</label>
          <select id="delivery-purpose" name="deliveryPurpose" required disabled={pending} defaultValue="SALE">
            <option value="SALE">Satış</option><option value="SAMPLE">Numune</option><option value="CONSIGNMENT">Konsinye</option><option value="RETURN">İade</option><option value="OTHER">Diğer</option>
          </select></div>
        <div className="field-group"><label htmlFor="delivery-quantity">Miktar</label>
          <input id="delivery-quantity" name="quantity" type="number" min="0.001" step="0.001" inputMode="decimal" required disabled={pending} /></div>
      </div>
      <div className="field-group"><label htmlFor="delivery-scheduled-at">Planlanan teslim zamanı</label>
        <input id="delivery-scheduled-at" name="scheduledAt" type="datetime-local" required disabled={pending}
          value={scheduledLocal} onChange={(event) => setScheduledLocal(event.target.value)} /></div>
      <div className="field-group"><label htmlFor="delivery-note">Teslim notu (isteğe bağlı)</label>
        <textarea id="delivery-note" name="deliveryNote" rows={3} disabled={pending} /></div>
      <button className="primary-button" type="submit" disabled={submitDisabled}>{pending ? 'Kaydediliyor…' : 'Teslimi kaydet'}</button>
    </form>
  </main>;
}
