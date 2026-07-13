import type { PoolClient } from 'pg';

import type {
  ClearCustomerAssignmentsInput,
  CustomerAssignmentCleanupPort,
} from '../people/customer-assignment-port.js';

export class PostgresCustomerAssignmentCleanup implements CustomerAssignmentCleanupPort {
  async clearAssignmentsForDeactivatedStaff(client: PoolClient, input: ClearCustomerAssignmentsInput) {
    const locked = await client.query<{ id: string; version: number }>(
      `SELECT id, version FROM customers
       WHERE organization_id=$1 AND assigned_staff_user_id=$2
       ORDER BY id FOR UPDATE`, [input.organizationId, input.staffUserId],
    );
    const results: Array<{ customerId: string; nextVersion: number }> = [];
    for (const customer of locked.rows) {
      const updated = await client.query<{ version: number }>(
        `UPDATE customers SET assigned_staff_user_id=NULL, version=version+1, updated_at=NOW()
         WHERE organization_id=$1 AND id=$2 AND version=$3 RETURNING version`,
        [input.organizationId, customer.id, customer.version],
      );
      const nextVersion = updated.rows[0]!.version;
      await client.query(
        `INSERT INTO audit_events
          (organization_id, actor_user_id, subject_type, subject_id, event_type, old_value, new_value, metadata)
         VALUES ($1,$2,'CUSTOMER',$3,'CUSTOMER_ASSIGNEE_CHANGED',$4,$5,$6)`,
        [input.organizationId, input.actorUserId, customer.id,
          { assignedStaffUserId: input.staffUserId }, { assignedStaffUserId: null },
          { reason: 'STAFF_DEACTIVATED' }],
      );
      results.push({ customerId: customer.id, nextVersion });
    }
    return results;
  }
}
