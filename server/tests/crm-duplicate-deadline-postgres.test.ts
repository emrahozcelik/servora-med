import { randomUUID } from 'node:crypto';
import { createServer, connect, type Socket, type AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { PostgresDuplicateReadRepository } from '../src/modules/crm/duplicate-repository.js';

// Real PG17 protocol fault: forward requests, withhold server replies at the
// chosen statement. Works with a separate CI PG container. The owned Linux
// acceptance fixture additionally sends SIGSTOP/SIGCONT to its exact backend.
it.each(['BEGIN', 'SET LOCAL', 'SELECT id,name,phone,status', 'COMMIT', 'IDLE'])(
  'READ deadline: real PG17 transport stall at %s discards and recovers', async (phase) => {
    const url = new URL(process.env.TEST_DATABASE_URL!);
    const observer = new Pool({ connectionString: url.toString(), max: 1 });
    const appName = `duplicate-deadline-${randomUUID()}`;
    const sockets = new Set<Socket>(); let withheld = false; let frontSocket: Socket;
    let resumeWork = () => {};
    const proxy = createServer({ allowHalfOpen: true }, front => {
      frontSocket = front;
      const back = connect({ host: url.hostname, port: Number(url.port || 5432) });
      sockets.add(front); sockets.add(back);
      front.on('error', () => {}); back.on('error', () => {});
      front.on('close', () => { back.destroy(); sockets.delete(front); });
      back.on('close', () => { front.destroy(); sockets.delete(back); });
      front.pipe(back);
      back.on('data', chunk => { if (!withheld) front.write(chunk); });
    });
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const proxyUrl = new URL(url); proxyUrl.hostname = '127.0.0.1'; proxyUrl.port = String((proxy.address() as AddressInfo).port);
    const pool = new Pool({ connectionString: proxyUrl.toString(), application_name: appName, max: 1 });
    const released: unknown[] = []; pool.on('release', error => released.push(error));
    let ended = false;
    try {
      const client = await pool.connect();
      const query = client.query.bind(client);
      // Arm after handshake. The request reaches PG but its reply is withheld.
      client.query = ((...args: unknown[]) => {
        if (typeof args[0] === 'string' && args[0].startsWith(phase)) withheld = true;
        return Reflect.apply(query, client, args);
      }) as typeof client.query;
      client.once('end', () => { ended = true; }); client.release(); released.length = 0;
      const start = performance.now();
      await expect(new PostgresDuplicateReadRepository(pool).snapshot(async snapshot => {
        const rows = await snapshot.source(randomUUID(), null);
        if (phase === 'IDLE' && !withheld) {
          withheld = true; frontSocket.unpipe();
          await new Promise<void>(resolve => { resumeWork = resolve; });
          snapshot.checkpoint();
        }
        return rows;
      })).rejects.toMatchObject({ code: 'REVIEW_TEMPORARILY_UNAVAILABLE', statusCode: 503 });
      expect(performance.now() - start).toBeLessThan(6_500);
      resumeWork();
      expect(withheld).toBe(true); expect(released).toEqual([true]);
      expect(pool.totalCount).toBe(0); expect(pool.waitingCount).toBe(0);
      await waitForCleanup(async () => { expect(ended).toBe(true); });
      // Local close is required while the fault is active. The intentionally
      // blackholed upstream only receives EOF when the proxy fault is lifted,
      // like a SIGSTOP backend can process disconnect only after SIGCONT.
      withheld = false;
      for (const socket of sockets) socket.destroy();
      await waitForCleanup(async () => {
        expect((await observer.query('SELECT pid FROM pg_stat_activity WHERE application_name=$1', [appName])).rowCount).toBe(0);
      });
      await expect(new PostgresDuplicateReadRepository(pool).snapshot(snapshot => snapshot.source(randomUUID(), null))).resolves.toEqual([]);
      expect(pool.totalCount).toBe(1); expect(pool.idleCount).toBe(1);
    } finally {
      withheld = false; resumeWork();
      for (const socket of sockets) socket.destroy();
      await pool.end(); await observer.end();
      await new Promise<void>(resolve => proxy.close(() => resolve()));
    }
  }, 12_000,
);

async function waitForCleanup(check: () => Promise<void>) {
  const until = performance.now() + 2_000;
  for (;;) {
    try { await check(); return; }
    catch (error) {
      if (performance.now() >= until) throw error;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
}
