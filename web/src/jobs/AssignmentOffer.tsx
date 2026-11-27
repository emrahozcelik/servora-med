import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { Link } from 'react-router-dom';

import { useRealtimeInvalidation } from '../realtime/RealtimeProvider';
import { ApiError, type CurrentUser } from '../services/api';
import { ConfirmationAction } from '../ui/antd/ConfirmationAction';
import { OperationalCard } from '../ui/antd/OperationalCard';
import { ResultState } from '../ui/antd/ResultState';
import { ServoraListPagination } from '../ui/antd/ServoraPagination';
import { WheelDateTimeField } from '../ui/WheelDateTimeField';
import { DEFAULT_LIST_PAGE_SIZE, lastListPageOffset } from '../ui/pagination';
import { assignmentWindowErrorMessage } from './assignment-window-errors';
import { PastStartAcknowledgementDrawer, isPastStartAcknowledgementRequired } from './PastStartAcknowledgementDrawer';
import { ScheduleQuickControls } from './ScheduleQuickControls';
import {
  assignmentOfferCloseReasonLabel,
  assignmentOfferStateLabel,
  assignmentOfferUrgentReasonLabel,
  assignmentReasonLabels,
} from './job-labels';
import {
  ASSIGNMENT_REASON_CODES,
  acceptAssignmentProposal,
  listAssignmentOffersNeedingAction,
  pastStartAcknowledgementPayload,
  reofferAssignment,
  type AssignmentOffer,
  type AssignmentOfferCloseReason,
  type AssignmentOfferState,
  type AssignmentOfferNeedingActionItem,
  type AssignmentReasonCode,
  type JobCard,
  type PastStartAcknowledgement,
} from './jobs-api';

/** Offer states where management recovery is expected to open a new offer. */
const REOFFERABLE_OFFER_STATES: readonly AssignmentOfferState[] = [
  'DECLINED', 'RELEASED', 'EXPIRED', 'WITHDRAWN',
];

/**
 * Closed offers that leave the next move with management. A planned window
 * that simply passed is the only WITHDRAWN shape the manager recovers from
 * here; every other withdrawal came from an action that already opened a
 * newer offer.
 */
const MANAGEMENT_RECOVERY_OFFER_STATES: readonly AssignmentOfferState[] = [
  'DECLINED', 'RELEASED', 'EXPIRED',
];

/** Reasons where the recovery starts with a new planned time. */
const NEW_TIME_FIRST_CLOSE_REASONS: readonly AssignmentOfferCloseReason[] = [
  'SCHEDULE_CONFLICT', 'PLANNED_WINDOW_PASSED',
];

/** One recovery control; the first rendered entry is the primary action. */
type RecoveryAction = {
  key: 'new-time' | 'reassign';
  label: string;
  run: (trigger: HTMLButtonElement) => void;
};

function isManagementUser(user: CurrentUser): boolean {
  return user.role === 'MANAGER' || user.role === 'ADMIN';
}

function formatInstant(value: string): string {
  return new Intl.DateTimeFormat('tr-TR', { dateStyle: 'medium', timeStyle: 'short' })
    .format(new Date(value));
}

const proposalDateFormatter = new Intl.DateTimeFormat('tr-TR', { dateStyle: 'medium' });
const proposalTimeFormatter = new Intl.DateTimeFormat('tr-TR', { timeStyle: 'short' });

/** JOB-012 proposal interval as `<date> <start>–<end>` (end is server-derived). */
function formatProposedInterval(start: string, end: string | null): string {
  const date = proposalDateFormatter.format(new Date(start));
  const from = proposalTimeFormatter.format(new Date(start));
  if (end === null) return `${date} ${from}`;
  return `${date} ${from}–${proposalTimeFormatter.format(new Date(end))}`;
}

/**
 * JOB-012: a rejected proposal confirmation means the offer, the schedule or
 * the Staff calendar moved on. The explanation is Turkish and the card is
 * refreshed by the caller; unknown codes keep the server text.
 */
