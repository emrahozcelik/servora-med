import { foldCustomerSearchText, normalizeTurkishPhone, type CustomerStatus } from './types.js';

export type DuplicateSource = { id: string; name: string; phone: string | null; status: CustomerStatus };
export type CustomerPair = { customerAId: string; customerBId: string };

export const foldDuplicateText = (value: string | null) => value === null ? null : foldCustomerSearchText(value.trim()) || null;

function add(bucket: Map<string, string[]>, key: string | null, id: string) {
  if (key === null) return;
  const group = bucket.get(key);
  if (group) group.push(id); else bucket.set(key, [id]);
}

function count(bucket: Map<string, string[]>) {
  let result = 0;
  for (const group of bucket.values()) result += group.length * (group.length - 1) / 2;
  return result;
}

function upperBound(values: readonly string[], after: string) {
  let lo = 0; let hi = values.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (values[mid]! <= after) lo = mid + 1; else hi = mid; }
  return lo;
}

function* union(a: readonly string[], b: readonly string[], after = '') {
  let i = upperBound(a, after); let j = upperBound(b, after);
  while (i < a.length || j < b.length) {
    if (j >= b.length || (i < a.length && a[i]! < b[j]!)) yield a[i++]!;
    else if (i >= a.length || b[j]! < a[i]!) yield b[j++]!;
    else { yield a[i++]!; j++; }
  }
}

/** Builds equality buckets, never the quadratic pair space. Input has already been org/BUSINESS scoped. */
export function createCandidateIndex(input: readonly DuplicateSource[], checkpoint = () => {}) {
  const sources = [...input].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const names = new Map<string, string[]>(); const phones = new Map<string, string[]>();
  const overlap = new Map<string, string[]>();
  const keys = new Map<string, { name: string | null; phone: string | null }>();
  for (const source of sources) {
    checkpoint();
    const name = foldDuplicateText(source.name); const phone = normalizeTurkishPhone(source.phone);
    keys.set(source.id, { name, phone });
    add(names, name, source.id); add(phones, phone, source.id);
    if (name !== null && phone !== null) add(overlap, JSON.stringify([name, phone]), source.id);
  }
  return {
    rawPairCount: String(count(names) + count(phones) - count(overlap)),
    sourceKeys: sources.map((source) => [source.id, keys.get(source.id)!.name, keys.get(source.id)!.phone, source.status]),
    largestNameGroupSize: Math.max(0, ...[...names.values()].map((group) => group.length)),
    largestPhoneGroupSize: Math.max(0, ...[...phones.values()].map((group) => group.length)),
    pairCount(anchor: string | null) {
      if (!anchor) return String(count(names) + count(phones) - count(overlap));
      const key = keys.get(anchor);
      if (!key) return '0';
      let total = 0;
      for (const id of union(names.get(key.name!) ?? [], phones.get(key.phone!) ?? [])) { checkpoint(); if (id !== anchor) total++; }
      return String(total);
    },
    *pairs(options: { anchorCustomerId?: string | null; after?: CustomerPair | null } = {}): Generator<CustomerPair> {
      const { anchorCustomerId: anchor, after } = options;
      if (anchor) {
        const key = keys.get(anchor);
        if (!key) return;
        for (const partner of union(names.get(key.name!) ?? [], phones.get(key.phone!) ?? [])) {
          checkpoint();
          if (partner === anchor) continue;
          const pair = partner < anchor
            ? { customerAId: partner, customerBId: anchor }
            : { customerAId: anchor, customerBId: partner };
          if (!after || pair.customerAId > after.customerAId
            || (pair.customerAId === after.customerAId && pair.customerBId > after.customerBId)) yield pair;
        }
        return;
      }
      for (const source of sources) {
        checkpoint();
        if (after && source.id < after.customerAId) continue;
        const key = keys.get(source.id)!;
        const cursor = after && source.id === after.customerAId ? after.customerBId : source.id;
        for (const partner of union(names.get(key.name!) ?? [], phones.get(key.phone!) ?? [], cursor)) {
          yield { customerAId: source.id, customerBId: partner };
        }
      }
    },
  };
}
