import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

import {
  MAINTENANCE_ROLE_FENCE_SQL,
  verifyBackupMaintenanceRoleFence,
} from '../scripts/backup-maintenance-role-fence.mjs';

const OPERATOR = 'servora_br5_operator';
const vetted = readFileSync(fileURLToPath(new URL('../../server/src/db/migrations/062_backup_health_maintenance.sql', import.meta.url)), 'utf8');
function bodyOf(name) {
  const match = vetted.match(new RegExp('CREATE FUNCTION backup_health_maintenance_' + name
    + '[\\s\\S]*?AS \\$\\$(.*?)\\$\\$;', 's'));
  if (!match) throw Error('Missing pinned function body: ' + name);
  return match[1]
    .replace('INSERT INTO backup_health_maintenance_events', 'INSERT INTO public.backup_health_maintenance_events')
    .replace('UPDATE backup_health_maintenance_state', 'UPDATE public.backup_health_maintenance_state');
}
const bodies = {
  transition: bodyOf('transition'), audit: bodyOf('audit'), history: bodyOf('reject_history_mutation'),
};

function safeRow() {
  return {
    runtimeRole: 'servora_runtime',
    sessionRole: 'servora_runtime',
    databaseOwner: 'servora_db_owner',
    schemaOwner: 'pg_database_owner',
    stateOwner: 'servora_br5_owner',
    eventOwner: 'servora_br5_owner',
    transitionOwner: 'servora_br5_owner',
    auditOwner: 'servora_br5_owner',
    historyOwner: 'servora_br5_owner',
    runtimeSuperuser: false,
    runtimeCreateRole: false,
    runtimeCreateDb: false,
    runtimeBypassRls: false,
    protectedOwnerCanLogin: false,
    protectedOwnerSuperuser: false,
    protectedOwnerCreateRole: false,
    protectedOwnerCreateDb: false,
    protectedOwnerBypassRls: false,
    protectedOwnerReplication: false,
    operatorRole: OPERATOR,
    operatorCanLogin: false,
    operatorSuperuser: false,
    operatorCreateRole: false,
    operatorCreateDb: false,
    operatorBypassRls: false,
    operatorReplication: false,
    transitionSecurityDefiner: true,
    transitionConfig: ['search_path=pg_catalog'],
    transitionLanguage: 'plpgsql',
    transitionBody: bodies.transition,
    auditSecurityDefiner: true,
    auditConfig: ['search_path=pg_catalog'],
    auditLanguage: 'plpgsql',
    auditBody: bodies.audit,
    historySecurityDefiner: true,
    historyConfig: ['search_path=pg_catalog'],
    historyLanguage: 'plpgsql',
    historyBody: bodies.history,
    maintenanceTriggerCount: 3,
    auditTriggerValid: true,
    historyTriggerValid: true,
    stateNoDeleteTriggerValid: true,
    runtimeCanReadState: true,
    runtimeCanUpdateState: false,
    runtimeCanInsertState: false,
    runtimeCanDeleteState: false,
    runtimeCanTruncateState: false,
    runtimeCanInsertEvent: false,
    runtimeCanUpdateEvent: false,
    runtimeCanDeleteEvent: false,
    runtimeCanTruncateEvent: false,
    runtimeCanAuditFunction: false,
    runtimeCanHistoryFunction: false,
    runtimeCanTransition: false,
    runtimeCanCreateSchemaObjects: false,
    runtimeCanCreateDatabaseObjects: false,
    runtimeMemberOfOwner: false,
    runtimeMemberOfDatabaseOwner: false,
    runtimeMemberOfSchemaOwner: false,
    runtimeMemberOfOperator: false,
    operatorCanTransition: true,
    operatorCanUpdateState: false,
    operatorCanTruncateState: false,
    operatorCanInsertEvent: false,
    operatorCanTruncateEvent: false,
    operatorCanAuditFunction: false,
    operatorCanHistoryFunction: false,
    operatorCanCreateSchemaObjects: false,
    operatorCanCreateDatabaseObjects: false,
    operatorMemberOfOwner: false,
    operatorMemberOfDatabaseOwner: false,
    operatorMemberOfSchemaOwner: false,
  };
}

