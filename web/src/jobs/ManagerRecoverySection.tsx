import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { CurrentUser } from '../services/api';
import type { listStaff } from '../services/people-api';
import {
  formatProposedInterval,
  formatRecoveryInstant,
  hasManagementRecoveryOffer,
  recoveryOfferHeadline,
} from './assignment-transfer-helpers';
import {
  assignmentOfferCloseReasonLabel,
  assignmentOfferUrgentReasonLabel,
  assignmentSuggestedSolutionLabel,
  changeRequestReasonLabel,
} from './job-labels';
import type { JobCard, MeetingDetails } from './jobs-api';
import { ManagerRecoveryDrawer } from './ManagerRecoveryDrawer';

function isManagementUser(user: CurrentUser): boolean {
  return user.role === 'MANAGER' || user.role === 'ADMIN';
}

export function ManagerRecoverySection({
  job,
  user,
  disabled = false,
  meetingDetails = null,
  onCommitted,
  onActionStart,
  onRefresh,
  onUnknownOutcome,
  onReassigned,
  onChanged,
  onBusyChange,
  loadStaffFn,
}: {
  job: JobCard;
  user: CurrentUser;
  disabled?: boolean;
  meetingDetails?: MeetingDetails | null;
  onCommitted: (receipt: string, tone?: 'confirmed' | 'info') => Promise<void>;
  onActionStart: () => void;
  onRefresh: () => Promise<boolean>;
  onUnknownOutcome: (message: string) => void;
  onReassigned: (previous: JobCard, patched: JobCard & { assignmentTransitionId: string | null }) => void;
  onChanged: () => void;
  onBusyChange?: (busy: boolean) => void;
  loadStaffFn?: typeof listStaff;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [overlayHost, setOverlayHost] = useState<Element | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const hasOffer = hasManagementRecoveryOffer(job);
  const hasChangeRequest =
    job.changeRequest != null
    && job.workflowContext.allowedActions.includes('RESOLVE_CHANGE_REQUEST');

  if (!isManagementUser(user) || (!hasOffer && !hasChangeRequest)) {
    return null;
  }

  const offer = hasOffer ? job.assignmentOffer! : null;
  const request = hasChangeRequest ? job.changeRequest! : null;
  const urgentLabel = assignmentOfferUrgentReasonLabel(offer?.urgentReason);
  const closeReasonLabel = assignmentOfferCloseReasonLabel(offer?.closeReason);
  const proposedAt = offer?.proposedScheduledAt ?? null;
  const pendingProposal = offer !== null && proposedAt !== null && offer.proposalAcceptedAt === null;
  const proposalExpired = pendingProposal && proposedAt !== null && Date.parse(proposedAt) <= Date.now();
  const proposalIntervalText =
    pendingProposal && proposedAt !== null
      ? formatProposedInterval(proposedAt, offer!.proposedScheduledEndsAt)
      : null;

  return (
    <section
      className="detail-summary surface-flat job-recovery"
      data-manager-recovery="true"
      aria-labelledby="job-recovery-title"
    >
      <div className="job-recovery-header">
        <h2 id="job-recovery-title" className="job-recovery-heading">
          Müdahale gereken durum
        </h2>
      </div>

      <div className="job-recovery-sources">
        {offer && (
          <div
            className="job-recovery-source"
            data-assignment-offer={offer.state}
            data-assignment-offer-recovery={offer.state}
          >
            <h3 className="job-recovery-source-headline">{recoveryOfferHeadline(offer)}</h3>
            {urgentLabel !== null && (
              <p className="assignment-offer-urgent" data-assignment-offer-urgent={offer.urgentReason}>
                <strong>{urgentLabel}</strong>
                {' '}— müşteri zamanı risk altında.
              </p>
            )}
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
              {offer.suggestedSolution != null && (
                <div>
                  <dt>Personelin önerisi</dt>
                  <dd data-assignment-offer-suggested-solution={offer.suggestedSolution}>
                    {assignmentSuggestedSolutionLabel(offer.suggestedSolution)}
                  </dd>
                </div>
              )}
              {pendingProposal && proposedAt !== null && proposalIntervalText !== null && (
                <div>
                  <dt>Personelin önerdiği zaman</dt>
                  <dd data-assignment-offer-proposal={proposalExpired ? 'EXPIRED' : 'PENDING'}>
                    <time dateTime={proposedAt}>{proposalIntervalText}</time>
                  </dd>
                </div>
              )}
              {offer.closedAt !== null && (
                <div>
                  <dt>Karar zamanı</dt>
                  <dd>
                    <time dateTime={offer.closedAt}>{formatRecoveryInstant(offer.closedAt)}</time>
                  </dd>
                </div>
              )}
            </dl>
            {proposalExpired && (
              <p className="form-help" data-assignment-offer-proposal-expired="true">
                <strong>Önerilen zaman geçti</strong> — doğrudan onaylanamıyor; farklı bir zaman belirleyebilirsiniz.
              </p>
            )}
          </div>
        )}

        {request && (
          <div className="job-recovery-source" data-change-request="management">
            <h3 className="job-recovery-source-headline">
              {request.requestedBy.name} bu iş için değişiklik istiyor
            </h3>
            <dl className="job-row-facts">
              <div>
                <dt>Neden</dt>
                <dd>{changeRequestReasonLabel(request.reasonCode)}</dd>
              </div>
              <div>
                <dt>Personelin açıklaması</dt>
                <dd data-change-request-reason-text="true">{request.reasonText}</dd>
              </div>
              <div>
                <dt>Gönderim</dt>
                <dd>
                  <time dateTime={request.requestedAt}>{formatRecoveryInstant(request.requestedAt)}</time>
                </dd>
              </div>
            </dl>
            {request.requestedBy.id !== job.assignedTo && (
              <p className="form-help" data-change-request-reassigned="true">
                Sorumlu personel değişti; öneriyi kapatmayı unutmayın.
              </p>
            )}
          </div>
        )}
      </div>

      <div className="review-buttons">
        <button
          ref={triggerRef}
          type="button"
          className="primary-button compact-button"
          data-manager-recovery-trigger="true"
          disabled={disabled}
          aria-expanded={drawerOpen}
          onClick={(event) => {
            setOverlayHost(
              event.currentTarget.closest('[data-job-detail="true"]')
                ?? event.currentTarget.closest('section')
                ?? document.body,
            );
            setDrawerOpen(true);
          }}
        >
          Görevi çözüme ulaştır
        </button>
      </div>

      {drawerOpen && overlayHost && createPortal(
        <ManagerRecoveryDrawer
          open={drawerOpen}
          job={job}
          user={user}
          meetingDetails={meetingDetails}
          disabled={disabled}
          triggerRef={triggerRef}
          onClose={() => setDrawerOpen(false)}
          onCommitted={onCommitted}
          onActionStart={onActionStart}
          onRefresh={onRefresh}
          onUnknownOutcome={onUnknownOutcome}
          onReassigned={onReassigned}
          onChanged={onChanged}
          onBusyChange={onBusyChange}
          loadStaffFn={loadStaffFn}
        />,
        overlayHost,
      )}
    </section>
  );
}
