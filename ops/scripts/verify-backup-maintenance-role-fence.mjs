#!/usr/bin/env node
/**
 * Explicit, read-only BR5 maintenance role-fencing preflight.
 * Needs the ACTUAL application DATABASE_URL and a separately approved NOLOGIN
 * operator group. No DDL, grants, role changes or secret printing.
 *
 * Not invoked by production deploy or API automatically in this slice.
 */
import { createRequire } from 'node:module';
import { verifyBackupMaintenanceRoleFence } from './backup-maintenance-role-fence.mjs';

const require = createRequire(new URL('../../server/package.json', import.meta.url));

if (process.argv.length !== 3 || process.argv[2] !== '--read-only') {
  console.error('BACKUP_ROLE_FENCE_BLOCKED reason=READ_ONLY_FLAG_REQUIRED');
  process.exitCode = 2;
} else if (!process.env.DATABASE_URL || !process.env.BR5_MAINTENANCE_OPERATOR_ROLE) {
  console.error('BACKUP_ROLE_FENCE_BLOCKED reason=CONFIGURATION_MISSING');
  process.exitCode = 2;
} else {
  let client;
  try {
    const { Client } = require('pg');
    client = new Client({
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 5_000,
      application_name: 'servora-br5-maintenance-role-readonly',
    });
    await client.connect();
    const result = await verifyBackupMaintenanceRoleFence(client, process.env.BR5_MAINTENANCE_OPERATOR_ROLE);
    if (result.status === 'PASS') {
      console.log('BACKUP_ROLE_FENCE=PASS scope=maintenance-only admission=BLOCKED');
    } else {
      console.error(`BACKUP_ROLE_FENCE=BLOCKED reasons=${result.reasons.join(',')}`);
      process.exitCode = 1;
    }
  } catch {
    console.error('BACKUP_ROLE_FENCE=BLOCKED reasons=ROLE_FENCE_QUERY_FAILED');
    process.exitCode = 1;
  } finally {
    if (client) await client.end().catch(() => {});
  }
}
