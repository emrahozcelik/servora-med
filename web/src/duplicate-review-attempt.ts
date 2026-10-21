import type { DuplicateDecision, DuplicateDecisionReason } from './services/duplicate-customers-api';

export type DuplicateAttemptKind = 'DECIDE' | 'REOPEN';
export type DuplicateAttempt = {
  version: 1;
  kind: DuplicateAttemptKind;
  clientActionId: string;
  expectedReviewVersion: number;
  expectedEvidenceRevision: string;
  matchingRuleVersion: string;
  decision?: DuplicateDecision;
  reasonCode?: DuplicateDecisionReason;
  createdAt: number;
};

const keyFor = (organizationId: string, actorId: string, a: string, b: string) =>
  `CRM_DUPLICATE_COMMAND_ATTEMPT:v1:${organizationId}:${actorId}:${a < b ? a : b}:${a < b ? b : a}`;
const cooldownKey = (organizationId: string, actorId: string) => `CRM_DUPLICATE_COMMAND_COOLDOWN:v1:${organizationId}:${actorId}`;
const cooldowns = new Map<string, number>();
type CommandCooldownListener = (until: number | null) => void;
const commandCooldownListeners = new Map<string, Set<CommandCooldownListener>>();

/**
 * Same-tab sessionStorage writes do not emit storage events, so mounted sibling
 * recovery surfaces subscribe here instead of polling storage.
 */
export function subscribeDuplicateCommandCooldown(
  organizationId: string, actorId: string, listener: CommandCooldownListener,
) {
  const key = cooldownKey(organizationId, actorId);
  const set = commandCooldownListeners.get(key) ?? new Set<CommandCooldownListener>();
  set.add(listener);
  commandCooldownListeners.set(key, set);
  return () => {
    set.delete(listener);
    if (!set.size) commandCooldownListeners.delete(key);
  };
}

function notifyCommandCooldown(key: string, until: number | null) {
  commandCooldownListeners.get(key)?.forEach((listener) => listener(until));
}

export function readDuplicateCommandRetryAt(organizationId: string, actorId: string): number | null {
  const key = cooldownKey(organizationId, actorId);
  let until = cooldowns.get(key) ?? 0;
  try { until = Math.max(until, Number(window.sessionStorage.getItem(key)) || 0); } catch { /* retain in-memory cooldown */ }
  if (Number.isFinite(until) && until > Date.now()) return until;
  cooldowns.delete(key);
  try { window.sessionStorage.removeItem(key); } catch { /* expired metadata is optional */ }
  return null;
}

export function writeDuplicateCommandRetryAt(organizationId: string, actorId: string, until: number) {
  const key = cooldownKey(organizationId, actorId);
  cooldowns.set(key, until);
  try { window.sessionStorage.setItem(key, String(until)); } catch { /* in-memory cooldown remains enforced */ }
  notifyCommandCooldown(key, until);
}

export function clearDuplicateCommandRetryAt(organizationId: string, actorId: string) {
  const key = cooldownKey(organizationId, actorId);
  cooldowns.delete(key);
  try { window.sessionStorage.removeItem(key); } catch { /* storage is optional */ }
  notifyCommandCooldown(key, null);
}

function valid(value: unknown): value is DuplicateAttempt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return v.version === 1 && (v.kind === 'DECIDE' || v.kind === 'REOPEN')
    && typeof v.clientActionId === 'string' && v.clientActionId.length > 0 && v.clientActionId.length <= 255
    && typeof v.expectedReviewVersion === 'number' && Number.isInteger(v.expectedReviewVersion)
    && typeof v.expectedEvidenceRevision === 'string'
    && typeof v.matchingRuleVersion === 'string' && typeof v.createdAt === 'number'
    && (v.kind === 'REOPEN' || (typeof v.decision === 'string' && typeof v.reasonCode === 'string'));
}

export function readDuplicateAttempt(organizationId: string, actorId: string, a: string, b: string): DuplicateAttempt | null {
  try {
    const raw = window.sessionStorage.getItem(keyFor(organizationId, actorId, a, b));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return valid(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeDuplicateAttempt(organizationId: string, actorId: string, a: string, b: string, attempt: DuplicateAttempt) {
  try {
    const key = keyFor(organizationId, actorId, a, b);
    const serialized = JSON.stringify(attempt);
    const previous = window.sessionStorage.getItem(key);
    if (previous !== null && previous !== serialized) throw new Error('Unresolved attempt exists');
    window.sessionStorage.setItem(key, serialized);
    if (window.sessionStorage.getItem(key) !== serialized) throw new Error('Attempt was not persisted');
  } catch {
    throw new Error('İnceleme taslağı bu tarayıcıda saklanamadı. İşlem gönderilmedi.');
  }
}

export function clearDuplicateAttempt(organizationId: string, actorId: string, a: string, b: string) {
  try { window.sessionStorage.removeItem(keyFor(organizationId, actorId, a, b)); } catch { /* storage is optional */ }
}

export function attemptMatchesCurrent(
  attempt: Pick<DuplicateAttempt, 'expectedReviewVersion' | 'expectedEvidenceRevision' | 'matchingRuleVersion'>,
  review: { version: number },
  revision: string,
  matchingRuleVersion: string,
) {
  return attempt.expectedReviewVersion === review.version
    && attempt.expectedEvidenceRevision === revision
    && attempt.matchingRuleVersion === matchingRuleVersion;
}
