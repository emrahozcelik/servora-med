/**
 * BR5 maintenance: read-only role/privilege preflight.
 * NO GRANT/ALTER ROLE/DDL, no credential output, no production side effects.
 * This guard does not qualify OT3-C/D, migrate the database, or drain HTTP.
 *
 * PostgreSQL metadata is queried as the exact API runtime connection. The
 * operator role is an inert NOLOGIN group whose membership is provisioned by
 * an independently approved DBA workflow. No inferred credentials.
 */
import { createHash } from 'node:crypto';

// SHA-256 of pg_proc.prosrc for independently reviewed, schema-qualified
// disposable-PG17 reference bodies (transition, audit, history). Strict pins:
// any body edit, including a hidden GRANT, must trigger BLOCKED and review.
// NOT a provisioning operation; the original migration 062 remains unchanged.
const APPROVED_BODY_SHA256 = Object.freeze({
  transition: '66adca8d9f8252adb610b757dc7bd3c02e211517ae274ddb75117433d97307c5',
  audit: '85db898cec05afc8957e0b13dcb51187a17dd69a8fb25a0f7e564a62c8530db2',
  history: '8b5621d6bef5764754b7fbf037c55744153dc06e2abe68a62e1108eb64d6303f',
});

function bodyMatchesApproved(actual, expected) {
  return typeof actual === 'string'
    && createHash('sha256').update(actual, 'utf8').digest('hex') === expected;
}

// A writable search_path, or any extra per-function configuration, is denied.
function fixedDefiner(row, prefix) {
  return row[prefix + 'SecurityDefiner'] === true
    && Array.isArray(row[prefix + 'Config'])
    && row[prefix + 'Config'].length === 1
    && row[prefix + 'Config'][0] === 'search_path=pg_catalog'
    && row[prefix + 'Language'] === 'plpgsql';
}

