import { describe, expect, it, vi } from 'vitest';

import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCardBoardQuery, JobCardListQuery } from '../src/modules/job-cards/types.js';

type QueryCall = { sql: string; values: unknown[] };

const filters = {
  q: 'Klinik',
  type: 'PRODUCT_DELIVERY' as const,
  assignedTo: null,
  customerId: '22222222-2222-4222-8222-222222222222',
  priority: 'high' as const,
  dueBefore: '2026-07-31',
  dueAfter: '2026-07-01',
};
const boardQuery: JobCardBoardQuery = { ...filters, limit: 1 };
const listQuery: JobCardListQuery = { ...filters, status: 'active', limit: 100, offset: 0 };

const createdAt = new Date('2026-07-13T08:00:00.000Z');
const updatedAt = new Date('2026-07-13T09:00:00.000Z');

function itemRow(id: string, status: 'NEW' | 'ACCEPTED', updated = updatedAt) {
  return {
    id,
    type: 'PRODUCT_DELIVERY',
    status,
    version: 2,
    title: `${status} Klinik teslimi`,
    priority: 'high',
    due_date: '2026-07-20',
    created_at: createdAt,
    updated_at: updated,
    staff_completed_at: null,
    customer_id: 'customer-1',
    customer_name: 'ABC Klinik',
    contact_id: 'contact-1',
    contact_name: 'Dr. Deniz',
    assignee_id: 'staff-1',
    assignee_name: 'Ayşe Personel',
    delivery_item_count: 2,
  };
}

function poolDouble() {
  const calls: QueryCall[] = [];
  const rows = [itemRow('job-new', 'NEW'), itemRow('job-accepted', 'ACCEPTED')];
  return {
    calls,
    pool: {
      async query(sql: string, values: unknown[] = []) {
        calls.push({ sql, values });
        if (/AS total/.test(sql)) return { rows: [{ total: rows.length }] };
        if (/GROUP BY j\.status/.test(sql)) {
          return {
            rows: [
              { status: 'NEW', count: 3 },
              { status: 'ACCEPTED', count: 2 },
              { status: 'COMPLETED', count: 4 },
              { status: 'CANCELLED', count: 5 },
            ],
          };
        }
        return { rows };
      },
    },
  };
}

describe('PostgresJobCardRepository board projection', () => {
  it('maps a General Task board item with zero delivery items', async () => {
    const { pool } = poolDouble();
    const repository = new PostgresJobCardRepository({
      ...pool,
      async query(sql: string, values: unknown[] = []) {
        if (/GROUP BY j\.status/.test(sql)) return { rows: [{ status: 'NEW', count: 1 }] };
        return { rows: [{ ...itemRow('job-general', 'NEW'), type: 'GENERAL_TASK', delivery_item_count: 0 }] };
      },
    } as never);

    const board = await repository.listBoard(
      { organizationId: 'org-1', assignedTo: null },
      { ...boardQuery, type: 'GENERAL_TASK' },
    );

    expect(board.columns.NEW.items[0]).toMatchObject({
      id: 'job-general', type: 'GENERAL_TASK', deliveryItemCount: 0,
    });
  });

  it('maps a Sales Meeting board item without loading meeting details', async () => {
    const { pool } = poolDouble();
    const query = vi.fn(async (sql: string) => {
      if (/GROUP BY j\.status/.test(sql)) return { rows: [{ status: 'ACCEPTED', count: 1 }] };
      return {
        rows: [{
          ...itemRow('job-meeting', 'ACCEPTED'),
          type: 'SALES_MEETING',
          delivery_item_count: 0,
        }],
      };
    });
    const repository = new PostgresJobCardRepository({ ...pool, query } as never);

    const board = await repository.listBoard(
      { organizationId: 'org-1', assignedTo: null },
      { ...boardQuery, type: 'SALES_MEETING' },
    );

    expect(board.columns.ACCEPTED.items[0]).toMatchObject({
      id: 'job-meeting', type: 'SALES_MEETING', deliveryItemCount: 0,
    });
    expect(query.mock.calls.every(([sql]) => !sql.includes('job_card_meeting_details'))).toBe(true);
  });

  it('reuses canonical item projection and returns pre-limit active and closed counts', async () => {
    const { pool, calls } = poolDouble();
    const repository = new PostgresJobCardRepository(pool as never);
    const scope = { organizationId: 'org-1', assignedTo: 'staff-1' };

    const list = await repository.listJobCards(scope, listQuery);
    const board = await repository.listBoard(scope, boardQuery);

    const boardItems = Object.values(board.columns).flatMap((column) => column.items);
    expect(boardItems).toEqual(list.items);
    expect(board).toEqual({
      columns: {
        NEW: { items: [list.items[0]], count: 3 },
        ACCEPTED: { items: [list.items[1]], count: 2 },
        IN_PROGRESS: { items: [], count: 0 },
        WAITING_APPROVAL: { items: [], count: 0 },
        REVISION_REQUESTED: { items: [], count: 0 },
      },
      closedCounts: { COMPLETED: 4, CANCELLED: 5 },
    });

    const boardCalls = calls.slice(2);
    expect(boardCalls).toHaveLength(2);
    for (const call of boardCalls) {
      expect(call.sql).toContain('j.organization_id = $1');
      expect(call.sql).toContain('j.assigned_to = $2');
      expect(call.sql).toContain('j.type = $3');
      expect(call.sql).toContain('j.customer_id = $4');
      expect(call.sql).toContain('j.priority = $5');
      expect(call.sql).toContain('j.due_date >= $6::date');
      expect(call.sql).toContain('j.due_date <= $7::date');
    }
    expect(boardCalls[0]!.sql).toContain('j.title ILIKE $8');
    expect(boardCalls[1]!.sql).toContain('j.status = ANY($8::varchar[])');
    expect(boardCalls[1]!.sql).toContain('j.title ILIKE $9');
    expect(boardCalls[0]!.values).toEqual([
      'org-1', 'staff-1', 'PRODUCT_DELIVERY', filters.customerId, 'high',
      '2026-07-01', '2026-07-31', '%Klinik%',
    ]);
    expect(boardCalls[1]!.values).toEqual([
      'org-1', 'staff-1', 'PRODUCT_DELIVERY', filters.customerId, 'high',
      '2026-07-01', '2026-07-31',
      ['NEW', 'ACCEPTED', 'IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED'],
      '%Klinik%',
      1,
    ]);
  });

  it('ranks and caps each active column without loading closed items or summing quantities', async () => {
    const { pool, calls } = poolDouble();
    await new PostgresJobCardRepository(pool as never).listBoard(
      { organizationId: 'org-1', assignedTo: null },
      { ...boardQuery, q: null, type: null, customerId: null, priority: null,
        dueBefore: null, dueAfter: null },
    );

    const itemSql = calls[1]!.sql;
    expect(itemSql).toContain(
      'ROW_NUMBER() OVER (PARTITION BY j.status ORDER BY j.updated_at DESC, j.id DESC)',
    );
    expect(itemSql).toContain('row_number <= $3');
    expect(itemSql).toContain('ORDER BY status, updated_at DESC, id DESC');
    expect(itemSql).toContain('j.status = ANY($2::varchar[])');
    expect(itemSql).not.toContain('COMPLETED');
    expect(itemSql).not.toContain('CANCELLED');
    expect(itemSql).not.toContain('SUM(');
  });
});