function proposalAcceptErrorMessage(caught: unknown): string {
  if (caught instanceof ApiError) {
    switch (caught.code) {
      case 'ASSIGNMENT_PROPOSAL_NOT_AVAILABLE':
        return 'Personelin önerdiği zaman artık onaylanamıyor. İş güncellenmiş olabilir; en güncel durum gösteriliyor.';
      case 'ASSIGNMENT_PROPOSAL_EXPIRED':
        return 'Önerilen zaman geçti. Onaylanamıyor; personelden yeni bir zaman isteyin.';
      case 'VERSION_CONFLICT':
        return 'İş başka bir işlemle güncellendi. En güncel durum gösteriliyor.';
      case 'CALENDAR_CONFLICT':
        return caught.message || 'Önerilen zaman personelin takvimiyle çakışıyor.';
      default:
        return assignmentWindowErrorMessage(caught, 'Önerilen zaman onaylanamadı.');
    }
  }
  return caught instanceof Error ? caught.message : 'Önerilen zaman onaylanamadı.';
}

function isManagementRecoveryOffer(job: JobCard, offer: AssignmentOffer): boolean {
  if (job.status !== 'NEW') return false;
  if (MANAGEMENT_RECOVERY_OFFER_STATES.includes(offer.state)) return true;
  return offer.state === 'WITHDRAWN' && offer.closeReason === 'PLANNED_WINDOW_PASSED';
}

/** The state headline a management viewer reads first. */
function recoveryHeadline(offer: AssignmentOffer): string {
  switch (offer.state) {
    case 'DECLINED':
      return `${offer.assignee.name} görevi reddetti`;
    case 'RELEASED':
      return `${offer.assignee.name} görevi geri bıraktı`;
    case 'EXPIRED':
      return `${offer.assignee.name} teklifi süresinde yanıtlamadı`;
    case 'WITHDRAWN':
      return 'Planlanan zaman geçti';
    case 'OPEN':
    case 'ACCEPTED':
      return assignmentOfferStateLabel(offer.state);
  }
}

/** Moves the reader to the existing planned-time editor; no new route. */
export const SCHEDULE_EDITOR_OPEN_EVENT = 'servora:schedule-editor-open';

export function focusScheduleEditor(): void {
  const target = document.getElementById('job-scheduled-at');
  if (target !== null) {
    target.scrollIntoView({ block: 'center' });
    target.focus({ preventScroll: true });
    return;
  }
  // The schedule editor is collapsed by default; the page opens it and moves
  // focus once the field is rendered.
  document.dispatchEvent(new CustomEvent(SCHEDULE_EDITOR_OPEN_EVENT));
}

/** JOB-010 release 2b decline/release draft; validated in JobDetail. */
export type AssignmentReasonDraft = {
  code: AssignmentReasonCode | '';
  /**
   * JOB-012: device-local proposed time, required only for
   * `SCHEDULE_CONFLICT`. Converted with `localDateTimeToIso` on submit.
   */
  proposedScheduledLocal: string;
};

export const EMPTY_ASSIGNMENT_REASON: AssignmentReasonDraft = {
  code: '',
  proposedScheduledLocal: '',
};