export const MAINTENANCE_ROLE_FENCE_SQL = `
WITH object_ids AS (
  SELECT
    to_regclass('public.backup_health_maintenance_state') AS state_oid,
    to_regclass('public.backup_health_maintenance_events') AS event_oid,
    to_regprocedure('public.backup_health_maintenance_transition(bigint,boolean,text,text,text)') AS transition_oid,
    to_regprocedure('public.backup_health_maintenance_audit()') AS audit_oid,
    to_regprocedure('public.backup_health_maintenance_reject_history_mutation()') AS history_oid
)
SELECT
  current_user AS "runtimeRole",
  session_user AS "sessionRole",
  pg_get_userbyid(d.datdba) AS "databaseOwner",
  pg_get_userbyid(ns.nspowner) AS "schemaOwner",
  pg_get_userbyid(s.relowner) AS "stateOwner",
  pg_get_userbyid(e.relowner) AS "eventOwner",
  pg_get_userbyid(fn.proowner) AS "transitionOwner",
  pg_get_userbyid(audit.proowner) AS "auditOwner",
  pg_get_userbyid(history.proowner) AS "historyOwner",
  runtime.rolsuper AS "runtimeSuperuser",
  runtime.rolcreaterole AS "runtimeCreateRole",
  runtime.rolcreatedb AS "runtimeCreateDb",
  runtime.rolbypassrls AS "runtimeBypassRls",
  owner.rolcanlogin AS "protectedOwnerCanLogin",
  owner.rolsuper AS "protectedOwnerSuperuser",
  owner.rolcreaterole AS "protectedOwnerCreateRole",
  owner.rolcreatedb AS "protectedOwnerCreateDb",
  owner.rolbypassrls AS "protectedOwnerBypassRls",
  owner.rolreplication AS "protectedOwnerReplication",
  op_role.rolname AS "operatorRole",
  op_role.rolcanlogin AS "operatorCanLogin",
  op_role.rolsuper AS "operatorSuperuser",
  op_role.rolcreaterole AS "operatorCreateRole",
  op_role.rolcreatedb AS "operatorCreateDb",
  op_role.rolbypassrls AS "operatorBypassRls",
  op_role.rolreplication AS "operatorReplication",
  fn.prosecdef AS "transitionSecurityDefiner",
  fn.proconfig AS "transitionConfig",
  fn.prosrc AS "transitionBody",
  (SELECT l.lanname FROM pg_language l WHERE l.oid = fn.prolang) AS "transitionLanguage",
  audit.prosecdef AS "auditSecurityDefiner",
  audit.proconfig AS "auditConfig",
  audit.prosrc AS "auditBody",
  (SELECT l.lanname FROM pg_language l WHERE l.oid = audit.prolang) AS "auditLanguage",
  history.prosecdef AS "historySecurityDefiner",
  history.proconfig AS "historyConfig",
  history.prosrc AS "historyBody",
  (SELECT l.lanname FROM pg_language l WHERE l.oid = history.prolang) AS "historyLanguage",
  (SELECT count(*)::int FROM pg_trigger tr
    WHERE tr.tgrelid IN (s.oid, e.oid) AND NOT tr.tgisinternal) AS "maintenanceTriggerCount",
  EXISTS (SELECT 1 FROM pg_trigger tr
    WHERE tr.tgrelid = s.oid AND tr.tgname = 'backup_health_maintenance_audit'
      AND tr.tgfoid = audit.oid AND tr.tgenabled = 'O'
      AND NOT tr.tgisinternal AND tr.tgtype = 17) AS "auditTriggerValid",
  EXISTS (SELECT 1 FROM pg_trigger tr
    WHERE tr.tgrelid = e.oid AND tr.tgname = 'backup_health_maintenance_events_immutable'
      AND tr.tgfoid = history.oid AND tr.tgenabled = 'O'
      AND NOT tr.tgisinternal AND tr.tgtype = 27) AS "historyTriggerValid",
  EXISTS (SELECT 1 FROM pg_trigger tr
    WHERE tr.tgrelid = s.oid AND tr.tgname = 'backup_health_maintenance_state_no_delete'
      AND tr.tgfoid = history.oid AND tr.tgenabled = 'O'
      AND NOT tr.tgisinternal AND tr.tgtype = 11) AS "stateNoDeleteTriggerValid",
  has_table_privilege(runtime.oid, s.oid, 'SELECT') AS "runtimeCanReadState",
  has_table_privilege(runtime.oid, s.oid, 'UPDATE') AS "runtimeCanUpdateState",
  has_table_privilege(runtime.oid, s.oid, 'INSERT') AS "runtimeCanInsertState",
  has_table_privilege(runtime.oid, s.oid, 'DELETE') AS "runtimeCanDeleteState",
  has_table_privilege(runtime.oid, s.oid, 'TRUNCATE') AS "runtimeCanTruncateState",
  has_table_privilege(runtime.oid, e.oid, 'INSERT') AS "runtimeCanInsertEvent",
  has_table_privilege(runtime.oid, e.oid, 'UPDATE') AS "runtimeCanUpdateEvent",
  has_table_privilege(runtime.oid, e.oid, 'DELETE') AS "runtimeCanDeleteEvent",
  has_table_privilege(runtime.oid, e.oid, 'TRUNCATE') AS "runtimeCanTruncateEvent",
  has_function_privilege(runtime.oid, fn.oid, 'EXECUTE') AS "runtimeCanTransition",
  has_function_privilege(runtime.oid, audit.oid, 'EXECUTE') AS "runtimeCanAuditFunction",
  has_function_privilege(runtime.oid, history.oid, 'EXECUTE') AS "runtimeCanHistoryFunction",
  has_schema_privilege(runtime.oid, ns.oid, 'CREATE') AS "runtimeCanCreateSchemaObjects",
  has_database_privilege(runtime.oid, d.oid, 'CREATE') AS "runtimeCanCreateDatabaseObjects",
  pg_has_role(runtime.oid, owner.oid, 'MEMBER') AS "runtimeMemberOfOwner",
  pg_has_role(runtime.oid, d.datdba, 'MEMBER') AS "runtimeMemberOfDatabaseOwner",
  pg_has_role(runtime.oid, ns.nspowner, 'MEMBER') AS "runtimeMemberOfSchemaOwner",
  pg_has_role(runtime.oid, op_role.oid, 'MEMBER') AS "runtimeMemberOfOperator",
  has_function_privilege(op_role.oid, fn.oid, 'EXECUTE') AS "operatorCanTransition",
  has_table_privilege(op_role.oid, s.oid, 'UPDATE') AS "operatorCanUpdateState",
  has_table_privilege(op_role.oid, s.oid, 'TRUNCATE') AS "operatorCanTruncateState",
  has_table_privilege(op_role.oid, e.oid, 'INSERT') AS "operatorCanInsertEvent",
  has_table_privilege(op_role.oid, e.oid, 'TRUNCATE') AS "operatorCanTruncateEvent",
  has_function_privilege(op_role.oid, audit.oid, 'EXECUTE') AS "operatorCanAuditFunction",
  has_function_privilege(op_role.oid, history.oid, 'EXECUTE') AS "operatorCanHistoryFunction",
  has_schema_privilege(op_role.oid, ns.oid, 'CREATE') AS "operatorCanCreateSchemaObjects",
  has_database_privilege(op_role.oid, d.oid, 'CREATE') AS "operatorCanCreateDatabaseObjects",
  pg_has_role(op_role.oid, owner.oid, 'MEMBER') AS "operatorMemberOfOwner",
  pg_has_role(op_role.oid, d.datdba, 'MEMBER') AS "operatorMemberOfDatabaseOwner",
  pg_has_role(op_role.oid, ns.nspowner, 'MEMBER') AS "operatorMemberOfSchemaOwner"
FROM object_ids ids
JOIN pg_database d ON d.datname = current_database()
JOIN pg_namespace ns ON ns.nspname = 'public'
LEFT JOIN pg_class s ON s.oid = ids.state_oid
LEFT JOIN pg_class e ON e.oid = ids.event_oid
LEFT JOIN pg_proc fn ON fn.oid = ids.transition_oid
LEFT JOIN pg_proc audit ON audit.oid = ids.audit_oid
LEFT JOIN pg_proc history ON history.oid = ids.history_oid
LEFT JOIN pg_roles runtime ON runtime.rolname = current_user
LEFT JOIN pg_roles owner ON owner.oid = s.relowner
LEFT JOIN pg_roles op_role ON op_role.rolname = $1::text
`;

