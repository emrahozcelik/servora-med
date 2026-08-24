import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';

import { ConfirmationAction } from '../ui/antd/ConfirmationAction';
import type {
  JobCard,
  JobCardInvalidationReasonCode,
  JobCardStatus,
} from './jobs-api';
import { jobCardInvalidationReasonLabel, jobCardStatusLabel } from './job-labels';

const REASON_CODES: JobCardInvalidationReasonCode[] = [
  'DUPLICATE', 'WRONG_CUSTOMER', 'CREATED_BY_MISTAKE', 'TRAINING_OR_TEST_RECORD', 'OTHER',
];
const NOTE_MAX_LENGTH = 2000;

export type JobInvalidationAttempt = {
  jobCardId: string;
  expectedVersion: number;
  sourceStatus: JobCardStatus;
  reasonCode: JobCardInvalidationReasonCode;
  note: string | null;
  clientActionId: string;
};

export type JobInvalidationMutationState =
  | { kind: 'idle' }
  | { kind: 'submitting'; attempt: JobInvalidationAttempt }
  | { kind: 'reconciling'; attempt: JobInvalidationAttempt; message: string; checking: boolean }
  | { kind: 'retry-ready'; attempt: JobInvalidationAttempt; message: string }
  | { kind: 'error'; message: string };

type JobInvalidationJob = Pick<JobCard, 'id' | 'status' | 'version' | 'title' | 'customer'>;

