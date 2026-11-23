import { ApiError } from '../services/api';
import {
  ACTIVE_JOB_CARD_STATUSES,
  JOB_CARD_STATUSES,
  LIFECYCLE_COMMANDS,
  type JobCard,
  type JobCardStatus,
  type LifecycleCommand,
  type SubmissionReadiness,
  type SubmissionRequirement,
} from './jobs-api';
import type { SaleDetails } from './sale-api';

/**
 * SALE-002 S2 web presentation of the visit+sale pair.
 *
 * The server owns pair discovery, coordination and every redirect
 * (`sale-002-contract.md` §4.1/§4.2/§4.5). This module only mirrors what the
 * accepted contract requires the UI to *show*: which linked sale travels with a
 * visit command, the `expectedSaleVersion` that must accompany a coordinated
 * command, and the exact next action for a redirected single-card command.
 * Nothing here authorizes a state transition.
 */

/**
 * §4.1: a linked sale still belongs to a live pair while it is in the canonical
 * active status set (the same set the server's partial unique index protects).
 */
export function isActiveSaleStatus(status: JobCardStatus): boolean {
  return (ACTIVE_JOB_CARD_STATUSES as readonly JobCardStatus[]).includes(status);
}

/**
 * §4.2: the source-visit status in which each command coordinates the pair.
 * `CANCEL` / `INVALIDATE` and the assignment commands never coordinate.
 */
const COORDINATING_VISIT_STATUS: Partial<Record<LifecycleCommand, JobCardStatus>> = {
  SUBMIT_FOR_APPROVAL: 'IN_PROGRESS',
  APPROVE: 'WAITING_APPROVAL',
  REQUEST_REVISION: 'WAITING_APPROVAL',
  WITHDRAW_FROM_APPROVAL: 'WAITING_APPROVAL',
  RESUME: 'REVISION_REQUESTED',
};

/** Visit statuses that can still carry a live linked sale (§4.4). */
export const COORDINATING_VISIT_STATUSES: readonly JobCardStatus[] = [
  'IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED',
];

export type PairSaleFacts = {
  id: string;
  title: string;
  status: JobCardStatus;
  version: number;
  assignedTo: string;
  /** Server-computed sale submission readiness (`workflowContext`). */
  readiness: SubmissionReadiness | null;
};

/** One visit-linked sale, discovered from the existing read endpoints. */
export type VisitPairSale = PairSaleFacts & { items: SaleDetails['items'] };

/**
 * §4.2/§4.5: the sale version a visit command must send as
 * `expectedSaleVersion`. `null` means "no coordinated pair for this command",
 * so the field must be omitted — the server answers a supplied field without a
 * coordinated pair with `409 SALE_PAIR_STATE_CONFLICT`.
 */
export function coordinatedSaleVersion(input: {
  command: LifecycleCommand;
  visitStatus: JobCardStatus;
  visitAssignedTo: string;
  sale: PairSaleFacts | null | undefined;
}): number | null {
  const { command, visitStatus, visitAssignedTo, sale } = input;
  if (!sale || !isActiveSaleStatus(sale.status)) return null;
  // R17: a divergent-assignee pair is decoupled and never coordinates.
  if (sale.assignedTo !== visitAssignedTo) return null;
  if (COORDINATING_VISIT_STATUS[command] !== visitStatus) return null;
  return sale.version;
}

/** §4.2: every redirect a single-card sale command can receive. */
export const SALE_PAIR_REDIRECT_CODES = [
  'SALE_SUBMIT_VIA_VISIT_REQUIRED',
  'SALE_APPROVE_VIA_VISIT_REQUIRED',
  'SALE_REVISION_VIA_VISIT_REQUIRED',
  'SALE_WITHDRAW_VIA_VISIT_REQUIRED',
  'SALE_RESUME_VIA_VISIT_REQUIRED',
] as const;

export type SalePairRedirectCode = (typeof SALE_PAIR_REDIRECT_CODES)[number];

export type SalePairRedirect = {
  code: SalePairRedirectCode;
  visitId: string | null;
  saleId: string | null;
  saleStatus: JobCardStatus | null;
  allowedSaleCommand: LifecycleCommand | null;
};

/**
 * §4.3/§4.5: a pair command refused because the sale is not in a coordinated
 * state. `allowedSaleCommand` is the exact next step the server names.
 */
export type SalePairStateConflict = {
  allowedSaleCommand: LifecycleCommand | null;
  reason: string | null;
  visitId: string | null;
  saleId: string | null;
};

function conflictDetails(error: unknown): Record<string, unknown> | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const details = error.details;
  return details && typeof details === 'object' && !Array.isArray(details) ? details : null;
}

function optionalId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function optionalCommand(value: unknown): LifecycleCommand | null {
  return typeof value === 'string' && (LIFECYCLE_COMMANDS as readonly string[]).includes(value)
    ? value as LifecycleCommand
    : null;
}

