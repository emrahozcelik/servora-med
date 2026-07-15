import { describe, expect, it } from 'vitest';

import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';

const row = {
  id: 'job-1', organization_id: 'org-1', type: 'GENERAL_TASK', status: 'NEW', version: 1,
  title: 'Doktoru ara', description: null, customer_id: 'customer-1', contact_id: null,
  assigned_to: 'staff-1', created_by: 'manager-1', priority: 'normal', due_date: null,
  assignee_id: 'staff-1', assignee_name: 'Emrah Demir',
  customer_id_join: 'customer-1', customer_name: 'Demo Dental Klinik',
  contact_id_join: null, contact_name: null,
};

function repositoryDouble() {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const query = async (text: string, values: unknown[] = []) => {
    calls.push({ text, values });
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
    return { rows: values[0] === 'org-1' && values[1] === 'job-1' ? [row] : [] };
  };
  const client = { query, release() {} };
  const pool = { query, connect: async () => client };
  return { repository: new PostgresJobCardRepository(pool as never), calls };
}

describe('Postgres JobCard detail projection', () => {
  it('maps assignee and nullable Customer/Contact identities in one organization-scoped query', async () => {
    const { repository, calls } = repositoryDouble();

    await expect(repository.findJobCardDetail('org-1', 'job-1')).resolves.toEqual({
      id: 'job-1', organizationId: 'org-1', type: 'GENERAL_TASK', status: 'NEW', version: 1,
      title: 'Doktoru ara', description: null, customerId: 'customer-1', contactId: null,
      assignedTo: 'staff-1', createdBy: 'manager-1', priority: 'normal', dueDate: null,
      assignee: { id: 'staff-1', name: 'Emrah Demir' },
      customer: { id: 'customer-1', name: 'Demo Dental Klinik' },
      contact: null,
    });
    const projection = calls.at(-1)!;
    expect(projection.values).toEqual(['org-1', 'job-1']);
    expect(projection.text).toContain('JOIN users assignee');
    expect(projection.text).toContain('LEFT JOIN customers customer');
    expect(projection.text).toContain('LEFT JOIN contacts contact');
    expect(projection.text).toContain('WHERE j.organization_id = $1 AND j.id = $2');
  });

  it('returns null for a cross-organization public or transaction detail read', async () => {
    const { repository } = repositoryDouble();

    await expect(repository.findJobCardDetail('org-2', 'job-1')).resolves.toBeNull();
    await expect(repository.executeTransaction((transaction) =>
      transaction.getJobDetail('org-2', 'job-1'))).resolves.toBeNull();
  });
});
