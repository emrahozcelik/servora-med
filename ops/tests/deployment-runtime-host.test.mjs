import test from 'node:test';
import assert from 'node:assert/strict';
import { withRuntimeFixture, prepareRealBackup } from './r4-runtime-fixture.mjs';
import { verifyAttemptRelease, admitAttempt, checkpointAttempt, createAttemptBarrier,
  alignIdentityEnvironment, revokeStartPermit } from '../scripts/deployment-controller.mjs';
import { readLatestCheckpoint } from '../scripts/deployment-attempt.mjs';
import { readFileSync, writeFileSync, readlinkSync, unlinkSync, symlinkSync, existsSync } from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';

test('a reviewed immutable Linux artifact passes full content and catalog proof', () => withRuntimeFixture(grant => {
  assert.doesNotThrow(() => verifyAttemptRelease(grant.attemptId,'target'));
}));

test('normal migration deployment requires a sealed attempt before any host backup or activation', () => {
  const result = spawnSync('/usr/local/libexec/servora-med/deploy-production-host',[
    '--phase','deploy','--sha','8'.repeat(40),'--artifact','/home/emrah.guest/r4-rehearsal/servora-med-'+ '8'.repeat(40)+'.tar.gz',
    '--artifact-sha','a'.repeat(64),'--fqdn','r4.synthetic.invalid','--allow-migrations'],{encoding:'utf8',timeout:10000});
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/ATTEMPT_REQUIRED_FOR_MIGRATIONS/);
});

test('DB056 with OLD pointer and OLD env recovers the sealed candidate with one bounded real systemd start', () => withRuntimeFixture(grant => {
  const envFile = '/etc/servora-med/servora-med.env';
  const barrier = '/var/lib/servora-med/deploy/activation.block';
  const current = '/opt/servora-med/current';
  const envBefore = readFileSync(envFile,'utf8');
  const barrierBefore = readFileSync(barrier);
  const pointerBefore = readlinkSync(current);
  admitAttempt(grant.attemptId);
  prepareRealBackup(grant);
  try {
    unlinkSync(barrier); createAttemptBarrier(grant.attemptId);
    checkpointAttempt(grant.attemptId,'FENCED');
    checkpointAttempt(grant.attemptId,'MIGRATION_INTENT');
    writeFileSync(envFile,alignIdentityEnvironment(envBefore,grant.oldCatalog.at(-1).version,grant.oldReleaseSha));
    unlinkSync(current); symlinkSync('/opt/servora-med/releases/'+grant.oldReleaseSha,current);
    const result = spawnSync('/usr/local/libexec/servora-med/deploy-production-host',
      ['--phase','forward-recovery','--attempt-id',grant.attemptId],{encoding:'utf8',timeout:90000});
    assert.equal(result.status,0,result.stdout+result.stderr);
    assert.match(result.stdout,/FORWARD_RECOVERY=HEALTH_PASSED_PENDING_ACCEPTANCE/);
    const journal = readLatestCheckpoint(grant.attemptId).record;
    assert.equal(journal.phase,'HEALTH_PASSED'); assert.equal(journal.starts,1);
    assert.equal(readlinkSync(current),'/opt/servora-med/releases/'+grant.releaseSha);
    assert.equal(spawnSync('/usr/bin/systemctl',['show','servora-med.service','-p','Restart','--value'],{encoding:'utf8'}).stdout.trim(),'no');
    assert.equal(JSON.parse(readFileSync(barrier,'utf8')).attemptId,grant.attemptId);
    const repeat = spawnSync('/usr/local/libexec/servora-med/deploy-production-host',
      ['--phase','forward-recovery','--attempt-id',grant.attemptId],{encoding:'utf8',timeout:90000});
    assert.equal(repeat.status,0,repeat.stdout+repeat.stderr);
    assert.equal(readLatestCheckpoint(grant.attemptId).record.starts,1,'healthy repeat never spends another start');
  } finally {
    spawnSync('/usr/bin/systemctl',['stop','servora-med.service']);
    revokeStartPermit(grant.attemptId);
    writeFileSync(envFile,envBefore);
    unlinkSync(current); symlinkSync(pointerBefore,current);
    writeFileSync(barrier,barrierBefore,{mode:0o600});
  }
}));

