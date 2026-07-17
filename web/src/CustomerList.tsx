import {
  useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent, type RefObject,
} from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import { paths } from './paths';
import { ApiError, type CurrentUser } from './services/api';
import {
  createCustomer, deleteCustomer, listCustomers, type CreateCustomerInput, type CustomerFilters,
  type CustomerStatus, type CustomerSummary, type CustomerType,
} from './services/crm-api';
import { listStaff, type StaffProfile } from './services/people-api';
import { createRequestGate } from './services/request-gate';
import { isInteractiveTarget } from './ui/clickable-card';
import { FilterSheet, countTruthy } from './ui/FilterSheet';

export { createRequestGate } from './services/request-gate';

const customerTypeLabels: Record<CustomerType, string> = {
  clinic: 'Klinik', hospital: 'Hastane', dealer: 'Bayi', company: 'Firma', other: 'Diğer',
};
const customerStatusLabels: Record<CustomerStatus, string> = {
  prospect: 'Aday', active: 'Aktif', inactive: 'Pasif',
};

export type CustomerFilterValues = Partial<CustomerFilters>;
export type CustomerListState =
  | { kind: 'loading' }
  | { kind: 'ready'; customers: CustomerSummary[] }
  | { kind: 'error'; message: string; retryable: boolean };

export function customerFiltersFromParams(params: URLSearchParams): CustomerFilterValues {
  const status = params.get('status');
  const customerType = params.get('customerType');
  const limitValue = params.get('limit'); const limit = limitValue === null ? NaN : Number(limitValue);
  const offsetValue = params.get('offset'); const offset = offsetValue === null ? NaN : Number(offsetValue);
  return {
    ...(params.get('q') ? { q: params.get('q')! } : {}),
    ...(status === 'prospect' || status === 'active' || status === 'inactive' ? { status } : {}),
    ...(customerType === 'clinic' || customerType === 'hospital' || customerType === 'dealer' || customerType === 'company' || customerType === 'other'
      ? { customerType } : {}),
    ...(params.get('city') ? { city: params.get('city')! } : {}),
    ...(params.get('assignedStaffUserId') ? { assignedStaffUserId: params.get('assignedStaffUserId')! } : {}),
    ...(params.get('unassigned') === 'true' ? { unassigned: true } : {}),
    ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
    ...(Number.isFinite(offset) && offset >= 0 ? { offset } : {}),
  };
}

export function countActiveCustomerFilters(filters: CustomerFilterValues): number {
  return countTruthy([
    filters.q,
    filters.status,
    filters.customerType,
    filters.city,
    filters.assignedStaffUserId,
    filters.unassigned,
  ]);
}

type CustomerDraft = {
  q: string;
  status: string;
  customerType: string;
  city: string;
  assignedStaffUserId: string;
  unassigned: boolean;
};

function draftFromFilters(filters: CustomerFilterValues): CustomerDraft {
  return {
    q: filters.q ?? '',
    status: filters.status ?? '',
    customerType: filters.customerType ?? '',
    city: filters.city ?? '',
    assignedStaffUserId: filters.assignedStaffUserId ?? '',
    unassigned: filters.unassigned ?? false,
  };
}

/** Compact filter sheet when shell is not desktop (same 64rem gate as AppShell). */
function useNarrow() {
  const desktopQuery = '(min-width: 64rem)';
  const [narrow, setNarrow] = useState(() => (
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? !window.matchMedia(desktopQuery).matches
      : false
  ));
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(desktopQuery);
    const onChange = (event: MediaQueryListEvent) => setNarrow(!event.matches);
    media.addEventListener('change', onChange);
    setNarrow(!media.matches);
    return () => media.removeEventListener('change', onChange);
  }, []);
  return narrow;
}

