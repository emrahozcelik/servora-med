import { useEffect, useRef, useState, type FormEvent, type SyntheticEvent } from 'react';
import { Link } from 'react-router-dom';

import { createJobCard, type JobCardPriority } from './jobs/jobs-api';
import { defaultScheduledLocalValue, localDateTimeToIso } from './jobs/scheduling';
import { ApiError, type CurrentUser } from './services/api';
import {
  listContacts,
  listCustomers,
  type Contact,
  type CustomerSummary,
} from './services/crm-api';
import { listStaff, type StaffProfile } from './services/people-api';
import { createRequestGate } from './services/request-gate';

type LoadState = 'idle' | 'loading' | 'ready' | 'error';
type FieldErrors = { title?: string; assignedTo?: string };

async function loadAllCustomers() {
  const all: CustomerSummary[] = [];
  let offset = 0;
  while (true) {
    const page = await listCustomers({ limit: 200, offset });
    all.push(...page.items);
    if (all.length >= page.total || page.items.length === 0) return all;
    offset += page.items.length;
  }
}

async function loadAllContacts(customerId: string) {
  const all: Contact[] = [];
  let offset = 0;
  while (true) {
    const page = await listContacts(customerId, { status: 'active', limit: 200, offset });
    all.push(...page.items);
    if (all.length >= page.total || page.items.length === 0) return all;
    offset += page.items.length;
  }
}