export function AssignmentReasonSection({
  draft,
  inlineError,
  scheduleError,
  onChange,
  initialFocusRef,
}: {
  draft: AssignmentReasonDraft;
  inlineError: string | null;
  /** JOB-012: inline error of the proposed-time field, if any. */
  scheduleError: string | null;
  onChange: (patch: Partial<AssignmentReasonDraft>) => void;
  initialFocusRef?: RefObject<HTMLElement | null>;
}) {
  return (
    <fieldset className="assignment-reason-section" aria-describedby={inlineError ? 'assignment-reason-error' : undefined}>
      <legend className="sr-only">Atama yanıt nedeni</legend>
      <div className="field-group">
        <label htmlFor="assignment-reason-code">Neden</label>
        <select
          ref={initialFocusRef
            ? (node) => { initialFocusRef.current = node; }
            : undefined}
          id="assignment-reason-code"
          required
          value={draft.code}
          onChange={(event) => onChange({ code: event.target.value as AssignmentReasonCode | '' })}
        >
          <option value="">Neden seçin</option>
          {ASSIGNMENT_REASON_CODES.map((code) => (
            <option key={code} value={code}>{assignmentReasonLabels[code]}</option>
          ))}
        </select>
        <p className="form-help">
          Açıklamayı aşağıdaki alana yazın. Neden ve açıklama yöneticiye iletilir ve iş geçmişinde saklanır.
        </p>
      </div>
      {draft.code === 'SCHEDULE_CONFLICT' && (
        <div className="field-group" data-assignment-proposal-field="true">
          <WheelDateTimeField
            mode="datetime"
            id="assignment-proposed-at"
            name="proposedScheduledAt"
            value={draft.proposedScheduledLocal}
            onChange={(value) => onChange({ proposedScheduledLocal: value })}
            required
            invalid={Boolean(scheduleError)}
            aria-describedby={[
              'assignment-proposed-at-help',
              scheduleError ? 'assignment-proposed-at-error' : null,
            ].filter(Boolean).join(' ')}
            label="Önerdiğiniz zaman"
          />
          <p className="form-help" id="assignment-proposed-at-help">
            Yönetici onaylarsa iş bu zamana taşınır ve sizin için kabul edilmiş olur.
          </p>
          <ScheduleQuickControls
            value={draft.proposedScheduledLocal}
            onSelect={(next) => onChange({ proposedScheduledLocal: next })}
          />
          {scheduleError && (
            <p id="assignment-proposed-at-error" className="field-error" role="alert">{scheduleError}</p>
          )}
        </div>
      )}
      {inlineError && <p id="assignment-reason-error" className="field-error" role="alert">{inlineError}</p>}
    </fieldset>
  );
}

/**
 * JOB-010 release 2b assignment offer on the job detail: the server deadline,
 * the urgency badge and the management re-offer path. JOB-012 extends the
 * management guidance with the Staff member's time proposal and its
 * confirmation. The offer, its deadline, the proposal interval and its
 * urgency are server facts; this section never derives them from the browser
 * clock except to hide a confirm control for an already-passed proposal.
 */
