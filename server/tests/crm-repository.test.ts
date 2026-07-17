import { describe, expect, it } from 'vitest';

import { PostgresCrmRepository } from '../src/modules/crm/repository.js';
import { normalizeTaxNumber } from '../src/modules/crm/types.js';

type QueryCall = { text: string; values: unknown[] };

function recordingPool(resolveRows: (text: string) => unknown[] = () => []) {
  const calls: QueryCall[] = [];
  const query = async (text: string, values: unknown[] = []) => {
    calls.push({ text, values });
    const rows = resolveRows(text);
    return { rows, rowCount: rows.length };
  };
  const client = { query, release: () => undefined };
  return { calls, pool: { query, connect: async () => client } as never };
}

describe('CRM persistence', () => {
  it('normalizes tax numbers with one canonical algorithm', () => {
    expect(normalizeTaxNumber(' ab 12.3-4/ ')).toBe('AB1234');
    expect(normalizeTaxNumber(' . - / ')).toBeNull();
    expect(normalizeTaxNumber(null)).toBeNull();
  });

  it('commits successful work and rolls back failed work', async () => {
    const success = recordingPool();
    const repository = new PostgresCrmRepository(success.pool);
    await expect(repository.execute(async () => 'done')).resolves.toBe('done');
    expect(success.calls.map((call) => call.text)).toEqual(['BEGIN', 'COMMIT']);

    const failure = recordingPool();
    const failingRepository = new PostgresCrmRepository(failure.pool);
    await expect(failingRepository.execute(async () => {
      throw new Error('stop');
    })).rejects.toThrow('stop');
    expect(failure.calls.map((call) => call.text)).toEqual(['BEGIN', 'ROLLBACK']);
  });

  it('hides inactive Customers by default and searches Contact fields through EXISTS', async () => {
    const recorded = recordingPool((text) => text.includes('COUNT(*)') ? [{ total: '0' }] : []);
    const repository = new PostgresCrmRepository(recorded.pool);

    await repository.listCustomers('org-1', {
      q: 'ayşe', status: null, customerType: null, assignedStaffUserId: null,
      city: null, unassigned: false, limit: 50, offset: 0,
    });

    const sql = recorded.calls.map((call) => call.text).join('\n');
    expect(sql).toMatch(/c\.status IN \('prospect', 'active'\)/);
    expect(sql).toMatch(/EXISTS \([\s\S]*FROM contacts contact[\s\S]*contact\.organization_id = c\.organization_id[\s\S]*contact\.customer_id = c\.id/);
    expect(sql).toMatch(/contact\.(name|title|phone|email)/);
    expect(recorded.calls.some((call) => call.values.includes('%ayşe%'))).toBe(true);
  });

  it('does not turn a punctuation-only tax search into a wildcard match', async () => {
    const recorded = recordingPool((text) => text.includes('COUNT(*)') ? [{ total: '0' }] : []);
    const repository = new PostgresCrmRepository(recorded.pool);

    await repository.listCustomers('org-1', {
      q: '. - /', status: null, customerType: null, assignedStaffUserId: null,
      city: null, unassigned: false, limit: 50, offset: 0,
    });

    expect(recorded.calls.flatMap((call) => call.values)).not.toContain('%%');
  });

  it('returns deterministic bounded JobCard summaries with Staff scoping', async () => {
    const recorded = recordingPool((text) => {
      if (text.includes('FROM customers c') && !text.includes('COUNT')) return [{
        id: 'customer-1', organization_id: 'org-1', name: 'Klinik', customer_type: 'clinic',
        tax_number: null, phone: null, email: null, city: null, district: null, address: null,
        assigned_staff_user_id: null, status: 'active', version: 1,
        created_at: new Date('2026-07-12T00:00:00Z'), updated_at: new Date('2026-07-12T00:00:00Z'),
      }];
      return [];
    });
    const repository = new PostgresCrmRepository(recorded.pool);

    await repository.getCustomerDetail(
      { id: 'staff-1', organizationId: 'org-1', role: 'STAFF' },
      'customer-1',
    );

    const summaryCalls = recorded.calls.filter((call) => call.text.includes('FROM job_cards'));
    expect(summaryCalls).toHaveLength(2);
    expect(summaryCalls.every((call) => /assigned_to = \$\d+/.test(call.text))).toBe(true);
    expect(summaryCalls.every((call) => /LIMIT 5/.test(call.text))).toBe(true);
    expect(summaryCalls[0]!.text).toMatch(/status IN \('NEW', 'ACCEPTED', 'IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED'\)/);
    expect(summaryCalls[1]!.text).toMatch(/status = 'COMPLETED'/);
    expect(summaryCalls[1]!.text).toMatch(/manager_approved_at DESC NULLS LAST, id DESC/);
  });

  it('uses version predicates and writes only caller-supplied audit values', async () => {
    const recorded = recordingPool();
    const repository = new PostgresCrmRepository(recorded.pool);

    await repository.execute(async (tx) => {
      await tx.updateCustomer({
        organizationId: 'org-1', customerId: 'customer-1', expectedVersion: 3,
        name: 'Klinik', customerType: 'clinic', taxNumber: null, phone: null,
        email: null, city: null, district: null, address: null, assignedStaffUserId: null,
      });
      await tx.appendAudit({
        organizationId: 'org-1', actorUserId: 'manager-1', subjectType: 'CUSTOMER',
        subjectId: 'customer-1', eventType: 'CUSTOMER_FIELDS_UPDATED',
        oldValue: null, newValue: null, metadata: { changedFields: ['name'] },
      });
    });

    const update = recorded.calls.find((call) => call.text.includes('UPDATE customers'))!;
    expect(update.text).toMatch(/version = version \+ 1/);
    expect(update.text).toMatch(/WHERE organization_id = \$1 AND id = \$2 AND version = \$3/);
    const audit = recorded.calls.find((call) => call.text.includes('INSERT INTO audit_events'))!;
    expect(JSON.stringify(audit.values)).not.toMatch(/phone|email|address|password|token|cookie|session/i);
    expect(audit.values.at(-1)).toEqual({ changedFields: ['name'] });
  });

  it('caps Customer and Contact pagination at 200 records', async () => {
    const recorded = recordingPool((text) => text.includes('COUNT(*)') ? [{ total: '0' }] : []);
    const repository = new PostgresCrmRepository(recorded.pool);

    const customers = await repository.listCustomers('org-1', {
      q: null, status: null, customerType: null, assignedStaffUserId: null,
      city: null, unassigned: false, limit: 999, offset: 0,
    });
    const contacts = await repository.listContacts('org-1', 'customer-1', {
      q: null, status: 'active', limit: 999, offset: 0,
    });

    expect(customers.limit).toBe(200);
    expect(contacts.limit).toBe(200);
    const pageQueries = recorded.calls.filter((call) => /\bLIMIT \$\d+/.test(call.text));
    expect(pageQueries).toHaveLength(2);
    expect(pageQueries.every((call) => call.values.includes(200))).toBe(true);
    expect(pageQueries.every((call) => !call.values.includes(999))).toBe(true);
  });
});
