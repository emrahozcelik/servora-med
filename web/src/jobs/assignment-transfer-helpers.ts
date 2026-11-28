import { ApiError } from '../services/api';
import type { StaffProfile } from '../services/people-api';
import { assignmentWindowErrorMessage } from './assignment-window-errors';
import type {
  AssignmentOffer,
  AssignmentOfferState,
  JobCard,
} from './jobs-api';
import { CANONICAL_DURATION_MINUTES } from './scheduling';

/**
 * Closed offers that leave the next move with management. A planned window
 * that simply passed is the only WITHDRAWN shape the manager recovers from
 * here; every other withdrawal came from an action that already opened a
 * newer offer.
 */
const MANAGEMENT_RECOVERY_OFFER_STATES: readonly AssignmentOfferState[] = [
  'DECLINED',
  'RELEASED',
  'EXPIRED',
];

export function hasManagementRecoveryOffer(job: JobCard): boolean {
  const offer = job.assignmentOffer;
  if (job.status !== 'NEW' || !offer) return false;
  if (MANAGEMENT_RECOVERY_OFFER_STATES.includes(offer.state)) return true;
  return offer.state === 'WITHDRAWN' && offer.closeReason === 'PLANNED_WINDOW_PASSED';
}

export function recoveryOfferHeadline(offer: AssignmentOffer): string {
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
      return offer.assignee.name;
  }
}

const proposalDateFormatter = new Intl.DateTimeFormat('tr-TR', { dateStyle: 'medium' });
const proposalTimeFormatter = new Intl.DateTimeFormat('tr-TR', { timeStyle: 'short' });

/** JOB-012 proposal interval as `<date> <start>–<end>` (end is server-derived). */
export function formatProposedInterval(start: string, end: string | null): string {
  const date = proposalDateFormatter.format(new Date(start));
  const from = proposalTimeFormatter.format(new Date(start));
  if (end === null) return `${date} ${from}`;
  return `${date} ${from}–${proposalTimeFormatter.format(new Date(end))}`;
}

export function formatRecoveryInstant(value: string): string {
  return new Intl.DateTimeFormat('tr-TR', { dateStyle: 'medium', timeStyle: 'short' })
    .format(new Date(value));
}

export function proposalAcceptErrorMessage(caught: unknown): string {
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

export function filterEligibleTransferStaff(
  profiles: readonly StaffProfile[],
  excludeUserId: string,
): StaffProfile[] {
  return profiles.filter((profile) => profile.user.isActive && profile.user.id !== excludeUserId);
}

export function plannedIntervalDurationMinutes(job: Pick<JobCard, 'type' | 'scheduledAt' | 'scheduledEndsAt'>): number | null {
  if (job.scheduledAt && job.scheduledEndsAt) {
    const startMs = Date.parse(job.scheduledAt);
    const endMs = Date.parse(job.scheduledEndsAt);
    if (!Number.isNaN(startMs) && !Number.isNaN(endMs) && endMs > startMs) {
      return Math.round((endMs - startMs) / 60_000);
    }
  }
  return CANONICAL_DURATION_MINUTES[job.type] ?? null;
}

export function buildPatchCommitReceipt(
  patched: JobCard,
  options: {
    kind: 'RESCHEDULE' | 'REASSIGN_KEEP_TIME' | 'REASSIGN_AND_RESCHEDULE' | 'CORRECT';
    resolvedChangeRequest?: 'RESCHEDULED' | 'CORRECTED' | null;
  },
): string {
  let base: string;
  switch (options.kind) {
    case 'REASSIGN_AND_RESCHEDULE':
      base = 'Personel ve plan güncellendi.';
      break;
    case 'REASSIGN_KEEP_TIME':
      base = 'Sorumlu personel güncellendi.';
      break;
    case 'RESCHEDULE':
      base = 'Planlanan zaman güncellendi.';
      break;
    case 'CORRECT':
      base = patched.type === 'SALES_MEETING'
        ? 'Görüşme bilgileri güncellendi.'
        : 'Görev bilgileri güncellendi.';
      break;
  }
  if (options.kind !== 'CORRECT' && patched.assignmentOffer?.state === 'OPEN') {
    base += ` ${patched.assignee.name} için yeni atama teklifi açıldı. Personelin yanıtı bekleniyor.`;
  }
  if (options.resolvedChangeRequest && patched.changeRequest == null) {
    base += options.resolvedChangeRequest === 'CORRECTED'
      ? ' Personel önerisi “Düzeltildi” olarak kapatıldı.'
      : ' Personel önerisi “Yeniden planlandı” olarak kapatıldı.';
  }
  return base;
}
