import { describe, expect, it } from 'vitest';
import { saleTime, withSaleFixture } from './support/sale-harness.js';
import { PostgresOverviewRepository } from '../src/modules/overview/repository.js';
import { PostgresReportsRepository } from '../src/modules/reports/repository.js';
import type { SafeUser } from '../src/modules/auth/types.js';

const range = {
  from: '2026-10-14',
  // Approvals and notes stamp the database clock rather than the frozen
  // fixture time, so the window must reach the real current day.
  to: new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date()),
};

function safeUser(f: {
  staff: { id: string; organizationId: string };
  organizationId: string;
}, role: 'STAFF' | 'MANAGER'): SafeUser {
  return {
    id: f.staff.id, organizationId: f.organizationId, name: 'Overview reader',
    email: `overview-${role.toLowerCase()}@test.local`, role,
    mustChangePassword: false, isActive: true, version: 1,
  };
}

describe('Sale overview recent legacy gate', () => {
  it('excludes SALE rows from recent work and notes for legacy readers without displacing accessible rows', async () => {
    await withSaleFixture(async (f) => {
      const task = await f.service.create(f.staff, {
        clientActionId: 'recent-task-create', type: 'GENERAL_TASK', title: 'Accessible task',
        description: null, customerId: null, contactId: null, assignedTo: f.staff.id,
        priority: 'normal', dueDate: null, scheduledAt: null,
      });
      await f.service.start(f.staff, task.id, { clientActionId: 'recent-task-start', expectedVersion: 1 });
      await f.service.addNote(f.staff, task.id, { clientActionId: 'recent-task-note', note: 'Accessible note' });
      await f.service.submitForApproval(f.staff, task.id, {
        clientActionId: 'recent-task-submit', expectedVersion: 2, note: 'Task done',
      });
      await f.service.approve(f.manager, task.id, { clientActionId: 'recent-task-approve', expectedVersion: 3 });
      // Eleven newer completed sales would fill the legacy LIMIT 10 window on their own.
      for (let index = 0; index < 11; index += 1) {
        const sale = await f.service.createSaleFromVisit(f.staff, f.visitId, {
          ...f.input, clientActionId: `recent-sale-${index}`,
        });
        await f.service.addNote(f.staff, sale.jobCardId, {
          clientActionId: `recent-sale-note-${index}`, note: `Sale note ${index}`,
        });
        await f.service.start(f.staff, sale.jobCardId, {
          clientActionId: `recent-sale-start-${index}`, expectedVersion: 1,
        });
        await f.service.submitForApproval(f.staff, sale.jobCardId, {
          clientActionId: `recent-sale-submit-${index}`, expectedVersion: 2, note: 'Ready',
        });
        await f.service.approve(f.manager, sale.jobCardId, {
          clientActionId: `recent-sale-approve-${index}`, expectedVersion: 3,
        });
      }
      const overview = new PostgresOverviewRepository(f.pool, new PostgresReportsRepository(f.pool));
      const legacyStaff = await overview.getStaffOverview(safeUser(f, 'STAFF'),
        { requestedRange: range, includeSaleCapability: false }, saleTime);
      expect(legacyStaff.recentCompletedWork.map((row) => row.id)).toEqual([task.id]);
      expect(legacyStaff.recentNotes.length).toBeGreaterThan(0);
      expect(legacyStaff.recentNotes.every((row) => row.jobCardId === task.id)).toBe(true);
      expect(JSON.stringify(legacyStaff)).not.toContain('Product agreement');
      const currentStaff = await overview.getStaffOverview(safeUser(f, 'STAFF'),
        { requestedRange: range, includeSaleCapability: true }, saleTime);
      expect(currentStaff.recentCompletedWork.length).toBeGreaterThan(1);
      expect(currentStaff.recentNotes.some((row) => row.jobCardId !== task.id)).toBe(true);
      const legacyManagement = await overview.getManagementOverview(safeUser(f, 'MANAGER'),
        { requestedRange: range, includeSaleCapability: false }, saleTime);
      expect(legacyManagement.recentCompletedWork.map((row) => row.id)).toEqual([task.id]);
      expect(legacyManagement.recentNotes.length).toBeGreaterThan(0);
      expect(legacyManagement.recentNotes.every((row) => row.jobCardId === task.id)).toBe(true);
      expect(JSON.stringify(legacyManagement)).not.toContain('Product agreement');
    });
  });
});
