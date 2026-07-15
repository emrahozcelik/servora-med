import { useEffect, useRef, useState, type FormEvent } from 'react';

import { ApiError, type CurrentUser } from '../services/api';
import type {
  JobCard, MeetingDetails, MeetingOutcome, PatchMeetingDetailsInput,
} from './jobs-api';

const outcomeLabels: Record<MeetingOutcome, string> = {
  POSITIVE: 'Olumlu', FOLLOW_UP_REQUIRED: 'Takip gerekli',
  NO_DECISION: 'Karar verilmedi', NOT_INTERESTED: 'İlgilenmiyor',
};
const editableStatuses: JobCard['status'][] = ['NEW', 'PLANNED', 'IN_PROGRESS', 'REVISION_REQUESTED'];

function localValue(value: string | null) {
  if (!value) return '';
  const date = new Date(value); const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}
function instant(value: string) { return value ? new Date(value).toISOString() : null; }
function timezoneLabel() {
  const part = new Intl.DateTimeFormat('tr-TR', { timeZoneName: 'longOffset' })
    .formatToParts(new Date()).find((entry) => entry.type === 'timeZoneName')?.value;
  return part ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}
function formatInstant(value: string | null) {
  return value ? new Intl.DateTimeFormat('tr-TR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'Belirtilmedi';
}

export function MeetingDetailsSection({ job, details, user, mutationPending, onSave }: {
  job: JobCard; details: MeetingDetails; user: CurrentUser; mutationPending: boolean;
  onSave: (input: PatchMeetingDetailsInput) => Promise<MeetingDetails>;
}) {
  const [meetingAt, setMeetingAt] = useState(localValue(details.meetingAt));
  const [outcome, setOutcome] = useState<MeetingOutcome | ''>(details.outcome ?? '');
  const [summary, setSummary] = useState(details.meetingSummary ?? '');
  const [followUp, setFollowUp] = useState(localValue(details.nextFollowUpAt));
  const [feedback, setFeedback] = useState(''); const [error, setError] = useState('');
  const actionId = useRef<string | null>(null); const feedbackRef = useRef<HTMLDivElement>(null);
  useEffect(() => { setMeetingAt(localValue(details.meetingAt)); setOutcome(details.outcome ?? '');
    setSummary(details.meetingSummary ?? ''); setFollowUp(localValue(details.nextFollowUpAt)); }, [details]);
  useEffect(() => { if (feedback || error) feedbackRef.current?.focus(); }, [feedback, error]);
  const canEdit = editableStatuses.includes(job.status)
    && (user.role !== 'STAFF' || user.id === job.assignedTo);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (mutationPending) return; setError(''); setFeedback('');
    actionId.current ??= crypto.randomUUID();
    try {
      await onSave({ clientActionId: actionId.current, expectedVersion: job.version,
        meetingAt: instant(meetingAt), outcome: outcome || null,
        meetingSummary: summary.trim() || null, nextFollowUpAt: instant(followUp) });
      actionId.current = null; setFeedback('Görüşme sonucu kaydedildi.');
    } catch (caught) {
      if (caught instanceof ApiError && !caught.retryable) actionId.current = null;
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
        <input id="meeting-actual-at" type="datetime-local" value={meetingAt} onChange={(event) => setMeetingAt(event.target.value)} />
        <span className="field-status">Saat dilimi: {timezoneLabel()}</span></div>
      <div className="field-group"><label htmlFor="meeting-outcome">Sonuç</label>
        <select id="meeting-outcome" value={outcome} onChange={(event) => setOutcome(event.target.value as MeetingOutcome | '')}>
          <option value="">Sonuç seçin</option>{Object.entries(outcomeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
      <div className="field-group"><label htmlFor="meeting-summary">Görüşme özeti</label>
        <textarea id="meeting-summary" rows={5} maxLength={4000} value={summary} onChange={(event) => setSummary(event.target.value)} /></div>
      <div className="field-group"><label htmlFor="meeting-follow-up-at">Takip zamanı (isteğe bağlı)</label>
        <input id="meeting-follow-up-at" type="datetime-local" value={followUp} aria-describedby="meeting-follow-up-help"
          onChange={(event) => setFollowUp(event.target.value)} />
        <span id="meeting-follow-up-help" className={outcome === 'FOLLOW_UP_REQUIRED' ? 'field-guidance' : 'field-status'}>{followUpHelp}</span></div>
    </fieldset><button className="primary-button compact-button" type="submit" disabled={mutationPending}>
      {mutationPending ? 'Kaydediliyor…' : 'Görüşme sonucunu kaydet'}</button></form>
  </section>;
}
