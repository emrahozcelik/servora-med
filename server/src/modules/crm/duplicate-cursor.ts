import { timingSafeEqual } from 'node:crypto';
import { AppError } from '../../errors/index.js';
import type { CustomerPair } from './duplicate-candidates.js';
import { duplicateHmac, type DuplicateKeyring } from './duplicate-evidence.js';
import { DUPLICATE_LIMITS, DUPLICATE_RULE_VERSION } from './duplicate-types.js';

export type DuplicateCursorContext = {
  organizationId: string; view: 'ALL' | 'ATTENTION'; anchorCustomerId: string | null;
  limit: number; sourceRevision: string;
};
const purpose = 'CRM_DUPLICATE_CURSOR:v1';
export const duplicateUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const binding = (context: DuplicateCursorContext) => [context.organizationId, context.view, context.anchorCustomerId, context.limit];
const invalid = (): never => { throw new AppError('VALIDATION_ERROR', 400, 'Sayfalama anahtarı geçersiz.'); };
const restart = (): never => { throw new AppError('CURSOR_RESTART_REQUIRED', 409, 'Liste değişti. İlk sayfadan yeniden başlayın.'); };

export function encodeDuplicateCursor(context: DuplicateCursorContext, pair: CustomerPair, keys: DuplicateKeyring, now = Date.now()) {
  const payload = [1, binding(context), DUPLICATE_RULE_VERSION, context.sourceRevision, pair.customerAId, pair.customerBId, now];
  return `dc1.${keys.activeKeyId}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${duplicateHmac(keys, purpose, payload)}`;
}

export function decodeDuplicateCursor(raw: string, context: DuplicateCursorContext, keys: DuplicateKeyring, now = Date.now()): CustomerPair {
  if (raw.length > 2048) invalid();
  const parts = raw.split('.');
  if (parts.length !== 4 || parts[0] !== 'dc1' || !keys.keys.has(parts[1]!)) invalid();
  let payload: unknown;
  try {
    const bytes = Buffer.from(parts[2]!, 'base64url');
    if (bytes.toString('base64url') !== parts[2]) invalid();
    payload = JSON.parse(bytes.toString('utf8'));
  } catch { return invalid(); }
  const expected = duplicateHmac(keys, purpose, payload, parts[1]);
  if (!/^[A-Za-z0-9_-]{43}$/.test(parts[3]!) || !timingSafeEqual(Buffer.from(parts[3]!), Buffer.from(expected))) invalid();
  if (!Array.isArray(payload) || payload.length !== 7 || payload[0] !== 1
    || JSON.stringify(payload[1]) !== JSON.stringify(binding(context))
    || typeof payload[4] !== 'string' || typeof payload[5] !== 'string'
    || !duplicateUuidPattern.test(payload[4]) || !duplicateUuidPattern.test(payload[5]) || payload[4] >= payload[5]
    || !Number.isSafeInteger(payload[6])) return invalid();
  if (payload[2] !== DUPLICATE_RULE_VERSION || payload[3] !== context.sourceRevision
    || payload[6] > now || now - payload[6] >= DUPLICATE_LIMITS.cursorMs) restart();
  return { customerAId: payload[4], customerBId: payload[5] };
}
