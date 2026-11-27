# MSG-003 restore drill — evidence

- Result: **PASS** (42/42 assertions passed)
- Executed: 2026-11-27T06:47:42.474Z → 2026-11-27T06:47:47.606Z
- Application commit under test: `0397b48af9d11ecafcaff5198addbf2361044e97` (branch `fleet/20261127-093821-deepseek-7709`; the harness and evidence are committed as its child)
- Runtime: postgres (PostgreSQL) 17.11 (Homebrew); real Fastify production build; real `pg_dump`/`pg_restore` custom format.
- Command: `node web/scripts/msg003-restore-drill.mjs`
- Isolated resources: disposable PostgreSQL cluster in `/private/tmp` (random port), disposable databases, real built server on a loopback port. Everything was removed at the end.

## Scenarios

| ID | Scenario | Result | Started | Checks |
| -- | -------- | ------ | ------- | ------ |
| R1 | Migrated DB, first-start takeover on, operator disables MESSAGING, pg_dump | **PASS** | 2026-11-27T06:47:43.471Z | 11 |
| R2 | Operator re-enables MESSAGING after the dump (state drift) | **PASS** | 2026-11-27T06:47:44.819Z | 4 |
| R3 | Restore + reset-after-restore + restart: backup instant wins, old operator access rejected | **PASS** | 2026-11-27T06:47:44.905Z | 19 |
| R4 | Pre-takeover backup restore: takeover creates MESSAGING and one audit event | **PASS** | 2026-11-27T06:47:46.002Z | 8 |

## Recorded observations

### R1 — Migrated DB, first-start takeover on, operator disables MESSAGING, pg_dump

Result: **PASS**

Summary: MESSAGING takeover ON (version 1, ENV_TAKEOVER); operator login 200; PUT off 200 -> version 2; dump 356388 bytes sha256=cc25161de7d122a71928f4aca4b4b7c7626ae493bb11edbe248171dd9d2bb939; backup audit events=3

- PASS `MIGRATED-TO-HEAD`: applied=75, head=075_installation_module_registry_widening
- PASS `SYNTHETIC-CUSTOMER-SEEDED`: bootstrap:admin completed for msg003-customer-69cd27fb@example.test
- PASS `SERVER-FIRST-START`: real dist server healthy on http://127.0.0.1:49683
- PASS `TAKEOVER-MESSAGING-ON`: row={"module_key":"MESSAGING","enabled":true,"version":1,"source":"ENV_TAKEOVER","updated_at":"2026-11-27T06:47:44.455Z","updated_by_operator_id":null}
- PASS `TAKEOVER-SINGLE-EVENT`: events=[{"event_type":"MODULE_STATE_TAKEN_OVER","actor_kind":"SYSTEM","new_value":{"source":"ENV_TAKEOVER","enabled":true}}]
- PASS `OPERATOR-GRANTED`: account={"id":"b525f2e4-539e-4376-97de-77c061c1d377","email":"msg003-operator-69cd27fb@example.test","name":"MSG-003 Operator","is_active":true,"version":1,"updated_at":"2026-11-27T06:47:44.651Z"}
- PASS `OPERATOR-LOGIN`: status=200, cookie=set
- PASS `MESSAGING-INITIALLY-ON`: status=200, module={"key":"MESSAGING","enabled":true,"version":1,"source":"ENV_TAKEOVER","updatedAt":"2026-11-27T06:47:44.455Z"}
- PASS `OPERATOR-SWITCHES-MESSAGING-OFF`: status=200, module={"key":"MESSAGING","enabled":false,"version":2,"source":"OPERATOR","updatedAt":"2026-11-27T06:47:44.743Z"}
- PASS `MESSAGING-OFF-VISIBLE-TO-OPERATOR`: status=200, module={"key":"MESSAGING","enabled":false,"version":2,"source":"OPERATOR","updatedAt":"2026-11-27T06:47:44.743Z"}
- PASS `CUSTOM-FORMAT-DUMP-TAKEN`: sizeBytes=356388, sha256=cc25161de7d122a71928f4aca4b4b7c7626ae493bb11edbe248171dd9d2bb939

### R2 — Operator re-enables MESSAGING after the dump (state drift)

Result: **PASS**

Summary: MESSAGING switched ON again: version 3 / enabled true in the primary database while the dump still holds version 2 / disabled

- PASS `OPERATOR-LOGIN-AFTER-DUMP`: status=200
- PASS `OPERATOR-SWITCHES-MESSAGING-ON`: status=200, module={"key":"MESSAGING","enabled":true,"version":3,"source":"OPERATOR","updatedAt":"2026-11-27T06:47:44.894Z"}
- PASS `PRIMARY-STATE-DIFFERS-FROM-DUMP`: primary row={"module_key":"MESSAGING","enabled":true,"version":3,"source":"OPERATOR","updated_at":"2026-11-27T06:47:44.894Z","updated_by_operator_id":"b525f2e4-539e-4376-97de-77c061c1d377"}; dump captured version 2/off
- PASS `PRIMARY-SERVER-STOPPED`: Primary server stopped before restore work began

