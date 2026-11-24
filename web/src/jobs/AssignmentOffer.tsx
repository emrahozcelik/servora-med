import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { Link } from 'react-router-dom';

import { useRealtimeInvalidation } from '../realtime/RealtimeProvider';
import type { CurrentUser } from '../services/api';
import { OperationalCard } from '../ui/antd/OperationalCard';
import { ResultState } from '../ui/antd/ResultState';
import { ServoraListPagination } from '../ui/antd/ServoraPagination';
import { DEFAULT_LIST_PAGE_SIZE, lastListPageOffset } from '../ui/pagination';
import { assignmentWindowErrorMessage } from './assignment-window-errors';
import { PastStartAcknowledgementDrawer, isPastStartAcknowledgementRequired } from './PastStartAcknowledgementDrawer';
import {
  assignmentOfferCloseReasonLabel,
  assignmentOfferStateLabel,
  assignmentOfferUrgentReasonLabel,
  assignmentReasonLabels,
} from './job-labels';
import {
  ASSIGNMENT_REASON_CODES,
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
function focusScheduleEditor(): void {
  const target = document.getElementById('job-scheduled-at');
  if (target === null) return;
  target.scrollIntoView({ block: 'center' });
  target.focus({ preventScroll: true });
}

/** JOB-010 release 2b decline/release draft; validated in JobDetail. */
export type AssignmentReasonDraft = {
  code: AssignmentReasonCode | '';
};

export const EMPTY_ASSIGNMENT_REASON: AssignmentReasonDraft = { code: '' };

export function AssignmentReasonSection({
  draft,
  inlineError,
  onChange,
  initialFocusRef,
}: {
  draft: AssignmentReasonDraft;
  inlineError: string | null;
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
      {inlineError && <p id="assignment-reason-error" className="field-error" role="alert">{inlineError}</p>}
    </fieldset>
  );
}

/**
 * JOB-010 release 2b assignment offer on the job detail: the server deadline,
 * the urgency badge and the management re-offer path. The offer itself, its
 * deadline and its urgency are server facts; this section never derives them
 * from the browser clock.
 */
export function AssignmentOfferSection({ job, user, disabled = false, onChanged, onReassign }: {
  job: JobCard;
  user: CurrentUser;
  disabled?: boolean;
  onChanged?: () => void;
  /**
   * Opens the existing record-edit reassignment form. Purpose-bound so this
   * guidance never grows a second assignee form of its own.
   */
  onReassign?: (trigger: HTMLButtonElement) => void;
}) {
  const offer = job.assignmentOffer ?? null;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [ackOpen, setAckOpen] = useState(false);
  const [ackPending, setAckPending] = useState(false);
  const [ackError, setAckError] = useState('');
  const reofferTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setError('');
    setDone(false);
    setAckOpen(false);
    setAckError('');
  }, [job.id, job.version, offer?.id]);

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
  const newTimeAction: RecoveryAction = {
    key: 'new-time',
    label: 'Yeni zaman belirle',
    run: () => { focusScheduleEditor(); },
  };
  const reassignAction: RecoveryAction | null = onReassign === undefined
    ? null
    : { key: 'reassign', label: 'Sorumlu personeli değiştir', run: onReassign };
  const recoveryActions = (newTimeFirst
    ? [newTimeAction, reassignAction]
    : [reassignAction, newTimeAction]).filter((action): action is RecoveryAction => action !== null);
  const reofferButton = canReoffer ? (
    <button
      ref={reofferTriggerRef}
      className="secondary-button compact-button"
      type="button"
      disabled={disabled || pending || done}
      aria-expanded={ackOpen}
      data-assignment-offer-action="reoffer"
      onClick={() => { setError(''); setAckError(''); void sendReoffer(); }}
    >
      {pending && !ackOpen ? 'Kaydediliyor…' : 'Aynı zamanla yeniden teklif et'}
    </button>
  ) : null;

  async function sendReoffer(acknowledgement?: PastStartAcknowledgement): Promise<boolean> {
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
      onChanged?.();
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
            {offer.closedAt !== null && (
              <div>
                <dt>Karar zamanı</dt>
                <dd><time dateTime={offer.closedAt}>{formatInstant(offer.closedAt)}</time></dd>
              </div>
            )}
          </dl>
          <p className="assignment-offer-recovery-actions-label"><strong>Ne yapabilirsiniz</strong></p>
          <div className="review-buttons">
            {recoveryActions.map((action, index) => (
              <button
                key={action.key}
                className={index === 0 ? 'primary-button compact-button' : 'secondary-button compact-button'}
                type="button"
                disabled={disabled || pending}
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
          <p className="form-help" data-assignment-offer-schedule-hint="true">
            Planlanan zamanı kaydettiğinizde {offer.assignee.name} kişisine yeni atama teklifi gider.
          </p>
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
      {done && (
        <p role="status" data-assignment-offer-reoffered="true">
          Yeni atama teklifi açıldı; personelin yanıtı bekleniyor.
        </p>
      )}
      {error && <p className="field-error" role="alert">{error}</p>}
      {canReoffer && !recovery && (
        <div className="review-buttons">{reofferButton}</div>
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
