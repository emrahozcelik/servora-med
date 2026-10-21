import { expect, it } from 'vitest';

import { DuplicateComparisonService } from '../src/modules/crm/duplicate-service.js';
import { compareDuplicateFacts, createDuplicateEvidenceDetails, parseDuplicateKeyring } from '../src/modules/crm/duplicate-evidence.js';
import type { DuplicateCustomerFacts } from '../src/modules/crm/duplicate-types.js';
import type { DuplicateReviewHead } from '../src/modules/crm/duplicate-review.js';

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const customer = (n: number, name: string): DuplicateCustomerFacts => ({
  id: id(n), name, customerType: 'clinic', taxNumber: null, phone: null, email: null,
  city: null, district: null, address: null, status: 'active', version: 1,
  assignedStaffUserId: null, contacts: [], addressOverflow: false,
});

const keys = parseDuplicateKeyring(JSON.stringify({ activeKeyId: 'synthetic', keys: { synthetic: Buffer.alloc(32, 5).toString('base64') } }));
const org = 'org-a';
const input = { view: 'ALL' as const, anchorCustomerId: null, cursor: null, limit: 20 };

function blockedRepository(release: Promise<void>) {
  return {
    snapshot: async (run: (snapshot: unknown) => Promise<unknown>) => {
      await release;
      return run({
        asOf: new Date().toISOString(), checkpoint: () => {}, source: async () => [], facts: async () => new Map(), reviewHeads: async () => new Map(),
      });
    },
  } as never;
}

it('PERF-08: allows two scans per organization and rejects the third without opening a snapshot', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const service = new DuplicateComparisonService(blockedRepository(gate), keys);
  const actor = { id: 'actor-a', organizationId: org, role: 'ADMIN' as const };
  const first = service.candidates(actor, input);
  const second = service.candidates(actor, input);
  await expect(service.candidates(actor, input)).rejects.toMatchObject({ code: 'RATE_LIMIT_EXCEEDED', statusCode: 429 });
  const otherOrg = service.candidates({ ...actor, id: 'actor-b', organizationId: 'org-b' }, input);
  release();
  await Promise.all([first, second, otherOrg]);
  await expect(service.candidates(actor, input)).resolves.toBeDefined();
});

it('F10/PAIR-04: a 25-pair default page continues after the last returned pair', async () => {
  const source = Array.from({ length: 50 }, (_, n) => customer(n + 1, `Synthetic clinic ${Math.floor(n / 2)}`));
  const repository = { snapshot: async (run: (snapshot: unknown) => Promise<unknown>) => run({
    asOf: new Date().toISOString(), checkpoint: () => {}, source: async () => source,
    facts: async () => new Map(source.map((c) => [c.id, c])), reviewHeads: async () => new Map(),
  }) } as never;
  const service = new DuplicateComparisonService(repository, keys);
  const actor = { id: 'actor-a', organizationId: org, role: 'ADMIN' as const };
  const first = await service.candidates(actor, input);
  expect(first.items).toHaveLength(20);
  expect(first.page.exhausted).toBe(false);
  expect(first.page.evaluatedPairs).toBe(20);
  const second = await service.candidates(actor, { ...input, cursor: first.page.nextCursor });
  expect(second.items).toHaveLength(5);
  expect(second.page.exhausted).toBe(true);
  expect([...first.items, ...second.items].map((item) => item.pair)).toEqual(
    Array.from({ length: 25 }, (_, n) => ({ customerAId: id(n * 2 + 1), customerBId: id(n * 2 + 2) })),
  );
});

it('F10/PAIR-04/06/READ-04: 21/25/32/33/40 pairs match a brute-force oracle across ALL/ATTENTION, sparse decisions and anchors', async () => {
  for (const count of [21, 25, 32, 33, 40]) for (const anchored of [false, true]) {
    const source = Array.from({ length: anchored ? count + 1 : count * 2 }, (_, n) => customer(n + 1, anchored ? 'Synthetic clinic' : `Synthetic clinic ${Math.floor(n / 2)}`));
    const anchor = anchored ? source[Math.floor(count / 2)]!.id : null;
    const oracle = source.flatMap((a, index) => source.slice(index + 1)
      .filter((b) => (!anchor || a.id === anchor || b.id === anchor) && compareDuplicateFacts(a, b).matchingCodes.length)
      .map((b) => ({ customerAId: a.id, customerBId: b.id })));
    expect(oracle).toHaveLength(count);
    for (const pattern of ['none', 'sparse', 'first32'] as const) {
      const heads = new Map<string, DuplicateReviewHead>();
      oracle.forEach((pair, index) => {
        if (pattern === 'none' || (pattern === 'sparse' && index % 3 !== 0) || (pattern === 'first32' && index >= 32)) return;
        const details = createDuplicateEvidenceDetails(org, source.find((c) => c.id === pair.customerAId)!, source.find((c) => c.id === pair.customerBId)!, keys);
        heads.set(`${pair.customerAId}:${pair.customerBId}`, {
          id: id(10_000 + index), version: 1, eventId: id(20_000 + index), seq: 1, eventKind: 'DECISION_RECORDED',
          resultingStatus: index % 2 ? 'CONFIRMED_DUPLICATE' : 'DISMISSED',
          reasonCode: index % 2 ? 'SAME_OPERATIONAL_CUSTOMER_VERIFIED' : 'DISTINCT_BRANCH',
          actorUserId: id(30_000), occurredAt: new Date('2026-10-20T10:00:00Z'), evidenceSchemaVersion: 1,
          matchingRuleVersion: details.matchingRuleVersion, evidenceKeyId: details.keyId, evidenceDigest: details.digest,
          matchingCodes: details.matchingCodes, conflictingTaxNumbers: false, previousDecision: null,
        });
      });
      const repository = { snapshot: async (run: (snapshot: unknown) => Promise<unknown>) => run({
        asOf: new Date().toISOString(), checkpoint: () => {}, source: async () => source,
        facts: async () => new Map(source.map((c) => [c.id, c])), reviewHeads: async () => heads,
      }) } as never;
      const service = new DuplicateComparisonService(repository, keys);
      for (const view of ['ALL', 'ATTENTION'] as const) {
        const seen: unknown[] = []; let cursor: string | null = null; let evaluated = 0; let pages = 0;
        for (;;) {
          const page = await service.candidates({ id: 'manager', organizationId: org, role: 'MANAGER' }, { ...input, view, anchorCustomerId: anchor, cursor });
          pages++; expect(pages).toBeLessThan(6);
          expect(page.page.evaluatedPairs).toBeLessThanOrEqual(32); expect(page.items.length).toBeLessThanOrEqual(20);
          evaluated += page.page.evaluatedPairs; seen.push(...page.items.map((item) => item.pair));
          if (pattern === 'first32' && count > 32 && view === 'ATTENTION' && pages === 1) {
            expect(page.items).toEqual([]); expect(page.page.exhausted).toBe(false);
          }
          if (page.page.exhausted) { expect(page.page.nextCursor).toBeNull(); break; }
          expect(page.page.nextCursor).toBeTruthy(); expect(page.page.nextCursor).not.toBe(cursor); cursor = page.page.nextCursor;
        }
        expect(evaluated).toBe(count);
        const expected = oracle.filter((pair) => view === 'ALL' || !heads.has(`${pair.customerAId}:${pair.customerBId}`));
        expect(seen, `${count}/${anchored}/${pattern}/${view}`).toEqual(expected);
        expect(new Set(seen.map((pair) => JSON.stringify(pair))).size).toBe(seen.length);
      }
    }
  }
});