### R3 — Restore + reset-after-restore + restart: backup instant wins, old operator access rejected

Result: **PASS**

Summary: Restore returned MESSAGING off at version 2; reset-after-restore deactivated 1 operator and revoked 1 session; old cookie/password 401; re-grant + new password 200; customer /me messaging=false; MESSAGING_ENABLED=true ignored

- PASS `PG-RESTORE-INTO-NEW-DATABASE`: pg_restore completed into disposable database msg003_restored_69cd27fb
- PASS `RESTORED-MODULE-STATE-EQUALS-BACKUP-INSTANT`: modules=[{"module_key":"MESSAGING","enabled":false,"version":2,"source":"OPERATOR","updated_at":"2026-11-27T06:47:44.743Z","updated_by_operator_id":"b525f2e4-539e-4376-97de-77c061c1d377"},{"module_key":"OVERVIEW","enabled":false,"version":1,"source":"ENV_TAKEOVER","updated_at":"2026-11-27T06:47:44.453Z","updated_by_operator_id":null}], moduleAuditEvents=3, operator={"id":"b525f2e4-539e-4376-97de-77c061c1d377","email":"msg003-operator-69cd27fb@example.test","name":"MSG-003 Operator","is_active":true,"version":1,"updated_at":"2026-11-27T06:47:44.651Z"}
- PASS `RESTORED-MESSAGING-OFF-BACKUP-VERSION`: row={"module_key":"MESSAGING","enabled":false,"version":2,"source":"OPERATOR","updated_at":"2026-11-27T06:47:44.743Z","updated_by_operator_id":"b525f2e4-539e-4376-97de-77c061c1d377"}; backupApiRow={"key":"MESSAGING","enabled":false,"version":2,"source":"OPERATOR","updatedAt":"2026-11-27T06:47:44.743Z"}
- PASS `RESET-AFTER-RESTORE-COMMAND`: Operator access reset: 1 account(s) deactivated, 1 session(s) revoked.
- PASS `OPERATOR-DEACTIVATED-AND-SESSIONS-REVOKED`: account={"id":"b525f2e4-539e-4376-97de-77c061c1d377","email":"msg003-operator-69cd27fb@example.test","name":"MSG-003 Operator","is_active":false,"version":2,"updated_at":"2026-11-27T06:47:45.135Z"}, activeSessions=0, resetEvents=[{"actor_kind":"SYSTEM","event_type":"OPERATOR_ACCESS_RESET_BY_RESTORE","target_operator_id":"b525f2e4-539e-4376-97de-77c061c1d377","new_value":{"revokedSessions":1},"occurred_at":"2026-11-27T06:47:45.135Z"}]
- PASS `RESET-LEAVES-MODULE-STATE-AT-BACKUP-INSTANT`: modules=[{"module_key":"MESSAGING","enabled":false,"version":2,"source":"OPERATOR","updated_at":"2026-11-27T06:47:44.743Z","updated_by_operator_id":"b525f2e4-539e-4376-97de-77c061c1d377"},{"module_key":"OVERVIEW","enabled":false,"version":1,"source":"ENV_TAKEOVER","updated_at":"2026-11-27T06:47:44.453Z","updated_by_operator_id":null}]
- PASS `RESTORED-SERVER-STARTED-WITH-ENV-TRUE`: Real built server started on the restored database with MESSAGING_ENABLED=true
- PASS `ENV-IGNORED-AFTER-RESTORE`: row={"module_key":"MESSAGING","enabled":false,"version":2,"source":"OPERATOR","updated_at":"2026-11-27T06:47:44.743Z","updated_by_operator_id":"b525f2e4-539e-4376-97de-77c061c1d377"} (env MESSAGING_ENABLED=true)
- PASS `NO-NEW-TAKEOVER-EVENT-ON-RESTORE`: MESSAGING MODULE_STATE_TAKEN_OVER events=1 (the one restored from the backup)
- PASS `OLD-OPERATOR-COOKIE-REJECTED`: status=401, code=OPERATOR_UNAUTHENTICATED
- PASS `OLD-OPERATOR-PASSWORD-REJECTED-BEFORE-REGRANT`: status=401, code=INVALID_CREDENTIALS
- PASS `CUSTOMER-LOGIN-ON-RESTORED-DB`: status=200
- PASS `CUSTOMER-ME-REPORTS-MESSAGING-FALSE`: status=200, capabilities={"duplicateCustomerComparison":false,"overviewDashboard":false,"calendar":false,"messaging":false,"backup":false,"demoDatasetCreation":false}
- PASS `HOST-REGRANT-REACTIVATES-ACCOUNT`: output=Reactivated operator msg003-operator-69cd27fb@example.test (MODULE_MANAGEMENT)., account={"id":"b525f2e4-539e-4376-97de-77c061c1d377","email":"msg003-operator-69cd27fb@example.test","name":"MSG-003 Operator","is_active":true,"version":3,"updated_at":"2026-11-27T06:47:45.819Z"}
- PASS `OLD-PASSWORD-STILL-REJECTED-AFTER-REGRANT`: status=401, code=INVALID_CREDENTIALS
- PASS `NEW-PASSWORD-LOGIN`: status=200, cookie=set
- PASS `MODULES-SHOW-BACKUP-INSTANT-AFTER-REGRANT`: status=200, module={"key":"MESSAGING","enabled":false,"version":2,"source":"OPERATOR","updatedAt":"2026-11-27T06:47:44.743Z"}, backup={"key":"MESSAGING","enabled":false,"version":2,"source":"OPERATOR","updatedAt":"2026-11-27T06:47:44.743Z"}
- PASS `OLD-COOKIE-STILL-REJECTED-AFTER-REGRANT`: status=401
- PASS `SINGLE-RESET-AUDIT-EVENT`: OPERATOR_ACCESS_RESET_BY_RESTORE events=1

