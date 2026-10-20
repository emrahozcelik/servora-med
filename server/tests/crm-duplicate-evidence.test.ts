import { expect, it } from 'vitest';

import { compareDuplicateFacts, createDuplicateEvidence, parseDuplicateKeyring } from '../src/modules/crm/duplicate-evidence.js';

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const keyring = () => parseDuplicateKeyring(JSON.stringify({ activeKeyId: 'synthetic', keys: { synthetic: Buffer.alloc(32, 7).toString('base64') } }));
const customer = (n: number) => ({
  id: id(n), name: 'İSTANBUL KLİNİK', customerType: 'clinic' as const,
  taxNumber: null, phone: '(0532) 123 45 67', email: 'test@example.invalid',
  city: 'İstanbul', district: 'Merkez', address: 'Test sokak', status: 'active' as const,
  version: 1, assignedStaffUserId: null, contacts: [], addressOverflow: false,
});

it('EVID-03/04/05/06: Contact semantics matter, witness/operational fields do not, and Contact order/escaping is canonical', () => {
  const contact = { id: id(3), name: 'Test "Kişi"\\\n', title: 'Dr.', phone: '+905321234567', email: 'x@example.invalid', isPrimary: false, isActive: true, version: 1 };
  const a = { ...customer(1), contacts: [contact, { ...contact, id: id(4) }] };
  const b = customer(2); const revision = createDuplicateEvidence(id(9), a, b, keyring());
  expect(createDuplicateEvidence(id(9), { ...a, contacts: [...a.contacts].reverse().map((c) => ({ ...c, version: 99 })) }, { ...b, version: 99, assignedStaffUserId: id(8), status: 'inactive' }, keyring())).toBe(revision);
  for (const change of [{ name: 'Different' }, { title: null }, { phone: '+902125550101' }, { email: null }, { isPrimary: true }, { isActive: false }, { id: id(5) }]) {
    expect(createDuplicateEvidence(id(9), { ...a, contacts: [{ ...contact, ...change }, a.contacts[1]!] }, b, keyring())).not.toBe(revision);
  }
});

it('EVID-04/06, A12-S3: canonical evidence ignores source versions and equivalent formatting, but includes Contact membership', () => {
  const a = customer(1); const b = customer(2);
  const original = createDuplicateEvidence(id(9), a, b, keyring());
  expect(original).toMatch(/^ev1\.synthetic\.[A-Za-z0-9_-]{43}$/);
  expect(createDuplicateEvidence(id(9), { ...b, version: 99, phone: '+905321234567' }, { ...a, name: 'istanbul klinik' }, keyring())).toBe(original);
  expect(createDuplicateEvidence(id(9), a, { ...b, contacts: [{ id: id(3), name: 'Test Kişi', title: null, phone: null, email: null, isPrimary: false, isActive: false, version: 1 }] }, keyring())).not.toBe(original);
  expect(compareDuplicateFacts(a, b)).toEqual({ matchingCodes: ['SAME_NAME_AND_PHONE', 'SAME_NAME_AND_EMAIL', 'SAME_NAME_AND_ADDRESS'], warnings: [] });
});
