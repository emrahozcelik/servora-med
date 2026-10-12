// Real application/artifact fixture on the authorized disposable host. The
// all-8 SHA is deliberately synthetic, never a GitHub/production approval.
import assert from 'node:assert/strict';
import { withSealedFixture } from './r4-root-fixture.mjs';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { sealBackupReceipt } from '../scripts/deployment-controller.mjs';
export const LAB_SHA = process.env.SERVORA_R4_TEST_SHA ?? '8'.repeat(40);
assert.match(LAB_SHA,/^[0-9a-f]{40}$/);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function withRuntimeFixture(operation) {
  return withSealedFixture(grant => {
    const root = '/var/lib/servora-med/deploy';
    const profile = JSON.parse(readFileSync(root+'/profile.json','utf8'));
    const probe = spawnSync('/usr/bin/sudo',['-u','servora-med','/usr/bin/node',
      '--env-file=/etc/servora-med/servora-med.env','--input-type=module','-e',
      `import {createRequire} from 'node:module';
       const {Client}=createRequire('/opt/servora-med/releases/${LAB_SHA}/server/package.json')('pg');
       const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
       const r=await c.query('SELECT (pg_control_system()).system_identifier::text AS "clusterId", current_database() AS "databaseName", (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS "databaseOid", current_user AS role, host(inet_server_addr()) AS host, inet_server_port() AS port');
       console.log(JSON.stringify(r.rows[0]));await c.end();`],{encoding:'utf8'});
    assert.equal(probe.status,0,'synthetic database identity probe failed');
    profile.databaseIdentity = JSON.parse(probe.stdout);
    const text = JSON.stringify(profile)+'\n';
    grant.releaseSha = LAB_SHA;
    grant.expiresAtUTC = new Date(Date.now()+3600000).toISOString();
    grant.artifactSha256 = hash(readFileSync(`${root}/artifacts/${LAB_SHA}.tar.gz`));
    if (LAB_SHA !== '8'.repeat(40)) {
      const source = JSON.parse(readFileSync('/var/lib/servora-med/r4-test-source.json','utf8'));
      assert.equal(source.sha,LAB_SHA); assert.equal(source.artifactSha256,grant.artifactSha256);
      assert.match(source.tree,/^[0-9a-f]{40}$/);assert.match(source.ciManifestSha256,/^[0-9a-f]{64}$/);
      grant.treeSha=source.tree;grant.ciManifestSha256=source.ciManifestSha256;
    }
    grant.oldArtifactSha256 = hash(readFileSync(`${root}/artifacts/${grant.oldReleaseSha}.tar.gz`));
    const catalog = `/opt/servora-med/releases/${LAB_SHA}/server/dist/db/migrations`;
    grant.targetCatalog = readdirSync(catalog).filter(file => file.endsWith('.sql')).sort()
      .map(file => ({version:file.slice(0,-4),sha256:hash(readFileSync(catalog+'/'+file))}));
    grant.profileSha256 = hash(text);
    writeFileSync(root+'/profile.json',text);
    writeFileSync(`${root}/approvals/${grant.attemptId}.json`,JSON.stringify(grant)+'\n');
    return operation(grant);
  });
}

/** Real PG17 predeploy unit/receipt; only the owned synthetic VM is permitted. */
export function prepareRealBackup(grant) {
  const backupEnv = '/etc/servora-med/servora-med-backup.env';
  const before = readFileSync(backupEnv,'utf8');
  const profile = JSON.parse(readFileSync('/var/lib/servora-med/deploy/profile.json','utf8'));
  const directory = '/var/backups/servora-med';
  const names = new Set(readdirSync(directory));
  writeFileSync(backupEnv,before.replace(/^PGDATABASE=.*$/m,'PGDATABASE='+profile.databaseIdentity.databaseName));
  try {
    const result = spawnSync('/usr/bin/systemctl',['start',`servora-med-predeploy-backup@${grant.releaseSha}.service`],{encoding:'utf8',timeout:60000});
    assert.equal(result.status,0,'real synthetic predeploy backup failed');
    const created = readdirSync(directory).filter(name => !names.has(name) && /^servora-med-[0-9]{8}T[0-9]{6}Z\.dump$/.test(name));
    assert.equal(created.length,1,'exactly one fresh predeploy dump required');
    const file = directory+'/'+created[0];
    assert.equal(spawnSync('/usr/bin/pg_restore',['--list',file],{stdio:'ignore'}).status,0);
    sealBackupReceipt(grant.attemptId,'pre',file);
  } finally { writeFileSync(backupEnv,before); }
}