### R4 — Pre-takeover backup restore: takeover creates MESSAGING and one audit event

Result: **PASS**

Summary: Pre-takeover dump (no module rows) restored; first start created MESSAGING enabled=true version 1 ENV_TAKEOVER with exactly one MODULE_STATE_TAKEN_OVER event; Modules API confirms it

- PASS `PRE-TAKEOVER-SOURCE-MIGRATED-TO-HEAD`: applied=75, head=075_installation_module_registry_widening
- PASS `SOURCE-HAS-NO-MODULE-STATE`: moduleRows=0, moduleAuditEvents=0 (server never started)
- PASS `PRE-TAKEOVER-BACKUP-RESTORED`: pg_restore completed into msg003_pre_restored_69cd27fb; dump size=355117
- PASS `PRE-TAKEOVER-SERVER-STARTED-WITH-ENV-TRUE`: Real built server started on the restored pre-takeover database with MESSAGING_ENABLED=true
- PASS `TAKEOVER-CREATES-MESSAGING-ROW`: row={"module_key":"MESSAGING","enabled":true,"version":1,"source":"ENV_TAKEOVER","updated_at":"2026-11-27T06:47:46.979Z","updated_by_operator_id":null}
- PASS `TAKEOVER-EXACTLY-ONE-MESSAGING-EVENT`: events=[{"actor_kind":"SYSTEM","event_type":"MODULE_STATE_TAKEN_OVER","new_value":{"source":"ENV_TAKEOVER","enabled":true}}]
- PASS `R4-OPERATOR-LOGIN`: status=200
- PASS `TAKEOVER-VISIBLE-ON-MODULES-API`: status=200, module={"key":"MESSAGING","enabled":true,"version":1,"source":"ENV_TAKEOVER","updatedAt":"2026-11-27T06:47:46.979Z"}

## Backup artifacts

- `msg003-r1-69cd27fb`: format=custom, sizeBytes=356388, sha256=`cc25161de7d122a71928f4aca4b4b7c7626ae493bb11edbe248171dd9d2bb939`
- `msg003-r4-69cd27fb`: format=custom, sizeBytes=355117, sha256=`ffde58bee505421112964bc79ec31753d61c02f17b76b6777a2aa9670be3c1d0`

Dump files are not retained and are not part of the evidence: a dump contains
operator password and session hashes. Only the size and SHA-256 are recorded.

## Limits / not covered

- No staging environment exists (docs/operations/staging-contract.md); this is a
  local drill against the real application and real PostgreSQL, not production acceptance.
- This drill is server/database level. No browser/UI flow is exercised, so no
  screenshots are attached; the operator Modules page and customer menu behaviour
  belong to the separate MSG-003 UI acceptance.
- Only one restore cycle and one pre-takeover restore are covered. BR7 new-target
  cutover, host recovery cutover, offsite backups and dump encryption are not
  exercised.
- The drill runs on a single PostgreSQL 17 installation (dump and target same
  major version); cross-version restore is not covered.
- No concurrency is exercised around takeover/restore; MS1's concurrent-startup
  and MS10's version-conflict scenarios are covered by the server test suite and
  the separate messaging acceptance, not here.
- The customer account is bootstrapped synthetic data; no medical/dental business
  records are needed for this drill.
- `pg_dump` was taken while the primary server was running (consistent snapshot),
  which mirrors the backup worker's live-database path, not a quiesced maintenance window.
