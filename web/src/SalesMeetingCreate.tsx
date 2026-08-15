import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';

import {
  createJobCard,
  JOB_CARD_ENGAGEMENT_KINDS,
  type JobCardEngagementKind,
  type JobCardPriority,
} from './jobs/jobs-api';
import { JOB_CARD_ENGAGEMENT_LABELS } from './jobs/job-labels';
import { CustomerScheduleNotice } from './jobs/CustomerScheduleNotice';
import { useCustomerSchedulePreview } from './jobs/useCustomerSchedulePreview';
import {
  defaultScheduledLocalValue,
  isoInstantToLocalDateTime,
  localDateTimeToIso,
} from './jobs/scheduling';
import { ApiError, type CurrentUser } from './services/api';
import { listCustomers, type CustomerSummary } from './services/crm-api';
import { listStaff, type StaffProfile } from './services/people-api';

type LoadState = 'loading' | 'ready' | 'error';
type FieldErrors = {
  title?: string;
  customerId?: string;
  scheduledAt?: string;
  assignedTo?: string;
  engagementKind?: string;
};

async function loadAllCustomers() {
  const result: CustomerSummary[] = []; let offset = 0;
  while (true) {
    const page = await listCustomers({ limit: 200, offset });
    result.push(...page.items);
    if (result.length >= page.total || page.items.length === 0) return result;
    offset += page.items.length;
  }
}

