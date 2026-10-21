import { timingSafeEqual } from 'node:crypto';
import { AppError } from '../../errors/index.js';
import type { CustomerPair } from './duplicate-candidates.js';
import { duplicateHmac, type DuplicateKeyring } from './duplicate-evidence.js';
import { DUPLICATE_LIMITS, DUPLICATE_RULE_VERSION } from './duplicate-types.js';

export type DuplicateRegisterCursorContext = {
  organizationId: string; view: 'ALL' | 'ATTENTION'; limit: number;
};
// Register cursors are domain-separated from candidate cursors so one opaque
// token can never be replayed against the other endpoint.
const purpose = 'CRM_DUPLICATE_REGISTER_CURSOR:v1';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const binding = (context: DuplicateRegisterCursorContext) => [context.organizationId, context.view, context.limit];
const invalid = (): never => { throw new AppError('VALIDATION_ERROR', 400, 'Sayfalama anahtarı geçersiz.'); };
const restart = (): never => { throw new AppError('CURSOR_RESTART_REQUIRED', 409, 'Kayıt listesi değişti. İlk sayfadan yeniden başlayın.'); };

export function encodeRegisterCursor(
  context: DuplicateRegisterCursorContext, pair: CustomerPair, keys: DuplicateKeyring, now = Date.now(),
) {
  const payload = [1, binding(context), DUPLICATE_RULE_VERSION, pair.customerAId, pair.customerBId, now];
  return `dr1.${keys.activeKeyId}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${duplicateHmac(keys, purpose, payload)}`;
}

export function decodeRegisterCursor(
  raw: string, context: DuplicateRegisterCursorContext, keys: DuplicateKeyring, now = Date.now(),
): CustomerPair {
  if (raw.length > 2048) invalid();
  const parts = raw.split('.');
  if (parts.length !== 4 || parts[0] !== 'dr1' || !keys.keys.has(parts[1]!)) invalid();
  let payload: unknown;
  try {
    const bytes = Buffer.from(parts[2]!, 'base64url');
    if (bytes.toString('base64url') !== parts[2]) invalid();
    payload = JSON.parse(bytes.toString('utf8'));
  } catch { return invalid(); }
  const expected = duplicateHmac(keys, purpose, payload, parts[1]);
  if (!/^[A-Za-z0-9_-]{43}$/.test(parts[3]!) || !timingSafeEqual(Buffer.from(parts[3]!), Buffer.from(expected))) invalid();
  if (!Array.isArray(payload) || payload.length !== 6 || payload[0] !== 1
    || JSON.stringify(payload[1]) !== JSON.stringify(binding(context))
    || typeof payload[3] !== 'string' || typeof payload[4] !== 'string'
    || !uuidPattern.test(payload[3]) || !uuidPattern.test(payload[4]) || payload[3] >= payload[4]
    || !Number.isSafeInteger(payload[5])) return invalid();
  if (payload[2] !== DUPLICATE_RULE_VERSION || payload[5] > now || now - payload[5] >= DUPLICATE_LIMITS.cursorMs) restart();
  return { customerAId: payload[3], customerBId: payload[4] };
}
