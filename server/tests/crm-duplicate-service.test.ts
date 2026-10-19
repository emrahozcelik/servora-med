import { expect, it } from 'vitest';

import { DuplicateComparisonService } from '../src/modules/crm/duplicate-service.js';
import { parseDuplicateKeyring } from '../src/modules/crm/duplicate-evidence.js';

const keys = parseDuplicateKeyring(JSON.stringify({ activeKeyId: 'synthetic', keys: { synthetic: Buffer.alloc(32, 5).toString('base64') } }));
const org = 'org-a';
const input = { view: 'ALL' as const, anchorCustomerId: null, cursor: null, limit: 20 };

function blockedRepository(release: Promise<void>) {
  return {
    snapshot: async (run: (snapshot: unknown) => Promise<unknown>) => {
      await release;
      return run({
        asOf: new Date().toISOString(), checkpoint: () => {}, source: async () => [], facts: async () => new Map(),
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
