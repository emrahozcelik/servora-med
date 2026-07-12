import { useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import { paths } from './paths';
import { ApiError, type CurrentUser } from './services/api';
import {
  createCustomer, listCustomers, type CreateCustomerInput, type CustomerFilters,
  type CustomerStatus, type CustomerSummary, type CustomerType,
} from './services/crm-api';
import { listStaff, type StaffProfile } from './services/people-api';

const customerTypeLabels: Record<CustomerType, string> = {
  clinic: 'Klinik', hospital: 'Hastane', dealer: 'Bayi', company: 'Firma', other: 'Diğer',
};
const customerStatusLabels: Record<CustomerStatus, string> = {
  prospect: 'Aday', active: 'Aktif', inactive: 'Pasif',
};

export type CustomerFilterValues = Omit<Partial<CustomerFilters>, 'status'> & { status?: CustomerStatus | 'all' };
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
    ...(status === 'prospect' || status === 'active' || status === 'inactive' || status === 'all' ? { status } : {}),
    ...(customerType === 'clinic' || customerType === 'hospital' || customerType === 'dealer' || customerType === 'company' || customerType === 'other'
      ? { customerType } : {}),
    ...(params.get('city') ? { city: params.get('city')! } : {}),
    ...(params.get('assignedStaffUserId') ? { assignedStaffUserId: params.get('assignedStaffUserId')! } : {}),
    ...(params.get('unassigned') === 'true' ? { unassigned: true } : {}),
    ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
    ...(Number.isFinite(offset) && offset >= 0 ? { offset } : {}),
  };
}

function CustomerFiltersView({ filters, staff, onChange }: {
  filters: CustomerFilterValues;
  staff: StaffProfile[];
  onChange: (name: string, value: string | boolean) => void;
}) {
  return <form className="customer-filters" role="search" onSubmit={(event) => event.preventDefault()}>
    <div className="field-group"><label htmlFor="customer-search">Müşteri ara</label>
      <input id="customer-search" type="search" value={filters.q ?? ''} onChange={(event) => onChange('q', event.target.value)} /></div>
    <label className="field-group" htmlFor="customer-status">Durum
      <select id="customer-status" value={filters.status ?? ''} onChange={(event) => onChange('status', event.target.value)}>
        <option value="">Aktif ve aday</option><option value="active">Yalnız aktif</option><option value="prospect">Yalnız aday</option><option value="inactive">Pasif</option><option value="all">Tümü</option>
      </select>
    </label>
    <label className="field-group" htmlFor="customer-type">Müşteri türü
      <select id="customer-type" value={filters.customerType ?? ''} onChange={(event) => onChange('customerType', event.target.value)}>
        <option value="">Tümü</option>{Object.entries(customerTypeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
    </label>
    <label className="field-group" htmlFor="customer-city">Şehir
      <input id="customer-city" value={filters.city ?? ''} onChange={(event) => onChange('city', event.target.value)} />
    </label>
    <label className="field-group" htmlFor="customer-staff">Sorumlu personel
      <select id="customer-staff" value={filters.assignedStaffUserId ?? ''} onChange={(event) => onChange('assignedStaffUserId', event.target.value)} disabled={filters.unassigned}>
        <option value="">Tümü</option>{staff.map((profile) => <option key={profile.user.id} value={profile.user.id}>{profile.user.name}</option>)}
      </select>
    </label>
    <label className="customer-check" htmlFor="customer-unassigned">
      <input id="customer-unassigned" type="checkbox" checked={filters.unassigned ?? false} onChange={(event) => onChange('unassigned', event.target.checked)} />
      <span>Atanmamış müşteriler</span>
    </label>
  </form>;
}

export function CustomerListView({ state, user, hasFilters, onRetry, onCreate, filters, staff = [], onFilterChange }: {
  state: CustomerListState;
  user: CurrentUser;
  hasFilters: boolean;
  onRetry: () => void;
  onCreate: () => void;
  filters?: CustomerFilterValues;
  staff?: StaffProfile[];
  onFilterChange?: (name: string, value: string | boolean) => void;
}) {
  return <main className="workspace customer-workspace">
    <div className="workspace-heading"><div><p className="eyebrow">CRM</p><h1>Müşteriler</h1></div>
      {user.role !== 'STAFF' && <button className="primary-button compact-button" type="button" onClick={onCreate}>Yeni müşteri</button>}
    </div>
    {filters && onFilterChange && <CustomerFiltersView filters={filters} staff={staff} onChange={onFilterChange} />}
    {state.kind === 'loading' && <section className="customer-loading" aria-busy="true" aria-live="polite"><h2>Müşteriler yükleniyor</h2><span /><span /><span /></section>}
    {state.kind === 'error' && <div className="workspace-message" role="alert"><h2>Müşteriler yüklenemedi</h2><p>{state.message}</p>
      {state.retryable && <button className="secondary-button" type="button" onClick={onRetry}>Tekrar dene</button>}</div>}
    {state.kind === 'ready' && state.customers.length === 0 && <div className="workspace-message"><h2>{hasFilters ? 'Filtrelere uygun müşteri bulunamadı' : 'Henüz müşteri kaydı yok'}</h2>
      <p>{hasFilters ? 'Filtreleri değiştirerek yeniden deneyin.' : 'İlk müşteri kaydı eklendiğinde burada görünecek.'}</p></div>}
    {state.kind === 'ready' && state.customers.length > 0 && <ul className="customer-list">{state.customers.map((customer) => <li key={customer.id}>
      <article className="customer-row">
        <div className="customer-identity"><div className="customer-signals"><span className="status">{customerStatusLabels[customer.status]}</span><span>{customerTypeLabels[customer.customerType]}</span></div>
          <h2><Link to={paths.customer(customer.id)}>{customer.name}</Link></h2><p>{[customer.city, customer.district].filter(Boolean).join(', ') || 'Konum belirtilmedi'}</p></div>
        <dl className="customer-facts"><div><dt>Sorumlu personel</dt><dd>{customer.assignedStaffName ?? 'Atanmadı'}</dd></div>
          <div><dt>Birincil kişi</dt><dd>{customer.primaryContact?.name ?? 'Belirlenmedi'}</dd></div></dl>
        <Link className="secondary-button customer-open" to={paths.customer(customer.id)} aria-label={`${customer.name} müşterisini aç`}>Kaydı aç</Link>
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
  return { ...filters, q: debouncedQuery || undefined, status: filters.status === 'all' ? undefined : filters.status };
}

export function scheduleCustomerSearch(callback: () => void, delay = 250) {
  const timer = setTimeout(callback, delay);
  return () => clearTimeout(timer);
}

export function createRequestGate() {
  let generation = 0;
  return { next: () => ++generation, isCurrent: (candidate: number) => candidate === generation };
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

export function CustomerListScreen({ user }: { user: CurrentUser }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const filters = customerFiltersFromParams(params);
  const [debouncedQuery, setDebouncedQuery] = useState(filters.q ?? '');
  const [state, setState] = useState<CustomerListState>({ kind: 'loading' });
  const [staff, setStaff] = useState<StaffProfile[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
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
  const hasFilters = Boolean(filters.q || filters.customerType || filters.city || filters.assignedStaffUserId || filters.unassigned || filters.status);
  return <CustomerListView state={state} user={user} hasFilters={hasFilters} filters={filters} staff={staff}
    onFilterChange={changeFilter} onRetry={() => setReloadKey((value) => value + 1)} onCreate={() => navigate(paths.newCustomer)} />;
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