test('pre-migration abort refuses DB056 before touching an OLD pointer or env', () => withRuntimeFixture(grant => {
  const envFile = '/etc/servora-med/servora-med.env';
  const barrier = '/var/lib/servora-med/deploy/activation.block';
  const envBefore = readFileSync(envFile);
  const barrierBefore = readFileSync(barrier);
  const pointerBefore = readlinkSync('/opt/servora-med/current');
  admitAttempt(grant.attemptId);
  prepareRealBackup(grant);
  try {
    unlinkSync(barrier); createAttemptBarrier(grant.attemptId);
    checkpointAttempt(grant.attemptId,'FENCED');
    // Use an approved OLD starting tuple, rather than the unrelated base
    // component fixture restored by the preceding test.
    unlinkSync('/opt/servora-med/current');
    symlinkSync('/opt/servora-med/releases/'+grant.oldReleaseSha,'/opt/servora-med/current');
    writeFileSync(envFile,alignIdentityEnvironment(envBefore.toString('utf8'),grant.oldCatalog.at(-1).version,grant.oldReleaseSha));
    const approvedEnv = readFileSync(envFile);
    const result = spawnSync('/usr/local/libexec/servora-med/deploy-production-host',
      ['--phase','pre-migration-abort','--attempt-id',grant.attemptId],{encoding:'utf8',timeout:30000});
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/RECOVERY_DATABASE_NOT_EXACT/);
    assert.deepEqual(readFileSync(envFile),approvedEnv);
    assert.equal(readlinkSync('/opt/servora-med/current'),'/opt/servora-med/releases/'+grant.oldReleaseSha);
    assert.equal(readLatestCheckpoint(grant.attemptId).record.abortStarts,0);
  } finally {
    writeFileSync(envFile,envBefore);
    unlinkSync('/opt/servora-med/current'); symlinkSync(pointerBefore,'/opt/servora-med/current');
    writeFileSync(barrier,barrierBefore);
  }
}));

test('DB055 EXACT permits one OLD abort start and safely restores ordinary systemd ownership', () => {
  const envFile = '/etc/servora-med/servora-med.env';
  const barrier = '/var/lib/servora-med/deploy/activation.block';
  const current = '/opt/servora-med/current';
  const policy = '/etc/systemd/system/servora-med.service.d/90-servora-recovery.conf';
  const envBefore = readFileSync(envFile);
  const barrierBefore = readFileSync(barrier);
  const pointerBefore = readlinkSync(current);
  const policyBefore = existsSync(policy) ? readFileSync(policy) : null;
  // A different disposable DB is created at 055 by the real OLD migrator;
  // the existing 056 database is never downgraded/restored for this test.
  writeFileSync(envFile,readFileSync('/etc/servora-med/r4-abort-fixture.env'));
  try {
    withRuntimeFixture(grant => {
      admitAttempt(grant.attemptId);
      prepareRealBackup(grant);
      unlinkSync(barrier); createAttemptBarrier(grant.attemptId);
      checkpointAttempt(grant.attemptId,'FENCED');
      unlinkSync(current); symlinkSync('/opt/servora-med/releases/'+grant.oldReleaseSha,current);
      const result = spawnSync('/usr/local/libexec/servora-med/deploy-production-host',
        ['--phase','pre-migration-abort','--attempt-id',grant.attemptId],{encoding:'utf8',timeout:90000});
      assert.equal(result.status,0,result.stdout+result.stderr);
      assert.match(result.stdout,/PRE_MIGRATION_ABORT=COMPLETE_OLD_EXACT/);
      const journal = readLatestCheckpoint(grant.attemptId).record;
      assert.equal(journal.phase,'COMPLETED_ABORT'); assert.equal(journal.abortStarts,1);
      assert.equal(journal.starts,0); assert.equal(journal.migrationCommitted,false);
      assert.equal(existsSync(barrier),false);
      assert.equal(existsSync('/var/lib/servora-med/deploy/active.json'),false);
      assert.equal(spawnSync('/usr/bin/systemctl',['show','servora-med.service','-p','Restart','--value'],{encoding:'utf8'}).stdout.trim(),'on-failure');
      assert.equal(spawnSync('/usr/bin/systemctl',['is-active','servora-med.service'],{encoding:'utf8'}).stdout.trim(),'active');
    });
  } finally {
    spawnSync('/usr/bin/systemctl',['stop','servora-med.service']);
    writeFileSync(envFile,envBefore);
    unlinkSync(current); symlinkSync(pointerBefore,current);
    writeFileSync(barrier,barrierBefore,{mode:0o600});
    if (policyBefore) writeFileSync(policy,policyBefore,{mode:0o600});
    spawnSync('/usr/bin/systemctl',['daemon-reload']);
  }
});