function optionalStatus(value: unknown): JobCardStatus | null {
  return typeof value === 'string' && (JOB_CARD_STATUSES as readonly string[]).includes(value)
    ? value as JobCardStatus
    : null;
}

/** Parses `409 SALE_*_VIA_VISIT_REQUIRED` and its pair payload (§4.2). */
export function salePairRedirectFrom(error: unknown): SalePairRedirect | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  if (!(SALE_PAIR_REDIRECT_CODES as readonly string[]).includes(error.code)) return null;
  const details = conflictDetails(error);
  return {
    code: error.code as SalePairRedirectCode,
    visitId: optionalId(details?.visitId),
    saleId: optionalId(details?.saleId),
    saleStatus: optionalStatus(details?.saleStatus),
    allowedSaleCommand: optionalCommand(details?.allowedSaleCommand),
  };
}

/** Parses `409 SALE_PAIR_STATE_CONFLICT` (NO_COORDINATED_PAIR or a state step). */
export function salePairStateConflictFrom(error: unknown): SalePairStateConflict | null {
  if (!(error instanceof ApiError) || error.code !== 'SALE_PAIR_STATE_CONFLICT') return null;
  const details = conflictDetails(error);
  return {
    allowedSaleCommand: optionalCommand(details?.allowedSaleCommand),
    reason: typeof details?.reason === 'string' ? details.reason : null,
    visitId: optionalId(details?.visitId),
    saleId: optionalId(details?.saleId),
  };
}

/** Turkish name of the sale command a pair conflict names as the next step. */
export const pairSaleCommandLabels: Record<LifecycleCommand, string> = {
  ACCEPT_ASSIGNMENT: 'Satış kaydını kabul et',
  DECLINE_ASSIGNMENT: 'Satış görevini reddet',
  RELEASE_ASSIGNMENT: 'Satış görevini geri bırak',
  START: 'Satış kaydını başlat',
  SUBMIT_FOR_APPROVAL: 'Satış kaydını kontrole gönder',
  APPROVE: 'Satış kaydını onayla',
  REQUEST_REVISION: 'Satış kaydını düzeltmeye gönder',
  WITHDRAW_FROM_APPROVAL: 'Satış kaydını kontrolden geri çek',
  RESUME: 'Satış kaydında düzeltmeye başla',
  CANCEL: 'Satış kaydını iptal et',
};

/**
 * §4.2: the command a `SALE` card would offer for its own status but the server
 * withholds because the live pair coordinates it through the visit.
 *
 * Derived from the server's own `allowedCommands`, never from a second policy
 * table: if the server still allows the command (terminal source, standalone
 * sale or a decoupled legacy pair) this returns `null` and the card behaves
 * exactly as before.
 */
const SELF_SERVICE_COMMAND: Partial<Record<JobCardStatus, LifecycleCommand>> = {
  ACCEPTED: 'SUBMIT_FOR_APPROVAL',
  IN_PROGRESS: 'SUBMIT_FOR_APPROVAL',
  WAITING_APPROVAL: 'APPROVE',
  REVISION_REQUESTED: 'RESUME',
};

export function pairManagedSaleCommand(input: {
  type: JobCard['type'];
  status: JobCardStatus;
  allowedCommands: readonly LifecycleCommand[];
  sourceVisitAccess: 'NONE' | 'RESTRICTED' | 'FULL';
}): LifecycleCommand | null {
  if (input.type !== 'SALE' || input.sourceVisitAccess !== 'FULL') return null;
  const selfService = SELF_SERVICE_COMMAND[input.status];
  if (!selfService || input.allowedCommands.includes(selfService)) return null;
  return selfService;
}

/** One unmet linked-sale requirement shown before a joint submission. */
export type VisitSubmitPairBlocker =
  | { kind: 'NOT_READY'; unmet: Array<SubmissionRequirement & { label: string }> }
  | { kind: 'ACCEPT_REQUIRED' }
  | { kind: 'RESUME_REQUIRED' };

/**
 * §4.3 step 2-3 / §4.8: what blocks the joint submission. Readiness comes from
 * the sale's own server response; the two state steps mirror the documented
 * conflict payloads (`ACCEPT_ASSIGNMENT`, `RESUME`).
 */
export function visitSubmitPairBlockers(
  sale: VisitPairSale,
  labels: Record<SubmissionRequirement['code'], string>,
): VisitSubmitPairBlocker[] {
  const blockers: VisitSubmitPairBlocker[] = [];
  const unmet = (sale.readiness?.items ?? [])
    .filter((item) => item.state !== 'met')
    .map((item) => ({ ...item, label: labels[item.code] }));
  if (unmet.length > 0) blockers.push({ kind: 'NOT_READY', unmet });
  if (sale.status === 'NEW') blockers.push({ kind: 'ACCEPT_REQUIRED' });
  if (sale.status === 'REVISION_REQUESTED') blockers.push({ kind: 'RESUME_REQUIRED' });
  return blockers;
}

