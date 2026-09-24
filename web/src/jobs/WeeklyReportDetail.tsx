import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';

import { ApiError, type CurrentUser } from '../services/api';
import {
  acceptJobCard,
  approveJobCard,
  cancelJobCard,
  getJobCard,
  requestJobCardRevision,
  resumeJobCard,
  startJobCard,
  submitJobCardForApproval,
  withdrawJobCardFromApproval,
  type JobCard,
  type LifecycleCommand,
} from './jobs-api';
import { jobTypeLabels } from './job-labels';
import {
  deriveJobWorkflowPresentation,
  type JobWorkflowPresentation,
  type TransitionPresentation,
} from './job-workflow-presentation';
import {
  CurrentResponsibilityPanel,
  RequirementsChecklist,
  RevisionLoopPanel,
  TerminalJobBanner,
} from './JobWorkflowPanels';
import { JobWorkflowDialog, type JobWorkflowDialogKind } from './JobWorkflowDialog';
import { JobApprovalReviewPanel } from './JobApprovalReviewPanel';
import { JobDecisionPanel } from './JobDecisionPanel';
import { isDefinitiveMutationError } from './mutation-attempt-error';
import { captureStartLocation, type StartLocationCapture } from './start-location-capture';
import { useRealtimeInvalidation } from '../realtime/RealtimeProvider';
import { PageHeader } from '../ui/PageHeader';
import { StatusChip } from '../ui/StatusChip';
import { ResultState } from '../ui/antd/ResultState';
import {
  getWeeklyReport,
  listWeeklyReportSubmissions,
  patchWeeklyReportDraft,
  type WeeklyReportAnswer,
  type WeeklyReportDetail as WeeklyReportDetailDto,
  type WeeklyReportDraft,
  type WeeklyReportSubmission,
} from './weekly-report-api';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'error'; message: string };

const DRAFT_FIELDS: { key: keyof WeeklyReportDraft; label: string; required: boolean }[] = [
  { key: 'summary', label: 'Haftanın özeti', required: true },
  { key: 'blockers', label: 'Sorunlar / engeller', required: false },
  { key: 'nextWeekPlan', label: 'Gelecek hafta planı', required: true },
  { key: 'highlights', label: 'Öne çıkan çalışmalar', required: false },
  { key: 'fieldObservations', label: 'Müşteri / saha gözlemleri', required: false },
  { key: 'supportNeeded', label: 'Yöneticiden destek beklenen konular', required: false },
];

const SUBMISSION_BODY_FIELDS: { key: keyof WeeklyReportSubmission['body']; label: string }[] = [
  { key: 'summary', label: 'Haftanın özeti' },
  { key: 'blockers', label: 'Sorunlar / engeller' },
  { key: 'nextWeekPlan', label: 'Gelecek hafta planı' },
  { key: 'highlights', label: 'Öne çıkan çalışmalar' },
  { key: 'fieldObservations', label: 'Müşteri / saha gözlemleri' },
  { key: 'supportNeeded', label: 'Yöneticiden destek beklenen konular' },
];

const DIRTY_SUBMIT_MESSAGE = 'Raporu göndermeden önce değişiklikleri kaydedin.';
const CONFLICT_MESSAGE = 'Rapor sunucuda değişti. Kaydedilmemiş değişiklikleriniz korunuyor. '
  + 'Kaydetmeden önce güncel sürümü gözden geçirin.';

/**
 * Last successfully loaded/saved server truth. Dirty state is *derived* from a
 * structural comparison against this baseline, never from a sticky "was ever
 * touched" flag, so editing then reverting to the persisted value is clean.
 */
type PersistedBaseline = {
  draft: WeeklyReportDraft;
  answers: WeeklyReportAnswer[];
  version: number;
};

type FormState = {
  draft: WeeklyReportDraft;
  answers: WeeklyReportAnswer[];
  baseline: PersistedBaseline;
};

/**
 * Retained lifecycle attempt. An ambiguous outcome must replay the exact
 * original request — same clientActionId, expectedVersion and payload — so a
 * lost response can never be turned into a second, different mutation.
 */
type LifecycleAttempt = {
  command: LifecycleCommand;
  input: {
    clientActionId: string;
    expectedVersion: number;
    note?: string;
    revisionReason?: string;
    cancelReason?: string;
    locationCapture?: StartLocationCapture;
  };
  reason: string;
};