function pool(row = safeRow(), state = [{ paused: true, revision: '0' }]) {
  const queries = [];
  const query = async (sql, parameters = []) => {
    queries.push({ sql, parameters });
    if (queries.length === 1) return { rows: row === null ? [] : [row] };
    if (queries.length === 2) return { rows: state };
    throw new Error('unexpected query');
  };
  return { query, queries };
}

describe('BR5 role fencing read-only preflight', () => {
  it('accepts only explicit, minimal maintenance privilege separation and PAUSED', async () => {
    const db = pool();
    assert.deepEqual(await verifyBackupMaintenanceRoleFence(db, OPERATOR), { status: 'PASS', reasons: [] });
    assert.equal(db.queries.length, 2);
    assert.deepEqual(db.queries[0].parameters, [OPERATOR]);
    for (const q of db.queries) {
      assert.match(q.sql, /^\s*(WITH|SELECT)\b/i);
      assert.doesNotMatch(q.sql, /\b(CREATE|ALTER|DROP|GRANT|REVOKE|INSERT|UPDATE|DELETE|TRUNCATE)\s+(TABLE|ROLE|FUNCTION|ON|INTO|FROM)\b/i);
    }
  });

  it('does not use interpolated operator role names', async () => {
    const d = pool();
    const result = await verifyBackupMaintenanceRoleFence(d, 'x; DROP ROLE postgres;');
    assert.equal(result.status, 'BLOCKED');
    assert.deepEqual(d.queries, []);
    assert.match(MAINTENANCE_ROLE_FENCE_SQL, /op_role\.rolname = \$1::text/);
  });

  const dangerous = [
    ['role mismatch', { sessionRole: 'postgres' }],
    ['owner is runtime', { stateOwner: 'servora_runtime' }],
    ['db owner is runtime', { databaseOwner: 'servora_runtime' }],
    ['schema owner is runtime', { schemaOwner: 'servora_runtime' }],
    ['state and event ownership differ', { eventOwner: 'other' }],
    ['audit function ownership differs', { auditOwner: 'other' }],
    ['history trigger function ownership differs', { historyOwner: 'other' }],
    ['protected owner can login', { protectedOwnerCanLogin: true }],
    ['protected owner is SUPERUSER', { protectedOwnerSuperuser: true }],
    ['protected owner CREATEROLE', { protectedOwnerCreateRole: true }],
    ['protected owner CREATEDB', { protectedOwnerCreateDb: true }],
    ['protected owner bypassrls', { protectedOwnerBypassRls: true }],
    ['protected owner replication', { protectedOwnerReplication: true }],
    ['runtime NOINHERIT member of DB owner', { runtimeMemberOfDatabaseOwner: true }],
    ['runtime NOINHERIT member of schema owner', { runtimeMemberOfSchemaOwner: true }],
    ['operator NOINHERIT member of DB owner', { operatorMemberOfDatabaseOwner: true }],
    ['operator NOINHERIT member of schema owner', { operatorMemberOfSchemaOwner: true }],
    ['runtime TRUNCATE state', { runtimeCanTruncateState: true }],
    ['runtime TRUNCATE events', { runtimeCanTruncateEvent: true }],
    ['operator TRUNCATE state', { operatorCanTruncateState: true }],
    ['operator TRUNCATE events', { operatorCanTruncateEvent: true }],
    ['operator bypassrls', { operatorBypassRls: true }],
    ['operator replication', { operatorReplication: true }],
    ['runtime can run audit', { runtimeCanAuditFunction: true }],
    ['operator can run history', { operatorCanHistoryFunction: true }],
    ['audit is invoker', { auditSecurityDefiner: false }],
    ['history is invoker', { historySecurityDefiner: false }],
    ['audit wrong path', { auditConfig: null }],
    ['history wrong path', { historyConfig: ['search_path=public'] }],
    ['transition extra config', { transitionConfig: ['search_path=pg_catalog','session_replication_role=replica'] }],
    ['transition unqualified body', { transitionBody: bodies.transition.replace('public.backup_health_maintenance_state', 'backup_health_maintenance_state') }],
    ['audit unqualified body', { auditBody: bodies.audit.replace('public.backup_health_maintenance_events', 'backup_health_maintenance_events') }],
    ['hidden GRANT in transition', { transitionBody: bodies.transition.replace('BEGIN\n', "BEGIN\n  EXECUTE 'GRANT INSERT ON public.backup_health_maintenance_events TO servora_runtime';\n") }],
    ['hidden GRANT in audit', { auditBody: bodies.audit.replace('BEGIN\n', "BEGIN\n  EXECUTE 'GRANT INSERT ON public.backup_health_maintenance_events TO servora_runtime';\n") }],
    ['bad trigger count', { maintenanceTriggerCount: 2 }],
    ['missing audit trigger', { auditTriggerValid: false }],
    ['disabled history trigger', { historyTriggerValid: false }],
    ['missing state no-delete trigger', { stateNoDeleteTriggerValid: false }],
    ['runtime superuser', { runtimeSuperuser: true }],
    ['runtime createrole', { runtimeCreateRole: true }],
    ['runtime inherited owner', { runtimeMemberOfOwner: true }],
    ['runtime can CREATE in public', { runtimeCanCreateSchemaObjects: true }],
    ['runtime can CREATE in db', { runtimeCanCreateDatabaseObjects: true }],
    ['runtime can update state', { runtimeCanUpdateState: true }],
    ['runtime can insert events', { runtimeCanInsertEvent: true }],
    ['runtime can invoke transition', { runtimeCanTransition: true }],
    ['runtime can assume operator', { runtimeMemberOfOperator: true }],
    ['runtime cannot select state', { runtimeCanReadState: false }],
    ['function not security definer', { transitionSecurityDefiner: false }],
    ['function has ambient search path', { transitionConfig: null }],
    ['function search path writable', { transitionConfig: ['search_path=public'] }],
    ['operator missing', { operatorRole: null }],
    ['operator is login', { operatorCanLogin: true }],
    ['operator is superuser', { operatorSuperuser: true }],
    ['operator has DML', { operatorCanUpdateState: true }],
    ['operator can insert audit events', { operatorCanInsertEvent: true }],
    ['operator can CREATE in public', { operatorCanCreateSchemaObjects: true }],
    ['operator has no CAS execute', { operatorCanTransition: false }],
    ['operator can assume protected owner', { operatorMemberOfOwner: true }],
  ];
  for (const [name, change] of dangerous) {
    it('BLOCKED for ' + name, async () => {
      const db = pool({ ...safeRow(), ...change });
      const result = await verifyBackupMaintenanceRoleFence(db, OPERATOR);
      assert.equal(result.status, 'BLOCKED');
      assert.ok(result.reasons.length > 0);
      assert.equal(db.queries.length, 1, 'do not query state after failed authority check');
    });
  }
  it('denies an unpaused or invalid singleton', async () => {
    for (const rows of [[], [{ paused: false, revision: '1' }], [{ paused: true, revision: '-1' }],
      [{ paused: true, revision: '0' }, { paused: true, revision: '0' }]]) {
      const result = await verifyBackupMaintenanceRoleFence(pool(safeRow(), rows), OPERATOR);
      assert.deepEqual(result, { status: 'BLOCKED', reasons: ['MAINTENANCE_NOT_PAUSED_OR_INVALID'] });
    }
  });
  it('denies partial or missing metadata', async () => {
    for (const row of [null, {}, { ...safeRow(), stateOwner: null }]) {
      assert.equal((await verifyBackupMaintenanceRoleFence(pool(row), OPERATOR)).status, 'BLOCKED');
    }
  });
  it('denies database failure without leaking error details or caching a permit', async () => {
    let count = 0;
    const db = {
      query: async () => {
        count++;
        if (count === 1) return { rows: [safeRow()] };
        throw new Error('postgres://test-user:secret@host/db');
      },
    };
    const result = await verifyBackupMaintenanceRoleFence(db, OPERATOR);
    assert.deepEqual(result, { status: 'BLOCKED', reasons: ['ROLE_FENCE_QUERY_FAILED'] });
    assert.equal(JSON.stringify(result).includes('secret'), false);
    assert.equal(count, 2);
  });
});
