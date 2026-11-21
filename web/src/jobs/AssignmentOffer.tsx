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

function isManagementUser(user: CurrentUser): boolean {
  return user.role === 'MANAGER' || user.role === 'ADMIN';
}

function formatInstant(value: string): string {
  return new Intl.DateTimeFormat('tr-TR', { dateStyle: 'medium', timeStyle: 'short' })
    .format(new Date(value));
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
      <legend>Neden</legend>
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
export function AssignmentOfferSection({ job, user, disabled = false, onChanged }: {
  job: JobCard;
  user: CurrentUser;
  disabled?: boolean;
  onChanged?: () => void;
}) {
  const offer = job.assignmentOffer ?? null;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [ackOpen, setAckOpen] = useState(false);
  const [ackPending, setAckPending] = useState(false);
  const reofferTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setError('');
    setDone(false);
    setAckOpen(false);
  }, [job.id, job.version, offer?.id]);

  if (offer === null) return null;
  const management = isManagementUser(user);
  if (!management && user.id !== job.assignedTo) return null;

  const urgentReasonLabel = assignmentOfferUrgentReasonLabel(offer.urgentReason);
  const canReoffer = management
    && job.status === 'NEW'
    && REOFFERABLE_OFFER_STATES.includes(offer.state);

  async function sendReoffer(acknowledgement?: PastStartAcknowledgement): Promise<boolean> {
    setPending(true);
    setError('');
    try {
      await reofferAssignment(job.id, {
        clientActionId: crypto.randomUUID(),
        expectedVersion: job.version,
        ...pastStartAcknowledgementPayload(acknowledgement),
      });
      setDone(true);
      setAckOpen(false);
      onChanged?.();
      return true;
    } catch (caught) {
      if (acknowledgement === undefined && isPastStartAcknowledgementRequired(caught)) {
        setAckOpen(true);
        return false;
      }
      setError(assignmentWindowErrorMessage(caught, 'Yeniden atama teklifi açılamadı.'));
      return false;
    } finally {
      setPending(false);
    }
  }

  async function confirmAck(acknowledgement: PastStartAcknowledgement) {
    setAckPending(true);
    try {
      if (!(await sendReoffer(acknowledgement))) {
        // Nothing was opened: the section shows the authoritative reason, so the
        // drawer closes instead of repeating it behind the overlay.
        setAckOpen(false);
      }
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
      {canReoffer && (
        <div className="review-buttons">
          <button
            ref={reofferTriggerRef}
            className="secondary-button compact-button"
            type="button"
            disabled={disabled || pending || done}
            aria-expanded={ackOpen}
            data-assignment-offer-action="reoffer"
            onClick={() => { setError(''); void sendReoffer(); }}
          >
            {pending && !ackOpen ? 'Kaydediliyor…' : 'Yeniden teklif et'}
          </button>
        </div>
      )}
      <PastStartAcknowledgementDrawer
        open={ackOpen}
        description="Planlanan başlangıç saati geçti. Yeni teklifi açmadan önce müşterinin güncel durumunu onaylayın."
        pending={ackPending}
        returnFocusRef={reofferTriggerRef}
        onDismiss={() => { if (!ackPending) setAckOpen(false); }}
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
