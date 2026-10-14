import { describe, expect, it } from 'vitest';
import { JobCardService } from '../src/modules/job-cards/service.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { gatePoolStatements, waitFor } from './support/lifecycle-intent-harness.js';
import { saleTime, withSaleFixture } from './support/sale-harness.js';
import type { Pool } from 'pg';

async function waitForBlockedWriter(pool: Pool, pid: number) {
  await waitFor(async () => (await pool.query<{ blocked: boolean }>(
    'SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked', [pid])).rows[0]!.blocked,
  5_000, 'actual PostgreSQL row-lock wait');
}

describe.skipIf(!process.env.TEST_DATABASE_URL)('Sale row-lock arbitration', () => {
  it.each(['product', 'contact'] as const)('rejects when %s deactivation commits before the reference lock', async (reference) => {
    await withSaleFixture(async (f) => {
      const holder = await f.pool.connect();
      const pid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      let pending: Promise<unknown> | undefined;
      try {
        await holder.query('BEGIN');
        await holder.query(`UPDATE ${reference === 'product' ? 'products' : 'contacts'} SET is_active=false WHERE id=$1`,
          [reference === 'product' ? f.products[0] : f.metContactId]);
        pending = f.service.createSaleFromVisit(f.staff, f.visitId, f.input);
        // Attach the handler before releasing the lock to avoid an unhandled rejection.
        const outcome = pending.then((value) => ({ value }), (error: unknown) => ({ error }));
        await waitFor(async () => (await f.pool.query<{ blocked: boolean }>(
          'SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked', [pid])).rows[0]!.blocked,
        5_000, 'sale blocked on reference writer');
        await holder.query('COMMIT');
        expect(await outcome).toMatchObject({ error: { code: reference === 'product' ? 'PRODUCT_NOT_FOUND' : 'CONTACT_INACTIVE' } });
        expect((await f.pool.query("SELECT count(*)::int AS n FROM job_cards WHERE type='SALE'")).rows[0].n).toBe(0);
        expect((await f.pool.query("SELECT count(*)::int AS n FROM processed_actions WHERE operation_key='SALE_FROM_VISIT_CREATE'")).rows[0].n).toBe(0);
      } finally { await holder.query('ROLLBACK'); holder.release(); await pending?.catch(() => undefined); }
    });
  });
  it.each(['product', 'contact'] as const)('freezes %s metadata when sale wins before a rename/deactivation', async (reference) => {
    await withSaleFixture(async (f) => {
      const gate = gatePoolStatements(f.pool, 'INSERT INTO job_card_sale_details');
      const service = new JobCardService(new PostgresJobCardRepository(gate.pool), () => saleTime);
      const creating = service.createSaleFromVisit(f.staff, f.visitId, f.input);
      const writer = await f.pool.connect();
      let changing: Promise<unknown> | undefined;
      try {
        await gate.arrived;
        const pid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        changing = writer.query(`UPDATE ${reference === 'product' ? 'products' : 'contacts'} SET name='After sale',is_active=false WHERE id=$1`,
          [reference === 'product' ? f.products[0] : f.metContactId]);
        await waitForBlockedWriter(f.pool, pid);
        gate.release();
        const sale = await creating;
        await changing;
        if (reference === 'product') {
          expect((await f.pool.query('SELECT product_name_snapshot,product_brand_snapshot FROM job_card_sale_items WHERE job_card_id=$1 AND product_id=$2', [sale.jobCardId, f.products[0]])).rows[0])
            .toEqual({ product_name_snapshot: 'Matrix set', product_brand_snapshot: 'Brand A' });
        } else {
          expect((await f.pool.query('SELECT sale_contact_name_snapshot,source_met_contact_name_snapshot FROM job_card_sale_details WHERE job_card_id=$1', [sale.jobCardId])).rows[0])
            .toEqual({ sale_contact_name_snapshot: 'Actual doctor', source_met_contact_name_snapshot: 'Actual doctor' });
        }
      } finally { gate.release(); await creating.catch(() => undefined); await changing; writer.release(); }
    });
  });
  it.each(['submit', 'cancel', 'reassign'] as const)('rechecks source version/ownership when source %s wins', async (command) => {
    await withSaleFixture(async (f) => {
      let sourceVersion = f.input.expectedSourceVersion;
      if (command === 'submit') {
        const details = await f.service.patchMeetingDetails(f.staff, f.visitId, {
          clientActionId: 'source-ready', expectedVersion: sourceVersion,
          meetingAt: saleTime.toISOString(), outcome: 'POSITIVE', meetingSummary: 'Products discussed.',
        });
        sourceVersion = details.jobCardVersion;
      }
      const gate = gatePoolStatements(f.pool, 'FOR NO KEY UPDATE');
      const service = new JobCardService(new PostgresJobCardRepository(gate.pool), () => saleTime);
      const creating = service.createSaleFromVisit(f.staff, f.visitId, { ...f.input, expectedSourceVersion: sourceVersion });
      const outcome = creating.then((value) => ({ value }), (error: unknown) => ({ error }));
      try {
        await gate.arrived;
        if (command === 'submit') await f.service.submitForApproval(f.staff, f.visitId, { clientActionId: 'source-submit-wins', expectedVersion: sourceVersion, note: 'Visit recorded.' });
        if (command === 'cancel') await f.service.cancel(f.staff, f.visitId, { clientActionId: 'source-cancel-wins', expectedVersion: sourceVersion, cancelReason: 'Visit cancelled.' });
        if (command === 'reassign') {
          // Existing assignment policy permits reassignment only before START.
          // Use a competing repository transaction to isolate ownership arbitration.
          await f.repository.executeTransaction(async (tx) => {
            await tx.getAssigneeForUpdate(f.organizationId, f.otherStaff.id);
            await tx.getJobForUpdate(f.organizationId, f.visitId);
            await tx.updateFieldsWithVersion({ organizationId: f.organizationId, jobCardId: f.visitId,
              expectedVersion: sourceVersion, fields: { assignedTo: f.otherStaff.id } });
          });
        }
        gate.release();
        expect(await outcome).toMatchObject({ error: { code: command === 'reassign' ? 'JOB_CARD_NOT_FOUND' : 'VERSION_CONFLICT' } });
        expect((await f.pool.query("SELECT count(*)::int AS n FROM job_cards WHERE type='SALE'")).rows[0].n).toBe(0);
      } finally { gate.release(); await outcome; }
    });
  });
  it('accepts a fresh rename that commits before snapshot acquisition', async () => {
    await withSaleFixture(async (f) => {
      const gate = gatePoolStatements(f.pool, 'ORDER BY id FOR SHARE');
      const service = new JobCardService(new PostgresJobCardRepository(gate.pool), () => saleTime);
      const creating = service.createSaleFromVisit(f.staff, f.visitId, f.input);
      try {
        await gate.arrived;
        await f.pool.query("UPDATE contacts SET name='Before sale' WHERE id=$1", [f.metContactId]);
        await f.pool.query("UPDATE products SET name='Fresh product',brand='Fresh brand' WHERE id=$1", [f.products[0]]);
        gate.release();
        const sale = await creating;
        expect((await f.pool.query('SELECT sale_contact_name_snapshot FROM job_card_sale_details WHERE job_card_id=$1', [sale.jobCardId])).rows[0].sale_contact_name_snapshot).toBe('Before sale');
        expect((await f.pool.query('SELECT product_name_snapshot,product_brand_snapshot FROM job_card_sale_items WHERE job_card_id=$1 AND product_id=$2', [sale.jobCardId, f.products[0]])).rows[0])
          .toEqual({ product_name_snapshot: 'Fresh product', product_brand_snapshot: 'Fresh brand' });
      } finally { gate.release(); await creating.catch(() => undefined); }
    });
  });
});