export function JobInvalidationAction({
  job,
  mutationState,
  onSubmit,
  onRecheck,
  onRetry,
  onReset,
  createActionId = () => crypto.randomUUID(),
}: {
  job: JobInvalidationJob;
  mutationState: JobInvalidationMutationState;
  onSubmit: (attempt: JobInvalidationAttempt) => void;
  onRecheck: () => void;
  onRetry: () => void;
  onReset?: () => void;
  createActionId?: () => string;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [reasonCode, setReasonCode] = useState<JobCardInvalidationReasonCode | ''>('');
  const [note, setNote] = useState('');
  const [formError, setFormError] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const confirmAttemptRef = useRef(false);

  const locked = mutationState.kind === 'submitting'
    || mutationState.kind === 'reconciling'
    || mutationState.kind === 'retry-ready';
  const pending = mutationState.kind === 'submitting';
  const attempt = mutationState.kind === 'submitting'
    || mutationState.kind === 'reconciling'
    || mutationState.kind === 'retry-ready'
    ? mutationState.attempt
    : null;

  useEffect(() => {
    setOpen(false);
    setConfirmationOpen(false);
    setReasonCode('');
    setNote('');
    setFormError('');
    confirmAttemptRef.current = false;
  }, [job.id, job.status, job.version]);

  useEffect(() => {
    if (mutationState.kind !== 'submitting') setConfirmationOpen(false);
    if (mutationState.kind === 'error') {
      setOpen(false);
      setReasonCode('');
      setNote('');
      setFormError('');
    }
  }, [mutationState.kind]);

  useEffect(() => {
    if (mutationState.kind === 'idle' || mutationState.kind === 'error') {
      confirmAttemptRef.current = false;
    }
  }, [mutationState.kind]);

  function validateForm(): JobCardInvalidationReasonCode | null {
    if (!REASON_CODES.includes(reasonCode as JobCardInvalidationReasonCode)) {
      setFormError('Geçersiz kılma nedeni seçin.');
      return null;
    }
    const normalizedNote = note.trim();
    if (Array.from(normalizedNote).length > NOTE_MAX_LENGTH) {
      setFormError(`Açıklama ${NOTE_MAX_LENGTH.toLocaleString('tr-TR')} karakteri geçemez.`);
      return null;
    }
    if (reasonCode === 'OTHER' && normalizedNote.length === 0) {
      setFormError('Diğer nedeni için açıklama zorunludur.');
      return null;
    }
    setFormError('');
    return reasonCode as JobCardInvalidationReasonCode;
  }

  function openConfirmation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked) return;
    if (!validateForm()) return;
    setConfirmationOpen(true);
  }

  function confirm() {
    if (locked || confirmAttemptRef.current) return;
    const selectedReason = validateForm();
    if (!selectedReason) return;
    const normalizedNote = note.trim();
    const attempt = {
      jobCardId: job.id,
      expectedVersion: job.version,
      sourceStatus: job.status,
      reasonCode: selectedReason,
      note: normalizedNote || null,
      clientActionId: createActionId(),
    } satisfies JobInvalidationAttempt;
    confirmAttemptRef.current = true;
    onSubmit(attempt);
  }

  function resetForm() {
    if (locked) return;
    setOpen(false);
    setReasonCode('');
    setNote('');
    setFormError('');
    onReset?.();
  }

  const recovery = mutationState.kind === 'reconciling' || mutationState.kind === 'retry-ready'
    ? (
        <div className="job-invalidation-recovery" data-job-invalidation-recovery="true">
          <p className="field-status" role="status" aria-live="polite">
            {mutationState.message}
          </p>
          <div className="review-buttons">
            <button
              className="secondary-button"
              type="button"
              disabled={mutationState.kind === 'reconciling' && mutationState.checking}
              data-job-invalidation-recheck
              onClick={onRecheck}
            >
              {mutationState.kind === 'reconciling' && mutationState.checking
                ? 'Durum kontrol ediliyor…'
                : 'Durumu yeniden kontrol et'}
            </button>
            {mutationState.kind === 'retry-ready' && (
              <button
                className="destructive-button"
                type="button"
                data-job-invalidation-retry
                onClick={onRetry}
              >
                Aynı işlemi tekrar dene
              </button>
            )}
          </div>
        </div>
      )
    : null;

  return (
    <section
      className="job-invalidation-action surface-flat"
      aria-labelledby="job-invalidation-title"
      data-job-invalidation="true"
    >
      <div className="job-invalidation-heading">
        <div>
          <h2 id="job-invalidation-title">Yönetici işlemleri</h2>
          <p>Bu kayıt operasyonel akıştan çıkarılır ve yeniden açılamaz.</p>
        </div>
        <button
          ref={triggerRef}
          className="destructive-button"
          type="button"
          aria-expanded={open}
          disabled={locked}
          data-job-invalidation-trigger
          onClick={() => setOpen((value) => !value)}
        >
          {open ? 'Formu kapat' : 'Geçersiz olarak işaretle'}
        </button>
      </div>

      {open && (
        <form className="job-invalidation-form" onSubmit={openConfirmation} noValidate>
          <fieldset disabled={locked}>
            <legend>Geçersiz kılma bilgileri</legend>
            <div className="field-group">
              <label htmlFor="job-invalidation-reason">Neden</label>
              <select
                id="job-invalidation-reason"
                name="reasonCode"
                value={reasonCode}
                aria-invalid={formError ? true : undefined}
                aria-describedby={formError ? 'job-invalidation-form-error' : undefined}
                onChange={(event) => {
                  setReasonCode(event.target.value as JobCardInvalidationReasonCode);
                  setFormError('');
                }}
              >
                <option value="">Neden seçin</option>
                {REASON_CODES.map((code) => (
                  <option key={code} value={code}>{jobCardInvalidationReasonLabel(code)}</option>
                ))}
              </select>
            </div>
            <div className="field-group">
              <label htmlFor="job-invalidation-note">
                Açıklama{reasonCode === 'OTHER' ? ' (zorunlu)' : ' (isteğe bağlı)'}
              </label>
              <textarea
                id="job-invalidation-note"
                name="note"
                rows={4}
                maxLength={NOTE_MAX_LENGTH * 2}
                value={note}
                aria-describedby="job-invalidation-note-help"
                onChange={(event) => {
                  setNote(event.target.value);
                  setFormError('');
                }}
              />
              <span className="form-help" id="job-invalidation-note-help">
                En fazla {NOTE_MAX_LENGTH.toLocaleString('tr-TR')} karakter.
              </span>
            </div>
          </fieldset>
          {formError && <p className="field-error" id="job-invalidation-form-error" role="alert">{formError}</p>}
          <div className="review-buttons">
            <button className="secondary-button" type="button" disabled={locked} onClick={resetForm}>Vazgeç</button>
            <button
              className="destructive-button"
              type="submit"
              disabled={locked}
              data-job-invalidation-continue
            >
              Devam et
            </button>
          </div>
        </form>
      )}

      {mutationState.kind === 'error' && (
        <div className="detail-feedback detail-feedback-error" role="alert">{mutationState.message}</div>
      )}
      {recovery}

      {confirmationOpen && (
        <ConfirmationAction
          open
          title="İş kaydını geçersiz kılmak üzeresiniz"
          description="Bu işlem JobCard'ı silmez. Kayıt normal iş akışından ve operasyonel raporlardan çıkarılır. Geçmiş, notlar ve denetim kayıtları korunur."
          details={[
            `Kayıt: ${job.title}`,
            `Müşteri: ${job.customer?.name ?? 'Müşteri belirtilmemiş'}`,
            `Neden: ${jobCardInvalidationReasonLabel(reasonCode || null)}`,
            `Geçersiz kılma öncesi aşama: ${jobCardStatusLabel(job.status)}`,
            ...(note.trim() ? [`Açıklama: ${note.trim()}`] : []),
          ]}
          confirmLabel="Geçersiz olarak işaretle"
          destructive
          pending={pending}
          pendingLabel="Kayıt geçersiz kılınıyor…"
          returnFocusRef={triggerRef}
          onCancel={() => setConfirmationOpen(false)}
          onConfirm={confirm}
        />
      )}
      {attempt && mutationState.kind === 'submitting' && (
        <p className="sr-only" role="status" aria-live="polite">Kayıt geçersiz kılınıyor…</p>
      )}
    </section>
  );
}
