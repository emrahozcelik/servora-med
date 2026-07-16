import { useEffect, useRef, useState, type FormEvent } from 'react';

import { ApiError, type CurrentUser } from '../services/api';
import type {
  JobCard, MeetingDetailField, MeetingDetails, MeetingOutcome, PatchMeetingDetailsInput,
} from './jobs-api';

const outcomeLabels: Record<MeetingOutcome, string> = {
  POSITIVE: 'Olumlu', FOLLOW_UP_REQUIRED: 'Takip gerekli',
  NO_DECISION: 'Karar verilmedi', NOT_INTERESTED: 'İlgilenmiyor',
};
type MeetingFieldErrors = Partial<Record<MeetingDetailField, string>>;
const meetingFields: MeetingDetailField[] = [
  'meetingAt', 'outcome', 'meetingSummary', 'nextFollowUpAt',
];

function localValue(value: string | null) {
  if (!value) return '';
  const date = new Date(value); const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}
function instant(value: string) { return value ? new Date(value).toISOString() : null; }
function timezoneLabel() { return Intl.DateTimeFormat().resolvedOptions().timeZone; }
function formatInstant(value: string | null) {
  return value ? new Intl.DateTimeFormat('tr-TR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'Belirtilmedi';
}
function serverFieldErrors(error: unknown): MeetingFieldErrors {
  if (!(error instanceof ApiError) || error.code !== 'MEETING_NOT_READY') return {};
  const value = error.details?.fieldErrors;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>; const result: MeetingFieldErrors = {};
  for (const field of meetingFields) {
    if (typeof source[field] === 'string' && source[field]) result[field] = source[field];
  }
  return result;
}
function describedBy(...ids: Array<string | false | undefined>) {
  return ids.filter(Boolean).join(' ') || undefined;
}

export function MeetingDetailsSection({ job, details, user, canEdit: canEditOverride, mutationPending, submissionError, onSave }: {
  job: JobCard; details: MeetingDetails; user: CurrentUser; mutationPending: boolean;
  canEdit?: boolean;
  submissionError?: ApiError | null;
  onSave: (input: PatchMeetingDetailsInput) => Promise<MeetingDetails>;
}) {
  const [meetingAt, setMeetingAt] = useState(localValue(details.meetingAt));
  const [outcome, setOutcome] = useState<MeetingOutcome | ''>(details.outcome ?? '');
  const [summary, setSummary] = useState(details.meetingSummary ?? '');
  const [followUp, setFollowUp] = useState(localValue(details.nextFollowUpAt));
  const [feedback, setFeedback] = useState(''); const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<MeetingFieldErrors>({});
  const actionId = useRef<string | null>(null); const feedbackRef = useRef<HTMLDivElement>(null);
  useEffect(() => { setMeetingAt(localValue(details.meetingAt)); setOutcome(details.outcome ?? '');
    setSummary(details.meetingSummary ?? ''); setFollowUp(localValue(details.nextFollowUpAt)); }, [details]);
  useEffect(() => { setFieldErrors(serverFieldErrors(submissionError)); }, [submissionError]);
  useEffect(() => { if (feedback || error) feedbackRef.current?.focus(); }, [feedback, error]);
  const canEdit = canEditOverride ?? (
    ['IN_PROGRESS', 'REVISION_REQUESTED'].includes(job.status)
    && (user.role !== 'STAFF' || user.id === job.assignedTo)
  );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (mutationPending) return; setError(''); setFeedback(''); setFieldErrors({});
    const normalizedSummary = summary.trim();
    if (Array.from(normalizedSummary).length > 4_000) {
      setFieldErrors({ meetingSummary: 'Görüşme özeti en fazla 4.000 karakter olabilir.' });
      setError('Görüşme sonucunu kaydetmeden önce işaretli alanı düzeltin.');
      return;
    }
    actionId.current ??= crypto.randomUUID();
    try {
      await onSave({ clientActionId: actionId.current, expectedVersion: job.version,
        meetingAt: instant(meetingAt), outcome: outcome || null,
        meetingSummary: normalizedSummary || null, nextFollowUpAt: instant(followUp) });
      actionId.current = null; setFeedback('Görüşme sonucu kaydedildi.');
    } catch (caught) {
      if (caught instanceof ApiError && !caught.retryable) actionId.current = null;
      setFieldErrors(serverFieldErrors(caught));
      setError(caught instanceof Error ? caught.message : 'Görüşme sonucu kaydedilemedi.');
    }
  }

  if (!canEdit) return <section className="meeting-details" aria-labelledby="meeting-details-title">
    <h2 id="meeting-details-title">Görüşme sonucu</h2><dl className="detail-summary">
      <div><dt>Gerçekleşme zamanı</dt><dd>{formatInstant(details.meetingAt)}</dd></div>
      <div><dt>Sonuç</dt><dd>{details.outcome ? outcomeLabels[details.outcome] : 'Belirtilmedi'}</dd></div>
      <div><dt>Takip zamanı</dt><dd>{formatInstant(details.nextFollowUpAt)}</dd></div>
      <div className="detail-summary-wide"><dt>Görüşme özeti</dt><dd>{details.meetingSummary ?? 'Belirtilmedi'}</dd></div>
    </dl></section>;

  const followUpHelp = outcome === 'FOLLOW_UP_REQUIRED'
    ? 'Takip zamanı eklemeniz önerilir; tarih henüz belli değilse boş bırakabilirsiniz.'
    : 'Takip zamanı isteğe bağlıdır.';
  return <section className="meeting-details" aria-labelledby="meeting-details-title">
    <h2 id="meeting-details-title">Görüşme sonucu</h2>
    {(feedback || error) && <div ref={feedbackRef} className={`detail-feedback${error ? ' detail-feedback-error' : ''}`}
      role={error ? 'alert' : 'status'} tabIndex={-1}>{error || feedback}</div>}
    <form className="meeting-result-form" onSubmit={submit} noValidate><fieldset disabled={mutationPending}>
      <div className="field-group"><label htmlFor="meeting-actual-at">Gerçekleşme zamanı</label>
        <input id="meeting-actual-at" type="datetime-local" value={meetingAt}
          aria-invalid={fieldErrors.meetingAt ? true : undefined}
          aria-describedby={describedBy('meeting-timezone-help', fieldErrors.meetingAt && 'meeting-actual-at-error')}
          onChange={(event) => setMeetingAt(event.target.value)} />
        <span id="meeting-timezone-help" className="field-status">Saat dilimi: {timezoneLabel()}</span>
        {fieldErrors.meetingAt && <span id="meeting-actual-at-error" className="field-error">{fieldErrors.meetingAt}</span>}</div>
      <div className="field-group"><label htmlFor="meeting-outcome">Sonuç</label>
        <select id="meeting-outcome" value={outcome} aria-invalid={fieldErrors.outcome ? true : undefined}
          aria-describedby={fieldErrors.outcome ? 'meeting-outcome-error' : undefined}
          onChange={(event) => setOutcome(event.target.value as MeetingOutcome | '')}>
          <option value="">Sonuç seçin</option>{Object.entries(outcomeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        {fieldErrors.outcome && <span id="meeting-outcome-error" className="field-error">{fieldErrors.outcome}</span>}</div>
      <div className="field-group"><label htmlFor="meeting-summary">Görüşme özeti</label>
        <textarea id="meeting-summary" rows={5} value={summary}
          aria-invalid={fieldErrors.meetingSummary ? true : undefined}
          aria-describedby={fieldErrors.meetingSummary ? 'meeting-summary-error' : undefined}
          onChange={(event) => setSummary(event.target.value)} />
        {fieldErrors.meetingSummary && <span id="meeting-summary-error" className="field-error">{fieldErrors.meetingSummary}</span>}</div>
      <div className="field-group"><label htmlFor="meeting-follow-up-at">Takip zamanı (isteğe bağlı)</label>
        <input id="meeting-follow-up-at" type="datetime-local" value={followUp}
          aria-invalid={fieldErrors.nextFollowUpAt ? true : undefined}
          aria-describedby={describedBy('meeting-follow-up-help', fieldErrors.nextFollowUpAt && 'meeting-follow-up-at-error')}
          onChange={(event) => setFollowUp(event.target.value)} />
        <span id="meeting-follow-up-help" className={outcome === 'FOLLOW_UP_REQUIRED' ? 'field-guidance' : 'field-status'}>{followUpHelp}</span>
        {fieldErrors.nextFollowUpAt && <span id="meeting-follow-up-at-error" className="field-error">{fieldErrors.nextFollowUpAt}</span>}</div>
    </fieldset><button className="primary-button compact-button" type="submit" disabled={mutationPending}>
      {mutationPending ? 'Kaydediliyor…' : 'Görüşme sonucunu kaydet'}</button></form>
  </section>;
}