test('normal 055 to 056 deployment seals its real backup and journal before bounded activation', () => {
  const envFile = '/etc/servora-med/servora-med.env';
  const backupEnv = '/etc/servora-med/servora-med-backup.env';
  const barrier = '/var/lib/servora-med/deploy/activation.block';
  const current = '/opt/servora-med/current';
  const policy = '/etc/systemd/system/servora-med.service.d/90-servora-recovery.conf';
  const envBefore = readFileSync(envFile), backupBefore = readFileSync(backupEnv,'utf8');
  const barrierBefore = readFileSync(barrier), pointerBefore = readlinkSync(current);
  const policyBefore = readFileSync(policy);
  writeFileSync(envFile,readFileSync('/etc/servora-med/r4-normal-fixture.env'));
  const line = readFileSync(envFile,'utf8').split('\n').find(value => value.startsWith('DATABASE_URL='));
  const databaseName = new URL(line.slice(13)).pathname.slice(1);
  writeFileSync(backupEnv,backupBefore.replace(/^PGDATABASE=.*$/m,'PGDATABASE='+databaseName));
  try {
    withRuntimeFixture(grant => {
      unlinkSync(barrier); unlinkSync(policy);
      unlinkSync(current); symlinkSync('/opt/servora-med/releases/'+grant.oldReleaseSha,current);
      spawnSync('/usr/bin/systemctl',['daemon-reload']);
      assert.equal(spawnSync('/usr/bin/systemctl',['start','servora-med.service']).status,0);
      let healthy = false;
      for (let sample = 0; sample < 20; sample++) {
        if (spawnSync('/usr/bin/curl',['--fail','--silent','https://r4.synthetic.invalid/api/health']).status === 0) { healthy = true; break; }
        spawnSync('/usr/bin/sleep',['1']);
      }
      assert.equal(healthy,true,'OLD055 must be healthy before normal deployment');
      const result = spawnSync('/usr/local/libexec/servora-med/deploy-production-host',[
        '--phase','deploy','--sha',grant.releaseSha,
        '--artifact','/home/emrah.guest/r4-rehearsal/servora-med-'+grant.releaseSha+'.tar.gz',
        '--artifact-sha',grant.artifactSha256,'--fqdn','r4.synthetic.invalid',
        '--allow-migrations','--attempt-id',grant.attemptId],{encoding:'utf8',timeout:120000});
      assert.equal(result.status,0,result.stdout+result.stderr);
      assert.match(result.stdout,/PREDEPLOY_BACKUP=PASS/); assert.match(result.stdout,/MIGRATIONS_APPLIED=1/);
      assert.equal(existsSync('/var/lib/servora-med/deploy/active.json'),true,'normal deploy must retain attempt ownership through acceptance');
      const journal = readLatestCheckpoint(grant.attemptId).record;
      assert.equal(journal.phase,'HEALTH_PASSED'); assert.equal(journal.starts,1);
      assert.notEqual(journal.predeployBackup.sha256,'6'.repeat(64),'normal receipt must come from a real verified pg_dump');
      assert.equal(JSON.parse(readFileSync(barrier,'utf8')).attemptId,grant.attemptId);
      assert.equal(spawnSync('/usr/bin/systemctl',['show','servora-med.service','-p','Restart','--value'],{encoding:'utf8'}).stdout.trim(),'no');
    });
  } finally {
    spawnSync('/usr/bin/systemctl',['stop','servora-med.service']);
    writeFileSync(envFile,envBefore); writeFileSync(backupEnv,backupBefore);
    unlinkSync(current); symlinkSync(pointerBefore,current);
    writeFileSync(barrier,barrierBefore,{mode:0o600}); writeFileSync(policy,policyBefore,{mode:0o600});
    spawnSync('/usr/bin/systemctl',['daemon-reload']);
  }
});