function CustomerFiltersView({ filters, staff, onChange, onApplyMany }: {
  filters: CustomerFilterValues;
  staff: StaffProfile[];
  onChange: (name: string, value: string | boolean) => void;
  onApplyMany?: (next: CustomerDraft) => void;
}) {
  const narrow = useNarrow();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [draft, setDraft] = useState(() => draftFromFilters(filters));
  const activeCount = countActiveCustomerFilters(filters);

  useEffect(() => {
    setDraft(draftFromFilters(filters));
  }, [filters.q, filters.status, filters.customerType, filters.city, filters.assignedStaffUserId, filters.unassigned]);

  function openSheet() {
    setDraft(draftFromFilters(filters));
    setSheetOpen(true);
  }

  function dismissSheet() {
    setDraft(draftFromFilters(filters));
    setSheetOpen(false);
  }

  function applySheet() {
    onApplyMany?.(draft);
    setSheetOpen(false);
  }

  function clearSheet() {
    const cleared: CustomerDraft = {
      q: '', status: '', customerType: '', city: '', assignedStaffUserId: '', unassigned: false,
    };
    setDraft(cleared);
    onApplyMany?.(cleared);
    setSheetOpen(false);
  }

  const filterFields = (prefix: string) => (
    <>
      <label className="field-group" htmlFor={`${prefix}-status`}>Durum
        <select id={`${prefix}-status`} value={narrow ? draft.status : (filters.status ?? '')}
          onChange={(event) => (narrow
            ? setDraft({ ...draft, status: event.target.value })
            : onChange('status', event.target.value))}>
          <option value="">Aktif ve aday</option><option value="active">Yalnız aktif</option><option value="prospect">Yalnız aday</option><option value="inactive">Pasif</option>
        </select>
      </label>
      <label className="field-group" htmlFor={`${prefix}-type`}>Müşteri türü
        <select id={`${prefix}-type`} value={narrow ? draft.customerType : (filters.customerType ?? '')}
          onChange={(event) => (narrow
            ? setDraft({ ...draft, customerType: event.target.value })
            : onChange('customerType', event.target.value))}>
          <option value="">Tümü</option>{Object.entries(customerTypeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <label className="field-group" htmlFor={`${prefix}-city`}>Şehir
        <input id={`${prefix}-city`} value={narrow ? draft.city : (filters.city ?? '')}
          onChange={(event) => (narrow
            ? setDraft({ ...draft, city: event.target.value })
            : onChange('city', event.target.value))} />
      </label>
      <label className="field-group" htmlFor={`${prefix}-staff`}>Sorumlu personel
        <select id={`${prefix}-staff`}
          value={narrow ? draft.assignedStaffUserId : (filters.assignedStaffUserId ?? '')}
          disabled={narrow ? draft.unassigned : (filters.unassigned ?? false)}
          onChange={(event) => (narrow
            ? setDraft({ ...draft, assignedStaffUserId: event.target.value })
            : onChange('assignedStaffUserId', event.target.value))}>
          <option value="">Tümü</option>{staff.map((profile) => <option key={profile.user.id} value={profile.user.id}>{profile.user.name}</option>)}
        </select>
      </label>
      <label className="customer-check" htmlFor={`${prefix}-unassigned`}>
        <input id={`${prefix}-unassigned`} type="checkbox"
          checked={narrow ? draft.unassigned : (filters.unassigned ?? false)}
          onChange={(event) => (narrow
            ? setDraft({
              ...draft,
              unassigned: event.target.checked,
              assignedStaffUserId: event.target.checked ? '' : draft.assignedStaffUserId,
            })
            : onChange('unassigned', event.target.checked))} />
        <span>Atanmamış müşteriler</span>
      </label>
    </>
  );

  const filterTriggerRef = useRef<HTMLButtonElement>(null);

  if (narrow) {
    return (
      <div className="filter-region">
      <div className="customer-filters customer-filters--compact surface">
        <form className="customer-filter-compact-bar" role="search" onSubmit={(event) => event.preventDefault()}>
          <div className="field-group"><label htmlFor="customer-search">Müşteri ara</label>
            <input id="customer-search" type="search" value={filters.q ?? ''}
              onChange={(event) => onChange('q', event.target.value)} /></div>
          <button
            ref={filterTriggerRef}
            type="button"
            className="secondary-button filter-sheet-trigger"
            aria-expanded={sheetOpen}
            onClick={openSheet}
          >
            {activeCount > 0 ? `Filtreler ${activeCount}` : 'Filtreler'}
          </button>
        </form>
        <FilterSheet
          open={sheetOpen}
          title="Müşteri filtreleri"
          onDismiss={dismissSheet}
          onApply={applySheet}
          onClear={clearSheet}
          returnFocusRef={filterTriggerRef}
        >
          {filterFields('customer-sheet')}
        </FilterSheet>
      </div>
      </div>
    );
  }

  return <div className="filter-region"><form className="customer-filters surface" role="search" onSubmit={(event) => event.preventDefault()}>
    <div className="field-group"><label htmlFor="customer-search">Müşteri ara</label>
      <input id="customer-search" type="search" value={filters.q ?? ''} onChange={(event) => onChange('q', event.target.value)} /></div>
    {filterFields('customer')}
  </form></div>;
}

function CustomerDeleteDialog({ customer, pending, onCancel, onConfirm, trigger }: {
  customer: CustomerSummary;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  trigger: RefObject<HTMLButtonElement | null>;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => { cancelRef.current?.focus(); }, []);
  useEffect(() => {
    function keepFocusInside(event: FocusEvent) {
      if (dialogRef.current?.contains(event.target as Node)) return;
      (cancelRef.current ?? dialogRef.current)?.focus();
    }
    document.addEventListener('focusin', keepFocusInside);
    return () => {
      document.removeEventListener('focusin', keepFocusInside);
      trigger.current?.focus();
    };
  }, [trigger]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' && !pending) { event.preventDefault(); onCancel(); return; }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
    if (focusable.length === 0) { event.preventDefault(); dialogRef.current?.focus(); return; }
    const first = focusable[0]!; const last = focusable[focusable.length - 1]!;
    if (focusable.length === 1) { event.preventDefault(); first.focus(); }
    else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    else if (!dialogRef.current?.contains(document.activeElement)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  }

  return <div className="product-dialog-backdrop">
    <div className="product-dialog" role="dialog" aria-modal="true" aria-labelledby="customer-delete-title"
      tabIndex={-1} aria-describedby="customer-delete-description" ref={dialogRef} onKeyDown={handleKeyDown}>
      <h2 id="customer-delete-title">{customer.name} müşterisini sil</h2>
      <p id="customer-delete-description">Bu işlem geri alınamaz. Müşteri ve ilgili kişiler kalıcı olarak silinir.</p>
      <div className="product-dialog-actions">
        <button className="secondary-button" type="button" ref={cancelRef}
          onClick={() => { if (!pending) onCancel(); }} aria-disabled={pending}>Vazgeç</button>
        <button className="destructive-button" type="button" onClick={onConfirm} disabled={pending}>
          {pending ? 'Siliniyor…' : 'Sil'}
        </button>
      </div>
    </div>
  </div>;
}

function openCardIfEmpty(
  event: MouseEvent<HTMLElement>,
  open: ((id: string) => void) | undefined,
  id: string,
) {
  if (!open || isInteractiveTarget(event.target)) return;
  open(id);
}

export function CustomerListView({ state, user, hasFilters, onRetry, onCreate, filters, staff = [], onFilterChange, onApplyFilters, onOpenCustomer, onRequestDelete, feedback = '', actionError = '' }: {
  state: CustomerListState;
  user: CurrentUser;
  hasFilters: boolean;
  onRetry: () => void;
  onCreate: () => void;
  filters?: CustomerFilterValues;
  staff?: StaffProfile[];
  onFilterChange?: (name: string, value: string | boolean) => void;
  onApplyFilters?: (next: CustomerDraft) => void;
  onOpenCustomer?: (customerId: string) => void;
  onRequestDelete?: (customer: CustomerSummary, trigger: HTMLButtonElement) => void;
  feedback?: string;
  actionError?: string;
}) {
  const canManage = user.role !== 'STAFF';

  return <main className="workspace customer-workspace">
    <div className="workspace-heading"><div><p className="eyebrow">CRM</p><h1>Müşteriler</h1></div>
      {canManage && <button className="primary-button compact-button" type="button" onClick={onCreate}>Yeni müşteri</button>}
    </div>
    {filters && onFilterChange && <CustomerFiltersView filters={filters} staff={staff} onChange={onFilterChange} onApplyMany={onApplyFilters} />}
    <div className="sr-only" role="status" aria-live="polite">{feedback}</div>
    {actionError && <div className="workspace-message" role="alert"><p>{actionError}</p></div>}
    {state.kind === 'loading' && <section className="customer-loading" aria-busy="true" aria-live="polite"><h2>Müşteriler yükleniyor</h2><span /><span /><span /></section>}
    {state.kind === 'error' && <div className="workspace-message" role="alert"><h2>Müşteriler yüklenemedi</h2><p>{state.message}</p>
      {state.retryable && <button className="secondary-button" type="button" onClick={onRetry}>Tekrar dene</button>}</div>}
    {state.kind === 'ready' && state.customers.length === 0 && <div className="workspace-message"><h2>{hasFilters ? 'Filtrelere uygun müşteri bulunamadı' : 'Henüz müşteri kaydı yok'}</h2>
      <p>{hasFilters ? 'Filtreleri değiştirerek yeniden deneyin.' : 'İlk müşteri kaydı eklendiğinde burada görünecek.'}</p></div>}
    {state.kind === 'ready' && state.customers.length > 0 && <ul className="customer-list">{state.customers.map((customer) => <li key={customer.id}>
      <article className="customer-row customer-list-card" data-customer-id={customer.id}
        onClick={(event) => openCardIfEmpty(event, onOpenCustomer, customer.id)}>
        <div className="customer-identity"><div className="customer-signals"><span className="status">{customerStatusLabels[customer.status]}</span><span>{customerTypeLabels[customer.customerType]}</span></div>
          <h2><Link className="customer-title-link" to={paths.customer(customer.id)}>{customer.name}</Link></h2>
          <p>{[customer.city, customer.district].filter(Boolean).join(', ') || 'Konum belirtilmedi'}</p></div>
        <dl className="customer-facts"><div><dt>Sorumlu personel</dt><dd>{customer.assignedStaffName ?? 'Atanmadı'}</dd></div>
          <div><dt>Birincil kişi</dt><dd>{customer.primaryContact?.name ?? 'Belirlenmedi'}</dd></div></dl>
        {canManage && <div className="customer-row-commands">
          <Link className="secondary-button" to={paths.customer(customer.id)}
            aria-label={`${customer.name} müşterisini düzenle`}>Düzenle</Link>
          <button className="destructive-button" type="button"
            aria-label={`${customer.name} müşterisini sil`}
            onClick={(event) => onRequestDelete?.(customer, event.currentTarget)}>Sil</button>
        </div>}
      </article></li>)}</ul>}
  </main>;
}

export type CustomerFieldErrors = Partial<Record<'name' | 'customerType' | 'email', string>>;

export function CustomerCreateForm({ staff, pending, similarCustomers, fieldErrors = {}, error = '', errorRef, onCancel, onSubmit, onNameChange }: {
  staff: StaffProfile[];
  pending: boolean;
  similarCustomers: CustomerSummary[];
  fieldErrors?: CustomerFieldErrors;
  error?: string;
  errorRef?: RefObject<HTMLDivElement | null>;
  onCancel: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onNameChange?: (name: string) => void;
}) {
  return <main className="customer-create"><div className="detail-heading"><div><p className="eyebrow">CRM</p><h1>Yeni müşteri</h1></div>
    <button className="secondary-button" type="button" onClick={onCancel} disabled={pending}>Vazgeç</button></div>
    <p className="form-intro">Klinik veya firma kaydını oluşturun. İlgili kişiler müşteri kaydından sonra eklenir.</p>
    {error && <div className="form-error" role="alert" tabIndex={-1} ref={errorRef}>{error}</div>}
    {similarCustomers.length > 0 && <section className="similar-customers" aria-labelledby="similar-title"><h2 id="similar-title">Benzer müşteri kayıtları</h2>
      <p>Bu kayıtlar oluşturmayı engellemez. Yinelenen müşteri olmadığını kontrol edin.</p><ul>{similarCustomers.map((customer) => <li key={customer.id}><Link to={paths.customer(customer.id)}>{customer.name}</Link></li>)}</ul></section>}
    <form className="customer-form" onSubmit={onSubmit} noValidate>
      <div className="field-group"><label htmlFor="customer-name">Müşteri adı</label>
        <input id="customer-name" name="name" required disabled={pending} aria-invalid={fieldErrors.name ? true : undefined}
          aria-describedby={fieldErrors.name ? 'customer-name-error' : undefined} onChange={(event) => onNameChange?.(event.target.value)} />
      </div>{fieldErrors.name && <p className="field-error" id="customer-name-error">{fieldErrors.name}</p>}
      <label className="field-group" htmlFor="create-customer-type">Müşteri türü
        <select id="create-customer-type" name="customerType" defaultValue="clinic" disabled={pending}>{Object.entries(customerTypeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      </label>
      <div className="customer-form-pair"><label className="field-group" htmlFor="customer-tax">Vergi numarası<input id="customer-tax" name="taxNumber" disabled={pending} /></label>
        <label className="field-group" htmlFor="customer-phone">Telefon<input id="customer-phone" name="phone" type="tel" disabled={pending} /></label></div>
      <label className="field-group" htmlFor="customer-email">E-posta<input id="customer-email" name="email" type="email" disabled={pending}
        aria-invalid={fieldErrors.email ? true : undefined} aria-describedby={fieldErrors.email ? 'customer-email-error' : undefined} /></label>
      {fieldErrors.email && <p className="field-error" id="customer-email-error">{fieldErrors.email}</p>}
      <div className="customer-form-pair"><label className="field-group" htmlFor="customer-create-city">Şehir<input id="customer-create-city" name="city" disabled={pending} /></label>
        <label className="field-group" htmlFor="customer-district">İlçe<input id="customer-district" name="district" disabled={pending} /></label></div>
      <label className="field-group" htmlFor="customer-address">Adres<textarea id="customer-address" name="address" rows={3} disabled={pending} /></label>
      <label className="field-group" htmlFor="customer-assignee">Sorumlu personel<select id="customer-assignee" name="assignedStaffUserId" disabled={pending}><option value="">Atanmadı</option>
        {staff.map((profile) => <option key={profile.user.id} value={profile.user.id}>{profile.user.name}</option>)}</select></label>
      <div className="form-actions"><button className="secondary-button" type="button" onClick={onCancel} disabled={pending}>Vazgeç</button>
        <button className="primary-button compact-button" type="submit" disabled={pending}>{pending ? 'Oluşturuluyor…' : 'Müşteriyi oluştur'}</button></div>
    </form>
  </main>;
}

export async function createCustomerWithRecovery(input: CreateCustomerInput, dependencies = {
  create: createCustomer, refetch: listCustomers,
}) {
  try { return { customer: await dependencies.create(input), resultUnknown: false, matches: [] as CustomerSummary[] }; }
  catch (error) {
    if (!(error instanceof ApiError) || (error.code !== 'NETWORK_ERROR' && error.code !== 'INVALID_RESPONSE')) throw error;
    const result = await dependencies.refetch({ q: input.name });
    return { customer: null, resultUnknown: true, matches: result.items };
  }
}

export function customerRequestFilters(filters: CustomerFilterValues, debouncedQuery: string): CustomerFilters {
  return { ...filters, q: debouncedQuery || undefined };
}

export function scheduleCustomerSearch(callback: () => void, delay = 250) {
  const timer = setTimeout(callback, delay);
  return () => clearTimeout(timer);
}

function nullable(data: FormData, name: string) {
  return String(data.get(name) ?? '').trim() || null;
}

export function customerInputFromFormData(data: FormData): CreateCustomerInput {
  return {
    name: String(data.get('name') ?? '').trim(),
    customerType: String(data.get('customerType')) as CustomerType,
    taxNumber: nullable(data, 'taxNumber'), phone: nullable(data, 'phone'), email: nullable(data, 'email'),
    city: nullable(data, 'city'), district: nullable(data, 'district'), address: nullable(data, 'address'),
    assignedStaffUserId: nullable(data, 'assignedStaffUserId'), status: 'prospect',
  };
}

export function CustomerListScreen({ user, remove = deleteCustomer }: {
  user: CurrentUser;
  remove?: typeof deleteCustomer;
}) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const filters = customerFiltersFromParams(params);
  const [debouncedQuery, setDebouncedQuery] = useState(filters.q ?? '');
  const [state, setState] = useState<CustomerListState>({ kind: 'loading' });
  const [staff, setStaff] = useState<StaffProfile[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const [deleteTarget, setDeleteTarget] = useState<CustomerSummary | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [actionError, setActionError] = useState('');
  const deleteTriggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => scheduleCustomerSearch(() => setDebouncedQuery(filters.q ?? '')), [filters.q]);
  useEffect(() => {
    let active = true; setState({ kind: 'loading' });
    const requestFilters = customerRequestFilters(filters, debouncedQuery);
    Promise.all([listCustomers(requestFilters), user.role === 'STAFF' ? Promise.resolve([]) : listStaff('active')])
      .then(([result, profiles]) => { if (active) { setState({ kind: 'ready', customers: result.items }); setStaff(profiles); } })
      .catch((error) => { if (active) setState({ kind: 'error', message: error instanceof Error ? error.message : 'Müşteriler yüklenemedi.', retryable: error instanceof ApiError ? error.retryable : true }); });
    return () => { active = false; };
  }, [debouncedQuery, filters.status, filters.customerType, filters.city, filters.assignedStaffUserId, filters.unassigned, filters.limit, filters.offset, reloadKey, user.role]);
  function changeFilter(name: string, value: string | boolean) {
    const next = new URLSearchParams(params);
    if (value === '' || value === false) next.delete(name); else next.set(name, String(value));
    if (name === 'unassigned' && value === true) next.delete('assignedStaffUserId');
    next.delete('offset'); setParams(next);
  }
  function applyManyFilters(draft: CustomerDraft) {
    const next = new URLSearchParams();
    if (draft.q) next.set('q', draft.q);
    if (draft.status) next.set('status', draft.status);
    if (draft.customerType) next.set('customerType', draft.customerType);
    if (draft.city) next.set('city', draft.city);
    if (draft.unassigned) next.set('unassigned', 'true');
    else if (draft.assignedStaffUserId) next.set('assignedStaffUserId', draft.assignedStaffUserId);
    setParams(next);
  }
  function requestDelete(customer: CustomerSummary, trigger: HTMLButtonElement) {
    if (deletePending) return;
    deleteTriggerRef.current = trigger;
    setActionError('');
    setDeleteTarget(customer);
  }
  async function confirmDelete() {
    if (!deleteTarget || deletePending) return;
    setDeletePending(true);
    setActionError('');
    try {
      await remove(deleteTarget.id);
      const name = deleteTarget.name;
      setDeleteTarget(null);
      setFeedback(`${name} silindi.`);
      setReloadKey((value) => value + 1);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Müşteri silinemedi.');
      setDeleteTarget(null);
    } finally {
      setDeletePending(false);
    }
  }
  const hasFilters = Boolean(filters.q || filters.customerType || filters.city || filters.assignedStaffUserId || filters.unassigned || filters.status);
  return <>
    <CustomerListView state={state} user={user} hasFilters={hasFilters} filters={filters} staff={staff}
      onFilterChange={changeFilter} onApplyFilters={applyManyFilters}
      onRetry={() => setReloadKey((value) => value + 1)} onCreate={() => navigate(paths.newCustomer)}
      onOpenCustomer={(customerId) => navigate(paths.customer(customerId))}
      onRequestDelete={requestDelete} feedback={feedback} actionError={actionError} />
    {deleteTarget && <CustomerDeleteDialog customer={deleteTarget} pending={deletePending}
      trigger={deleteTriggerRef} onCancel={() => { if (!deletePending) setDeleteTarget(null); }}
      onConfirm={() => { void confirmDelete(); }} />}
  </>;
}

export function CustomerCreateScreen({ user }: { user: CurrentUser }) {
  const navigate = useNavigate();
  const [staff, setStaff] = useState<StaffProfile[]>([]);
  const [similar, setSimilar] = useState<CustomerSummary[]>([]);
  const [pending, setPending] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<CustomerFieldErrors>({});
  const [error, setError] = useState('');
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => { void listStaff('active').then(setStaff).catch(() => setStaff([])); }, []);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const similarRequestGate = useRef(createRequestGate());
  useEffect(() => () => { if (searchTimer.current) clearTimeout(searchTimer.current); similarRequestGate.current.next(); }, []);
  function nameChanged(name: string) {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const requestGeneration = similarRequestGate.current.next();
    searchTimer.current = setTimeout(() => {
      if (name.trim().length < 2) { setSimilar([]); return; }
      void listCustomers({ q: name.trim(), limit: 5, offset: 0 })
        .then((result) => { if (similarRequestGate.current.isCurrent(requestGeneration)) setSimilar(result.items); })
        .catch(() => { if (similarRequestGate.current.isCurrent(requestGeneration)) setSimilar([]); });
    }, 250);
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setFieldErrors({});
    const data = new FormData(event.currentTarget); const input = customerInputFromFormData(data); const { name, email } = input;
    const errors: CustomerFieldErrors = {};
    if (!name) errors.name = 'Müşteri adı zorunludur.';
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'Geçerli bir e-posta adresi yazın.';
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      const firstErrorId = errors.name ? 'customer-name' : 'customer-email';
      setTimeout(() => document.getElementById(firstErrorId)?.focus(), 0);
      return;
    }
    setPending(true);
    try {
      const result = await createCustomerWithRecovery(input);
      if (result.customer) navigate(paths.customer(result.customer.id));
      else { setSimilar(result.matches); setError('Kayıt isteğinin sonucu doğrulanamadı. Benzer kayıtları kontrol edip gerekirse yeniden deneyin.'); }
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Müşteri oluşturulamadı. Tekrar deneyin.'); }
    finally { setPending(false); }
  }
  if (user.role === 'STAFF') return null;
  return <CustomerCreateForm staff={staff} pending={pending} similarCustomers={similar} fieldErrors={fieldErrors} error={error} errorRef={errorRef}
    onCancel={() => navigate(paths.customers)} onSubmit={(event) => void submit(event)} onNameChange={nameChanged} />;
}
