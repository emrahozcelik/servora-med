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
  type JobCardStatus,
  type LifecycleCommand,
} from './jobs-api';
import { jobTypeLabel, jobTypeLabels } from './job-labels';
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
import { JobTimeline } from './JobTimeline';
import { isDefinitiveMutationError } from './mutation-attempt-error';
import { captureActionLocation, type ActionLocationCapture } from './start-location-capture';
import { submitComparisonWarning } from './location-distance-format';
import { useRealtimeInvalidation } from '../realtime/RealtimeProvider';
import { PageHeader } from '../ui/PageHeader';
import { StatusChip } from '../ui/StatusChip';
import { ResultState } from '../ui/antd/ResultState';
import {
  RecordDescriptions,
  WorkflowSteps,
  type RecordDescriptionItem,
} from '../ui/antd';
import {
  downloadWeeklyReportSubmissionPdf,
  getWeeklyReport,
  listWeeklyReportSubmissions,
  patchWeeklyReportDraft,
  type WeeklyReportAnswer,
  type WeeklyReportDetail as WeeklyReportDetailDto,
  type WeeklyReportDraft,
  type WeeklyReportSubmission,
} from './weekly-report-api';
import { saveBlobAs } from '../services/file-download';

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
 * Human-readable presentation for a server-owned instant.
 *
 * This only *formats* the instant the server sent; it performs no timezone or
 * calendar arithmetic, so the screen never invents a device-local authority over
 * the value. Unparseable input degrades to a dash instead of "Invalid Date".
 */
function formatInstant(value: string): string {
  const instant = new Date(value);
  return Number.isNaN(instant.valueOf()) ? '—' : new Intl.DateTimeFormat('tr-TR', {
    dateStyle: 'medium', timeStyle: 'short',
  }).format(instant);
}

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
    locationCapture?: ActionLocationCapture;
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

/**
 * Copy for the report section when the viewer may not edit it. Presentation
 * only: the lifecycle authority is unchanged — `editable` still decides whether
 * a form is offered at all, so this never grants or revokes access.
 */