export function GeneralTaskCreateScreen({ user, onCancel, onCreated, initialCustomerId = '' }: {
  user: CurrentUser;
  onCancel: () => void;
  onCreated: (jobCardId: string) => void;
  initialCustomerId?: string;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<JobCardPriority>('normal');
  const [scheduledLocal, setScheduledLocal] = useState(
    () => defaultScheduledLocalValue(new Date()),
  );
  const [assignedTo, setAssignedTo] = useState(user.role === 'STAFF' ? user.id : '');
  const [staff, setStaff] = useState<StaffProfile[]>([]);
  const [staffState, setStaffState] = useState<LoadState>(user.role === 'STAFF' ? 'ready' : 'loading');
  const [customers, setCustomers] = useState<CustomerSummary[]>([]);
  const [customerState, setCustomerState] = useState<LoadState>('idle');
  const [customerId, setCustomerId] = useState(initialCustomerId);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactState, setContactState] = useState<LoadState>('idle');
  const [contactId, setContactId] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const errorRef = useRef<HTMLDivElement>(null);
  const actionIdRef = useRef<string | null>(null);
  const contactGate = useRef(createRequestGate());

  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);

  async function loadActiveStaff() {
    setStaffState('loading');
    try {
      const profiles = (await listStaff('active')).filter((profile) => profile.user.isActive);
      setStaff(profiles); setStaffState('ready');
    } catch {
      setStaff([]); setStaffState('error');
    }
  }

  useEffect(() => {
    if (user.role === 'STAFF') return;
    void loadActiveStaff();
  // The signed-in identity owns the initial assignee policy.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.id, user.role]);

  useEffect(() => () => { contactGate.current.next(); }, []);

  async function loadActiveCustomers() {
    setCustomerState('loading');
    try {
      const next = await loadAllCustomers(); setCustomers(next); setCustomerState('ready');
      if (initialCustomerId && next.some((item) => item.id === initialCustomerId)) {
        setCustomerId(initialCustomerId);
        void changeCustomer(initialCustomerId);
      } else if (initialCustomerId) {
        setCustomerId('');
      }
    } catch {
      setCustomers([]); setCustomerId(''); setContacts([]); setContactId('');
      setContactState('idle'); setCustomerState('error');
    }
  }

  function openOptional(event: SyntheticEvent<HTMLDetailsElement>) {
    if (event.currentTarget.open && customerState === 'idle') void loadActiveCustomers();
  }

  async function changeCustomer(nextCustomerId: string) {
    setCustomerId(nextCustomerId); setContactId(''); setContacts([]);
    const generation = contactGate.current.next();
    if (!nextCustomerId) { setContactState('idle'); return; }
    setContactState('loading');
    try {
      const nextContacts = await loadAllContacts(nextCustomerId);
      if (!contactGate.current.isCurrent(generation)) return;
      setContacts(nextContacts); setContactState('ready');
    } catch {
      if (!contactGate.current.isCurrent(generation)) return;
      setContacts([]); setContactState('error');
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const trimmedTitle = title.trim();
    const nextErrors: FieldErrors = {};
    if (!trimmedTitle || Array.from(trimmedTitle).length > 255) {
      nextErrors.title = 'Başlık 1 ile 255 karakter arasında olmalıdır.';
    }
    const selectedAssignee = user.role === 'STAFF' ? user.id : assignedTo;
    if (!selectedAssignee) nextErrors.assignedTo = 'Aktif bir sorumlu personel seçin.';
    setFieldErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      setError('Görevi oluşturmadan önce işaretli alanları düzeltin.');
      return;
    }

    setPending(true); setError('');
    actionIdRef.current ??= crypto.randomUUID();
    try {
      const job = await createJobCard({
        clientActionId: actionIdRef.current,
        type: 'GENERAL_TASK',
        title: trimmedTitle,
        assignedTo: selectedAssignee,
        description: description.trim() || null,
        priority,
        dueDate: null,
        scheduledAt: scheduledLocal ? localDateTimeToIso(scheduledLocal) : null,
        customerId: customerId || null,
        contactId: contactId || null,
      });
      onCreated(job.id);
    } catch (caught) {
      if (caught instanceof ApiError && !caught.retryable) actionIdRef.current = null;
      setError(caught instanceof Error ? caught.message : 'Görev oluşturulamadı. Tekrar deneyin.');
      setPending(false);
    }
  }

  const staffUnavailable = user.role !== 'STAFF' && staffState !== 'ready';

  return <main className="task-create">
    <div className="delivery-heading">
      <div><p className="eyebrow">Yeni kayıt</p><h1>Genel görev</h1></div>
      <button data-cancel-task className="secondary-button" type="button" onClick={onCancel} disabled={pending}>Vazgeç</button>
    </div>
    <p className="form-intro">Takip edilmesi gereken işi kısa ve açık biçimde kaydedin.</p>
    {error && <div className="form-error" role="alert" tabIndex={-1} ref={errorRef}>{error}</div>}
    <form className="task-form" onSubmit={submit} noValidate>
      <fieldset disabled={pending}>
        <div className="field-group">
          <label htmlFor="task-title">Başlık</label>
          <input id="task-title" name="title" required maxLength={255} value={title}
            aria-invalid={fieldErrors.title ? true : undefined}
            aria-describedby={fieldErrors.title ? 'task-title-error' : undefined}
            onChange={(event) => setTitle(event.target.value)} />
          {fieldErrors.title && <span id="task-title-error" className="field-error">{fieldErrors.title}</span>}
        </div>
        <div className="field-group">
          <label htmlFor="task-description">Açıklama (isteğe bağlı)</label>
          <textarea id="task-description" name="description" rows={4} value={description}
            onChange={(event) => setDescription(event.target.value)} />
        </div>
        {user.role === 'STAFF'
          ? <div className="field-group"><span className="field-label">Sorumlu personel</span>
              <p className="fixed-field-value">{user.name}</p></div>
          : <div className="field-group">
              <label htmlFor="task-assignee">Sorumlu personel</label>
              <select id="task-assignee" required value={assignedTo} disabled={pending || staffState !== 'ready'}
                aria-invalid={fieldErrors.assignedTo ? true : undefined}
                aria-describedby={fieldErrors.assignedTo ? 'task-assignee-error' : undefined}
                onChange={(event) => setAssignedTo(event.target.value)}>
                <option value="">Seçin</option>
                {staff.map((profile) => <option key={profile.user.id} value={profile.user.id}>{profile.user.name}</option>)}
              </select>
              {staffState === 'loading' && <span className="field-status" role="status">Personel listesi yükleniyor…</span>}
              {staffState === 'error' && <span className="field-error" role="alert">Personel listesi yüklenemedi.{' '}
                <button data-retry-staff className="inline-action" type="button" onClick={() => void loadActiveStaff()}>Tekrar dene</button></span>}
              {fieldErrors.assignedTo && <span id="task-assignee-error" className="field-error">{fieldErrors.assignedTo}</span>}
            </div>}

        <details className="task-optional" onToggle={openOptional}>
          <summary>Ek bilgiler</summary>
          <div className="task-optional-fields">
            <div className="task-field-pair">
              <div className="field-group"><label htmlFor="task-priority">Öncelik</label>
                <select id="task-priority" value={priority} onChange={(event) => setPriority(event.target.value as JobCardPriority)}>
                  <option value="low">Düşük</option><option value="normal">Normal</option>
                  <option value="high">Yüksek</option><option value="urgent">Acil</option>
                </select></div>
              <div className="field-group"><label htmlFor="task-scheduled-at">Planlanan zaman (isteğe bağlı)</label>
                <input id="task-scheduled-at" type="datetime-local" value={scheduledLocal}
                  onChange={(event) => setScheduledLocal(event.target.value)} /></div>
            </div>
            <div className="field-group"><label htmlFor="task-customer">Müşteri (isteğe bağlı)</label>
              <select id="task-customer" value={customerId} disabled={customerState !== 'ready'}
                onChange={(event) => void changeCustomer(event.target.value)}>
                <option value="">Müşteri seçilmedi</option>
                {customers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
              {customerState === 'loading' && <span className="field-status" role="status">Müşteriler yükleniyor…</span>}
              {customerState === 'error' && <span className="field-error" role="alert">Müşteriler yüklenemedi. Görevi müşterisiz kaydedebilirsiniz.{' '}
                <button className="inline-action" type="button" onClick={() => void loadActiveCustomers()}>Tekrar dene</button></span>}
              {customerState === 'ready' && customers.length === 0 && <span className="field-status">Henüz müşteri yok.{' '}
                <Link className="inline-action" to="/customers/new?source=task">Yeni müşteri ekle</Link></span>}
            </div>
            <div className="field-group"><label htmlFor="task-contact">İlgili kişi (isteğe bağlı)</label>
              <select id="task-contact" value={contactId}
                disabled={!customerId || contactState !== 'ready'} onChange={(event) => setContactId(event.target.value)}>
                <option value="">İlgili kişi seçilmedi</option>
                {contacts.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
              {contactState === 'loading' && <span className="field-status" role="status">İlgili kişiler yükleniyor…</span>}
              {contactState === 'error' && <span className="field-error" role="alert">İlgili kişiler yüklenemedi. Müşteriyi yeniden seçip deneyin.</span>}
            </div>
          </div>
        </details>
      </fieldset>
      <button className="primary-button" type="submit" disabled={pending || staffUnavailable}>
        {pending ? 'Görev oluşturuluyor…' : 'Görevi oluştur'}
      </button>
    </form>
  </main>;
}