describe('JobCardService board scope', () => {
  it('short-circuits a conflicting Staff filter and preserves server-owned scope', async () => {
    const listBoard = vi.fn().mockResolvedValue({
      columns: {
        NEW: { items: [], count: 0 }, ACCEPTED: { items: [], count: 0 },
        IN_PROGRESS: { items: [], count: 0 }, WAITING_APPROVAL: { items: [], count: 0 },
        REVISION_REQUESTED: { items: [], count: 0 },
      },
      closedCounts: { COMPLETED: 0, CANCELLED: 0 },
    });
    const service = new JobCardService({ listBoard } as never);
    const staff = { id: 'staff-1', organizationId: 'org-1', role: 'STAFF' as const };

    await expect(service.board(staff, { ...boardQuery, assignedTo: 'staff-2' })).resolves.toEqual({
      columns: {
        NEW: { items: [], count: 0 }, ACCEPTED: { items: [], count: 0 },
        IN_PROGRESS: { items: [], count: 0 }, WAITING_APPROVAL: { items: [], count: 0 },
        REVISION_REQUESTED: { items: [], count: 0 },
      },
      closedCounts: { COMPLETED: 0, CANCELLED: 0 },
    });
    expect(listBoard).not.toHaveBeenCalled();

    await service.board(staff, { ...boardQuery, assignedTo: null });
    expect(listBoard).toHaveBeenCalledWith(
      { organizationId: 'org-1', assignedTo: 'staff-1' },
      expect.objectContaining({ limit: 1 }),
    );
  });

  it('adds allowed commands to list and board items from the authenticated actor', async () => {
    const time = new Date('2026-07-13T12:00:00.000Z');
    const manager = { id: 'manager-1', organizationId: 'org-1', role: 'MANAGER' as const };
    const waitingItem = {
      id: 'job-waiting',
      type: 'PRODUCT_DELIVERY' as const,
      status: 'WAITING_APPROVAL' as const,
      version: 3,
      title: 'Onay bekleyen teslim',
      priority: 'high' as const,
      dueDate: '2026-07-20',
      createdAt: time.toISOString(),
      updatedAt: time.toISOString(),
      staffCompletedAt: time.toISOString(),
      customer: { id: 'customer-1', name: 'ABC Klinik' },
      contact: null,
      assignee: { id: 'staff-1', name: 'Ayşe Personel' },
      deliveryItemCount: 1,
    };
    const listJobCards = vi.fn().mockResolvedValue({
      items: [waitingItem], total: 1, limit: 25, offset: 0,
    });
    const listBoard = vi.fn().mockResolvedValue({
      columns: {
        NEW: { items: [], count: 0 },
        ACCEPTED: { items: [], count: 0 },
        IN_PROGRESS: { items: [], count: 0 },
        WAITING_APPROVAL: { items: [waitingItem], count: 1 },
        REVISION_REQUESTED: { items: [], count: 0 },
      },
      closedCounts: { COMPLETED: 0, CANCELLED: 0 },
    });
    const service = new JobCardService({ listJobCards, listBoard } as never, () => time);
    const list = await service.list(manager, listQuery);
    const board = await service.board(manager, boardQuery);
    expect(list.items[0]?.allowedCommands).toEqual([
      'APPROVE', 'REQUEST_REVISION', 'WITHDRAW_FROM_APPROVAL', 'CANCEL',
    ]);
    expect(board.columns.WAITING_APPROVAL.items[0]?.allowedCommands).toEqual([
      'APPROVE', 'REQUEST_REVISION', 'WITHDRAW_FROM_APPROVAL', 'CANCEL',
    ]);
  });
});