function findTransition(
  presentation: JobWorkflowPresentation,
  command: LifecycleCommand,
): TransitionPresentation | undefined {
  if (presentation.primaryTransition?.command === command) return presentation.primaryTransition;
  return presentation.secondaryTransitions.find((transition) => transition.command === command);
}

function normalized(value: string | null | undefined): string {
  return value ?? '';
}

function draftsEqual(left: WeeklyReportDraft, right: WeeklyReportDraft): boolean {
  return DRAFT_FIELDS.every((field) => normalized(left[field.key]) === normalized(right[field.key]));
}

function answerMap(answers: readonly WeeklyReportAnswer[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const answer of answers) map.set(answer.questionKey, answer.answer);
  return map;
}

function answersEqual(left: readonly WeeklyReportAnswer[], right: readonly WeeklyReportAnswer[]): boolean {
  const leftMap = answerMap(left);
  const rightMap = answerMap(right);
  const keys = new Set([...leftMap.keys(), ...rightMap.keys()]);
  for (const key of keys) {
    if (normalized(leftMap.get(key)) !== normalized(rightMap.get(key))) return false;
  }
  return true;
}

function isFormDirty(state: FormState): boolean {
  return !draftsEqual(state.draft, state.baseline.draft)
    || !answersEqual(state.answers, state.baseline.answers);
}

function commandOf(dialog: JobWorkflowDialogKind): LifecycleCommand | null {
  if (dialog.kind === 'withdraw-edit') return null;
  if (dialog.kind === 'submit') return 'SUBMIT_FOR_APPROVAL';
  if (dialog.kind === 'approve') return 'APPROVE';
  if (dialog.kind === 'revision') return 'REQUEST_REVISION';
  return 'CANCEL';
}

