import { useEffect, useState, type FormEvent } from 'react';

import { listStaff, type StaffProfile } from '../services/people-api';

type LoadState = 'loading' | 'ready' | 'error';

export function DeliveryAssigneeEditForm({ job, pending, onCancel, onSave }: {
  job: { version: number; assignedTo: string; assignee: { id: string; name: string } };
  pending: boolean;
  onCancel: () => void;
  onSave: (assignedTo: string) => Promise<void>;
}) {
  const [assignedTo, setAssignedTo] = useState(job.assignedTo);
  const [staff, setStaff] = useState<StaffProfile[]>([]);
  const [staffState, setStaffState] = useState<LoadState>('loading');
  const [fieldError, setFieldError] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    void listStaff('active').then((items) => {
      setStaff(items.filter((item) => item.user.isActive)); setStaffState('ready');
    }).catch(() => { setStaff([]); setStaffState('error'); });
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (pending) return;
    if (!assignedTo) {
      setFieldError('Aktif bir sorumlu personel seçin.');
      return;
    }
    setFieldError(''); setError('');
    await onSave(assignedTo);
  }

  return <section className="delivery-assignee-details" aria-labelledby="delivery-assignee-edit-title-heading">
    <h2 id="delivery-assignee-edit-title-heading">Sorumlu personeli değiştir</h2>
    {error && <div className="form-error" role="alert">{error}</div>}
    {staffState === 'error' && <p className="field-error" role="alert">Personel listesi yüklenemedi.</p>}
    <form className="task-form" onSubmit={submit} noValidate><fieldset disabled={pending}>
      <div className="field-group"><label htmlFor="delivery-edit-assignee">Sorumlu personel</label>
        <select id="delivery-edit-assignee" value={assignedTo} disabled={staffState !== 'ready'}
          aria-invalid={fieldError ? true : undefined}
          aria-describedby={fieldError ? 'delivery-edit-assignee-error' : undefined}
          onChange={(event) => setAssignedTo(event.target.value)}>
          <option value="">Seçin</option>{staff.map((item) => <option key={item.user.id} value={item.user.id}>{item.user.name}</option>)}</select>
        {fieldError && <span id="delivery-edit-assignee-error" className="field-error">{fieldError}</span>}
        <p className="form-help">Sorumlu personel değişikliği işi atandığı aşamaya geri alır ve mesajlaşma üyeliği ayrıca sorulur.</p>
      </div>
    </fieldset><div className="review-buttons inline-form-actions">
      <button data-cancel-delivery-assignee-edit className="secondary-button" type="button" disabled={pending} onClick={onCancel}>Vazgeç</button>
      <button className="primary-button compact-button" type="submit" disabled={pending || staffState !== 'ready'}>
        {pending ? 'Kaydediliyor…' : 'Değişiklikleri kaydet'}</button>
    </div></form>
  </section>;
}