export function AssignmentOfferSection({
  job, user, disabled = false, onChanged, onCommitted, onActionStart, onRefresh, onReassign, canSetNewTime = true,
}: {
  job: JobCard;
  user: CurrentUser;
  disabled?: boolean;
  onChanged?: () => void;
  /**
   * UI-FEEDBACK/B: the page owns the committed receipt so it survives this
   * section unmounting. When provided, this section never renders its own
   * success status line.
   */
  onCommitted?: (receipt: string) => Promise<void>;
  /** Clears the previous page receipt when a new decision starts. */
  onActionStart?: () => void;
  /** Serialized canonical reload after a failed or conflicting decision. */
  onRefresh?: () => Promise<void>;
  /**
   * Opens the existing record-edit reassignment form. Purpose-bound so this
   * guidance never grows a second assignee form of its own.
   */
  onReassign?: (trigger: HTMLButtonElement) => void;
  /** False when this viewer has no planned-time editor on the page. */
  canSetNewTime?: boolean;
}) {
  const offer = job.assignmentOffer ?? null;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [ackOpen, setAckOpen] = useState(false);
  const [ackPending, setAckPending] = useState(false);
  const [ackError, setAckError] = useState('');
  const [proposalConfirmOpen, setProposalConfirmOpen] = useState(false);
  const [proposalPending, setProposalPending] = useState(false);
  const [proposalError, setProposalError] = useState('');
  // JOB-012: the confirmed offer and the offer the confirmation opened. The
  // success note shows only while one of them is the latest offer: it survives
  // the refresh right after confirming and disappears on any later change.
  const [proposalDoneOfferIds, setProposalDoneOfferIds] = useState<readonly string[]>([]);
  const reofferTriggerRef = useRef<HTMLButtonElement>(null);
  const proposalTriggerRef = useRef<HTMLButtonElement>(null);
  // A conflict refresh replaces the job version; the rejection copy is still
  // the answer to the decision the manager just made, so it must survive it.
  const preserveErrorOnVersionChange = useRef(false);
  const lastJobId = useRef(job.id);

  useEffect(() => {
    const sameJob = lastJobId.current === job.id;
    lastJobId.current = job.id;
    if (!sameJob || !preserveErrorOnVersionChange.current) setError('');
    preserveErrorOnVersionChange.current = false;
    setDone(false);
    setAckOpen(false);
    setAckError('');
  }, [job.id, job.version, offer?.id]);

  // JOB-012: a different job clears the proposal outcome entirely.
  useEffect(() => {
    setProposalConfirmOpen(false);
    setProposalError('');
    setProposalDoneOfferIds([]);
  }, [job.id]);

  if (offer === null) return null;
  const management = isManagementUser(user);
  if (!management && user.id !== job.assignedTo) return null;

  const urgentReasonLabel = assignmentOfferUrgentReasonLabel(offer.urgentReason);
  const canReoffer = management
    && job.status === 'NEW'
    && REOFFERABLE_OFFER_STATES.includes(offer.state);
  // A declined/released/expired offer with a NEW job leaves recovery to
  // management: the bare state row alone never says what to do next.
  const recovery = management && isManagementRecoveryOffer(job, offer);
  const closeReasonLabel = assignmentOfferCloseReasonLabel(offer.closeReason);
  const newTimeFirst = offer.state === 'EXPIRED'
    || (offer.closeReason !== null && NEW_TIME_FIRST_CLOSE_REASONS.includes(offer.closeReason));
  const newTimeAction: RecoveryAction | null = canSetNewTime
    ? { key: 'new-time', label: 'Yeni zaman belirle', run: () => { focusScheduleEditor(); } }
    : null;
  const reassignAction: RecoveryAction | null = onReassign === undefined
    ? null
    : { key: 'reassign', label: 'Sorumlu personeli değiştir', run: onReassign };
  const recoveryActions = (newTimeFirst
    ? [newTimeAction, reassignAction]
    : [reassignAction, newTimeAction]).filter((action): action is RecoveryAction => action !== null);
  /**
   * JOB-012: the latest closed offer carries a Staff time proposal that
   * management has not answered yet. The browser clock only decides whether
   * the confirm control is still offered; the server re-checks the start.
   */
  const proposedAt = offer.proposedScheduledAt;
  const pendingProposal = recovery
    && proposedAt !== null
    && offer.proposalAcceptedAt === null;
  const proposalStartPassed = pendingProposal && proposedAt !== null
    && Date.parse(proposedAt) <= Date.now();
  const proposalIntervalText = pendingProposal && proposedAt !== null
    ? formatProposedInterval(proposedAt, offer.proposedScheduledEndsAt)
    : null;
  const proposalPrimary = proposalIntervalText !== null && !proposalStartPassed;
  const reofferButton = canReoffer ? (
    <button
      ref={reofferTriggerRef}
      className="secondary-button compact-button"
      type="button"
      disabled={disabled || pending || done || proposalPending}
      aria-expanded={ackOpen}
      data-assignment-offer-action="reoffer"
      onClick={() => { setError(''); setAckError(''); void sendReoffer(); }}
    >
      {pending && !ackOpen ? 'Kaydediliyor…' : 'Aynı zamanla yeniden teklif et'}
    </button>
  ) : null;

  async function refreshAfterFailure(allowChangedFallback = true) {
    if (onRefresh !== undefined) {
      preserveErrorOnVersionChange.current = true;
      await onRefresh();
      return;
    }
    // Legacy callers keep their pre-receipt behaviour: proposal rejection
    // refreshed through onChanged, a plain re-offer rejection only warned.
    if (allowChangedFallback) onChanged?.();
  }

  async function confirmProposal(target: AssignmentOffer) {
    if (target.proposedScheduledAt === null) return;
    onActionStart?.();
    setProposalPending(true);
    setProposalError('');
    try {
      const receipt = await acceptAssignmentProposal(job.id, {
        clientActionId: crypto.randomUUID(),
        expectedVersion: job.version,
        offerId: target.id,
      });
      setProposalDoneOfferIds([target.id, receipt.offerId]);
      setProposalConfirmOpen(false);
      if (onCommitted !== undefined) {
        await onCommitted(`Önerilen zaman onaylandı; iş ${target.assignee.name} için kabul edildi.`);
      } else {
        onChanged?.();
      }
    } catch (caught) {
      setProposalConfirmOpen(false);
      setProposalError(proposalAcceptErrorMessage(caught));
      // The rejected proposal means the offer or the calendar moved: refresh.
      await refreshAfterFailure();
    } finally {
      setProposalPending(false);
    }
  }

  async function sendReoffer(acknowledgement?: PastStartAcknowledgement): Promise<boolean> {
    onActionStart?.();
    setPending(true);
    setError('');
    if (acknowledgement !== undefined) setAckError('');
    try {
      await reofferAssignment(job.id, {
        clientActionId: crypto.randomUUID(),
        expectedVersion: job.version,
        ...pastStartAcknowledgementPayload(acknowledgement),
      });
      setDone(true);
      setAckOpen(false);
      setAckError('');
      if (onCommitted !== undefined) {
        await onCommitted('Yeni atama teklifi açıldı; personelin yanıtı bekleniyor.');
      } else {
        onChanged?.();
      }
      return true;
    } catch (caught) {
      if (acknowledgement === undefined && isPastStartAcknowledgementRequired(caught)) {
        setAckError('');
        setAckOpen(true);
        return false;
      }
      const message = assignmentWindowErrorMessage(caught, 'Yeniden atama teklifi açılamadı.');
      if (acknowledgement !== undefined) {
        setAckError(message);
      } else {
        setError(message);
        // A plain re-offer rejection means the offer/job moved on; reconcile
        // without claiming a success receipt. Only a page-owned refresh is
        // used: legacy `onChanged` callers keep their local-warning behaviour.
        // The acknowledgement retry keeps its drawer and inline error so the
        // manager can correct the input.
        await refreshAfterFailure(false);
      }
      return false;
    } finally {
      setPending(false);
    }
  }

  async function confirmAck(acknowledgement: PastStartAcknowledgement) {
    setAckPending(true);
    setAckError('');
    try {
      await sendReoffer(acknowledgement);
    } finally {
      setAckPending(false);
    }
  }

  return (
    <section
      className="detail-summary surface-flat assignment-offer"
      aria-labelledby="assignment-offer-title"
      data-assignment-offer={offer.state}
    >
      <h2 id="assignment-offer-title">Görev kabul durumu</h2>
      {recovery ? (
        <div className="assignment-offer-recovery" data-assignment-offer-recovery={offer.state}>
          <h3 className="assignment-offer-recovery-headline">{recoveryHeadline(offer)}</h3>
          <dl className="job-row-facts">
            {closeReasonLabel !== null && (
              <div>
                <dt>Neden</dt>
                <dd data-assignment-offer-close-reason={offer.closeReason}>{closeReasonLabel}</dd>
              </div>
            )}
            {offer.closeText !== null && offer.closeText.trim().length > 0 && (
              <div>
                <dt>Personelin açıklaması</dt>
                <dd>“{offer.closeText.trim()}”</dd>
              </div>
            )}
            {pendingProposal && proposedAt !== null && proposalIntervalText !== null && (
              <div>
                <dt>Personelin önerdiği zaman</dt>
                <dd data-assignment-offer-proposal={proposalStartPassed ? 'EXPIRED' : 'PENDING'}>
                  <time dateTime={proposedAt}>{proposalIntervalText}</time>
                </dd>
              </div>
            )}
            {offer.closedAt !== null && (
              <div>
                <dt>Karar zamanı</dt>
                <dd><time dateTime={offer.closedAt}>{formatInstant(offer.closedAt)}</time></dd>
              </div>
            )}
          </dl>
          <p className="assignment-offer-recovery-actions-label"><strong>Ne yapabilirsiniz</strong></p>
          <div className="review-buttons">
            {proposalPrimary && (
              <button
                ref={proposalTriggerRef}
                className="primary-button compact-button"
                type="button"
                disabled={disabled || pending || proposalPending || done
                  || proposalDoneOfferIds.includes(offer.id)}
                data-assignment-offer-action="accept-proposal"
                onClick={() => {
                  setProposalError('');
                  setProposalDoneOfferIds([]);
                  setProposalConfirmOpen(true);
                }}
              >
                Önerilen zamanı onayla
              </button>
            )}
            {recoveryActions.map((action, index) => (
              <button
                key={action.key}
                className={index === 0 && !proposalPrimary
                  ? 'primary-button compact-button'
                  : 'secondary-button compact-button'}
                type="button"
                disabled={disabled || pending || proposalPending}
                data-assignment-offer-action={action.key}
                onClick={(event) => { action.run(event.currentTarget); }}
              >
                {action.label}
              </button>
            ))}
            {reofferButton}
          </div>
          {canReoffer && (
            <p className="form-help">Zamanı değiştirmeden aynı personele yeniden sorar.</p>
          )}
          {canSetNewTime && (
            <p className="form-help" data-assignment-offer-schedule-hint="true">
              Planlanan zamanı kaydettiğinizde {offer.assignee.name} kişisine yeni atama teklifi gider.
            </p>
          )}
        </div>
      ) : (
        <dl className="job-row-facts">
          <div>
            <dt>Durum</dt>
            <dd data-assignment-offer-state={offer.state}>{assignmentOfferStateLabel(offer.state)}</dd>
          </div>
          <div>
            <dt>Kabul için son</dt>
            <dd>
              <time dateTime={offer.acceptanceDueAt}>{formatInstant(offer.acceptanceDueAt)}</time>
            </dd>
          </div>
          <div>
            <dt>Personel</dt>
            <dd>{offer.assignee.name}</dd>
          </div>
        </dl>
      )}
      {urgentReasonLabel !== null && (
        <p className="assignment-offer-urgent" data-assignment-offer-urgent={offer.urgentReason}>
          <strong>{urgentReasonLabel}</strong>
          {' '}— müşteri zamanı risk altında.
        </p>
      )}
      {done && onCommitted === undefined && (
        <p role="status" data-assignment-offer-reoffered="true">
          Yeni atama teklifi açıldı; personelin yanıtı bekleniyor.
        </p>
      )}
      {error && <p className="field-error" role="alert">{error}</p>}
      {proposalStartPassed && (
        <p data-assignment-offer-proposal-expired="true">
          <strong>Önerilen zaman geçti</strong> — personelden yeni bir zaman isteyin.
        </p>
      )}
      {proposalDoneOfferIds.includes(offer.id) && onCommitted === undefined && (
        <p role="status" data-assignment-offer-proposal-accepted="true">
          Önerilen zaman onaylandı; iş {offer.assignee.name} için kabul edildi.
        </p>
      )}
      {proposalError && (
        <p className="field-error" role="alert" data-assignment-offer-proposal-error="true">
          {proposalError}
        </p>
      )}
      {canReoffer && !recovery && (
        <div className="review-buttons">{reofferButton}</div>
      )}
      {proposalPrimary && proposalIntervalText !== null && (
        <ConfirmationAction
          open={proposalConfirmOpen}
          title="Önerilen zamanı onayla"
          description={`İş ${proposalIntervalText} zamanına taşınır ve ${offer.assignee.name} için kabul edilmiş olur.`}
          details={[
            `Personel: ${offer.assignee.name}`,
            `Önerilen zaman: ${proposalIntervalText}`,
            'İş, öneri sahibi personel için kabul edilmiş olarak başlar; ayrıca kabul beklenmez.',
          ]}
          confirmLabel="Önerilen zamanı onayla"
          pending={proposalPending}
          pendingLabel="Onaylanıyor…"
          returnFocusRef={proposalTriggerRef}
          onCancel={() => {
            if (!proposalPending) setProposalConfirmOpen(false);
          }}
          onConfirm={() => { void confirmProposal(offer); }}
        />
      )}
      <PastStartAcknowledgementDrawer
        open={ackOpen}
        description="Planlanan başlangıç saati geçti. Yeni teklifi açmadan önce müşterinin güncel durumunu onaylayın."
        pending={ackPending}
        error={ackError}
        returnFocusRef={reofferTriggerRef}
        onDismiss={() => {
          if (!ackPending) {
            setAckOpen(false);
            setAckError('');
          }
        }}
        onConfirm={(acknowledgement) => { void confirmAck(acknowledgement); }}
      />
    </section>
  );
}

