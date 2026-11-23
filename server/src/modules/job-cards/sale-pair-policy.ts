import { AppError } from '../../errors/index.js';
import type { JobCardStatus, LifecycleCommand } from './types.js';

/**
 * SALE-002 §4 — the coordinated visit + sale ("pair") state machine, in one
 * place so the redirect guards, the pair commands and their unit tests share a
 * single truth. Nothing here reads the database; the service passes locked (or
 * planning) rows in.
 */

/**
 * §1.2: a source visit is *live* while it is in one of these statuses. A
 * terminal source (COMPLETED, CANCELLED, INVALIDATED) releases the sale to its
 * independent lifecycle.
 */
export const LIVE_PAIR_SOURCE_STATUSES: readonly JobCardStatus[] = [
  'IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED',
];

/** §4.2: the sale commands a live source visit redirects to the pair surface. */
export type SalePairCommand = Extract<
  LifecycleCommand,
  | 'SUBMIT_FOR_APPROVAL'
  | 'APPROVE'
  | 'REQUEST_REVISION'
  | 'WITHDRAW_FROM_APPROVAL'
  | 'RESUME'
>;

const PAIR_COMMANDS: readonly LifecycleCommand[] = [
  'SUBMIT_FOR_APPROVAL', 'APPROVE', 'REQUEST_REVISION', 'WITHDRAW_FROM_APPROVAL', 'RESUME',
];

export function isSalePairCommand(command: LifecycleCommand): command is SalePairCommand {
  return PAIR_COMMANDS.includes(command);
}

/**
 * §4.2 table: the source status that makes a single-card sale command a
 * redirect. Every other source status (COMPLETED/CANCELLED/INVALIDATED, or a
 * status the command does not coordinate from) keeps the independent
 * behaviour.
 */
const REDIRECT_SOURCE_STATUSES: Readonly<Record<SalePairCommand, readonly JobCardStatus[]>> = {
  SUBMIT_FOR_APPROVAL: ['IN_PROGRESS', 'REVISION_REQUESTED'],
  APPROVE: ['WAITING_APPROVAL'],
  REQUEST_REVISION: ['WAITING_APPROVAL'],
  WITHDRAW_FROM_APPROVAL: ['WAITING_APPROVAL'],
  RESUME: ['REVISION_REQUESTED'],
};

const REDIRECT_ERROR_CODES: Readonly<Record<SalePairCommand, string>> = {
  SUBMIT_FOR_APPROVAL: 'SALE_SUBMIT_VIA_VISIT_REQUIRED',
  APPROVE: 'SALE_APPROVE_VIA_VISIT_REQUIRED',
  REQUEST_REVISION: 'SALE_REVISION_VIA_VISIT_REQUIRED',
  WITHDRAW_FROM_APPROVAL: 'SALE_WITHDRAW_VIA_VISIT_REQUIRED',
  RESUME: 'SALE_RESUME_VIA_VISIT_REQUIRED',
};

/** §4.5: the anchor operation key namespace of each pair command. */
export const PAIR_OPERATION_KEYS: Readonly<Record<SalePairCommand, string>> = {
  SUBMIT_FOR_APPROVAL: 'JOB_SUBMIT_FOR_APPROVAL_PAIR',
  APPROVE: 'JOB_APPROVE_PAIR',
  REQUEST_REVISION: 'JOB_REQUEST_REVISION_PAIR',
  WITHDRAW_FROM_APPROVAL: 'JOB_WITHDRAW_FROM_APPROVAL_PAIR',
  RESUME: 'JOB_RESUME_PAIR',
};

/**
 * §4.2 precondition (R17): while the source visit is live, one owner per pair.
 * A divergent pair is *decoupled*: no redirect, no pair command, no shared id.
 */
export function isPairOwnedTogether(
  visit: { assignedTo: string },
  sale: { assignedTo: string },
): boolean {
  return visit.assignedTo === sale.assignedTo;
}

export function isLivePairSource(status: JobCardStatus): boolean {
  return LIVE_PAIR_SOURCE_STATUSES.includes(status);
}

/** True when this command is coordinated from the given live source status. */
export function redirectsSaleCommand(
  command: SalePairCommand,
  sourceStatus: JobCardStatus,
): boolean {
  return REDIRECT_SOURCE_STATUSES[command].includes(sourceStatus);
}

/**
 * §4.2: the exact next action a redirected sale command returns. Produced only
 * for an actor who can already read both cards (the pair owner or management):
 * the ownership invariant short-circuits a decoupled pair before this error is
 * ever built.
 */
export function salePairRedirect(input: {
  command: SalePairCommand;
  visitId: string;
  saleId: string;
  saleStatus: JobCardStatus;
}): AppError {
  return new AppError(
    REDIRECT_ERROR_CODES[input.command],
    409,
    'Bağlı satış kaydı, kaynak ziyaret üzerinden sonuçlandırılır.',
    {
      visitId: input.visitId,
      saleId: input.saleId,
      saleStatus: input.saleStatus,
      allowedSaleCommand: input.command,
    },
  );
}

/**
 * §4.3 step 3: the visit submission cannot silently skip its linked sale.
 * `allowedSaleCommand` names the single-card command that must run first.
 */
export function salePairStateConflict(input: {
  visitId: string;
  saleId: string;
  saleStatus: JobCardStatus;
  allowedSaleCommand: 'ACCEPT_ASSIGNMENT' | 'RESUME';
}): AppError {
  return new AppError(
    'SALE_PAIR_STATE_CONFLICT',
    409,
    input.allowedSaleCommand === 'ACCEPT_ASSIGNMENT'
      ? 'Bağlı satış kaydı önce kabul edilmelidir.'
      : 'Bağlı satış kaydı önce düzeltmeden çıkarılmalıdır.',
    {
      visitId: input.visitId,
      saleId: input.saleId,
      saleStatus: input.saleStatus,
      allowedSaleCommand: input.allowedSaleCommand,
    },
  );
}

/** §4.3 last item (R17): a live pair keeps one owner. */
export function salePairAssigneeConflict(input: {
  visitAssignee: string;
  requestedAssignee: string;
}): AppError {
  return new AppError(
    'SALE_PAIR_ASSIGNEE_CONFLICT',
    409,
    'Canlı bir ziyaret+satış çiftinde sorumlu personel ortak olmalıdır; fiziksel teslim için onay sırasında farklı bir teslim personeli seçin.',
    {
      visitAssignee: input.visitAssignee,
      requestedAssignee: input.requestedAssignee,
    },
  );
}

/**
 * §4.5: `expectedSaleVersion` is required iff a coordinated pair exists for the
 * command, and is a conflict (never a validation error) when supplied without
 * one — a race or a stale client view.
 */
export function noCoordinatedPair(): AppError {
  return new AppError(
    'SALE_PAIR_STATE_CONFLICT',
    409,
    'Bu işlem için eşgüdümlü bir ziyaret+satış çifti bulunmuyor.',
    { reason: 'NO_COORDINATED_PAIR' },
  );
}

export function expectedSaleVersionRequired(): AppError {
  return new AppError(
    'VALIDATION_ERROR',
    400,
    'Bağlı satış kaydı için expectedSaleVersion zorunludur.',
    { fieldErrors: { expectedSaleVersion: 'Bağlı satış kaydı sürümü zorunludur.' } },
  );
}
