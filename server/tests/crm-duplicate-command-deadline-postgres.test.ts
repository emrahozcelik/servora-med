import { randomUUID } from 'node:crypto';
import { createServer, connect, type Socket, type AddressInfo } from 'node:net';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { withSaleFixture } from './support/sale-harness.js';
import { parseDuplicateKeyring } from '../src/modules/crm/duplicate-evidence.js';
import { DuplicateComparisonService } from '../src/modules/crm/duplicate-service.js';
import { PostgresDuplicateReadRepository } from '../src/modules/crm/duplicate-repository.js';
import { DuplicateReviewService } from '../src/modules/crm/duplicate-review-service.js';
import { PostgresDuplicateReviewRepository } from '../src/modules/crm/duplicate-review-repository.js';

it.skipIf(!process.env.TEST_DATABASE_URL).each(['BEGIN', 'SET LOCAL', 'INSERT INTO processed_actions', 'SELECT id,name,customer_type', 'COMMIT', 'ROLLBACK'])(
  'TX-06/TX-12: blackholed PG17 %s expires, destroys its connection and safely reconciles the original intent', async (phase) => {
  await withSaleFixture(async (f) => {
    const keys = parseDuplicateKeyring(JSON.stringify({ activeKeyId: 'synthetic', keys: { synthetic: Buffer.alloc(32, 111).toString('base64') } }));
    const b = (await f.pool.query("INSERT INTO customers(organization_id,name,customer_type) VALUES($1,'Dental Klinik','clinic') RETURNING id", [f.organizationId])).rows[0].id;
    const read = await new DuplicateComparisonService(new PostgresDuplicateReadRepository(f.pool), keys).comparison(f.manager, f.customerId, b);
    const command = { clientActionId: randomUUID(), expectedReviewVersion: 0, expectedEvidenceRevision: read.evidence.revision, matchingRuleVersion: read.evidence.matchingRuleVersion, decision: 'DISMISSED' as const, reasonCode: 'DISTINCT_BRANCH' as const };
    if (phase === 'ROLLBACK') command.expectedEvidenceRevision = `ev1.synthetic.${'A'.repeat(43)}`;
    const upstream = new URL(process.env.TEST_DATABASE_URL!); const sockets = new Set<Socket>(); let withheld = false;
    const proxy = createServer({ allowHalfOpen: true }, (front) => {
      const back = connect({ host: upstream.hostname, port: Number(upstream.port || 5432) });
      sockets.add(front); sockets.add(back); front.on('error', () => {}); back.on('error', () => {});
      front.on('close', () => { back.destroy(); sockets.delete(front); }); back.on('close', () => { front.destroy(); sockets.delete(back); });
      front.pipe(back); back.on('data', (bytes) => { if (!withheld) front.write(bytes); });
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const proxyUrl = new URL(upstream); proxyUrl.hostname = '127.0.0.1'; proxyUrl.port = String((proxy.address() as AddressInfo).port);
    const pool = new Pool({ connectionString: proxyUrl.toString(), options: f.pool.options.options, max: 1 });
    pool.on('error', () => {}); // Owned transport fault, including RED cleanup.
    const client = await pool.connect(); const raw = client.query.bind(client);
    client.query = ((...args: unknown[]) => { if (typeof args[0] === 'string' && args[0].startsWith(phase)) withheld = true; return Reflect.apply(raw, client, args); }) as typeof client.query;
    client.release();
    const service = new DuplicateReviewService(new PostgresDuplicateReviewRepository(pool, keys));
    const start = performance.now(); const running = service.decide(f.manager, f.customerId, b, command);
    let timer: ReturnType<typeof setTimeout>;
    try {
      await expect(Promise.race([running, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Command deadline did not settle')), 6_500); })]))
        .rejects.toMatchObject({ code: 'REVIEW_TEMPORARILY_UNAVAILABLE', statusCode: 503 });
      expect(performance.now() - start).toBeLessThan(6_000); expect(withheld).toBe(true);
      expect(pool.totalCount).toBe(0); expect(pool.waitingCount).toBe(0);
      withheld = false; for (const socket of sockets) socket.destroy();
      const retry = new DuplicateReviewService(new PostgresDuplicateReviewRepository(f.pool, keys)).decide(f.manager, f.customerId, b, command);
      if (phase === 'ROLLBACK') await expect(retry).rejects.toMatchObject({ code: 'EVIDENCE_CHANGED', statusCode: 409 });
      else { const replay = await retry; expect(replay.replayed).toBe(phase === 'COMMIT'); expect(replay.receipt.reviewVersion).toBe(1); }
      expect((await f.pool.query('SELECT count(*) FROM customer_duplicate_review_events')).rows[0].count).toBe(phase === 'ROLLBACK' ? '0' : '1');
    } finally {
      clearTimeout(timer!); withheld = false; for (const socket of sockets) socket.destroy();
      await running.catch(() => {}); await pool.end(); await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });
}, 12_000);