function lockedReportNotice(status: JobCardStatus, owner: boolean): string {
  if (!owner) return 'Raporu yalnızca atanan personel düzenleyebilir.';
  switch (status) {
    case 'NEW':
      return 'Raporu hazırlamaya başlamak için önce atanan işi kabul edin.';
    case 'REVISION_REQUESTED':
      return 'Düzeltmeye başladıktan sonra raporu yeniden düzenleyebilirsiniz.';
    case 'WAITING_APPROVAL':
      return 'Rapor yönetici kontrolünde; kontrol tamamlanana kadar düzenlenemez.';
    case 'COMPLETED':
      return 'Rapor tamamlandı; içerik gönderim anında donduruldu.';
    case 'CANCELLED':
      return 'İş iptal edildi; rapor düzenlenemez.';
    case 'INVALIDATED':
      return 'İş geçersiz kılındı; rapor düzenlenemez.';
    default:
      return 'Rapor şu an düzenlenemiyor.';
  }
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
  /**
   * Slice 2 advisory post-submit notice (neutral, non-error). Set only on a
   * successful DIFFERENT submit; cleared when a new lifecycle starts.
   */
  const [actionNotice, setActionNotice] = useState('');
  const [pdfPending, setPdfPending] = useState(false);
  const [pdfError, setPdfError] = useState('');
  const [ambiguous, setAmbiguous] = useState(false);
  const [pending, setPending] = useState(false);
  const [dialog, setDialog] = useState<JobWorkflowDialogKind | null>(null);
  const [timelineKey, setTimelineKey] = useState(0);
  const loadGeneration = useRef(0);
  const formRef = useRef<FormState | null>(null);
  const attemptRef = useRef<LifecycleAttempt | null>(null);
  /**
   * Synchronous lifecycle ownership. React `pending` state only flips after a
   * rerender, so two triggers in the same tick would both observe
   * `pending === false` and mint different clientActionIds/captures. This ref
   * is claimed synchronously before any awaited location capture; a second
   * invocation during the same operation creates nothing.
   */
  const lifecycleInFlight = useRef(false);
  /**
   * Minimal session identity for the lifecycle path (mirrors the generic
   * detail screen's operation/session check without its realtime machinery).
   * After every awaited boundary the operation must still belong to the
   * mounted component for the same jobCardId, otherwise it terminates
   * without dispatching or touching the replacement screen's state.
   */
  const lifecycleSession = useRef({ jobId: jobCardId, active: true });

  function isLifecycleCurrent(operationJobId: string) {
    const session = lifecycleSession.current;
    return session.active && session.jobId === operationJobId;
  }

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
        // Slice 1 reader gate: this screen can submit, so it opts into the
        // SUBMIT capability flag previous bundles never request.
        getJobCard(jobCardId, { includeSubmitLocationCapability: true }),
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
  /**
   * Session reset. A retained ambiguous attempt belongs to the previous job's
   * version/clientActionId and must never replay against the new job; an
   * in-flight operation of the previous job releases its claim so the new
   * screen is never blocked by a stale owner.
   */
  useEffect(() => {
    lifecycleSession.current = { jobId: jobCardId, active: true };
    lifecycleInFlight.current = false;
    attemptRef.current = null;
    setAmbiguous(false);
    return () => {
      lifecycleSession.current.active = false;
    };
  }, [jobCardId]);

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
  const submitLocationCaptureEnabled = loadedJob.workflowContext.submitLocationCaptureEnabled;
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

  /**
   * Read-only download of one frozen submission version. The seq is explicit,
   * so what the user sees selected is exactly what is downloaded.
   */
  async function downloadPdf(seqNo: number) {
    if (pdfPending) return;
    setPdfPending(true); setPdfError('');
    try {
      const { blob, fileName } = await downloadWeeklyReportSubmissionPdf(jobCardId, seqNo);
      saveBlobAs(blob, fileName);
    } catch (caught) {
      setPdfError(caught instanceof Error ? caught.message : 'PDF indirilemedi. Tekrar deneyin.');
    } finally { setPdfPending(false); }
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
    // Synchronous claim BEFORE any awaited location capture: a second trigger
    // in the same tick must not mint another clientActionId/capture.
    if (lifecycleInFlight.current) return;
    const retained = attemptRef.current;
    // Unrelated actions are blocked while an ambiguous attempt is frozen.
    if (retained !== null && retained.command !== command) return;
    lifecycleInFlight.current = true;
    const operationJobId = jobCardId;
    setPending(true); setActionError(''); setActionNotice('');
    try {
      if (retained === null) {
        const input: LifecycleAttempt['input'] = {
          clientActionId: crypto.randomUUID(),
          expectedVersion: loadedJob.version,
        };
        if (command === 'SUBMIT_FOR_APPROVAL') {
          input.note = reason;
          // Slice 1: advisory one-shot SUBMIT snapshot, bound to this exact
          // attempt so ambiguous retry reuses it without recapturing.
          if (submitLocationCaptureEnabled) {
            input.locationCapture = await captureActionLocation();
            // Navigated/unmounted while capturing: never dispatch for the old job.
            if (!isLifecycleCurrent(operationJobId)) return;
          }
        }
        else if (command === 'APPROVE' && reason.trim()) input.note = reason.trim();
        else if (command === 'REQUEST_REVISION') input.revisionReason = reason;
        else if (command === 'CANCEL') input.cancelReason = reason;
        else if (command === 'START' && startLocationCaptureEnabled) {
          input.locationCapture = await captureActionLocation();
          if (!isLifecycleCurrent(operationJobId)) return;
        }
        attemptRef.current = { command, input, reason };
      }
      const attempt = attemptRef.current;
      if (attempt === null || !isLifecycleCurrent(operationJobId)) return;
      const updated = await dispatchCommand(attempt.command, attempt.input);
      if (!isLifecycleCurrent(operationJobId)) return;
      attemptRef.current = null;
      setAmbiguous(false);
      setDialog(null);
      await refresh();
      if (!isLifecycleCurrent(operationJobId)) return;
      // The shared activity timeline (SUBMIT location evidence included)
      // reloads from the first page after a successful lifecycle mutation.
      setTimelineKey((value) => value + 1);
      // Slice 2: advisory post-submit notice on the mutation response. The
      // submission already succeeded — informational only, no second
      // request, no misconduct implication. MATCH/UNRELIABLE stay silent.
      if (attempt.command === 'SUBMIT_FOR_APPROVAL'
        && updated.submitLocationComparison?.outcome === 'DIFFERENT') {
        setActionNotice(submitComparisonWarning(updated.submitLocationComparison.distanceMeters));
      }
    } catch (caught) {
      if (!isLifecycleCurrent(operationJobId)) return;
      if (caught instanceof ApiError
        && (caught.code === 'VERSION_CONFLICT' || caught.code === 'INVALID_TRANSITION')) {
        attemptRef.current = null;
        setAmbiguous(false);
        setDialog(null);
        await refresh();
        setActionError('İş başka bir işlemle güncellendi. En güncel durum gösteriliyor.');
        setActionNotice('');
      } else if (isDefinitiveMutationError(caught)) {
        attemptRef.current = null;
        setAmbiguous(false);
        setActionError(caught instanceof Error ? caught.message : 'İşlem tamamlanamadı. Tekrar deneyin.');
        setActionNotice('');
      } else {
        // Ambiguous: keep the exact original attempt frozen for replay.
        setAmbiguous(true);
        setActionError(caught instanceof Error
          ? caught.message
          : 'İşlem sonucu doğrulanamadı. Özgün isteği tekrar deneyebilirsiniz.');
        setActionNotice('');
      }
    } finally { lifecycleInFlight.current = false; setPending(false); }
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

  const showRequirements = !managementReview
    && presentation.terminalState === null
    && presentation.requirements.length > 0;
  const hasDecision = Boolean(
    presentation.primaryTransition || presentation.secondaryTransitions.length > 0,
  );
  const hasWorkflowMain = Boolean(showRequirements || hasDecision);
  const hasRail = Boolean(managementReview || hasWorkflowMain);
  const showFrozenReport = frozenPrimary && latestSubmission !== null;

  const reportFacts: RecordDescriptionItem[] = [
    { key: 'assignee', label: 'Personel', content: loadedJob.assignee.name },
    {
      key: 'period',
      label: 'Rapor haftası',
      content: `${loadedReport.periodStart} – ${loadedReport.periodEnd}`,
    },
    {
      key: 'due-date',
      label: 'Teslim son tarihi',
      content: loadedReport.dueDate ?? 'Belirtilmedi',
    },
    { key: 'version', label: 'Rapor sürümü', content: `v${loadedReport.version}` },
  ];

  const frozenReportFacts: RecordDescriptionItem[] = latestSubmission === null ? [] : [
    ...SUBMISSION_BODY_FIELDS.map((field) => ({
      key: field.key,
      label: field.label,
      content: latestSubmission.body[field.key] ?? '—',
    })),
    ...latestSubmission.answers.map((answer) => ({
      key: answer.questionKey,
      label: latestSubmission.questions.find((question) => question.key === answer.questionKey)?.prompt
        ?? answer.questionKey,
      content: answer.answer,
    })),
  ];

  const historyFacts: RecordDescriptionItem[] = selected === null ? [] : [
    { key: 'submitted-by', label: 'Gönderen', content: selected.submittedBy },
    { key: 'submitted-at', label: 'Zaman', content: formatInstant(selected.submittedAt) },
    { key: 'summary', label: 'Özet', content: selected.body.summary },
    { key: 'blockers', label: 'Sorunlar', content: selected.body.blockers ?? '—' },
    { key: 'next-week', label: 'Gelecek hafta', content: selected.body.nextWeekPlan },
    ...selected.answers.map((answer) => ({
      key: answer.questionKey,
      label: selected.questions.find((question) => question.key === answer.questionKey)?.prompt
        ?? answer.questionKey,
      content: answer.answer,
    })),
    {
      key: 'source-work',
      label: `Otomatik liste (${selected.sourceWork.length})`,
      content: selected.sourceWork.map((item) => item.title).join(' · ') || '—',
      wide: true,
    },
  ];

  // DOM/keyboard order mirrors JobDetail: heading → feedback → lifecycle →
  // revision|terminal|responsibility → facts → content → management review →
  // actions → timeline.
  return <main className="job-detail" data-weekly-report-detail="true">
    <div data-job-detail-section="heading">
      <PageHeader
        eyebrow={jobTypeLabels[loadedJob.type]}
        description={`${loadedReport.periodStart} – ${loadedReport.periodEnd}`}
        fallbackTitle={loadedJob.title}
      />
      <div className="detail-heading-meta" data-job-detail-meta="true">
        <StatusChip status={loadedJob.status} />
      </div>
    </div>
      {actionError && <div
        className="detail-feedback detail-feedback-error"
        role="alert"
        data-job-detail-section="feedback"
      >
        {actionError}
        {ambiguous && <>{' '}<button className="secondary-button" type="button" disabled={pending}
          onClick={retryAttempt}>Özgün işlemi tekrar dene</button></>}
      </div>}
      {actionNotice && <div
        className="detail-feedback"
        role="status"
        data-job-detail-section="feedback"
      >
        {actionNotice}
      </div>}
    <div data-job-detail-section="lifecycle">
      <WorkflowSteps
        items={presentation.phaseItems.map((item) => ({
          key: item.phase, label: item.label, state: item.state,
        }))}
        currentKey={presentation.currentPhase}
      />
    </div>
    {presentation.revisionLoop && (
      <div data-job-detail-section="revision">
        <RevisionLoopPanel loop={presentation.revisionLoop} />
      </div>
    )}
    {presentation.terminalDetails && (
      <div data-job-detail-section="terminal">
        <TerminalJobBanner details={presentation.terminalDetails} />
      </div>
    )}
    {presentation.terminalState === null && (
      <div data-job-detail-section="responsibility">
        <CurrentResponsibilityPanel
          presentation={presentation}
          assigneeName={loadedJob.assignee.name}
        />
      </div>
    )}

    <div className={hasRail ? 'job-detail-content job-detail-content--rail' : 'job-detail-content'}>
      <div className="job-detail-main">
        <section
          className="detail-summary surface-flat"
          data-job-detail-section="facts"
          data-job-detail-block="record-facts"
        >
          <RecordDescriptions
            ariaLabel="Haftalık rapor kayıt bilgileri"
            items={reportFacts}
            maxColumns={hasRail ? 1 : 2}
          />
        </section>

        {loadedReport.instructions && (
          <section className="surface weekly-instructions" aria-labelledby="weekly-instructions-title">
            <h2 id="weekly-instructions-title">Yönetici talimatı</h2>
            <p className="form-help">Talep sahibi tarafından yazıldı; düzenlenemez.</p>
            <p className="weekly-instructions-text">{loadedReport.instructions}</p>
          </section>
        )}

        <section
          className="surface weekly-activity"
          aria-labelledby="weekly-activity-title"
          data-job-detail-block="weekly-activity"
        >
          <h2 id="weekly-activity-title">
            {frozenReview ? 'Gönderimde dondurulan çalışma listesi' : 'Otomatik çalışma listesi'}
          </h2>
          <p className="form-help">{frozenReview
            ? 'Gönderim anında donduruldu; sonradan değişmez.'
            : 'Sistem tarafından üretildi; personelin o hafta tamamladığı işler. Düzenlenemez.'}</p>
          {sourceWork.length === 0
            ? <p className="weekly-activity-empty">{frozenReview
              ? 'Gönderimde dondurulan çalışma listesi boş.'
              : 'Bu hafta için uygun iş bulunamadı.'}</p>
            : <ul className="weekly-activity-list">
                {sourceWork.map((item) => (
                  <li key={item.jobCardId} className="weekly-activity-row">
                    <span className="weekly-activity-row-title">{item.title}</span>
                    <span className="weekly-activity-row-meta">
                      {jobTypeLabel(item.type)}{item.customerName ? ` · ${item.customerName}` : ''}
                    </span>
                    <time className="weekly-activity-row-time" dateTime={item.staffCompletedAt}>
                      {formatInstant(item.staffCompletedAt)}
                    </time>
                  </li>
                ))}
              </ul>}
        </section>

        {showFrozenReport && (
          <section
            className="surface weekly-frozen-report"
            aria-labelledby="weekly-frozen-title"
            data-job-detail-block="weekly-frozen-report"
          >
            <h2 id="weekly-frozen-title">Gönderilen rapor</h2>
            <p className="form-help">
              {`Gönderim #${latestSubmission.seqNo} · ${formatInstant(latestSubmission.submittedAt)} · ${latestSubmission.submittedBy}`}
            </p>
            <RecordDescriptions
              ariaLabel="Gönderilen rapor içeriği"
              items={frozenReportFacts}
              maxColumns={hasRail ? 1 : 2}
            />
          </section>
        )}

        {!showFrozenReport && editable && (
          <section
            className="surface weekly-report-editor"
            aria-labelledby="weekly-report-title"
            data-job-detail-block="weekly-report-editor"
          >
            <h2 id="weekly-report-title">Haftalık rapor</h2>
            <form onSubmit={saveDraft}>
              <fieldset disabled={saving}>
                <section className="weekly-report-section" aria-labelledby="weekly-content-heading">
                  <h3 id="weekly-content-heading" className="weekly-section-heading">Rapor içeriği</h3>
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
                </section>
                {loadedReport.questions.length > 0 && (
                  <section className="weekly-report-section" aria-labelledby="weekly-questions-heading">
                    <h3 id="weekly-questions-heading" className="weekly-section-heading">
                      Yönetici soruları
                    </h3>
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
                  </section>
                )}
              </fieldset>
              {conflict && <div className="form-error weekly-conflict" role="alert">
                {CONFLICT_MESSAGE}
                {' '}
                <button className="secondary-button" type="button" disabled={saving}
                  onClick={() => { setSaveError(''); void refresh({ hydrateForm: true }); }}>Sunucudaki sürümü yükle</button>
              </div>}
              {saveError && <div className="form-error" role="alert">{saveError}</div>}
              <div className="form-actions">
                <button className="primary-button" type="submit" disabled={saving}>
                  {saving ? 'Kaydediliyor…' : 'Taslağı kaydet'}
                </button>
              </div>
            </form>
          </section>
        )}

        {!showFrozenReport && !editable && (
          <section
            className="surface weekly-report-locked"
            aria-labelledby="weekly-report-title"
            data-job-detail-block="weekly-report-locked"
          >
            <h2 id="weekly-report-title">Haftalık rapor</h2>
            <p className="weekly-report-locked-notice">
              {lockedReportNotice(loadedJob.status, isOwner)}
            </p>
          </section>
        )}
      </div>

      {hasRail && (
        <aside className="job-detail-work-rail" data-job-detail-rail="true">
          {managementReview && (
            <div
              className="job-detail-management-review"
              data-job-detail-section="management-review"
            >
              <JobApprovalReviewPanel
                job={loadedJob}
                lifecycle={loadedJob.workflowContext.lifecycle}
                requirements={presentation.requirements}
              />
            </div>
          )}

          {hasWorkflowMain && (
            <div className="job-detail-workflow-layout" data-job-detail-section="actions">
              <div className="job-detail-workflow-main">
                <h2 className="job-detail-rail-heading">İşlemler</h2>
                {showRequirements && <RequirementsChecklist requirements={presentation.requirements} />}
                {submitBlockedReason && (
                  <p
                    className="form-help weekly-submit-notice"
                    role="status"
                    data-weekly-submit-notice="true"
                  >
                    {submitBlockedReason}
                  </p>
                )}
                {hasDecision && <JobDecisionPanel
                  primary={presentation.primaryTransition}
                  secondary={presentation.secondaryTransitions}
                  recordEditAction={null}
                  pending={pending}
                  startLocationCaptureEnabled={startLocationCaptureEnabled}
                  submitLocationCaptureEnabled={submitLocationCaptureEnabled}
                  disabledCommands={[...blockedCommands]}
                  onCommand={onCommand}
                />}
              </div>
            </div>
          )}
        </aside>
      )}
    </div>

    <div className="job-detail-timeline" data-job-detail-section="timeline">
      <section
        className="surface weekly-history"
        aria-labelledby="weekly-history-title"
        data-job-detail-block="weekly-history"
      >
        <h2 id="weekly-history-title">Gönderim geçmişi</h2>
        {history.length === 0
          ? <p className="weekly-history-empty">Henüz gönderim yok.</p>
          : <>
              <div className="weekly-history-controls">
                <div className="field-group">
                  <label htmlFor="weekly-history-select">Sürüm</label>
                  <select
                    id="weekly-history-select"
                    value={selectedSeq ?? history[history.length - 1]!.seqNo}
                    onChange={(event) => setSelectedSeq(Number(event.target.value))}
                  >
                    {history.map((entry) => (
                      <option key={entry.seqNo} value={entry.seqNo}>
                        #{entry.seqNo} · {formatInstant(entry.submittedAt)}
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={pdfPending || selected === null}
                  onClick={() => { if (selected) void downloadPdf(selected.seqNo); }}
                >
                  {pdfPending ? 'PDF hazırlanıyor…' : 'PDF indir'}
                </button>
              </div>
              {pdfError && <p className="form-error" role="alert">{pdfError}</p>}
              {selected && <RecordDescriptions
                ariaLabel="Seçilen gönderim ayrıntısı"
                items={historyFacts}
                maxColumns={2}
              />}
            </>}
      </section>
      {/*
        Slice 1 SUBMIT location evidence is exposed through the shared
        JobTimeline (SSOT formatter): approximate label, accuracy and capture
        time for captured snapshots, the localized reason when unavailable.
        No raw coordinates, no comparison, no badges.
      */}
      <JobTimeline jobId={jobCardId} refreshKey={timelineKey} />
    </div>

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
