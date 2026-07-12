import type { PoolClient } from 'pg';

export type ClearCustomerAssignmentsInput = {
  organizationId: string;
  staffUserId: string;
  actorUserId: string;
};

export interface CustomerAssignmentCleanupPort {
  clearAssignmentsForDeactivatedStaff(
    client: PoolClient,
    input: ClearCustomerAssignmentsInput,
  ): Promise<Array<{ customerId: string; nextVersion: number }>>;
}
