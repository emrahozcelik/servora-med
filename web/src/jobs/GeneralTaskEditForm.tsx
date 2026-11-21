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
  /** OVR-5 §5.4: sent only when the due date actually changed. */
  dueDate?: string | null;
  /** OVR-5 §4.5: management reason for a deadline change that may end lateness. */
  deadlineExtensionReason?: string;
  /** OVR-5 §4.11: resolve the job's open change request in the same patch. */
  changeRequestResolution?: { changeRequestId: string; resolution: 'RESCHEDULED' };
};

export function GeneralTaskEditForm({ job, user, pending, deadlineExtensionError = null, onCancel, onSave }: {
  job: JobCard & { type: 'GENERAL_TASK' };
  user: CurrentUser;
  pending: boolean;
  /** OVR-5 §5.4: server field error after 400 DEADLINE_EXTENSION_REASON_REQUIRED. */
  deadlineExtensionError?: string | null;
  onCancel: () => void;
  onSave: (input: GeneralTaskEditInput) => Promise<void>;
}) {
  const managementUser = user.role !== 'STAFF';
  const canChangeAssignee = managementUser;
  const hasOpenOverdueIncident = job.hasOpenOverdueIncident === true;
  const [title, setTitle] = useState(job.title);
  const [description, setDescription] = useState(job.description ?? '');
  const [priority, setPriority] = useState<JobCardPriority>(job.priority);
  const [assignedTo, setAssignedTo] = useState(job.assignedTo);
  const [dueDate, setDueDate] = useState(job.dueDate ?? '');
  // OVR-5 §5.4: the reason surface appears with open lateness, or after the
  // server answered DEADLINE_EXTENSION_REASON_REQUIRED. Entered values are kept.
  const [reason, setReason] = useState('');
  const [reasonVisible, setReasonVisible] = useState(managementUser && hasOpenOverdueIncident);
  const [reasonError, setReasonError] = useState('');
  // OVR-5 §4.11: checked by default; only sent when the due date changed.
  const [resolveChangeRequest, setResolveChangeRequest] = useState(true);
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

  useEffect(() => {
    if (managementUser && hasOpenOverdueIncident) setReasonVisible(true);
  }, [hasOpenOverdueIncident, managementUser]);

  useEffect(() => {
    if (!deadlineExtensionError) return;
    setReasonVisible(true);
    setReasonError(deadlineExtensionError);
  }, [deadlineExtensionError]);

  const dueDateChanged = dueDate !== (job.dueDate ?? '');
  // OVR-5 §4.5: the reason is only required for a deadline change that may end
  // open lateness, or after the server asked for it. Open lateness alone must
  // not block title/description/priority/assignee edits.
  const deadlineExtensionRequired = dueDateChanged || Boolean(deadlineExtensionError);

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
    if (managementUser && reasonVisible && deadlineExtensionRequired && !reason.trim()) {
      setReasonError('Gecikmeyi sonlandıran tarih değişikliği için gerekçe yazın.');
      return;
    }
    setFieldError(''); setError(''); setReasonError('');
    const trimmedReason = managementUser && reasonVisible && deadlineExtensionRequired
      ? reason.trim()
      : '';
    const resolution = managementUser && resolveChangeRequest && dueDateChanged && job.changeRequest
      ? {
          changeRequestId: job.changeRequest.id,
          resolution: 'RESCHEDULED' as const,
        }
      : undefined;
    await onSave({
      title: nextTitle,
      description: description.trim(),
      priority,
      ...(canChangeAssignee ? { assignedTo } : {}),
      ...(dueDateChanged ? { dueDate: dueDate.trim() ? dueDate : null } : {}),
      ...(trimmedReason ? { deadlineExtensionReason: trimmedReason } : {}),
      ...(resolution ? { changeRequestResolution: resolution } : {}),
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
      <div className="field-group"><label htmlFor="general-task-edit-due-date">Son tarih</label>
        <input id="general-task-edit-due-date" name="dueDate" type="date" value={dueDate}
          disabled={!managementUser && hasOpenOverdueIncident}
          aria-describedby={!managementUser && hasOpenOverdueIncident
            ? 'general-task-edit-due-date-hint'
            : undefined}
          onChange={(event) => { setDueDate(event.target.value); setReasonError(''); }} />
        {!managementUser && hasOpenOverdueIncident && (
          <span className="form-help" id="general-task-edit-due-date-hint">
            Gecikmesi açık işin tarihini yalnızca yönetim değiştirebilir. Değişiklik talebi gönderin.
          </span>
        )}
      </div>
      {managementUser && reasonVisible && (
        <div className="field-group"><label htmlFor="general-task-edit-extension-reason">Tarih değişikliği gerekçesi</label>
          <textarea id="general-task-edit-extension-reason" name="deadlineExtensionReason" rows={3}
            value={reason} maxLength={500} required={deadlineExtensionRequired}
            aria-invalid={reasonError ? true : undefined}
            aria-describedby={reasonError ? 'general-task-edit-extension-reason-error' : undefined}
            onChange={(event) => { setReason(event.target.value); setReasonError(''); }} />
          {reasonError && (
            <span id="general-task-edit-extension-reason-error" className="field-error" role="alert">
              {reasonError}
            </span>
          )}
        </div>
      )}
      {managementUser && job.changeRequest && dueDateChanged && (
        <div className="form-checkbox-row">
          <input id="general-task-edit-resolve-change-request" name="resolveChangeRequest"
            type="checkbox" checked={resolveChangeRequest}
            onChange={(event) => setResolveChangeRequest(event.target.checked)} />
          <label htmlFor="general-task-edit-resolve-change-request">
            Personelin önerisini “Yeniden planlandı” olarak sonuçlandır
          </label>
        </div>
      )}
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