type AssignmentOfferListState =
  | { kind: 'loading' }
  | { kind: 'ready'; items: AssignmentOfferNeedingActionItem[]; total: number }
  | { kind: 'error'; message: string };

/**
 * JOB-010 release 2b management overview section: jobs whose latest assignment
 * offer needs a management answer, oldest deadline first. Placement and state
 * handling mirror the open Staff request section next to it.
 */
export function OpenAssignmentOffersSection({ load = listAssignmentOffersNeedingAction }: {
  load?: typeof listAssignmentOffersNeedingAction;
}) {
  const [state, setState] = useState<AssignmentOfferListState>({ kind: 'loading' });
  const [offset, setOffset] = useState(0);
  const requestId = useRef(0);

  const refresh = useCallback(async () => {
    const id = ++requestId.current;
    setState((current) => current.kind === 'ready' ? current : { kind: 'loading' });
    try {
      const page = await load({ limit: DEFAULT_LIST_PAGE_SIZE, offset });
      if (id !== requestId.current) return;
      const lastOffset = lastListPageOffset(page.total);
      if (offset > lastOffset) {
        setOffset(lastOffset);
        return;
      }
      setState({ kind: 'ready', items: [...page.items], total: page.total });
    } catch (caught) {
      if (id !== requestId.current) return;
      setState({
        kind: 'error',
        message: caught instanceof Error ? caught.message : 'Atama teklifleri yüklenemedi.',
      });
    }
  }, [load, offset]);

  useEffect(() => {
    void refresh();
    return () => { requestId.current += 1; };
  }, [refresh]);
  useRealtimeInvalidation(['overview', 'job-list'], () => { void refresh(); });

  if (state.kind === 'loading') return null;
  // A failed load must never look like "nothing needs action".
  if (state.kind === 'error') {
    return (
      <section
        className="overview-section"
        aria-label="Müdahale gereken atamalar"
        data-assignment-offers="error"
      >
        <ResultState
          status="error"
          title="Müdahale gereken atamalar yüklenemedi"
          description={state.message}
          headingLevel={2}
          action={(
            <button className="secondary-button" type="button" onClick={() => void refresh()}>
              Tekrar dene
            </button>
          )}
        />
      </section>
    );
  }
  if (state.items.length === 0) return null;

  return (
    <section
      className="overview-section"
      aria-labelledby="assignment-offers-title"
      data-assignment-offers="true"
    >
      <h2 id="assignment-offers-title">Müdahale gereken atamalar</h2>
      <ul className="overview-card-stack">
        {state.items.map((item) => {
          const urgentLabel = assignmentOfferUrgentReasonLabel(item.urgentReason);
          const closeReasonLabel = assignmentOfferCloseReasonLabel(item.closeReason);
          return (
            <li key={item.offerId}>
              <OperationalCard
                title={<Link to={item.jobPath}>{item.jobTitle}</Link>}
                tone="attention"
                statusLabel={assignmentOfferStateLabel(item.state)}
                className="assignment-offer-card"
              >
                <span>
                  {item.assignee.name} · {item.customer?.name ?? 'Müşteri belirtilmedi'} · Kabul için son:{' '}
                  <time dateTime={item.acceptanceDueAt}>{formatInstant(item.acceptanceDueAt)}</time>
                </span>
                {item.scheduledAt !== null && (
                  <p>
                    Planlanan zaman:{' '}
                    <time dateTime={item.scheduledAt}>{formatInstant(item.scheduledAt)}</time>
                  </p>
                )}
                {item.proposedScheduledAt !== null && (
                  <p data-assignment-offer-proposal="PENDING">
                    Personelin önerdiği zaman:{' '}
                    <time dateTime={item.proposedScheduledAt}>{formatInstant(item.proposedScheduledAt)}</time>
                  </p>
                )}
                {urgentLabel !== null && (
                  <p data-assignment-offer-urgent={item.urgentReason}>
                    <strong>{urgentLabel}</strong> — müşteri zamanı risk altında.
                  </p>
                )}
                {closeReasonLabel !== null && <p>{closeReasonLabel}</p>}
                {item.closeText && <p>{item.closeText}</p>}
              </OperationalCard>
            </li>
          );
        })}
      </ul>
      <ServoraListPagination
        total={state.total}
        offset={offset}
        label="Müdahale gereken atamalar sayfaları"
        itemName="atama"
        onOffsetChange={(nextOffset) => {
          // Hide the focused pager in the same event as the offset change so an
          // intermediate render cannot consume its keyboard-focus ticket.
          setState({ kind: 'loading' });
          setOffset(nextOffset);
        }}
      />
    </section>
  );
}