export function WeeklyReportDetail({ jobCardId, user }: { jobCardId: string; user: CurrentUser }) {
  const [load, setLoad] = useState<LoadState>({ kind: 'loading' });
  const [job, setJob] = useState<JobCard | null>(null);
  const [report, setReport] = useState<WeeklyReportDetailDto | null>(null);
  const [history, setHistory] = useState<WeeklyReportSubmission[]>([]);
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [actionError, setActionError] = useState('');
  const [ambiguous, setAmbiguous] = useState(false);
  const [pending, setPending] = useState(false);
  const [dialog, setDialog] = useState<JobWorkflowDialogKind | null>(null);
  const loadGeneration = useRef(0);
  const formRef = useRef<FormState | null>(null);
  const attemptRef = useRef<LifecycleAttempt | null>(null);

  const applyForm = useCallback((next: FormState) => {
    formRef.current = next;
    setForm(next);
  }, []);

  /**
   * Server refresh. Job/status/history always refresh; the editable form is
   * hydrated only when it is clean (or an explicit reload was requested).
   * A dirty form keeps its local draft/answers *and* the baseline they were
   * derived from, so a server-side version move is surfaced as a conflict
   * instead of silently overwriting unsaved text.
   */
  const refresh = useCallback(async (options?: { hydrateForm?: boolean; showLoading?: boolean }) => {
    const generation = loadGeneration.current + 1;
    loadGeneration.current = generation;
    if (options?.showLoading) setLoad({ kind: 'loading' });
    try {
      const [loadedJob, loadedReport, submissions] = await Promise.all([
        getJobCard(jobCardId),
        getWeeklyReport(jobCardId),
        listWeeklyReportSubmissions(jobCardId),
      ]);
      if (loadGeneration.current !== generation) return;
      setJob(loadedJob);
      setReport(loadedReport);
      setHistory(submissions);
      setSelectedSeq((current) => current
        ?? (submissions.length > 0 ? submissions[submissions.length - 1]!.seqNo : null));
      const current = formRef.current;
      const dirty = current !== null && isFormDirty(current);
      if (options?.hydrateForm === true || current === null || !dirty) {
        applyForm({
          draft: loadedReport.draft,
          answers: loadedReport.answers,
          baseline: {
            draft: loadedReport.draft,
            answers: loadedReport.answers,
            version: loadedReport.version,
          },
        });
      }
      setLoad({ kind: 'ready' });
    } catch (caught) {
      if (loadGeneration.current !== generation) return;
      setLoad({
        kind: 'error',
        message: caught instanceof Error ? caught.message : 'Rapor yüklenemedi. Tekrar deneyin.',
      });
    }
  }, [applyForm, jobCardId]);

  useEffect(() => { void refresh({ showLoading: true }); }, [refresh]);
  useRealtimeInvalidation([`job-detail:${jobCardId}`], () => { void refresh(); });

  if (load.kind === 'error') {
    return <main className="workspace"><ResultState status="error" title="Rapor yüklenemedi"
      description={load.message}
      action={<button className="secondary-button" type="button"
        onClick={() => void refresh({ showLoading: true })}>Tekrar dene</button>} /></main>;
  }
  if (!job || !report || !form) {
    return <main className="workspace"><ResultState status="info" title="Rapor yükleniyor" description="Haftalık rapor hazırlanıyor…" /></main>;
  }
  const loadedJob: JobCard = job;
  const loadedReport: WeeklyReportDetailDto = report;
  const loadedForm: FormState = form;

  const presentation = deriveJobWorkflowPresentation({
    job, user, workflowContext: loadedJob.workflowContext, deliveryItems: [], meetingDetails: null,
  });
  const startLocationCaptureEnabled = loadedJob.workflowContext.startLocationCaptureEnabled;
  const isOwner = user.role === 'STAFF' && loadedReport.staffUserId === user.id;
  const editable = isOwner && (loadedJob.status === 'ACCEPTED' || loadedJob.status === 'IN_PROGRESS');
  const managementReview = user.role !== 'STAFF' && loadedJob.status === 'WAITING_APPROVAL';
  const selected = history.find((entry) => entry.seqNo === selectedSeq) ?? null;
  const latestSubmission = history.length > 0 ? history[history.length - 1]! : null;
  const frozenReview = latestSubmission !== null
    && (loadedJob.status === 'WAITING_APPROVAL' || loadedJob.status === 'COMPLETED');
  const frozenPrimary = frozenReview && (managementReview || loadedJob.status === 'COMPLETED');

  const formDirty = isFormDirty(loadedForm);
  const conflict = loadedForm.baseline.version !== loadedReport.version;
  const submitBlockedReason = editable
    ? saving ? 'Taslak kaydedilirken rapor gönderilemez.'
      : formDirty ? DIRTY_SUBMIT_MESSAGE
        : conflict ? CONFLICT_MESSAGE
          : null
    : null;

  const presentationCommands: LifecycleCommand[] = [
    ...(presentation.primaryTransition ? [presentation.primaryTransition.command] : []),
    ...presentation.secondaryTransitions.map((transition) => transition.command),
  ];
  const blockedCommands = new Set<LifecycleCommand>();
  if (submitBlockedReason !== null) blockedCommands.add('SUBMIT_FOR_APPROVAL');
  if (saving || ambiguous) {
    for (const command of presentationCommands) blockedCommands.add(command);
  }

  function setDraftField(key: keyof WeeklyReportDraft, value: string) {
    const current = formRef.current;
    if (!current) return;
    applyForm({ ...current, draft: { ...current.draft, [key]: value } });
  }

  function setAnswer(questionKey: string, answer: string) {
    const current = formRef.current;
    if (!current) return;
    const answers = current.answers.some((entry) => entry.questionKey === questionKey)
      ? current.answers.map((entry) => (entry.questionKey === questionKey ? { ...entry, answer } : entry))
      : [...current.answers, { questionKey, answer }];
    applyForm({ ...current, answers });
  }

  async function saveDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const current = formRef.current;
    if (saving || !current) return;
    setSaving(true); setSaveError('');
    try {
      const updated = await patchWeeklyReportDraft(jobCardId, {
        expectedVersion: current.baseline.version,
        draft: current.draft,
        answers: current.answers,
      });
      setReport(updated);
      applyForm({
        draft: updated.draft,
        answers: updated.answers,
        baseline: {
          draft: updated.draft,
          answers: updated.answers,
          version: updated.version,
        },
      });
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'VERSION_CONFLICT') {
        // Never discard the user's local edits. Refresh the server-side
        // metadata only; the dirty form is preserved and the version gap is
        // surfaced as an explicit conflict the user resolves deliberately.
        await refresh();
        setSaveError(CONFLICT_MESSAGE);
      } else {
        setSaveError(caught instanceof Error ? caught.message : 'Taslak kaydedilemedi. Tekrar deneyin.');
      }
    } finally { setSaving(false); }
  }

  async function dispatchCommand(command: LifecycleCommand, input: LifecycleAttempt['input']) {
    switch (command) {
      case 'ACCEPT_ASSIGNMENT':
        return acceptJobCard(loadedJob.id, input);
      case 'START':
        return startJobCard(loadedJob.id, input.locationCapture === undefined
          ? input
          : { ...input, locationCapture: input.locationCapture });
      case 'RESUME':
        return resumeJobCard(loadedJob.id, input);
      case 'WITHDRAW_FROM_APPROVAL':
        return withdrawJobCardFromApproval(loadedJob.id, input);
      case 'SUBMIT_FOR_APPROVAL':
        return submitJobCardForApproval(loadedJob.id, { ...input, note: input.note ?? '' });
      case 'APPROVE':
        return approveJobCard(loadedJob.id, input.note ? { ...input, note: input.note } : input);
      case 'REQUEST_REVISION':
        return requestJobCardRevision(loadedJob.id, { ...input, revisionReason: input.revisionReason ?? '' });
      case 'CANCEL':
        return cancelJobCard(loadedJob.id, { ...input, cancelReason: input.cancelReason ?? '' });
      default: {
        const exhaustive: never = command;
        throw new Error(`Unsupported lifecycle command: ${exhaustive}`);
      }
    }
  }

  async function runLifecycle(command: LifecycleCommand, reason: string) {
    if (pending) return;
    const retained = attemptRef.current;
    // Unrelated actions are blocked while an ambiguous attempt is frozen.
    if (retained !== null && retained.command !== command) return;
    setPending(true); setActionError('');
    try {
      if (retained === null) {
        const input: LifecycleAttempt['input'] = {
          clientActionId: crypto.randomUUID(),
          expectedVersion: loadedJob.version,
        };
        if (command === 'SUBMIT_FOR_APPROVAL') input.note = reason;
        else if (command === 'APPROVE' && reason.trim()) input.note = reason.trim();
        else if (command === 'REQUEST_REVISION') input.revisionReason = reason;
        else if (command === 'CANCEL') input.cancelReason = reason;
        else if (command === 'START' && startLocationCaptureEnabled) {
          input.locationCapture = await captureStartLocation();
        }
        attemptRef.current = { command, input, reason };
      }
      const attempt = attemptRef.current;
      if (attempt === null) return;
      await dispatchCommand(attempt.command, attempt.input);
      attemptRef.current = null;
      setAmbiguous(false);
      setDialog(null);
      await refresh();
    } catch (caught) {
      if (caught instanceof ApiError
        && (caught.code === 'VERSION_CONFLICT' || caught.code === 'INVALID_TRANSITION')) {
        attemptRef.current = null;
        setAmbiguous(false);
        setDialog(null);
        await refresh();
        setActionError('İş başka bir işlemle güncellendi. En güncel durum gösteriliyor.');
      } else if (isDefinitiveMutationError(caught)) {
        attemptRef.current = null;
        setAmbiguous(false);
        setActionError(caught instanceof Error ? caught.message : 'İşlem tamamlanamadı. Tekrar deneyin.');
      } else {
        // Ambiguous: keep the exact original attempt frozen for replay.
        setAmbiguous(true);
        setActionError(caught instanceof Error
          ? caught.message
          : 'İşlem sonucu doğrulanamadı. Özgün isteği tekrar deneyebilirsiniz.');
      }
    } finally { setPending(false); }
  }

  function retryAttempt() {
    const attempt = attemptRef.current;
    if (attempt === null) return;
    void runLifecycle(attempt.command, attempt.reason);
  }

  function openDialog(command: LifecycleCommand) {
    const transition = findTransition(presentation, command);
    if (!transition) return;
    const kind = command === 'SUBMIT_FOR_APPROVAL' ? 'submit'
      : command === 'APPROVE' ? 'approve'
      : command === 'REQUEST_REVISION' ? 'revision' : 'cancel';
    setDialog({ kind, presentation: transition } as JobWorkflowDialogKind);
  }

  function onCommand(command: LifecycleCommand, trigger: HTMLButtonElement) {
    void trigger;
    if (ambiguous || blockedCommands.has(command)) {
      if (submitBlockedReason !== null) setActionError(submitBlockedReason);
      return;
    }
    if (command === 'ACCEPT_ASSIGNMENT' || command === 'START'
      || command === 'RESUME' || command === 'WITHDRAW_FROM_APPROVAL') {
      void runLifecycle(command, '');
      return;
    }
    if (command === 'SUBMIT_FOR_APPROVAL' || command === 'APPROVE'
      || command === 'REQUEST_REVISION' || command === 'CANCEL') {
      openDialog(command);
    }
  }

  function confirmDialog(reason: string) {
    if (!dialog) return;
    const command = commandOf(dialog);
    if (command === null) return;
    if (ambiguous) { retryAttempt(); return; }
    void runLifecycle(command, reason);
  }

  const sourceWork = frozenReview && latestSubmission !== null
    ? latestSubmission.sourceWork
    : loadedReport.liveSourceWork;

  return <main className="job-detail" data-weekly-report-detail="true">
    <PageHeader
      eyebrow={jobTypeLabels[loadedJob.type]}
      description={`${loadedReport.periodStart} – ${loadedReport.periodEnd}`}
      fallbackTitle={loadedJob.title}
    />
    <div className="job-identity">
      <StatusChip status={loadedJob.status} />
      <dl className="identity-grid">
        <div><dt>Personel</dt><dd>{loadedJob.assignee.name}</dd></div>
        <div><dt>Rapor haftası</dt><dd>{loadedReport.periodStart} – {loadedReport.periodEnd}</dd></div>
        <div><dt>Termin</dt><dd>{loadedReport.dueDate ?? 'Belirtilmedi'}</dd></div>
        <div><dt>Rapor sürümü</dt><dd>v{loadedReport.version}</dd></div>
      </dl>
    </div>
    {actionError && <div className="form-error" role="alert">
      {actionError}
      {ambiguous && <>{' '}<button className="secondary-button" type="button" disabled={pending}
        onClick={retryAttempt}>Özgün işlemi tekrar dene</button></>}
    </div>}
    <CurrentResponsibilityPanel presentation={presentation} assigneeName={loadedJob.assignee.name} />
    {managementReview && (
      <JobApprovalReviewPanel
        job={loadedJob}
        lifecycle={loadedJob.workflowContext.lifecycle}
        requirements={presentation.requirements}
      />
    )}
    {!managementReview && presentation.terminalState === null && presentation.requirements.length > 0 && (
      <RequirementsChecklist requirements={presentation.requirements} />
    )}
    {presentation.revisionLoop && <RevisionLoopPanel loop={presentation.revisionLoop} />}
    {presentation.terminalDetails && <TerminalJobBanner details={presentation.terminalDetails} />}

    {loadedReport.instructions && (
      <section className="surface weekly-instructions" aria-labelledby="weekly-instructions-title">
        <h2 id="weekly-instructions-title">Yönetici talimatı</h2>
        <p className="form-help">Talep sahibi tarafından yazıldı; düzenlenemez.</p>
        <p className="weekly-instructions-text">{loadedReport.instructions}</p>
      </section>
    )}

    <section className="surface" aria-labelledby="weekly-activity-title">
      <h2 id="weekly-activity-title">
        {frozenReview ? 'Gönderimde dondurulan çalışma listesi' : 'Otomatik çalışma listesi'}
      </h2>
      <p className="form-help">{frozenReview
        ? 'Gönderim anında donduruldu; sonradan değişmez.'
        : 'Sistem tarafından üretildi; personelin o hafta tamamladığı işler. Düzenlenemez.'}</p>
      {sourceWork.length === 0
        ? <p className="empty-state">{frozenReview
          ? 'Gönderimde dondurulan çalışma listesi boş.'
          : 'Bu hafta için uygun iş bulunamadı.'}</p>
        : <ul className="activity-list">
            {sourceWork.map((item) => (
              <li key={item.jobCardId} className="activity-item">
                <strong>{item.title}</strong>
                <span>{item.type}{item.customerName ? ` · ${item.customerName}` : ''}</span>
                <time>{item.staffCompletedAt}</time>
              </li>
            ))}
          </ul>}
    </section>

    {frozenPrimary && latestSubmission && (
      <section className="surface weekly-frozen-report" aria-labelledby="weekly-frozen-title">
        <h2 id="weekly-frozen-title">Gönderilen rapor</h2>
        <p className="form-help">
          {`Gönderim #${latestSubmission.seqNo} · ${latestSubmission.submittedAt} · ${latestSubmission.submittedBy}`}
        </p>
        <dl className="identity-grid">
          {SUBMISSION_BODY_FIELDS.map((field) => (
            <div key={field.key}><dt>{field.label}</dt><dd>{latestSubmission.body[field.key] ?? '—'}</dd></div>
          ))}
          {latestSubmission.answers.map((answer) => (
            <div key={answer.questionKey}>
              <dt>{latestSubmission.questions.find((question) => question.key === answer.questionKey)?.prompt
                ?? answer.questionKey}</dt>
              <dd>{answer.answer}</dd>
            </div>
          ))}
        </dl>
      </section>
    )}

    {!frozenPrimary && (
      <section className="surface" aria-labelledby="weekly-report-title">
        <h2 id="weekly-report-title">Haftalık rapor</h2>
        <form onSubmit={saveDraft}>
          <fieldset disabled={!editable || saving}>
            {DRAFT_FIELDS.map((field) => (
              <div className="field-group" key={field.key}>
                <label htmlFor={`weekly-${field.key}`}>
                  {field.label}{field.required ? ' *' : ''}
                </label>
                <textarea
                  id={`weekly-${field.key}`}
                  rows={3}
                  value={loadedForm.draft[field.key] ?? ''}
                  onChange={(event) => setDraftField(field.key, event.target.value)}
                />
              </div>
            ))}
            {loadedReport.questions.length > 0 && <h3>Yönetici soruları</h3>}
            {loadedReport.questions.map((question) => (
              <div className="field-group" key={question.key}>
                <label htmlFor={`weekly-answer-${question.key}`}>{question.prompt} *</label>
                <textarea
                  id={`weekly-answer-${question.key}`}
                  rows={3}
                  value={loadedForm.answers.find((entry) => entry.questionKey === question.key)?.answer ?? ''}
                  onChange={(event) => setAnswer(question.key, event.target.value)}
                />
              </div>
            ))}
          </fieldset>
          {conflict && <div className="form-error weekly-conflict" role="alert">
            {CONFLICT_MESSAGE}
            {' '}
            <button className="secondary-button" type="button" disabled={saving}
              onClick={() => { setSaveError(''); void refresh({ hydrateForm: true }); }}>Sunucudaki sürümü yükle</button>
          </div>}
          {saveError && <div className="form-error" role="alert">{saveError}</div>}
          {editable && (
            <div className="form-actions">
              <button className="primary-button" type="submit" disabled={saving}>
                {saving ? 'Kaydediliyor…' : 'Taslağı kaydet'}
              </button>
            </div>
          )}
        </form>
      </section>
    )}

    {submitBlockedReason && (
      <p className="form-help weekly-submit-notice" role="status">{submitBlockedReason}</p>
    )}
    <JobDecisionPanel
      primary={presentation.primaryTransition}
      secondary={presentation.secondaryTransitions}
      recordEditAction={null}
      pending={pending}
      startLocationCaptureEnabled={startLocationCaptureEnabled}
      disabledCommands={[...blockedCommands]}
      onCommand={onCommand}
    />

    <section className="surface" aria-labelledby="weekly-history-title">
      <h2 id="weekly-history-title">Gönderim geçmişi</h2>
      {history.length === 0
        ? <p className="empty-state">Henüz gönderim yok.</p>
        : <>
            <div className="field-group">
              <label htmlFor="weekly-history-select">Sürüm</label>
              <select
                id="weekly-history-select"
                value={selectedSeq ?? history[history.length - 1]!.seqNo}
                onChange={(event) => setSelectedSeq(Number(event.target.value))}
              >
                {history.map((entry) => (
                  <option key={entry.seqNo} value={entry.seqNo}>
                    #{entry.seqNo} · {entry.submittedAt}
                  </option>
                ))}
              </select>
            </div>
            {selected && (
              <dl className="identity-grid">
                <div><dt>Gönderen</dt><dd>{selected.submittedBy}</dd></div>
                <div><dt>Zaman</dt><dd>{selected.submittedAt}</dd></div>
                <div><dt>Özet</dt><dd>{selected.body.summary}</dd></div>
                <div><dt>Sorunlar</dt><dd>{selected.body.blockers ?? '—'}</dd></div>
                <div><dt>Gelecek hafta</dt><dd>{selected.body.nextWeekPlan}</dd></div>
                {selected.answers.map((answer) => (
                  <div key={answer.questionKey}>
                    <dt>{selected.questions.find((q) => q.key === answer.questionKey)?.prompt ?? answer.questionKey}</dt>
                    <dd>{answer.answer}</dd>
                  </div>
                ))}
                <div><dt>Otomatik liste ({selected.sourceWork.length})</dt>
                  <dd>{selected.sourceWork.map((item) => item.title).join(' · ') || '—'}</dd></div>
              </dl>
            )}
          </>}
    </section>

    {dialog && dialog.kind !== 'withdraw-edit' && (
      <JobWorkflowDialog
        dialog={dialog}
        pending={pending}
        uncertain={ambiguous}
        onClose={() => setDialog(null)}
        onConfirm={confirmDialog}
      />
    )}
  </main>;
}
