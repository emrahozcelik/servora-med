import { describe, expect, it } from 'vitest';

import { withSaleFixture, saleFixture } from './support/sale-harness.js';

/**
 * SALE-002 slice S1 acceptance — sale creation from a COMPLETED visit.
 * Owning contract: docs/features/visit-to-sale/sale-002-contract.md §6.2, §9.3.
 *
 * R3 widens `assertSaleSourceEligible` to IN_PROGRESS **or** COMPLETED; every
 * terminal non-completed source stays ineligible (covered by the existing
 * sale-origin policy suite). The one-active-sale-per-visit slot rule is
 * unchanged (R16), and a terminal source releases the sale to its own
 * lifecycle (§4.2).
 */

const completedAt = new Date('2026-10-14T09:00:00.000Z');

type Fixture = Awaited<ReturnType<typeof saleFixture>>;

/** Make the fixture's IN_PROGRESS visit a genuinely completed visit row. */
async function markVisitCompleted(fixture: Fixture): Promise<number> {
  const result = await fixture.pool.query<{ version: number }>(
    `UPDATE job_cards
        SET status = 'COMPLETED',
            started_at = COALESCE(started_at, $2),
            staff_completed_at = $3,
            staff_completed_by = $4,
            manager_approved_at = $3,
            manager_approved_by = $4
      WHERE id = $1
      RETURNING version`,
    [fixture.visitId, new Date('2026-10-14T08:30:00.000Z'), completedAt, fixture.manager.id],
  );
  return result.rows[0]!.version;
}

describe.skipIf(!process.env.TEST_DATABASE_URL)('SALE-002 S1 completed-visit sale creation', () => {
  it('records a sale from a completed visit with source snapshots and the source fact', async () => {
    await withSaleFixture(async (f) => {
      const sourceVersion = await markVisitCompleted(f);

      const sale = await f.service.createSaleFromVisit(f.staff, f.visitId, {
        ...f.input,
        expectedSourceVersion: sourceVersion,
      });
      expect(sale.version).toBe(1);

      const root = (await f.pool.query(
        `SELECT type, status, customer_id, assigned_to, created_by, sale_source_visit_id,
                source_job_card_id, contact_id, scheduled_at, due_date
           FROM job_cards WHERE id = $1`,
        [sale.jobCardId],
      )).rows[0];
      expect(root).toEqual({
        type: 'SALE',
        status: 'ACCEPTED',
        customer_id: f.customerId,
        assigned_to: f.staff.id,
        created_by: f.staff.id,
        sale_source_visit_id: f.visitId,
        source_job_card_id: null,
        contact_id: null,
        scheduled_at: null,
        due_date: null,
      });

      const details = (await f.pool.query(
        `SELECT source_visit_version, source_visit_title_snapshot,
                source_customer_name_snapshot, source_planned_contact_id,
                source_planned_contact_name_snapshot, source_met_contact_id,
                source_met_contact_name_snapshot, sale_contact_id,
                sale_contact_name_snapshot
           FROM job_card_sale_details WHERE job_card_id = $1`,
        [sale.jobCardId],
      )).rows[0];
      expect(details).toEqual({
        source_visit_version: sourceVersion,
        source_visit_title_snapshot: 'Clinic visit',
        source_customer_name_snapshot: 'Dental Klinik',
        source_planned_contact_id: f.plannedContactId,
        source_planned_contact_name_snapshot: 'Planned doctor',
        source_met_contact_id: f.metContactId,
        source_met_contact_name_snapshot: 'Actual doctor',
        sale_contact_id: f.metContactId,
        sale_contact_name_snapshot: 'Actual doctor',
      });

      expect((await f.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM job_card_activity_logs
          WHERE job_card_id = $1 AND event_type = 'SALE_FROM_VISIT_CREATED'`,
        [f.visitId],
      )).rows[0]!.n).toBe(1);

      // Creating the sale never touches the completed visit row.
      expect((await f.pool.query(
        `SELECT status, version, manager_approved_at, manager_approved_by
           FROM job_cards WHERE id = $1`,
        [f.visitId],
      )).rows[0]).toMatchObject({
        status: 'COMPLETED',
        version: sourceVersion,
        manager_approved_by: f.manager.id,
      });

      // One active sale per visit is unchanged: the active slot stays taken.
      await expect(f.service.createSaleFromVisit(f.staff, f.visitId, {
        ...f.input,
        clientActionId: 's1-completed-second-active',
        expectedSourceVersion: sourceVersion,
      })).rejects.toMatchObject({ code: 'SALE_FROM_VISIT_ACTIVE_EXISTS', statusCode: 409 });

      // A terminal sale releases the slot; a later agreement can be recorded.
      await f.service.cancel(f.manager, sale.jobCardId, {
        clientActionId: 's1-completed-cancel',
        expectedVersion: 1,
        cancelReason: 'Sözleşme kapatıldı',
      });
      const replacement = await f.service.createSaleFromVisit(f.staff, f.visitId, {
        ...f.input,
        clientActionId: 's1-completed-replacement',
        expectedSourceVersion: sourceVersion,
      });
      expect(replacement.jobCardId).not.toBe(sale.jobCardId);
      expect((await f.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM job_cards WHERE type = 'SALE'`,
      )).rows[0]!.n).toBe(2);
    });
  });

  it('keeps management creation NEW for the visit staff and leaves the independent lifecycle intact', async () => {
    await withSaleFixture(async (f) => {
      const sourceVersion = await markVisitCompleted(f);

      const sale = await f.service.createSaleFromVisit(f.manager, f.visitId, {
        ...f.input,
        clientActionId: 's1-completed-management-create',
        expectedSourceVersion: sourceVersion,
      });
      expect((await f.pool.query(
        'SELECT status, assigned_to, created_by, accepted_at, accepted_by FROM job_cards WHERE id = $1',
        [sale.jobCardId],
      )).rows[0]).toEqual({
        status: 'NEW',
        assigned_to: f.staff.id,
        created_by: f.manager.id,
        accepted_at: null,
        accepted_by: null,
      });

      // A terminal source never coordinates: the sale runs its own lifecycle.
      await f.service.acceptAssignment(f.staff, sale.jobCardId, {
        clientActionId: 's1-completed-accept',
        expectedVersion: 1,
      });
      const started = await f.service.start(f.staff, sale.jobCardId, {
        clientActionId: 's1-completed-start',
        expectedVersion: 2,
      });
      const submitted = await f.service.submitForApproval(f.staff, sale.jobCardId, {
        clientActionId: 's1-completed-submit',
        expectedVersion: started.version,
        note: 'Tamamlanmış ziyaret sonrası kayıt',
      });
      expect(submitted.status).toBe('WAITING_APPROVAL');
      const approved = await f.service.approve(f.manager, sale.jobCardId, {
        clientActionId: 's1-completed-approve',
        expectedVersion: submitted.version,
      });
      expect(approved.status).toBe('COMPLETED');

      expect((await f.pool.query('SELECT status, version FROM job_cards WHERE id = $1', [f.visitId])).rows[0])
        .toEqual({ status: 'COMPLETED', version: sourceVersion });
    });
  });
});