/** §8.1: does this approval complete the linked sale as well? */
export function approvalCompletesSale(sale: VisitPairSale | null | undefined): boolean {
  return sale !== null && sale !== undefined && sale.status === 'WAITING_APPROVAL';
}

/** §8.1: does this revision/withdraw move the linked sale too? */
export function lifecycleMovesSale(
  sale: VisitPairSale | null | undefined,
  command: 'REQUEST_REVISION' | 'WITHDRAW_FROM_APPROVAL' | 'RESUME',
): boolean {
  if (!sale) return false;
  if (command === 'RESUME') return sale.status === 'REVISION_REQUESTED';
  return sale.status === 'WAITING_APPROVAL';
}

export type SalePairGuidance = {
  message: string;
  targetId: string | null;
  targetLabel: string | null;
};

const PAIR_REDIRECT_COPY: Record<SalePairRedirectCode, string> = {
  SALE_SUBMIT_VIA_VISIT_REQUIRED:
    'Bu satış kaydının gönderimi bağlı ziyaret kaydıyla birlikte yapılır.',
  SALE_APPROVE_VIA_VISIT_REQUIRED:
    'Bu satış kaydının onayı bağlı ziyaret kaydıyla birlikte verilir.',
  SALE_REVISION_VIA_VISIT_REQUIRED:
    'Düzeltme isteği bağlı ziyaret kaydıyla birlikte gönderilir.',
  SALE_WITHDRAW_VIA_VISIT_REQUIRED:
    'Kontrolden geri çekme bağlı ziyaret kaydıyla birlikte yapılır.',
  SALE_RESUME_VIA_VISIT_REQUIRED:
    'Düzeltmeye başlama bağlı ziyaret kaydıyla birlikte yapılır.',
};

/**
 * §4.2/§8.1: the exact next action for a redirected sale command. The visit is
 * the only valid surface, so the guidance never leaves the user on a dead end.
 */
export function pairRedirectGuidance(
  redirect: SalePairRedirect,
  fallbackVisitId: string | null,
): SalePairGuidance {
  const target = redirect.visitId ?? fallbackVisitId;
  return {
    message: `${PAIR_REDIRECT_COPY[redirect.code]} İşlemi ziyaret kartından yürütün.`,
    targetId: target,
    targetLabel: target ? 'Ziyaret kartını aç' : null,
  };
}

/**
 * §4.3/§4.5: a pair command refused because the sale is not in a coordinated
 * state. `allowedSaleCommand` names the sale-side step the user must finish
 * first, unless the pair itself stopped being coordinated.
 */
export function pairConflictGuidance(
  conflict: SalePairStateConflict,
  fallbackSaleId: string | null,
  currentCardId?: string,
): SalePairGuidance {
  if (conflict.reason === 'NO_COORDINATED_PAIR') {
    return {
      message: 'Bağlı satış çifti bu işlem için artık geçerli değil. '
        + 'Kayıt en güncel hâliyle gösteriliyor; işlemi yeniden başlatın.',
      targetId: null,
      targetLabel: null,
    };
  }
  const candidate = conflict.saleId ?? fallbackSaleId;
  // A conflict raised on the sale card itself must not link back to the same card.
  const target = candidate === currentCardId ? null : candidate;
  const label = conflict.allowedSaleCommand
    ? pairSaleCommandLabels[conflict.allowedSaleCommand]
    : null;
  return {
    message: label
      ? `Bağlı satış kaydı bu işlem için hazır değil. Önce “${label}” adımını tamamlayın.`
      : 'Bağlı satış kaydı bu işlem için hazır değil. Bağlı satış kaydını açıp durumunu kontrol edin.',
    targetId: target,
    targetLabel: target ? 'Satış kaydını aç' : null,
  };
}

/** Success suffix for a pair command that actually moved the sale (§4.7). */
export function pairSuccessSuffix(
  command: LifecycleCommand,
  linkedSaleJobCardId: string | null,
): string {
  if (linkedSaleJobCardId === null) return '';
  switch (command) {
    case 'SUBMIT_FOR_APPROVAL':
      return ' Bağlı satış kaydı da onaya gönderildi.';
    case 'APPROVE':
      return ' Bağlı satış kaydı da tamamlandı.';
    case 'REQUEST_REVISION':
      return ' Bağlı satış kaydı da düzeltme için geri gönderildi.';
    case 'WITHDRAW_FROM_APPROVAL':
    case 'RESUME':
      return ' Bağlı satış kaydı da yeniden düzenlemeye açıldı.';
    default:
      return '';
  }
}
