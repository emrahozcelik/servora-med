import { useEffect, useState, type FormEvent } from 'react';

import { listStaff, type StaffProfile } from '../services/people-api';
import type { CurrentUser } from '../services/api';
import type { JobCard, JobCardPriority } from './jobs-api';

type LoadState = 'loading' | 'ready' | 'error';

export type GeneralTaskEditInput = {
  title: string;
  description: string;
  priority: JobCardPriority;
  assignedTo?: string;
};

export function GeneralTaskEditForm({ job, user, pending, onCancel, onSave }: {
  job: JobCard & { type: 'GENERAL_TASK' };
  user: CurrentUser;
  pending: boolean;
  onCancel: () => void;
  onSave: (input: GeneralTaskEditInput) => Promise<void>;
}) {
  const canChangeAssignee = user.role !== 'STAFF';
  const [title, setTitle] = useState(job.title);
  const [description, setDescription] = useState(job.description ?? '');
  const [priority, setPriority] = useState<JobCardPriority>(job.priority);
  const [assignedTo, setAssignedTo] = useState(job.assignedTo);
  const [staff, setStaff] = useState<StaffProfile[]>([]);
  const [staffState, setStaffState] = useState<LoadState>(canChangeAssignee ? 'loading' : 'ready');
  const [fieldError, setFieldError] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!canChangeAssignee) return;
    void listStaff('active').then((items) => {
      setStaff(items.filter((item) => item.user.isActive)); setStaffState('ready');
    }).catch(() => { setStaff([]); setStaffState('error'); });
  }, [canChangeAssignee]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (pending) return;
    const nextTitle = title.trim();
    if (!nextTitle) {
      setFieldError('Görev başlığı boş olamaz.');
      return;
    }
    if (canChangeAssignee && !assignedTo) {
      setFieldError('Aktif bir sorumlu personel seçin.');
      return;
    }
    setFieldError(''); setError('');
    await onSave({
      title: nextTitle,
      description: description.trim(),
      priority,
      ...(canChangeAssignee ? { assignedTo } : {}),
    });
  }

  return <section className="general-task-edit-form" aria-labelledby="general-task-edit-title-heading">
    <h2 id="general-task-edit-title-heading">Görevi düzenle</h2>
    {error && <div className="form-error" role="alert">{error}</div>}
    {staffState === 'error' && <p className="field-error" role="alert">Personel listesi yüklenemedi.</p>}
    <form className="task-form" onSubmit={submit} noValidate><fieldset disabled={pending}>
      <div className="field-group"><label htmlFor="general-task-edit-title">Başlık</label>
        <input id="general-task-edit-title" name="title" value={title} maxLength={255} required
          aria-invalid={fieldError === 'Görev başlığı boş olamaz.' ? true : undefined}
          onChange={(event) => setTitle(event.target.value)} />
        {fieldError === 'Görev başlığı boş olamaz.'
          && <span className="field-error">{fieldError}</span>}
      </div>
      <div className="field-group"><label htmlFor="general-task-edit-description">Açıklama</label>
        <textarea id="general-task-edit-description" name="description" rows={4}
          value={description}
          onChange={(event) => setDescription(event.target.value)} />
      </div>
      <div className="field-group"><label htmlFor="general-task-edit-priority">Öncelik</label>
        <select id="general-task-edit-priority" name="priority" value={priority}
          onChange={(event) => setPriority(event.target.value as JobCardPriority)}>
          <option value="low">Düşük</option><option value="normal">Normal</option>
          <option value="high">Yüksek</option><option value="urgent">Acil</option></select>
      </div>
      {canChangeAssignee && <div className="field-group"><label htmlFor="general-task-edit-assignee">Sorumlu personel</label>
        <select id="general-task-edit-assignee" name="assignedTo" value={assignedTo}
          disabled={staffState !== 'ready'}
          aria-invalid={fieldError === 'Aktif bir sorumlu personel seçin.' ? true : undefined}
          onChange={(event) => setAssignedTo(event.target.value)}>
          <option value="">Seçin</option>{staff.map((item) => <option key={item.user.id} value={item.user.id}>{item.user.name}</option>)}</select>
        {fieldError === 'Aktif bir sorumlu personel seçin.'
          && <span className="field-error">{fieldError}</span>}
        <p className="form-help">Sorumlu personel değişikliği işi atandığı aşamaya geri alır ve mesajlaşma üyeliği ayrıca sorulur.</p>
      </div>}
    </fieldset><div className="review-buttons inline-form-actions">
      <button data-cancel-general-task-edit className="secondary-button" type="button" disabled={pending} onClick={onCancel}>Vazgeç</button>
      <button className="primary-button compact-button" type="submit" disabled={pending || staffState !== 'ready'}>
        {pending ? 'Kaydediliyor…' : 'Değişiklikleri kaydet'}</button>
    </div></form>
  </section>;
}
