import { useEffect, useRef, useState, type FormEvent } from 'react';

import {
  ApiError,
  createProductDelivery as createProductDeliveryRequest,
  type CurrentUser,
  type DeliveryPurpose,
} from './services/api';
import { ProductSelect } from './ProductSelect';
import { CustomerScheduleNotice } from './jobs/CustomerScheduleNotice';
import { AvailableSlotsNotice } from './jobs/AvailableSlotsNotice';
import { useCustomerSchedulePreview } from './jobs/useCustomerSchedulePreview';
import { useAvailableSlotSearch } from './jobs/useAvailableSlotSearch';
import type { AvailableSlot } from './jobs/jobs-api';
import type { CustomerScheduleConflictDetail, CustomerScheduleEvaluation } from './jobs/jobs-api';
import { defaultScheduledLocalValue, isoInstantToLocalDateTime, localDateTimeToIso } from './jobs/scheduling';
import { listStaff, type StaffProfile } from './services/people-api';
import { CustomerSearchSelect } from './jobs/CustomerSearchSelect';
import type { Product } from './services/products-api';
import type { Customer, CustomerSummary } from './services/crm-api';
import { CustomerCreateSideFlow } from './CustomerCreateSideFlow';

export type DeliveryFormValues = {
  customerId: string;
  customerName: string;
  assignedTo: string;
  items: Array<{ productId: string; quantity: number }>;
  deliveryPurpose: DeliveryPurpose;
  /** Device-local `YYYY-MM-DDTHH:mm` planned time for the JobCard. */
  scheduledAt: string;
  deliveryNote?: string;
  overrideReason?: string | null;
};

type FlowDependencies = {
  createDelivery: (input: Parameters<typeof createProductDeliveryRequest>[0]) => Promise<{ jobCardId: string; version: number }>;
  createActionId: () => string;
};

const defaultDependencies: FlowDependencies = {
  createDelivery: createProductDeliveryRequest,
  createActionId: () => crypto.randomUUID(),
};

export async function createProductDelivery(
  user: CurrentUser,
  values: DeliveryFormValues,
  dependencies: FlowDependencies = defaultDependencies,
) {
  const result = await dependencies.createDelivery({
    clientActionId: dependencies.createActionId(),
    type: 'PRODUCT_DELIVERY',
    title: `${values.customerName} ürün teslimi`,
    customerId: values.customerId,
    assignedTo: user.role === 'STAFF' ? user.id : values.assignedTo,
    priority: 'normal',
    scheduledAt: localDateTimeToIso(values.scheduledAt),
    deliveryPurpose: values.deliveryPurpose,
    deliveryNote: values.deliveryNote?.trim() || null,
    items: values.items,
    ...(values.overrideReason?.trim() ? { overrideReason: values.overrideReason.trim() } : {}),
  });
  return result;
}