const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

function collectRoleFenceFailures(row, expectedOperatorRole) {
  const failures = [];
  const fail = (condition, code) => { if (!condition) failures.push(code); };
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    return ['ROLE_METADATA_MISSING'];
  }
  const { runtimeRole, sessionRole, databaseOwner, schemaOwner, stateOwner,
    eventOwner, transitionOwner, auditOwner, historyOwner, operatorRole } = row;
  fail(typeof runtimeRole === 'string' && runtimeRole !== '' && runtimeRole === sessionRole, 'RUNTIME_ROLE_IDENTITY');
  fail(typeof stateOwner === 'string' && stateOwner !== '' && stateOwner !== runtimeRole
    && stateOwner !== databaseOwner && stateOwner !== schemaOwner, 'PROTECTED_OWNER_NOT_SEPARATE');
  fail(eventOwner === stateOwner && transitionOwner === stateOwner
    && auditOwner === stateOwner && historyOwner === stateOwner, 'PROTECTED_OBJECT_OWNERS_MISMATCH');
  fail(row.protectedOwnerCanLogin === false, 'PROTECTED_OWNER_MUST_BE_NOLOGIN');
  fail([row.protectedOwnerSuperuser, row.protectedOwnerCreateRole,
    row.protectedOwnerCreateDb, row.protectedOwnerBypassRls,
    row.protectedOwnerReplication].every(v => v === false), 'PROTECTED_OWNER_UNSAFE_ATTRIBUTES');
  // MEMBER (not USAGE) catches indirect/NOINHERIT membership, which still
  // allows SET ROLE db/schema owner and destructive DDL.
  fail(row.runtimeMemberOfDatabaseOwner === false, 'RUNTIME_MEMBER_OF_DATABASE_OWNER');
  fail(row.runtimeMemberOfSchemaOwner === false, 'RUNTIME_MEMBER_OF_SCHEMA_OWNER');
  fail(row.operatorMemberOfDatabaseOwner === false, 'OPERATOR_MEMBER_OF_DATABASE_OWNER');
  fail(row.operatorMemberOfSchemaOwner === false, 'OPERATOR_MEMBER_OF_SCHEMA_OWNER');
  fail(runtimeRole !== databaseOwner && runtimeRole !== schemaOwner
    && row.runtimeSuperuser === false && row.runtimeCreateRole === false
    && row.runtimeCreateDb === false && row.runtimeBypassRls === false
    && row.runtimeCanCreateSchemaObjects === false
    && row.runtimeCanCreateDatabaseObjects === false
    && row.runtimeMemberOfOwner === false, 'RUNTIME_OWNER_OR_DDL_PRIVILEGE');
  fail(row.runtimeCanReadState === true, 'RUNTIME_STATE_READ_MISSING');
  fail([row.runtimeCanUpdateState, row.runtimeCanInsertState, row.runtimeCanDeleteState,
    row.runtimeCanTruncateState, row.runtimeCanInsertEvent, row.runtimeCanUpdateEvent,
    row.runtimeCanDeleteEvent, row.runtimeCanTruncateEvent, row.runtimeCanTransition,
    row.runtimeCanAuditFunction, row.runtimeCanHistoryFunction,
    row.runtimeMemberOfOperator].every(v => v === false),
  'RUNTIME_MAINTENANCE_WRITE_OR_OPERATOR_PRIVILEGE');
  fail(fixedDefiner(row, 'transition'), 'TRANSITION_DEFINER_SEARCH_PATH_UNSAFE');
  fail(fixedDefiner(row, 'audit'), 'AUDIT_DEFINER_SEARCH_PATH_UNSAFE');
  fail(fixedDefiner(row, 'history'), 'HISTORY_DEFINER_SEARCH_PATH_UNSAFE');
  // Full pg_proc source pin, rather than keyword matching: unqualified
  // relations or an injected dynamic GRANT cannot receive PASS.
  fail(bodyMatchesApproved(row.transitionBody, APPROVED_BODY_SHA256.transition), 'TRANSITION_BODY_UNAPPROVED');
  fail(bodyMatchesApproved(row.auditBody, APPROVED_BODY_SHA256.audit), 'AUDIT_BODY_UNAPPROVED');
  fail(bodyMatchesApproved(row.historyBody, APPROVED_BODY_SHA256.history), 'HISTORY_BODY_UNAPPROVED');
  fail(row.maintenanceTriggerCount === 3 && row.auditTriggerValid === true
    && row.historyTriggerValid === true && row.stateNoDeleteTriggerValid === true,
  'MAINTENANCE_TRIGGER_TOPOLOGY_UNSAFE');
  fail(operatorRole === expectedOperatorRole && operatorRole !== runtimeRole
    && operatorRole !== stateOwner
    && row.operatorCanLogin === false
    && row.operatorSuperuser === false
    && row.operatorCreateRole === false && row.operatorCreateDb === false
    && row.operatorBypassRls === false && row.operatorReplication === false,
  'OPERATOR_GROUP_NOT_ISOLATED');
  fail(row.operatorCanTransition === true
    && row.operatorCanUpdateState === false
    && row.operatorCanTruncateState === false
    && row.operatorCanInsertEvent === false
    && row.operatorCanTruncateEvent === false
    && row.operatorCanAuditFunction === false
    && row.operatorCanHistoryFunction === false
    && row.operatorCanCreateSchemaObjects === false
    && row.operatorCanCreateDatabaseObjects === false
    && row.operatorMemberOfOwner === false, 'OPERATOR_PRIVILEGES_UNSAFE');
  return failures;
}

