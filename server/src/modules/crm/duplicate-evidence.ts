import { createHmac } from 'node:crypto';

import { AppError } from '../../errors/index.js';
import { foldDuplicateText } from './duplicate-candidates.js';
import { DUPLICATE_LIMITS, DUPLICATE_RULE_VERSION, type DuplicateCustomerFacts, type DuplicateMatchCode, type DuplicateWarning } from './duplicate-types.js';
import { normalizeTaxNumber, normalizeTurkishPhone } from './types.js';

export type DuplicateKeyring = { readonly activeKeyId: string; readonly keys: ReadonlyMap<string, Buffer> };
const keyIdPattern = /^[A-Za-z0-9_-]{1,32}$/;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Strict, bounded secret config. Errors never include the supplied secret. */
export function parseDuplicateKeyring(raw: string): DuplicateKeyring {
  const fail = (): never => { throw new Error('CRM_DUPLICATE_EVIDENCE_KEYRING is invalid'); };
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 2048) fail();
  let value: unknown; try { value = JSON.parse(raw); } catch { return fail(); }
  if (!object(value) || Object.keys(value).sort().join(',') !== 'activeKeyId,keys'
    || typeof value.activeKeyId !== 'string' || !keyIdPattern.test(value.activeKeyId) || !object(value.keys)) return fail();
  const entries = Object.entries(value.keys);
  if (entries.length < 1 || entries.length > 2) fail();
  // This schema permits only two objects with ID/base64 values (no colons).
  // Count property tokens to detect duplicate JSON names erased by JSON.parse.
  if ((raw.match(/"(?:[^"\\]|\\.)*"\s*:/g) ?? []).length !== 2 + entries.length) fail();
  const keys = new Map<string, Buffer>();
  for (const [id, encoded] of entries) {
    if (!keyIdPattern.test(id) || typeof encoded !== 'string') return fail();
    const key = Buffer.from(encoded, 'base64');
    if (key.length !== 32 || key.toString('base64') !== encoded) fail();
    keys.set(id, key);
  }
  if (!keys.has(value.activeKeyId)) fail();
  return { activeKeyId: value.activeKeyId, keys };
}

export function duplicateHmac(keyring: DuplicateKeyring, purpose: string, payload: unknown, keyId = keyring.activeKeyId) {
  const key = keyring.keys.get(keyId);
  if (!key) throw new AppError('EVIDENCE_UNAVAILABLE', 503, 'Karşılaştırma kanıtı şu anda doğrulanamıyor.');
  return createHmac('sha256', key).update(JSON.stringify([purpose, payload]), 'utf8').digest('base64url');
}

const emailKey = (value: string | null) => value?.trim().toLowerCase() || null;
function phoneTuple(value: string | null) {
  const raw = value?.trim();
  if (!raw) return ['MISSING', null];
  const canonical = normalizeTurkishPhone(raw);
  return canonical ? ['TR', canonical] : ['UNUSABLE', raw];
}

export function compareDuplicateFacts(a: DuplicateCustomerFacts, b: DuplicateCustomerFacts) {
  const sameName = foldDuplicateText(a.name) !== null && foldDuplicateText(a.name) === foldDuplicateText(b.name);
  const samePhone = normalizeTurkishPhone(a.phone) !== null && normalizeTurkishPhone(a.phone) === normalizeTurkishPhone(b.phone);
  const sameEmail = emailKey(a.email) !== null && emailKey(a.email) === emailKey(b.email);
  const sameAddress = (['city', 'district', 'address'] as const).every((field) => foldDuplicateText(a[field]) !== null && foldDuplicateText(a[field]) === foldDuplicateText(b[field]));
  const matchingCodes: DuplicateMatchCode[] = [];
  if (sameName && samePhone) matchingCodes.push('SAME_NAME_AND_PHONE');
  if (sameName && sameEmail) matchingCodes.push('SAME_NAME_AND_EMAIL');
  if (sameName && sameAddress && !a.addressOverflow && !b.addressOverflow) matchingCodes.push('SAME_NAME_AND_ADDRESS');
  if (samePhone && !sameName) matchingCodes.push('SAME_PHONE');
  if (sameName && matchingCodes.length === 0) matchingCodes.push('SAME_NAME');
  const taxA = normalizeTaxNumber(a.taxNumber); const taxB = normalizeTaxNumber(b.taxNumber);
  const warnings: DuplicateWarning[] = taxA && taxB && taxA !== taxB ? ['CONFLICTING_TAX_NUMBERS'] : [];
  return { matchingCodes, warnings };
}

export function createDuplicateEvidence(org: string, first: DuplicateCustomerFacts, second: DuplicateCustomerFacts, keyring: DuplicateKeyring) {
  const [a, b] = first.id < second.id ? [first, second] : [second, first];
  const tuple = (customer: DuplicateCustomerFacts) => [
    customer.id, foldDuplicateText(customer.name), phoneTuple(customer.phone), emailKey(customer.email),
    foldDuplicateText(customer.city), foldDuplicateText(customer.district), foldDuplicateText(customer.address),
    normalizeTaxNumber(customer.taxNumber), customer.customerType,
    [...customer.contacts].sort((x, y) => x.id < y.id ? -1 : x.id > y.id ? 1 : 0).map((contact) => [
      contact.id, foldDuplicateText(contact.name), foldDuplicateText(contact.title), phoneTuple(contact.phone),
      emailKey(contact.email), contact.isPrimary, contact.isActive,
    ]),
  ];
  if ([a, b].some((c) => c.addressOverflow || Buffer.byteLength(c.address ?? '') > DUPLICATE_LIMITS.addressBytes || c.contacts.length > DUPLICATE_LIMITS.contacts)) {
    throw new AppError('EVIDENCE_LIMIT_EXCEEDED', 422, 'Karşılaştırma kanıtının bütünü okunamadı.');
  }
  const canonical = JSON.stringify(['CRM_DUPLICATE_EVIDENCE', 1, DUPLICATE_RULE_VERSION, org, a.id, b.id, tuple(a), tuple(b)]);
  if (Buffer.byteLength(canonical) > DUPLICATE_LIMITS.evidenceBytes) throw new AppError('EVIDENCE_LIMIT_EXCEEDED', 422, 'Karşılaştırma kanıtı sınırı aşıldı.');
  const key = keyring.keys.get(keyring.activeKeyId)!;
  return `ev1.${keyring.activeKeyId}.${createHmac('sha256', key).update(canonical, 'utf8').digest('base64url')}`;
}
