import type { PoolClient } from 'pg';

/**
 * Restore safety (contract §9): before traffic is opened after a database
 * restore, revoke every operator session and deactivate every operator
 * account, recording `OPERATOR_ACCESS_RESET_BY_RESTORE` (actor SYSTEM) per
 * affected account. The host operator re-grants needed accounts.
 *
 * One SQL statement, so it is atomic on its own and also composes inside a
 * caller-owned transaction. Module state and audit history are left as the
 * backup returned them.
 */
export async function resetOperatorAccessAfterRestore(
  client: PoolClient,
  now: Date,
): Promise<{ revokedSessions: number; deactivatedAccounts: number }> {
  const result = await client.query<{ revoked_sessions: number; deactivated_accounts: number }>(
    `WITH revoked AS (
       UPDATE operator_sessions SET revoked_at = $1
        WHERE revoked_at IS NULL
        RETURNING operator_id
     ),
     revoked_by_account AS (
       SELECT operator_id, COUNT(*)::int AS revoked_sessions
         FROM revoked GROUP BY operator_id
     ),
     deactivated AS (
       UPDATE operator_accounts
          SET is_active = FALSE, version = version + 1, updated_at = $1
        WHERE is_active
        RETURNING id
     ),
     affected AS (
       SELECT id AS operator_id FROM deactivated
       UNION
       SELECT operator_id FROM revoked_by_account
     ),
     audit AS (
       INSERT INTO operator_audit_events
         (actor_kind, event_type, target_operator_id, new_value, occurred_at)
       SELECT 'SYSTEM', 'OPERATOR_ACCESS_RESET_BY_RESTORE', a.operator_id,
              jsonb_build_object('revokedSessions', COALESCE(r.revoked_sessions, 0)), $1
         FROM affected a
         LEFT JOIN revoked_by_account r ON r.operator_id = a.operator_id
       RETURNING 1
     )
     SELECT (SELECT COUNT(*) FROM revoked)::int AS revoked_sessions,
            (SELECT COUNT(*) FROM deactivated)::int AS deactivated_accounts`,
    [now],
  );
  const row = result.rows[0]!;
  return {
    revokedSessions: row.revoked_sessions,
    deactivatedAccounts: row.deactivated_accounts,
  };
}

/** True when the schema is at/after migration 074 (pre-074 backups have no operator tables). */
export async function operatorTablesExist(client: Pick<PoolClient, 'query'>): Promise<boolean> {
  const result = await client.query<{ present: string | null }>(
    "SELECT to_regclass('operator_accounts')::text AS present",
  );
  return result.rows[0]?.present != null;
}