export function SalesMeetingCreateScreen({ user, onCancel, onCreated, initialCustomerId = '' }: {
  user: CurrentUser; onCancel: () => void; onCreated: (jobCardId: string) => void;
  initialCustomerId?: string;
}) {
  const [title, setTitle] = useState(''); const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<JobCardPriority>('normal');
  const [engagementKind, setEngagementKind] = useState<JobCardEngagementKind | ''>('');
  const [scheduledLocal, setScheduledLocal] = useState(
    () => defaultScheduledLocalValue(new Date()),
  );
  const [customers, setCustomers] = useState<CustomerSummary[]>([]);
  const [customerState, setCustomerState] = useState<LoadState>('loading'); const [customerId, setCustomerId] = useState(initialCustomerId);
  const [staff, setStaff] = useState<StaffProfile[]>([]);
  const [staffState, setStaffState] = useState<LoadState>(user.role === 'STAFF' ? 'ready' : 'loading');
  const [assignedTo, setAssignedTo] = useState(user.role === 'STAFF' ? user.id : '');
  const [pending, setPending] = useState(false); const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [overrideReason, setOverrideReason] = useState('');
  const errorRef = useRef<HTMLDivElement>(null); const actionIdRef = useRef<string | null>(null);

  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);

  const { evaluation, previewing } = useCustomerSchedulePreview({
    type: 'SALES_MEETING',
    customerId: customerId || null,
    scheduledLocal,
    enabled: customerState === 'ready' && engagementKind !== '',
  });

  function useSuggestedAlternative() {
    if (!evaluation?.suggestedAlternativeAt) return;
    setScheduledLocal(isoInstantToLocalDateTime(evaluation.suggestedAlternativeAt));
  }

  async function loadCustomers() {
    setCustomerState('loading');
    try {
      const next = await loadAllCustomers(); setCustomers(next); setCustomerState('ready');
      if (initialCustomerId && next.some((item) => item.id === initialCustomerId)) {
        setCustomerId(initialCustomerId);
      } else if (initialCustomerId) {
        setCustomerId('');
      }
    } catch { setCustomers([]); setCustomerId(''); setCustomerState('error'); }
  }
  async function loadActiveStaff() {
    setStaffState('loading');
    try {
      setStaff((await listStaff('active')).filter((item) => item.user.isActive)); setStaffState('ready');
    } catch { setStaff([]); setStaffState('error'); }
  }
  useEffect(() => { void loadCustomers(); }, []); // initial required reference
  useEffect(() => { if (user.role !== 'STAFF') void loadActiveStaff(); }, [user.id, user.role]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (pending) return;
    const trimmedTitle = title.trim(); const selectedAssignee = user.role === 'STAFF' ? user.id : assignedTo;
    const nextErrors: FieldErrors = {};
    if (!trimmedTitle || Array.from(trimmedTitle).length > 255) nextErrors.title = 'Başlık 1 ile 255 karakter arasında olmalıdır.';
    if (!engagementKind) nextErrors.engagementKind = 'Görüşme veya ziyaret türünü seçin.';
    if (!customerId) nextErrors.customerId = 'Aktif veya aday bir müşteri seçin.';
    if (!scheduledLocal) nextErrors.scheduledAt = 'Planlanan görüşme zamanını seçin.';
    if (!selectedAssignee) nextErrors.assignedTo = 'Aktif bir sorumlu personel seçin.';
    setFieldErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      setError('Görüşme veya ziyareti planlamadan önce işaretli alanları düzeltin.');
      return;
    }
    setPending(true); setError(''); actionIdRef.current ??= crypto.randomUUID();
    try {
      const job = await createJobCard({
        clientActionId: actionIdRef.current,
        type: 'SALES_MEETING',
        engagementKind: engagementKind as JobCardEngagementKind,
        title: trimmedTitle,
        customerId, assignedTo: selectedAssignee,
        scheduledAt: localDateTimeToIso(scheduledLocal),
        description: description.trim() || null, contactId: null, priority,
        ...(overrideReason.trim() ? { overrideReason: overrideReason.trim() } : {}),
      });
      onCreated(job.id);
    } catch (caught) {
      if (caught instanceof ApiError && !caught.retryable) actionIdRef.current = null;
      // Retain entered form data; show the authoritative server error inline.
      setError(caught instanceof Error ? caught.message : 'Görüşme veya ziyaret planlanamadı. Tekrar deneyin.');
      setPending(false);
    }
  }

  const referencesUnavailable = customerState !== 'ready' || customers.length === 0
    || (user.role !== 'STAFF' && staffState !== 'ready');
  return <main className="task-create meeting-create">
    <div className="create-heading"><div><p className="eyebrow">Yeni kayıt</p><h1>Görüşme / ziyaret planla</h1></div></div>
    <p className="form-intro">
      Görüşme türünü, planlanan zamanı, müşteriyi ve sorumlu personeli belirleyin.
      Görüşme veya ziyaret sonucu daha sonra kaydedilir.
    </p>
    {error && <div className="form-error" role="alert" tabIndex={-1} ref={errorRef}>{error}</div>}
    {customerState === 'loading' && <p className="field-status" role="status">Müşteriler yükleniyor…</p>}
    {customerState === 'error' && <p className="field-error" role="alert">Müşteriler yüklenemedi.{' '}
      <button data-retry-customers className="inline-action" type="button" onClick={() => void loadCustomers()}>Tekrar dene</button></p>}
    {customerState === 'ready' && customers.length === 0 && <p className="field-status" role="status">Görüşme planlamak için aktif veya aday müşteri gereklidir.</p>}
    <form className="task-form" onSubmit={submit} noValidate><fieldset disabled={pending}>
      <div className="field-group"><label htmlFor="meeting-title">Başlık</label>
        <input id="meeting-title" required maxLength={255} value={title} aria-invalid={fieldErrors.title ? true : undefined}
          aria-describedby={fieldErrors.title ? 'meeting-title-error' : undefined} onChange={(event) => setTitle(event.target.value)} />
        {fieldErrors.title && <span id="meeting-title-error" className="field-error">{fieldErrors.title}</span>}</div>
      <div className="field-group">
        <label htmlFor="meeting-engagement-kind">Görüşme / ziyaret türü</label>
        <select
          id="meeting-engagement-kind"
          required
          value={engagementKind}
          aria-invalid={fieldErrors.engagementKind ? true : undefined}
          aria-describedby={fieldErrors.engagementKind ? 'meeting-engagement-kind-error meeting-engagement-kind-help' : 'meeting-engagement-kind-help'}
          onChange={(event) => setEngagementKind(event.target.value as JobCardEngagementKind | '')}
        >
          <option value="">Tür seçin</option>
          {JOB_CARD_ENGAGEMENT_KINDS.map((kind) => (
            <option key={kind} value={kind}>{JOB_CARD_ENGAGEMENT_LABELS[kind]}</option>
          ))}
        </select>
        <p id="meeting-engagement-kind-help" className="form-help">
          Görüşmenin veya ziyaretin ana amacını seçin. Bu bilgi liste ve raporlarda gösterilir.
        </p>
        {fieldErrors.engagementKind && (
          <span id="meeting-engagement-kind-error" className="field-error">{fieldErrors.engagementKind}</span>
        )}
      </div>
      <div className="task-field-pair">
        <div className="field-group"><div className="field-label-row"><label htmlFor="meeting-customer">Müşteri</label><Link className="inline-action" to="/customers/new?source=meeting">Yeni müşteri ekle</Link></div>
          <select id="meeting-customer" required value={customerId} disabled={customerState !== 'ready'}
            aria-invalid={fieldErrors.customerId ? true : undefined}
            aria-describedby={fieldErrors.customerId ? 'meeting-customer-error' : undefined}
            onChange={(event) => setCustomerId(event.target.value)}>
            <option value="">Seçin</option>{customers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
          {fieldErrors.customerId && <span id="meeting-customer-error" className="field-error">{fieldErrors.customerId}</span>}</div>
        <div className="field-group"><label htmlFor="meeting-scheduled-at">Planlanan görüşme zamanı</label>
          <input id="meeting-scheduled-at" type="datetime-local" required value={scheduledLocal}
            aria-invalid={fieldErrors.scheduledAt ? true : undefined}
            aria-describedby={fieldErrors.scheduledAt ? 'meeting-scheduled-at-error' : undefined}
            onChange={(event) => setScheduledLocal(event.target.value)} />
          {fieldErrors.scheduledAt && <span id="meeting-scheduled-at-error" className="field-error">{fieldErrors.scheduledAt}</span>}</div>
      </div>
      <CustomerScheduleNotice
        evaluation={evaluation}
        mode={user.role === 'STAFF' ? 'staff' : 'manager'}
        overrideReason={overrideReason}
        onOverrideReasonChange={setOverrideReason}
        onUseSuggestedAlternative={useSuggestedAlternative}
      />
      {previewing && <p className="field-status" role="status">Müşteri planı kontrol ediliyor…</p>}
      {user.role === 'STAFF' ? <div className="field-group"><span className="field-label">Sorumlu personel</span><p className="fixed-field-value">{user.name}</p></div>
        : <div className="field-group"><label htmlFor="meeting-assignee">Sorumlu personel</label>
          <select id="meeting-assignee" required value={assignedTo} disabled={staffState !== 'ready'}
            aria-invalid={fieldErrors.assignedTo ? true : undefined}
            aria-describedby={fieldErrors.assignedTo ? 'meeting-assignee-error' : undefined}
            onChange={(event) => setAssignedTo(event.target.value)}>
            <option value="">Seçin</option>{staff.map((item) => <option key={item.user.id} value={item.user.id}>{item.user.name}</option>)}</select>
          {staffState === 'loading' && <span className="field-status" role="status">Personel listesi yükleniyor…</span>}
          {staffState === 'error' && <span className="field-error" role="alert">Personel listesi yüklenemedi.{' '}<button className="inline-action" type="button" onClick={() => void loadActiveStaff()}>Tekrar dene</button></span>}
          {fieldErrors.assignedTo && <span id="meeting-assignee-error" className="field-error">{fieldErrors.assignedTo}</span>}</div>}
      <div className="field-group"><label htmlFor="meeting-description">Açıklama (isteğe bağlı)</label>
        <textarea id="meeting-description" rows={4} value={description} onChange={(event) => setDescription(event.target.value)} /></div>
      <div className="field-group"><label htmlFor="meeting-priority">Öncelik</label>
        <select id="meeting-priority" value={priority} onChange={(event) => setPriority(event.target.value as JobCardPriority)}>
          <option value="low">Düşük</option><option value="normal">Normal</option>
          <option value="high">Yüksek</option><option value="urgent">Acil</option></select></div>
    </fieldset><div className="form-actions">
      <button data-cancel-meeting className="secondary-button" type="button" onClick={onCancel} disabled={pending}>Vazgeç</button>
      <button className="primary-button" type="submit" disabled={pending || referencesUnavailable}>
        {pending ? 'Planlanıyor…' : 'Görüşme / ziyareti planla'}</button></div></form>
  </main>;
}
