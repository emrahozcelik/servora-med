import { ACTIVE_JOB_CARD_STATUSES, type JobCardStatus } from '../job-cards/types.js';
import type { CrmActor, Customer } from './types.js';

export type CustomerEnrichmentJob = {
  id: string; organizationId: string; customerId: string; assignedTo: string; status: JobCardStatus;
};

/** CRM visibility and job authorship/history are deliberately not mutation grants. */
export function canEnrichCustomer(actor: CrmActor, customer: Customer, job: CustomerEnrichmentJob | null) {
  return actor.role === 'STAFF' && actor.organizationId === customer.organizationId
    && customer.status !== 'inactive'
    && (customer.assignedStaffUserId === actor.id || job !== null
      && job.organizationId === actor.organizationId && job.customerId === customer.id
      && job.assignedTo === actor.id && (ACTIVE_JOB_CARD_STATUSES as readonly string[]).includes(job.status));
}
