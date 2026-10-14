// Synthetic root contract fixture, never a deployment/artifact acceptance.
import assert from 'node:assert/strict';
import { hostname } from 'node:os';
import { readFileSync, existsSync, writeFileSync, unlinkSync, realpathSync, readdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { environmentBaseline } from '../scripts/deployment-controller.mjs';

export function withSealedFixture(operation) {
  assert.equal(hostname(), 'lima-servora-r4-20261012');
  assert.equal(process.getuid(), 0);
  const root = '/var/lib/servora-med/deploy';
  assert.equal(existsSync(root + '/active.json'), false);
  const oldProfile = existsSync(root + '/profile.json') ? readFileSync(root + '/profile.json') : null;
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const installed = '/usr/local/libexec/servora-med';
  const profile = { formatVersion: 1, machineId: readFileSync('/etc/machine-id','utf8').trim(), fqdn:'r4.synthetic.invalid',
    databaseIdentity:{clusterId:'1',databaseName:'servora_med_test_r4_host',databaseOid:'1',role:'servora_r4_app',host:'127.0.0.1',port:5432},
    envBaselineSha256:environmentBaseline(readFileSync('/etc/servora-med/servora-med.env','utf8')),
    contracts:Object.fromEntries(Object.entries({helperSha256:installed+'/deploy-production-host',nodeSha256:realpathSync('/usr/bin/node'),
      unitSha256:'/etc/systemd/system/servora-med.service',attemptModuleSha256:installed+'/deployment-attempt.mjs',
      dbGuardModuleSha256:installed+'/deployment-db-guard.mjs',reconciliationModuleSha256:installed+'/migration-reconciliation.mjs',
      controllerModuleSha256:installed+'/deployment-controller.mjs'}).map(([key,file]) => [key,hash(readFileSync(file))])) };
  const text = JSON.stringify(profile)+'\n';
  const id = randomUUID();
  const now = Date.now();
  const catalog = sha => {
    const dir = `/opt/servora-med/releases/${sha}/server/dist/db/migrations`;
    return readdirSync(dir).filter(name => /^[0-9]{3}_[a-z0-9_]+\.sql$/.test(name)).sort()
      .map(name => ({version:name.slice(0,-4),sha256:hash(readFileSync(dir+'/'+name))}));
  };
  const grant = {formatVersion:1,attemptId:id,releaseSha:'e4ca2b19f7865dca3f1e4597dd099ed167667a19',treeSha:'b94bbfb4a7a07249ea4b40ecb1e5c9ebe04ba641',
    artifactSha256:'c'.repeat(64),ciManifestSha256:'d'.repeat(64),targetCatalog:catalog('e4ca2b19f7865dca3f1e4597dd099ed167667a19'),
    oldReleaseSha:'71ae6df6dd0659ed6390a6785d4bab29ddf5b1fa',oldArtifactSha256:'1'.repeat(64),oldCatalog:catalog('71ae6df6dd0659ed6390a6785d4bab29ddf5b1fa'),
    profileSha256:hash(text),issuedAtUTC:new Date(now-1000).toISOString(),expiresAtUTC:new Date(now+7200000).toISOString(),maxStarts:2,maxAbortStarts:1,
    allowMigration:true,allowForwardRecovery:true,allowPreMigrationAbort:true,allowPostdeployBackup:true};
  writeFileSync(root+'/profile.json',text,{mode:0o600});
  writeFileSync(`${root}/approvals/${id}.json`,JSON.stringify(grant)+'\n',{mode:0o600});
  const cleanup = () => {
    if (existsSync(root+'/active.json')) {
      const active = JSON.parse(readFileSync(root+'/active.json','utf8'));
      assert.equal(active.attemptId,id);
      unlinkSync(root+'/active.json'); // Owned isolated fixture cleanup only.
    }
    if (oldProfile) writeFileSync(root+'/profile.json',oldProfile); else unlinkSync(root+'/profile.json');
  };
  let result;
  try { result = operation(grant); } catch(error) { cleanup(); throw error; }
  if (result && typeof result.then === 'function') return result.finally(cleanup);
  cleanup(); return result;
}