/**
 * Checks only metadata and PAUSED singleton, as the real API connection.
 * This preflight does NOT perform a maintenance transition.
 * A passing result is necessary, not sufficient, for a production cutover.
 */
export async function verifyBackupMaintenanceRoleFence(pool, expectedOperatorRole) {
  if (typeof expectedOperatorRole !== 'string' || !ROLE_NAME.test(expectedOperatorRole)) {
    return { status: 'BLOCKED', reasons: ['OPERATOR_ROLE_ARGUMENT_INVALID'] };
  }
  try {
    const metadata = await pool.query(MAINTENANCE_ROLE_FENCE_SQL, [expectedOperatorRole]);
    if (metadata.rows.length !== 1) return { status: 'BLOCKED', reasons: ['ROLE_METADATA_MISSING'] };
    const failures = collectRoleFenceFailures(metadata.rows[0], expectedOperatorRole);
    if (failures.length > 0) return { status: 'BLOCKED', reasons: failures };
    const state = await pool.query(
      'SELECT paused, revision FROM public.backup_health_maintenance_state WHERE singleton',
    );
    const revision = state.rows[0]?.revision;
    if (state.rows.length !== 1 || state.rows[0]?.paused !== true
      || !(typeof revision === 'string' && /^(0|[1-9][0-9]*)$/.test(revision)
        || typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0)) {
      return { status: 'BLOCKED', reasons: ['MAINTENANCE_NOT_PAUSED_OR_INVALID'] };
    }
    return { status: 'PASS', reasons: [] };
  } catch {
    return { status: 'BLOCKED', reasons: ['ROLE_FENCE_QUERY_FAILED'] };
  }
}
