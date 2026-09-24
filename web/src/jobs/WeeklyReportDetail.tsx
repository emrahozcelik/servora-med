import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';

import { ApiError, type CurrentUser } from '../services/api';
import {
  approveJobCard,
  cancelJobCard,
  getJobCard,
  requestJobCardRevision,
  resumeJobCard,
  startJobCard,
  submitJobCardForApproval,
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
import { captureStartLocation } from './start-location-capture';
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

function findTransition(
  presentation: JobWorkflowPresentation,
  command: LifecycleCommand,
): TransitionPresentation | undefined {
  if (presentation.primaryTransition?.command === command) return presentation.primaryTransition;
  return presentation.secondaryTransitions.find((transition) => transition.command === command);
}

export function WeeklyReportDetail({ jobCardId, user }: { jobCardId: string; user: CurrentUser }) {
  const [load, setLoad] = useState<LoadState>({ kind: 'loading' });
  const [job, setJob] = useState<JobCard | null>(null);
  const [report, setReport] = useState<WeeklyReportDetailDto | null>(null);
  const [history, setHistory] = useState<WeeklyReportSubmission[]>([]);
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const [draft, setDraft] = useState<WeeklyReportDraft | null>(null);
  const [answers, setAnswers] = useState<WeeklyReportAnswer[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [actionError, setActionError] = useState('');
  const [ambiguous, setAmbiguous] = useState(false);
  const [pending, setPending] = useState(false);
  const [dialog, setDialog] = useState<JobWorkflowDialogKind | null>(null);
  const loadGeneration = useRef(0);

  const refresh = useCallback(async () => {
    const generation = loadGeneration.current + 1;
    loadGeneration.current = generation;
    setLoad({ kind: 'loading' });
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
      setDraft(loadedReport.draft);
      setAnswers(loadedReport.answers);
      setSelectedSeq(submissions.length > 0 ? submissions[submissions.length - 1]!.seqNo : null);
      setLoad({ kind: 'ready' });
    } catch (caught) {
      if (loadGeneration.current !== generation) return;
      setLoad({
        kind: 'error',
        message: caught instanceof Error ? caught.message : 'Rapor yüklenemedi. Tekrar deneyin.',
      });
    }
  }, [jobCardId]);

  useEffect(() => { void refresh(); }, [refresh]);
  useRealtimeInvalidation([`job-detail:${jobCardId}`], () => { void refresh(); });

  if (load.kind === 'error') {
    return <main className="workspace"><ResultState status="error" title="Rapor yüklenemedi"
      description={load.message}
      action={<button className="secondary-button" type="button" onClick={() => void refresh()}>Tekrar dene</button>} /></main>;
  }
  if (!job || !report) {
    return <main className="workspace"><ResultState status="info" title="Rapor yükleniyor" description="Haftalık rapor hazırlanıyor…" /></main>;
  }
  const loadedJob: JobCard = job;
  const loadedReport: WeeklyReportDetailDto = report;

  const presentation = deriveJobWorkflowPresentation({
    job, user, workflowContext: loadedJob.workflowContext, deliveryItems: [], meetingDetails: null,
  });
  const isOwner = user.role === 'STAFF' && loadedReport.staffUserId === user.id;
  const editable = isOwner && (loadedJob.status === 'ACCEPTED' || loadedJob.status === 'IN_PROGRESS');
  const managementReview = user.role !== 'STAFF' && loadedJob.status === 'WAITING_APPROVAL';
  const selected = history.find((entry) => entry.seqNo === selectedSeq) ?? null;

  function setDraftField(key: keyof WeeklyReportDraft, value: string) {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
  }

  function setAnswer(questionKey: string, answer: string) {
    setAnswers((current) => {
      if (current.some((entry) => entry.questionKey === questionKey)) {
        return current.map((entry) => (entry.questionKey === questionKey ? { ...entry, answer } : entry));
      }
      return [...current, { questionKey, answer }];
    });
  }

  async function saveDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || !draft) return;
    setSaving(true); setSaveError('');
    try {
      const updated = await patchWeeklyReportDraft(jobCardId, {
        expectedVersion: loadedReport.version,
        draft,
        answers,
      });
      setReport(updated);
      setDraft(updated.draft);
      setAnswers(updated.answers);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'VERSION_CONFLICT') {
        await refresh();
        setSaveError('Rapor başka bir işlemde güncellendi. Güncel hali yükledik; değişikliklerinizi gözden geçirip tekrar kaydedin.');
      } else {
        setSaveError(caught instanceof Error ? caught.message : 'Taslak kaydedilemedi. Tekrar deneyin.');
      }
    } finally { setSaving(false); }
  }

  async function executeDirect(command: 'START' | 'RESUME' | 'WITHDRAW_FROM_APPROVAL') {
    setPending(true); setActionError('');
    try {
      if (command === 'START') {
        const locationCapture = await captureStartLocation();
        await startJobCard(loadedJob.id, {
          clientActionId: crypto.randomUUID(), expectedVersion: loadedJob.version, locationCapture,
        });
      } else if (command === 'RESUME') {
        await resumeJobCard(loadedJob.id, { clientActionId: crypto.randomUUID(), expectedVersion: loadedJob.version });
      } else {
        const { withdrawJobCardFromApproval } = await import('./jobs-api');
        await withdrawJobCardFromApproval(loadedJob.id, {
          clientActionId: crypto.randomUUID(), expectedVersion: loadedJob.version,
        });
      }
      setAmbiguous(false);
      await refresh();
    } catch (caught) {
      if (!isDefinitiveMutationError(caught)) setAmbiguous(true);
      setActionError(caught instanceof Error ? caught.message : 'İşlem tamamlanamadı. Tekrar deneyin.');
    } finally { setPending(false); }
  }

  function openDialog(command: 'SUBMIT_FOR_APPROVAL' | 'APPROVE' | 'REQUEST_REVISION' | 'CANCEL') {
    const transition = findTransition(presentation, command);
    if (!transition) return;
    const kind = command === 'SUBMIT_FOR_APPROVAL' ? 'submit'
      : command === 'APPROVE' ? 'approve'
      : command === 'REQUEST_REVISION' ? 'revision' : 'cancel';
    setDialog({ kind, presentation: transition } as JobWorkflowDialogKind);
  }

  async function confirmDialog(reason: string) {
    if (!dialog || dialog.kind === 'withdraw-edit') return;
    const command = dialog.kind === 'submit' ? 'SUBMIT_FOR_APPROVAL'
      : dialog.kind === 'approve' ? 'APPROVE'
      : dialog.kind === 'revision' ? 'REQUEST_REVISION' : 'CANCEL';
    setPending(true); setActionError('');
    try {
      const input = { clientActionId: crypto.randomUUID(), expectedVersion: loadedJob.version };
      if (command === 'SUBMIT_FOR_APPROVAL') {
        await submitJobCardForApproval(loadedJob.id, { ...input, note: reason });
      } else if (command === 'APPROVE') {
        await approveJobCard(loadedJob.id, reason ? { ...input, note: reason } : input);
      } else if (command === 'REQUEST_REVISION') {
        await requestJobCardRevision(loadedJob.id, { ...input, revisionReason: reason });
      } else {
        await cancelJobCard(loadedJob.id, { ...input, cancelReason: reason });
      }
      setAmbiguous(false);
      setDialog(null);
      await refresh();
    } catch (caught) {
      if (!isDefinitiveMutationError(caught)) setAmbiguous(true);
      setActionError(caught instanceof Error ? caught.message : 'İşlem tamamlanamadı. Tekrar deneyin.');
    } finally { setPending(false); }
  }

  function onCommand(command: LifecycleCommand, trigger: HTMLButtonElement) {
    void trigger;
    if (command === 'START' || command === 'RESUME' || command === 'WITHDRAW_FROM_APPROVAL') {
      void executeDirect(command);
      return;
    }
    if (command === 'SUBMIT_FOR_APPROVAL' || command === 'APPROVE'
      || command === 'REQUEST_REVISION' || command === 'CANCEL') {
      openDialog(command);
    }
  }

  return <main className="job-detail">
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
    {actionError && <div className="form-error" role="alert">{actionError}</div>}
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

    <section className="surface" aria-labelledby="weekly-activity-title">
      <h2 id="weekly-activity-title">Otomatik çalışma listesi</h2>
      <p className="form-help">Sistem tarafından üretildi; personelin o hafta tamamladığı işler. Düzenlenemez.</p>
      {loadedReport.liveSourceWork.length === 0
        ? <p className="empty-state">Bu hafta için uygun iş bulunamadı.</p>
        : <ul className="activity-list">
            {loadedReport.liveSourceWork.map((item) => (
              <li key={item.jobCardId} className="activity-item">
                <strong>{item.title}</strong>
                <span>{item.type}{item.customerName ? ` · ${item.customerName}` : ''}</span>
                <time>{item.staffCompletedAt}</time>
              </li>
            ))}
          </ul>}
    </section>

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
                value={draft?.[field.key] ?? ''}
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
                value={answers.find((entry) => entry.questionKey === question.key)?.answer ?? ''}
                onChange={(event) => setAnswer(question.key, event.target.value)}
              />
            </div>
          ))}
        </fieldset>
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

    <JobDecisionPanel
      primary={presentation.primaryTransition}
      secondary={presentation.secondaryTransitions}
      recordEditAction={null}
      pending={pending}
      startLocationCaptureEnabled={false}
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
        onConfirm={(reason) => void confirmDialog(reason)}
      />
    )}
  </main>;
}