export function DeliveryCreateView({ user, onCancel, onCreated, initialCustomerId = '' }: {
  user: CurrentUser;
  initialCustomerId?: string;
  onCancel: () => void;
  onCreated: (result: { jobCardId: string; version: number }) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [customerId, setCustomerId] = useState(initialCustomerId);
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerSummary | null>(null);
  const [customerReady, setCustomerReady] = useState(false);
  const [pinnedCustomer, setPinnedCustomer] = useState<CustomerSummary | null>(null);
  const [staff, setStaff] = useState<StaffProfile[]>([]);
  const [staffState, setStaffState] = useState<'loading' | 'ready' | 'error'>(user.role === 'STAFF' ? 'ready' : 'loading');
  const [assignedTo, setAssignedTo] = useState(user.role === 'STAFF' ? user.id : '');
  const [selectedProducts, setSelectedProducts] = useState<Array<{ product: Product; quantity: number | '' }>>([]);
  const [scheduledLocal, setScheduledLocal] = useState(
    () => defaultScheduledLocalValue(new Date()),
  );
  const [overrideReason, setOverrideReason] = useState('');
  const [authoritativeEvaluation, setAuthoritativeEvaluation] = useState<CustomerScheduleEvaluation | null>(null);
  const [calendarConflicts, setCalendarConflicts] = useState<Array<Record<string, unknown>>>([]);
  const errorRef = useRef<HTMLDivElement>(null);
  const [customerCreateOpen, setCustomerCreateOpen] = useState(false);
  const customerCreateTriggerRef = useRef<HTMLButtonElement>(null);
  const activeStaffIds = useRef(new Set<string>());
  const responsibleStaffId = useRef<string | null>(null);
  const assigneeModified = useRef(false);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  // An authoritative conflict belongs to the submitted form state; once the
  // user changes a scheduling-relevant field the advisory preview takes over.
  useEffect(() => {
    setAuthoritativeEvaluation(null);
    setCalendarConflicts([]);
  }, [assignedTo, customerId, scheduledLocal]);

  const { evaluation, previewing } = useCustomerSchedulePreview({
    type: 'PRODUCT_DELIVERY',
    customerId: customerId || null,
    scheduledLocal,
    enabled: customerReady,
  });
  const availableSlotSearch = useAvailableSlotSearch({
    type: 'PRODUCT_DELIVERY',
    customerId: customerId || null,
    assignedTo: user.role === 'STAFF' ? user.id : assignedTo || null,
    scheduledStartLocal: scheduledLocal,
    jobCardId: null,
    enabled: user.capabilities?.calendar === true
      && customerReady,
  });

  function useSuggestedAlternative() {
    const alternativeAt = (authoritativeEvaluation ?? evaluation)?.suggestedAlternativeAt;
    if (!alternativeAt) return;
    setScheduledLocal(isoInstantToLocalDateTime(alternativeAt));
  }

  function useAvailableSlot(slot: AvailableSlot) {
    setScheduledLocal(isoInstantToLocalDateTime(slot.startsAt));
  }

  function applyCustomerSelection(customer: CustomerSummary | undefined) {
    const responsibleId = customer?.assignedStaffUserId ?? null;
    responsibleStaffId.current = responsibleId;
    assigneeModified.current = false;
    if (user.role !== 'STAFF') {
      setAssignedTo(
        responsibleId && activeStaffIds.current.has(responsibleId) ? responsibleId : '',
      );
    }
  }

  function handleCustomerChange(nextCustomerId: string) {
    setCustomerId(nextCustomerId);
    // A manual pick reevaluates responsible staff from the new customer.
    assigneeModified.current = false;
  }

  function handleCustomerResolved(customer: CustomerSummary | null) {
    setSelectedCustomer(customer);
    if (!assigneeModified.current) applyCustomerSelection(customer ?? undefined);
  }
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
  function addCreatedCustomer(customer: Customer) {
    setPinnedCustomer({ ...customer, assignedStaffName: null, primaryContact: null });
    setCustomerId(customer.id);
    setCustomerCreateOpen(false);
  }

  function addSelectedProduct(product: Product) {
    setSelectedProducts((current) => current.some((entry) => entry.product.id === product.id)
      ? current
      : [...current, { product, quantity: 1 }]);
  }

  function removeSelectedProduct(productId: string) {
    setSelectedProducts((current) => current.filter((entry) => entry.product.id !== productId));
  }

  function updateSelectedQuantity(productId: string, value: string) {
    setSelectedProducts((current) => current.map((entry) => (
      entry.product.id === productId
        ? { ...entry, quantity: value === '' ? '' : Number(value) }
        : entry
    )));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setError('');
    const data = new FormData(event.currentTarget);
    const customer = selectedCustomer && selectedCustomer.id === customerId && selectedCustomer.status !== 'inactive'
      ? selectedCustomer
      : null;
    try {
      if (!customer) throw new Error('Geçerli bir müşteri seçin.');
      if (selectedProducts.length === 0) throw new Error('En az bir ürün seçin.');
      if (!scheduledLocal) throw new Error('Planlanan teslim zamanını seçin.');
      const selectedAssignee = user.role === 'STAFF' ? user.id : String(data.get('assignedTo') ?? '');
      if (!selectedAssignee) throw new Error('Geçerli bir sorumlu personel seçin.');
      const items = selectedProducts.map((entry) => {
        if (entry.quantity === '' || !Number.isFinite(entry.quantity) || entry.quantity <= 0) {
          throw new Error(`${entry.product.name} için geçerli bir miktar girin.`);
        }
        return { productId: entry.product.id, quantity: entry.quantity };
      });
      const result = await createProductDelivery(user, {
        customerId: customer.id,
        customerName: customer.name,
        assignedTo: selectedAssignee,
        items,
        deliveryPurpose: String(data.get('deliveryPurpose') ?? '') as DeliveryPurpose,
        scheduledAt: scheduledLocal,
        deliveryNote: String(data.get('deliveryNote') ?? ''),
        overrideReason: overrideReason.trim() || null,
      });
      onCreated(result);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'CUSTOMER_SCHEDULE_CONFLICT') {
        const details = caught.details ?? {};
        setAuthoritativeEvaluation({
          level: 'CONFLICT',
          safeMessage: null,
          conflicts: Array.isArray(details.conflicts)
            ? details.conflicts as CustomerScheduleConflictDetail[]
            : [],
          recentVisit: null,
          suggestedAlternativeAt: typeof details.suggestedAlternativeAt === 'string'
            ? details.suggestedAlternativeAt
            : null,
        });
      }
      if (caught instanceof ApiError && caught.code === 'CALENDAR_CONFLICT') {
        // STAFF never receives conflict details (server projects them away);
        // MANAGER/ADMIN may see the rich same-org conflict list.
        const raw = caught.details?.conflicts;
        setCalendarConflicts(user.role === 'STAFF'
          ? []
          : Array.isArray(raw) ? raw as Array<Record<string, unknown>> : []);
      }
      setError(caught instanceof Error ? caught.message : 'Teslim kaydı oluşturulamadı. Tekrar deneyin.');
      setPending(false);
    }
  }

  const referencesPending = !customerReady || staffState === 'loading';
  const submitDisabled = pending || !customerReady || selectedProducts.length === 0
    || referencesPending || (user.role !== 'STAFF' && !assignedTo);
  return <main className="delivery-create">
    <div className="create-heading"><div><p className="eyebrow">Yeni kayıt</p><h1>Ürün teslimi</h1></div></div>
    <p className="form-intro">Teslim edilen ürünü ve işlem amacını kaydedin. Teslim notu isteğe bağlıdır.</p>
    {error && <div className="form-error" role="alert" tabIndex={-1} ref={errorRef}>{error}
      {calendarConflicts.map((conflict) => (
        <p key={String(conflict.id)}>
          {String(conflict.title)} · {new Date(String(conflict.startsAt)).toLocaleString('tr-TR')}
        </p>
      ))}
    </div>}
    <form className="delivery-form" onSubmit={submit}>
      <div className="field-group"><div className="field-label-row"><label htmlFor="delivery-customer">Müşteri</label>
        <button ref={customerCreateTriggerRef} className="inline-action" type="button" disabled={pending} onClick={() => setCustomerCreateOpen(true)}>Yeni müşteri ekle</button></div>
        <CustomerSearchSelect
          id="delivery-customer"
          value={customerId}
          onChange={handleCustomerChange}
          onCustomerResolved={handleCustomerResolved}
          pinnedCustomer={pinnedCustomer}
          onReadyChange={setCustomerReady}
          clearValueWhenMissing
          isEligible={(customer) => customer.status !== 'inactive'}
          disabled={pending}
        />
      </div>
      {user.role !== 'STAFF' && <div className="field-group"><label htmlFor="delivery-assignee">Sorumlu personel</label>
        <select id="delivery-assignee" name="assignedTo" required disabled={pending || staffState !== 'ready'} value={assignedTo}
          onChange={(event) => { assigneeModified.current = true; setAssignedTo(event.target.value); }}>
          <option value="">Seçin</option>{staff.map((profile) => <option key={profile.user.id} value={profile.user.id}>{profile.user.name}</option>)}
        </select>
        {staffState === 'loading' && <span className="field-status" role="status">Personel listesi yükleniyor…</span>}
        {staffState === 'error' && <span className="field-error" role="alert">Personel listesi yüklenemedi. Sayfayı yenileyip tekrar deneyin.</span>}
      </div>}
      <ProductSelect selectedProducts={selectedProducts.map((entry) => entry.product)}
        onAdd={addSelectedProduct} onRemove={removeSelectedProduct} disabled={pending || !customerReady} />
      {selectedProducts.length > 0 && <div className="delivery-selected-quantities" aria-labelledby="delivery-quantities-heading">
        <h2 id="delivery-quantities-heading">Miktarlar</h2>
        {selectedProducts.map((entry) => <div className="field-group" key={entry.product.id}>
          <label htmlFor={`delivery-quantity-${entry.product.id}`}>Miktar: {entry.product.name}</label>
          <input id={`delivery-quantity-${entry.product.id}`} type="number" min="0.001" step="0.001"
            inputMode="decimal" value={entry.quantity} required disabled={pending}
            onChange={(event) => updateSelectedQuantity(entry.product.id, event.target.value)} />
        </div>)}
      </div>}
      <div className="delivery-pair">
        <div className="field-group"><label htmlFor="delivery-purpose">Teslim amacı</label>
          <select id="delivery-purpose" name="deliveryPurpose" required disabled={pending} defaultValue="SALE">
            <option value="SALE">Satış</option><option value="SAMPLE">Numune</option><option value="CONSIGNMENT">Konsinye</option><option value="RETURN">İade</option><option value="OTHER">Diğer</option>
          </select></div>
      </div>
      <div className="field-group"><label htmlFor="delivery-scheduled-at">Planlanan teslim zamanı</label>
        <input id="delivery-scheduled-at" name="scheduledAt" type="datetime-local" required disabled={pending}
          value={scheduledLocal} onChange={(event) => setScheduledLocal(event.target.value)} /></div>
      <CustomerScheduleNotice
        evaluation={authoritativeEvaluation ?? evaluation}
        mode={user.role === 'STAFF' ? 'staff' : 'manager'}
        overrideReason={overrideReason}
        onOverrideReasonChange={setOverrideReason}
        onUseSuggestedAlternative={useSuggestedAlternative}
      />
      {previewing && <p className="field-status" role="status">Müşteri planı kontrol ediliyor…</p>}
      <AvailableSlotsNotice
        {...availableSlotSearch}
        onSelect={useAvailableSlot}
      />
      <div className="field-group"><label htmlFor="delivery-note">Teslim notu (isteğe bağlı)</label>
        <textarea id="delivery-note" name="deliveryNote" rows={3} disabled={pending} /></div>
      <div className="form-actions">
        <button className="secondary-button" type="button" onClick={onCancel} disabled={pending}>Vazgeç</button>
        <button className="primary-button" type="submit" disabled={submitDisabled}>{pending ? 'Kaydediliyor…' : 'Teslimi kaydet'}</button>
      </div>
    </form>
    <CustomerCreateSideFlow
      open={customerCreateOpen}
      user={user}
      returnFocusRef={customerCreateTriggerRef}
      onCancel={() => setCustomerCreateOpen(false)}
      onCreated={addCreatedCustomer}
    />
  </main>;
}
