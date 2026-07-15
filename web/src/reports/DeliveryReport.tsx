import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { paths } from '../paths';
import type { CurrentUser } from '../services/api';
import { listStaff, type StaffProfile } from '../services/people-api';
import { getDeliveryReport } from './reports-api';
import { deliverySearch, readDeliverySearch, validateRequestedRange } from './report-search';
import type { DeliveryReportResponse } from './report-types';

const purposeLabels = { SALE: 'Satış', SAMPLE: 'Numune', CONSIGNMENT: 'Konsinye', RETURN: 'İade', OTHER: 'Diğer' } as const;
const formatDate = (value: string) => new Intl.DateTimeFormat('tr-TR', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(`${value}T00:00:00Z`));

export function DeliveryReportView({ report }: { report: DeliveryReportResponse }) {
  if (report.items.length === 0) return <div className="report-empty"><p>Seçilen dönemde onaylı teslim bulunmuyor.</p></div>;
  if (report.groupBy === 'day') return <ReportTable headings={['Tarih', 'Birim', 'Miktar']} rows={report.items.map((item) => [formatDate(item.date), item.unit ?? 'Birim belirtilmedi', item.quantity])} />;
  if (report.groupBy === 'purpose') return <ReportTable headings={['Amaç', 'Birim', 'Miktar']} rows={report.items.map((item) => [purposeLabels[item.purpose], item.unit ?? 'Birim belirtilmedi', item.quantity])} />;
  if (report.groupBy === 'product') return <ReportTable headings={['Ürün', 'SKU', 'Model', 'Birim', 'Miktar']} rows={report.items.map((item) => [item.productNameSnapshot, item.productSkuSnapshot ?? 'Belirtilmedi', item.productModelSnapshot ?? 'Belirtilmedi', item.unit ?? 'Birim belirtilmedi', item.quantity])} />;
  return <ReportTable headings={['Personel', 'Birim', 'Miktar']} rows={report.items.map((item) => [`${item.staff.name}${item.staff.isActive ? '' : ' (Pasif)'}`, item.unit ?? 'Birim belirtilmedi', item.quantity])} />;
}

function ReportTable({ headings, rows }: { headings: string[]; rows: string[][] }) {
  return <table className="report-table responsive-report-table"><caption>Teslim miktarları</caption><thead><tr>{headings.map((heading) => <th key={heading} scope="col">{heading}</th>)}</tr></thead>
    <tbody>{rows.map((row, index) => <tr key={JSON.stringify([index, row])}>{row.map((value, cell) => cell === 0 ? <th key={cell} scope="row" data-label={headings[cell]}>{value}</th> : <td key={cell} data-label={headings[cell]}>{value}</td>)}</tr>)}</tbody></table>;
}

