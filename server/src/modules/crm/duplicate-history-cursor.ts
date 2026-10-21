import { AppError } from '../../errors/index.js';
import { duplicateHmac, type DuplicateKeyring } from './duplicate-evidence.js';

const purpose = 'CRM_DUPLICATE_HISTORY:v1';
const ttlMs = 15 * 60_000;

type Payload = [string, string, number, number | null, number];

export function encodeHistoryCursor(
  keys: DuplicateKeyring,
  organizationId: string,
  reviewId: string,
  upperSeq: number,
  beforeSeq: number | null,
  now = Date.now(),
) {
  const payload: Payload = [organizationId, reviewId, upperSeq, beforeSeq, now];
  return `dh1.${keys.activeKeyId}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${duplicateHmac(keys, purpose, payload)}`;
}

export function decodeHistoryCursor(
  value: string,
  keys: DuplicateKeyring,
  organizationId: string,
  reviewId: string,
  now = Date.now(),
): { upperSeq: number; beforeSeq: number | null } {
  const reject = (): never => { throw new AppError('CURSOR_RESTART_REQUIRED', 409, 'Geçmiş imleci kullanılamıyor. İlk sayfadan başlayın.'); };
  if (value.length > 2048) reject();
  const parts = value.split('.');
  if (parts.length !== 4 || parts[0] !== 'dh1') reject();
  let payload: unknown;
  try { payload = JSON.parse(Buffer.from(parts[2]!, 'base64url').toString('utf8')); } catch { return reject(); }
  if (!Array.isArray(payload) || payload.length !== 5) reject();
  const [org, id, upperSeq, beforeSeq, issuedAt] = payload as unknown[];
  if (typeof org !== 'string' || typeof id !== 'string'
    || typeof upperSeq !== 'number' || !Number.isInteger(upperSeq) || upperSeq < 1
    || (beforeSeq !== null && (typeof beforeSeq !== 'number' || !Number.isInteger(beforeSeq) || beforeSeq < 2 || beforeSeq > upperSeq))
    || typeof issuedAt !== 'number' || !Number.isInteger(issuedAt) || issuedAt > now + 60_000 || now - issuedAt > ttlMs) reject();
  if (org !== organizationId || id !== reviewId) reject();
  let expected: string;
  try { expected = duplicateHmac(keys, purpose, payload, parts[1]); } catch { return reject(); }
  if (expected !== parts[3]) reject();
  return { upperSeq: upperSeq as number, beforeSeq: beforeSeq as number | null };
}