test('failed candidate starts cannot trigger systemd retries or exceed the two durable slots', () => withRuntimeFixture(grant => {
  const envFile='/etc/servora-med/servora-med.env', barrier='/var/lib/servora-med/deploy/activation.block', current='/opt/servora-med/current';
  const envBefore=readFileSync(envFile),barrierBefore=readFileSync(barrier),pointerBefore=readlinkSync(current);
  const blocker=spawn('/usr/bin/sudo',['-u','servora-med','--','/usr/bin/python3','-c',
    'import socket,time; s=socket.socket(); s.bind(("127.0.0.1",3000)); s.listen(); time.sleep(120)'],{stdio:'ignore'});
  try {
    let listening=false;
    for(let count=0;count<10;count++) {
      if(spawnSync('/usr/bin/ss',['-lnt','sport','=',':3000'],{encoding:'utf8'}).stdout.includes('127.0.0.1:3000')) {listening=true;break;}
      spawnSync('/usr/bin/sleep',['1']);
    }
    assert.equal(listening,true,'controlled loopback bind fault must actually be present');
    admitAttempt(grant.attemptId); prepareRealBackup(grant);
    unlinkSync(barrier);createAttemptBarrier(grant.attemptId);checkpointAttempt(grant.attemptId,'FENCED');
    writeFileSync(envFile,alignIdentityEnvironment(envBefore.toString(),grant.oldCatalog.at(-1).version,grant.oldReleaseSha));
    unlinkSync(current);symlinkSync('/opt/servora-med/releases/'+grant.oldReleaseSha,current);
    for(let slot=1;slot<=2;slot++) {
      const result=spawnSync('/usr/local/libexec/servora-med/deploy-production-host',['--phase','forward-recovery','--attempt-id',grant.attemptId],{encoding:'utf8',timeout:90000});
      assert.notEqual(result.status,0,result.stdout+result.stderr);
      assert.match(result.stderr,/RECOVERY_(?:SERVICE_START|HEALTH)_FAILED/);
      const state=readLatestCheckpoint(grant.attemptId).record;
      assert.equal(state.phase,'START_FAILED');assert.equal(state.starts,slot);
      spawnSync('/usr/bin/sleep',['6']);
      assert.equal(spawnSync('/usr/bin/systemctl',['show','servora-med.service','-p','NRestarts','--value'],{encoding:'utf8'}).stdout.trim(),'0');
      assert.equal(spawnSync('/usr/bin/systemctl',['show','servora-med.service','-p','MainPID','--value'],{encoding:'utf8'}).stdout.trim(),'0');
    }
    const before=readLatestCheckpoint(grant.attemptId);
    const denied=spawnSync('/usr/local/libexec/servora-med/deploy-production-host',['--phase','forward-recovery','--attempt-id',grant.attemptId],{encoding:'utf8',timeout:30000});
    assert.match(denied.stderr,/ATTEMPT_START_BUDGET_EXHAUSTED/);
    assert.deepEqual(readLatestCheckpoint(grant.attemptId),before);
    assert.equal(existsSync('/run/servora-med-recovery/start.permit'),false);
    assert.equal(JSON.parse(readFileSync(barrier)).attemptId,grant.attemptId);
    for(const testDatabase of [undefined,'postgres://synthetic:synthetic@127.0.0.1/servora_med_test_r4_never_used']) {
      const env={PATH:'/usr/bin:/bin',SHA:grant.releaseSha,OPS_LOG:'/var/lib/servora-med/deploy/logs/'+grant.attemptId+'/maintenance.log'};
      if(testDatabase)env.TEST_DATABASE_URL=testDatabase;
      for(const [script,args] of [
        ['deploy-release.sh',[]],
        ['production-recovery.sh',['--backup','/tmp/r4-missing-never-restore.dump','--checksum','/tmp/r4-missing-never-restore.sha256',
          '--target-db','servora_med','--expected-host','127.0.0.1','--allow-destructive','--old-release',grant.oldReleaseSha,
          '--old-health-schema-version',grant.oldCatalog.at(-1).version]],
      ]) {
        const legacy=spawnSync('/opt/servora-med/releases/'+grant.releaseSha+'/ops/scripts/'+script,args,{encoding:'utf8',env,timeout:10000});
        assert.notEqual(legacy.status,0);assert.match(legacy.stderr,/RECOVERY_ATTEMPT_PENDING/,script+' cannot bypass the host fence');
      }
    }
  } finally {
    blocker.kill('SIGTERM');spawnSync('/usr/bin/systemctl',['stop','servora-med.service']);revokeStartPermit(grant.attemptId);
    writeFileSync(envFile,envBefore);unlinkSync(current);symlinkSync(pointerBefore,current);writeFileSync(barrier,barrierBefore);
  }
}));