type StaffOptions = { status: 'loading' | 'ready' | 'error'; items: StaffProfile[] };
export function DeliveryReport({ user }: { user: CurrentUser }) {
  const [search, setSearch] = useSearchParams(); const state = readDeliverySearch(search);
  const [report, setReport] = useState<DeliveryReportResponse | null>(null); const [loading, setLoading] = useState(true); const [error, setError] = useState('');
  const [options, setOptions] = useState<StaffOptions>({ status: 'loading', items: [] }); const [reload, setReload] = useState(0); const [formError, setFormError] = useState('');
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!state.canonical) setSearch(deliverySearch(state), { replace: true }); }, [state, setSearch]);
  useEffect(() => { let current = true; setOptions({ status: 'loading', items: [] }); void listStaff(user.role === 'ADMIN' ? 'all' : 'active').then(
    (items) => current && setOptions({ status: 'ready', items }), () => current && setOptions({ status: 'error', items: [] })); return () => { current = false; };
  }, [user.role, reload]);
  const { from, to, groupBy, staffUserId, offset } = state;
  const load = useCallback(async () => { setLoading(true); setError(''); try {
    const next = await getDeliveryReport({ groupBy, staffUserId,
      requestedRange: from && to ? { from, to } : null, limit: 50, offset }); setReport(next);
    if (!from || !to) setSearch(deliverySearch({ from: next.range.from, to: next.range.to, groupBy, staffUserId, offset, canonical: true }), { replace: true });
  } catch (reason) { setError(reason instanceof Error ? reason.message : 'Teslim raporu yüklenemedi.'); } finally { setLoading(false); }
  }, [from, to, groupBy, staffUserId, offset, setSearch]); useEffect(() => { void load(); }, [load]);
  const allowed = useMemo(() => new Set([...options.items.map((item) => item.user.id), ...(state.staffUserId ? [state.staffUserId] : [])]), [options.items, state.staffUserId]);
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const data = new FormData(event.currentTarget); const from = String(data.get('from') ?? ''); const to = String(data.get('to') ?? ''); const range = validateRequestedRange(from, to);
    const groupBy = String(data.get('groupBy') ?? ''); const selected = String(data.get('staffUserId') ?? '');
    if (!range.ok || !['day', 'purpose', 'product', 'staff'].includes(groupBy) || (selected && !allowed.has(selected))) { setFormError(!range.ok ? range.errors[0]?.message ?? 'Tarih aralığı geçersiz.' : 'Geçerli filtreler seçin.'); requestAnimationFrame(() => errorRef.current?.focus()); return; }
    setFormError(''); setSearch(deliverySearch({ ...range.value, groupBy: groupBy as DeliveryReportResponse['groupBy'], staffUserId: selected || null, offset: 0, canonical: true })); }
  const unavailable = state.staffUserId !== null && !options.items.some((item) => item.user.id === state.staffUserId);
  return <main className="workspace report-workspace"><header className="workspace-heading"><div><p className="eyebrow">Raporlar</p><h1>Teslim raporu</h1></div><nav className="report-nav" aria-label="Rapor bölümleri"><Link to={paths.reports}>Özet</Link><Link to={paths.approvalReports}>Onaylar</Link></nav></header>
    <form key={JSON.stringify([state.from, state.to, state.groupBy, state.staffUserId])} className="report-filters report-filters-wide" onSubmit={submit} noValidate>
      <label>Başlangıç<input name="from" type="date" defaultValue={state.from ?? ''}
        aria-invalid={formError ? true : undefined}
        aria-describedby={formError ? 'delivery-filter-error' : undefined} /></label>
      <label>Bitiş<input name="to" type="date" defaultValue={state.to ?? ''}
        aria-invalid={formError ? true : undefined}
        aria-describedby={formError ? 'delivery-filter-error' : undefined} /></label>
      <label>Gruplama<select name="groupBy" defaultValue={state.groupBy}
        aria-describedby={formError ? 'delivery-filter-error' : undefined}><option value="day">Gün</option><option value="purpose">Amaç</option><option value="product">Ürün</option><option value="staff">Personel</option></select></label>
      <label>Personel<select name="staffUserId" defaultValue={state.staffUserId ?? ''} disabled={options.status === 'loading'}
        aria-describedby={formError ? 'delivery-filter-error' : undefined}><option value="">Tüm personel</option>{unavailable && <option value={state.staffUserId!}>Seçili personel (listede yok)</option>}{options.items.map((item) => <option key={item.user.id} value={item.user.id}>{item.user.name}{item.user.isActive ? '' : ' (Pasif)'}</option>)}</select></label>
      <button className="secondary-button">Uygula</button></form>
    {options.status === 'error' && <div className="inline-report-error" role="alert">Personel seçenekleri yüklenemedi. <button onClick={() => setReload((value) => value + 1)}>Tekrar dene</button></div>}
    {formError && <div id="delivery-filter-error" ref={errorRef} className="form-error"
      role="alert" tabIndex={-1}><h2>Filtreleri kontrol edin</h2><p>{formError}</p></div>}
    {loading && <section className="report-loading" aria-busy="true"><h1>Teslim raporu yükleniyor</h1></section>}
    {!loading && error && <div className="workspace-message" role="alert"><h2>Teslim raporu yüklenemedi</h2><p>{error}</p><button className="secondary-button" onClick={() => void load()}>Tekrar dene</button></div>}
    {!loading && !error && report && <><DeliveryReportView report={report} /><div className="report-pagination"><button disabled={state.offset === 0} onClick={() => setSearch(deliverySearch({ ...state, offset: Math.max(0, state.offset - 50) }))}>Önceki</button><span>{report.total} grup</span><button disabled={state.offset + report.limit >= report.total} onClick={() => setSearch(deliverySearch({ ...state, offset: state.offset + report.limit }))}>Sonraki</button></div></>}
  </main>;
}
