import test from 'node:test';
import assert from 'node:assert/strict';
import { withRuntimeFixture, prepareRealBackup, readDatabaseInvariants } from './r4-runtime-fixture.mjs';
import { verifyAttemptRelease, admitAttempt, checkpointAttempt, createAttemptBarrier,
  alignIdentityEnvironment, revokeStartPermit } from '../scripts/deployment-controller.mjs';
import { readLatestCheckpoint } from '../scripts/deployment-attempt.mjs';
import { readFileSync, writeFileSync, readlinkSync, unlinkSync, symlinkSync, existsSync, mkdirSync, rmdirSync, readdirSync } from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';

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
    checkpointAttempt(grant.attemptId,{kind:'MIGRATION_INTENT',baseline:readDatabaseInvariants()});
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
    'import socket,time; s=socket.socket(); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1); s.bind(("127.0.0.1",3000)); s.listen(); time.sleep(120)'],{stdio:'ignore'});
  try {
    let listening=false;
    for(let count=0;count<10;count++) {
      if(spawnSync('/usr/bin/ss',['-lnt','sport','=',':3000'],{encoding:'utf8'}).stdout.includes('127.0.0.1:3000')) {listening=true;break;}
      spawnSync('/usr/bin/sleep',['1']);
    }
    assert.equal(listening,true,'controlled loopback bind fault must actually be present');
    admitAttempt(grant.attemptId); prepareRealBackup(grant);
    unlinkSync(barrier);createAttemptBarrier(grant.attemptId);checkpointAttempt(grant.attemptId,'FENCED');
    checkpointAttempt(grant.attemptId,{kind:'MIGRATION_INTENT',baseline:readDatabaseInvariants()});
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

// ---- Remediation regression: early-phase recovery, scopes, durable schema gate, terminal read-only ----

function freshAbortDatabase() {
  const db='servora_med_test_r4_early_'+randomUUID().replaceAll('-','');
  assert.equal(spawnSync('/usr/bin/sudo',['-u','postgres','--','/usr/bin/createdb','-O','servora_r4_app','-T','servora_med_test_r4_abort_20261012',db]).status,0);
  return db;
}
function writeAbortEnv(envFile,backupEnv,saved,db) {
  const text=readFileSync('/etc/servora-med/r4-abort-fixture.env','utf8');
  const url=new URL(text.split('\n').find(line=>line.startsWith('DATABASE_URL=')).slice(13));url.pathname='/'+db;
  writeFileSync(envFile,text.replace(/^DATABASE_URL=.*$/m,'DATABASE_URL='+url.toString()));
  writeFileSync(backupEnv,saved.backup.replace(/^PGDATABASE=.*$/m,'PGDATABASE='+db));
}

test('an ADMITTED attempt interrupted before its backup resumes with the same owner and keeps one budget', () => {
  const envFile='/etc/servora-med/servora-med.env',backupEnv='/etc/servora-med/servora-med-backup.env';
  const barrier='/var/lib/servora-med/deploy/activation.block',current='/opt/servora-med/current';
  const policy='/etc/systemd/system/servora-med.service.d/90-servora-recovery.conf';
  const saved={env:readFileSync(envFile,'utf8'),backup:readFileSync(backupEnv,'utf8'),barrier:readFileSync(barrier),pointer:readlinkSync(current),policy:existsSync(policy)?readFileSync(policy):null};
  const db=freshAbortDatabase();
  writeAbortEnv(envFile,backupEnv,saved,db);
  try {
    return withRuntimeFixture(grant => {
      unlinkSync(barrier);if(existsSync(policy))unlinkSync(policy);
      unlinkSync(current);symlinkSync('/opt/servora-med/releases/'+grant.oldReleaseSha,current);
      spawnSync('/usr/bin/systemctl',['daemon-reload']);
      assert.equal(spawnSync('/usr/bin/systemctl',['start','servora-med.service']).status,0);
      for(let wait=0;wait<20;wait++){if(spawnSync('/usr/bin/curl',['--fail','--silent','https://r4.synthetic.invalid/api/health']).status===0)break;spawnSync('/usr/bin/sleep',['1']);}
      // Kill-window equivalent: ownership claimed, no backup, nothing mutated.
      admitAttempt(grant.attemptId);
      assert.equal(readLatestCheckpoint(grant.attemptId).record.phase,'ADMITTED');
      const dumpsBefore=readdirSync('/var/backups/servora-med').filter(x=>x.endsWith('.dump')).length;
      const result=spawnSync('/usr/local/libexec/servora-med/deploy-production-host',[
        '--phase','deploy','--sha',grant.releaseSha,
        '--artifact','/home/emrah.guest/r4-rehearsal/servora-med-'+grant.releaseSha+'.tar.gz',
        '--artifact-sha',grant.artifactSha256,'--fqdn','r4.synthetic.invalid','--allow-migrations','--attempt-id',grant.attemptId],{encoding:'utf8',timeout:120000});
      assert.equal(result.status,0,result.stdout+result.stderr);
      assert.match(result.stdout,/PREDEPLOY_BACKUP=PASS/);
      assert.match(result.stdout,/MIGRATIONS_APPLIED=1/);
      const journal=readLatestCheckpoint(grant.attemptId).record;
      assert.equal(journal.phase,'HEALTH_PASSED');assert.equal(journal.starts,1);
      assert.match(journal.predeployBackup.sha256,/^[0-9a-f]{64}$/);
      assert.equal(readdirSync('/var/backups/servora-med').filter(x=>x.endsWith('.dump')).length,dumpsBefore+1);
      console.log('ADMITTED_RESUME_SAME_OWNER=PASS starts=1 dumps_delta=1');
    });
  } finally {
    spawnSync('/usr/bin/systemctl',['stop','servora-med.service']);
    writeFileSync(envFile,saved.env);writeFileSync(backupEnv,saved.backup);
    unlinkSync(current);symlinkSync(saved.pointer,current);writeFileSync(barrier,saved.barrier,{mode:0o600});
    if(saved.policy)writeFileSync(policy,saved.policy,{mode:0o600});else if(existsSync(policy))unlinkSync(policy);
    spawnSync('/usr/bin/systemctl',['daemon-reload']);
  }
});

test('a BACKED_UP attempt interrupted before fencing resumes without a second backup', () => {
  const envFile='/etc/servora-med/servora-med.env',backupEnv='/etc/servora-med/servora-med-backup.env';
  const barrier='/var/lib/servora-med/deploy/activation.block',current='/opt/servora-med/current';
  const policy='/etc/systemd/system/servora-med.service.d/90-servora-recovery.conf';
  const saved={env:readFileSync(envFile,'utf8'),backup:readFileSync(backupEnv,'utf8'),barrier:readFileSync(barrier),pointer:readlinkSync(current),policy:existsSync(policy)?readFileSync(policy):null};
  const db=freshAbortDatabase();
  writeAbortEnv(envFile,backupEnv,saved,db);
  try {
    return withRuntimeFixture(grant => {
      unlinkSync(barrier);if(existsSync(policy))unlinkSync(policy);
      unlinkSync(current);symlinkSync('/opt/servora-med/releases/'+grant.oldReleaseSha,current);
      spawnSync('/usr/bin/systemctl',['daemon-reload']);
      assert.equal(spawnSync('/usr/bin/systemctl',['start','servora-med.service']).status,0);
      for(let wait=0;wait<20;wait++){if(spawnSync('/usr/bin/curl',['--fail','--silent','https://r4.synthetic.invalid/api/health']).status===0)break;spawnSync('/usr/bin/sleep',['1']);}
      // Kill-window equivalent: sealed receipt durable, no fence event yet.
      admitAttempt(grant.attemptId);
      prepareRealBackup(grant);
      const sealed=readLatestCheckpoint(grant.attemptId).record;
      assert.equal(sealed.phase,'BACKED_UP');assert.match(sealed.predeployBackup.sha256,/^[0-9a-f]{64}$/);
      const dumpsBefore=readdirSync('/var/backups/servora-med').filter(x=>x.endsWith('.dump')).length;
      const result=spawnSync('/usr/local/libexec/servora-med/deploy-production-host',[
        '--phase','deploy','--sha',grant.releaseSha,
        '--artifact','/home/emrah.guest/r4-rehearsal/servora-med-'+grant.releaseSha+'.tar.gz',
        '--artifact-sha',grant.artifactSha256,'--fqdn','r4.synthetic.invalid','--allow-migrations','--attempt-id',grant.attemptId],{encoding:'utf8',timeout:120000});
      assert.equal(result.status,0,result.stdout+result.stderr);
      assert.match(result.stdout,/PREDEPLOY_BACKUP_RESUMED=RETAINED_RECEIPT_VERIFIED/);
      assert.equal(readdirSync('/var/backups/servora-med').filter(x=>x.endsWith('.dump')).length,dumpsBefore,'resume must not take a second predeploy dump');
      const journal=readLatestCheckpoint(grant.attemptId).record;
      assert.equal(journal.phase,'HEALTH_PASSED');assert.equal(journal.starts,1);
      assert.equal(journal.predeployBackup.sha256,sealed.predeployBackup.sha256,'the sealed receipt must be the same durable backup');
      console.log('BACKED_UP_RESUME_RETAINED_RECEIPT=PASS starts=1 dumps_delta=0');
    });
  } finally {
    spawnSync('/usr/bin/systemctl',['stop','servora-med.service']);
    writeFileSync(envFile,saved.env);writeFileSync(backupEnv,saved.backup);
    unlinkSync(current);symlinkSync(saved.pointer,current);writeFileSync(barrier,saved.barrier,{mode:0o600});
    if(saved.policy)writeFileSync(policy,saved.policy,{mode:0o600});else if(existsSync(policy))unlinkSync(policy);
    spawnSync('/usr/bin/systemctl',['daemon-reload']);
  }
});

test('an interrupted ADMITTED attempt or a failed predeploy backup can still cancel to OLD EXACT', () => {
  const envFile='/etc/servora-med/servora-med.env',backupEnv='/etc/servora-med/servora-med-backup.env';
  const barrier='/var/lib/servora-med/deploy/activation.block',current='/opt/servora-med/current';
  const policy='/etc/systemd/system/servora-med.service.d/90-servora-recovery.conf';
  const failDropIn='/etc/systemd/system/servora-med-predeploy-backup@.service.d';
  const saved={env:readFileSync(envFile,'utf8'),backup:readFileSync(backupEnv,'utf8'),barrier:readFileSync(barrier),pointer:readlinkSync(current),policy:existsSync(policy)?readFileSync(policy):null};
  try {
    for (const scenario of ['admitted-window','backup-failure']) {
      const db=freshAbortDatabase();
      writeAbortEnv(envFile,backupEnv,saved,db);
      if (scenario==='backup-failure') { mkdirSync(failDropIn,{mode:0o755});writeFileSync(failDropIn+'/90-r4-synthetic-failure.conf','[Service]\nExecStart=\nExecStart=/bin/false\n',{mode:0o644,flag:'wx'});spawnSync('/usr/bin/systemctl',['daemon-reload']); }
      try {
        withRuntimeFixture(grant => {
          if(existsSync(barrier))unlinkSync(barrier);if(existsSync(policy))unlinkSync(policy);
          unlinkSync(current);symlinkSync('/opt/servora-med/releases/'+grant.oldReleaseSha,current);
          spawnSync('/usr/bin/systemctl',['daemon-reload']);
          assert.equal(spawnSync('/usr/bin/systemctl',['start','servora-med.service']).status,0);
          for(let wait=0;wait<20;wait++){if(spawnSync('/usr/bin/curl',['--fail','--silent','https://r4.synthetic.invalid/api/health']).status===0)break;spawnSync('/usr/bin/sleep',['1']);}
          admitAttempt(grant.attemptId);
          if (scenario==='backup-failure') {
            const deploy=spawnSync('/usr/local/libexec/servora-med/deploy-production-host',[
              '--phase','deploy','--sha',grant.releaseSha,
              '--artifact','/home/emrah.guest/r4-rehearsal/servora-med-'+grant.releaseSha+'.tar.gz',
              '--artifact-sha',grant.artifactSha256,'--fqdn','r4.synthetic.invalid','--allow-migrations','--attempt-id',grant.attemptId],{encoding:'utf8',timeout:60000});
            assert.notEqual(deploy.status,0,deploy.stdout+deploy.stderr);
            assert.match(deploy.stderr,/PREDEPLOY_BACKUP_FAILED/);
            const stuck=readLatestCheckpoint(grant.attemptId).record;
            assert.equal(stuck.phase,'ADMITTED');assert.equal(stuck.predeployBackup,null);
            assert.equal(existsSync('/var/lib/servora-med/deploy/active.json'),true);
          }
          const abort=spawnSync('/usr/local/libexec/servora-med/deploy-production-host',[
            '--phase','pre-migration-abort','--attempt-id',grant.attemptId],{encoding:'utf8',timeout:90000});
          assert.equal(abort.status,0,abort.stdout+abort.stderr);
          assert.match(abort.stdout,/PRE_MIGRATION_ABORT=COMPLETE_OLD_EXACT/);
          const final=readLatestCheckpoint(grant.attemptId).record;
          assert.equal(final.phase,'COMPLETED_ABORT');assert.equal(final.abortStarts,1);assert.equal(final.starts,0);
          assert.equal(existsSync(barrier),false);assert.equal(existsSync('/var/lib/servora-med/deploy/active.json'),false);
          assert.equal(spawnSync('/usr/bin/systemctl',['is-active','servora-med.service'],{encoding:'utf8'}).stdout.trim(),'active');
          assert.equal(spawnSync('/usr/bin/systemctl',['show','servora-med.service','-p','Restart','--value'],{encoding:'utf8'}).stdout.trim(),'on-failure');
          console.log('EARLY_ABORT_'+scenario.replaceAll('-','_').toUpperCase()+'=COMPLETED_OLD_EXACT');
        });
      } finally {
        spawnSync('/usr/bin/systemctl',['stop','servora-med.service']);
      }
    }
  } finally {
    if (existsSync(failDropIn+'/90-r4-synthetic-failure.conf')) {unlinkSync(failDropIn+'/90-r4-synthetic-failure.conf');rmdirSync(failDropIn);}
    writeFileSync(envFile,saved.env);writeFileSync(backupEnv,saved.backup);
    unlinkSync(current);symlinkSync(saved.pointer,current);writeFileSync(barrier,saved.barrier,{mode:0o600});
    if(saved.policy)writeFileSync(policy,saved.policy,{mode:0o600});else if(existsSync(policy))unlinkSync(policy);
    spawnSync('/usr/bin/systemctl',['daemon-reload']);
  }
});

test('a grant missing downstream scopes is rejected before any backup, mutation or claim', () => withRuntimeFixture(grant => {
  const envFile='/etc/servora-med/servora-med.env',backupEnv='/etc/servora-med/servora-med-backup.env';
  const current='/opt/servora-med/current';
  const saved={env:readFileSync(envFile,'utf8'),backup:readFileSync(backupEnv,'utf8'),pointer:readlinkSync(current)};
  writeFileSync(envFile,alignIdentityEnvironment(saved.env,grant.oldCatalog.at(-1).version,grant.oldReleaseSha));
  unlinkSync(current);symlinkSync('/opt/servora-med/releases/'+grant.oldReleaseSha,current);
  try {
    for (const override of [{allowForwardRecovery:false},{allowPostdeployBackup:false}]) {
      const scoped={...grant,...override};
      writeFileSync(`/var/lib/servora-med/deploy/approvals/${grant.attemptId}.json`,JSON.stringify(scoped)+'\n');
      const pid=spawnSync('/usr/bin/systemctl',['show','servora-med.service','-p','MainPID','--value'],{encoding:'utf8'}).stdout;
      const dumps=readdirSync('/var/backups/servora-med').filter(x=>x.endsWith('.dump')).length;
      const result=spawnSync('/usr/local/libexec/servora-med/deploy-production-host',[
        '--phase','deploy','--sha',grant.releaseSha,
        '--artifact','/home/emrah.guest/r4-rehearsal/servora-med-'+grant.releaseSha+'.tar.gz',
        '--artifact-sha',grant.artifactSha256,'--fqdn','r4.synthetic.invalid','--allow-migrations','--attempt-id',grant.attemptId],{encoding:'utf8',timeout:30000});
      assert.notEqual(result.status,0,result.stdout+result.stderr);
      assert.match(result.stderr,/ATTEMPT_DEPLOYMENT_SCOPES_INCOMPLETE/);
      assert.equal(existsSync('/var/lib/servora-med/deploy/active.json'),false,'no ownership claim for an unfinishable grant');
      assert.equal(existsSync('/var/lib/servora-med/deploy/attempts/'+grant.attemptId),false,'no journal for an unfinishable grant');
      assert.equal(readdirSync('/var/backups/servora-med').filter(x=>x.endsWith('.dump')).length,dumps);
      assert.equal(spawnSync('/usr/bin/systemctl',['show','servora-med.service','-p','MainPID','--value'],{encoding:'utf8'}).stdout,pid);
      console.log('SCOPE_INCOMPLETE_DENIED='+JSON.stringify(override));
    }
  } finally {
    writeFileSync(`/var/lib/servora-med/deploy/approvals/${grant.attemptId}.json`,JSON.stringify(grant)+'\n');
    writeFileSync(envFile,saved.env);writeFileSync(backupEnv,saved.backup);
    unlinkSync(current);symlinkSync(saved.pointer,current);
  }
}));

test('no smoke, postdeploy or completion can bypass a durable schema-check result', () => withRuntimeFixture(async grant => {
  const envFile='/etc/servora-med/servora-med.env',barrier='/var/lib/servora-med/deploy/activation.block';
  const current='/opt/servora-med/current';
  const policy='/etc/systemd/system/servora-med.service.d/90-servora-recovery.conf';
  const failDropIn='/etc/systemd/system/servora-med-postdeploy-backup.service.d';
  const envBefore=readFileSync(envFile,'utf8'),barrierBefore=readFileSync(barrier),pointerBefore=readlinkSync(current);
  const policyBefore=existsSync(policy)?readFileSync(policy):null;
  admitAttempt(grant.attemptId);
  prepareRealBackup(grant);
  try {
    unlinkSync(barrier);createAttemptBarrier(grant.attemptId);
    checkpointAttempt(grant.attemptId,'FENCED');
    checkpointAttempt(grant.attemptId,{kind:'MIGRATION_INTENT',baseline:readDatabaseInvariants()});
    writeFileSync(envFile,alignIdentityEnvironment(envBefore,grant.oldCatalog.at(-1).version,grant.oldReleaseSha));
    unlinkSync(current);symlinkSync('/opt/servora-med/releases/'+grant.oldReleaseSha,current);
    const recovered=spawnSync('/usr/local/libexec/servora-med/deploy-production-host',['--phase','forward-recovery','--attempt-id',grant.attemptId],{encoding:'utf8',timeout:90000});
    assert.equal(recovered.status,0,recovered.stdout+recovered.stderr);
    let journal=readLatestCheckpoint(grant.attemptId).record;
    assert.equal(journal.phase,'HEALTH_PASSED');assert.equal(journal.starts,1);assert.equal(journal.schemaChecked,false);
    // The exact review window: no durable schema result yet. Postdeploy must
    // fail before running any backup or reaching smoke/observation.
    mkdirSync(failDropIn,{mode:0o755});
    writeFileSync(failDropIn+'/90-r4-synthetic-failure.conf','[Service]\nExecStart=\nExecStart=/bin/false\n',{mode:0o644,flag:'wx'});
    spawnSync('/usr/bin/systemctl',['daemon-reload']);
    try {
      const invocationBefore=spawnSync('/usr/bin/systemctl',['show','servora-med-postdeploy-backup.service','-p','InvocationID','--value'],{encoding:'utf8'}).stdout.trim();
      const gate=spawnSync('/usr/local/libexec/servora-med/deploy-production-host',['--phase','postdeploy','--sha',grant.releaseSha,'--fqdn','r4.synthetic.invalid','--attempt-id',grant.attemptId],{encoding:'utf8',timeout:30000});
      assert.notEqual(gate.status,0,gate.stdout+gate.stderr);
      assert.match(gate.stderr,/DEPLOYMENT_STATE_INVALID/);
      journal=readLatestCheckpoint(grant.attemptId).record;
      assert.equal(journal.phase,'HEALTH_PASSED','the failed gate must not advance the journal');
      assert.equal(journal.schemaChecked,false);
      assert.equal(journal.postdeployBackup,null);
      assert.equal(spawnSync('/usr/bin/systemctl',['show','servora-med-postdeploy-backup.service','-p','InvocationID','--value'],{encoding:'utf8'}).stdout.trim(),invocationBefore,'no new postdeploy backup invocation may be made');
    } finally { unlinkSync(failDropIn+'/90-r4-synthetic-failure.conf');rmdirSync(failDropIn);spawnSync('/usr/bin/systemctl',['daemon-reload']); }
    // Re-entry runs the sealed release's own fresh check and records it durably.
    const reentry=spawnSync('/usr/local/libexec/servora-med/deploy-production-host',['--phase','forward-recovery','--attempt-id',grant.attemptId],{encoding:'utf8',timeout:90000});
    assert.equal(reentry.status,0,reentry.stdout+reentry.stderr);
    assert.match(reentry.stdout,/FORWARD_RECOVERY=HEALTH_PASSED_PENDING_ACCEPTANCE/);
    journal=readLatestCheckpoint(grant.attemptId).record;
    assert.equal(journal.phase,'HEALTH_PASSED');assert.equal(journal.schemaChecked,true);assert.equal(journal.starts,1);
    // Direct helper contract: healthy env passes, a mismatched pin fails closed.
    const mod=await import('../scripts/deployment-controller.mjs');
    if (typeof mod.runTargetSchemaCheck !== 'function') assert.fail('runTargetSchemaCheck export missing');
    assert.doesNotThrow(()=>mod.runTargetSchemaCheck({approval:grant}));
    const pin=readFileSync(envFile,'utf8');
    writeFileSync(envFile,pin.replace(/^HEALTH_SCHEMA_VERSION=.*$/m,'HEALTH_SCHEMA_VERSION='+grant.oldCatalog.at(-1).version));
    try { assert.throws(()=>mod.runTargetSchemaCheck({approval:grant}),/RECOVERY_SCHEMA_CHECK_FAILED/); }
    finally { writeFileSync(envFile,pin); }
    console.log('SCHEMA_GATE_DURABLE=PASS reentry_recorded=PASS mismatch_fail_closed=PASS');
  } finally {
    spawnSync('/usr/bin/systemctl',['stop','servora-med.service']);revokeStartPermit(grant.attemptId);
    writeFileSync(envFile,envBefore);unlinkSync(current);symlinkSync(pointerBefore,current);
    writeFileSync(barrier,barrierBefore,{mode:0o600});
    if(policyBefore)writeFileSync(policy,policyBefore,{mode:0o600});else if(existsSync(policy))unlinkSync(policy);
    spawnSync('/usr/bin/systemctl',['daemon-reload']);
  }
}));

test('a completed attempt confirms read-only through preflight and recovery without mutation', () => {
  const envFile='/etc/servora-med/servora-med.env',barrier='/var/lib/servora-med/deploy/activation.block';
  const current='/opt/servora-med/current';
  const policy='/etc/systemd/system/servora-med.service.d/90-servora-recovery.conf';
  const saved={env:readFileSync(envFile,'utf8'),barrier:readFileSync(barrier),pointer:readlinkSync(current),policy:existsSync(policy)?readFileSync(policy):null};
  let observationEnv=saved.env;
  if(!observationEnv.includes('BACKUP_PROVIDER=host-observation')) {
    observationEnv=observationEnv.replace(/^BACKUP_PROVIDER=.*$/m,'BACKUP_PROVIDER=host-observation');
    if(!observationEnv.includes('BACKUP_PROVIDER=')) observationEnv+='BACKUP_PROVIDER=host-observation\n';
  }
  if(!observationEnv.includes('BACKUP_OBSERVATION_PATH=')) observationEnv+='BACKUP_OBSERVATION_PATH=/var/lib/servora-med-backup/observation-v1.json\n';
  writeFileSync(envFile,observationEnv);
  try {
    return withRuntimeFixture(grant => {
      admitAttempt(grant.attemptId);
      prepareRealBackup(grant);
      unlinkSync(barrier);createAttemptBarrier(grant.attemptId);
      checkpointAttempt(grant.attemptId,'FENCED');
      checkpointAttempt(grant.attemptId,{kind:'MIGRATION_INTENT',baseline:readDatabaseInvariants()});
      writeFileSync(envFile,alignIdentityEnvironment(observationEnv,grant.oldCatalog.at(-1).version,grant.oldReleaseSha));
      unlinkSync(current);symlinkSync('/opt/servora-med/releases/'+grant.oldReleaseSha,current);
      const recovered=spawnSync('/usr/local/libexec/servora-med/deploy-production-host',['--phase','forward-recovery','--attempt-id',grant.attemptId],{encoding:'utf8',timeout:90000});
      assert.equal(recovered.status,0,recovered.stdout+recovered.stderr);
      assert.equal(spawnSync('/usr/bin/systemctl',['start','servora-med-backup.service']).status,0,'scheduled heartbeat required for backup health');
      checkpointAttempt(grant.attemptId,'SCHEMA_CHECKED');
      checkpointAttempt(grant.attemptId,'SMOKE_PASSED');
      checkpointAttempt(grant.attemptId,'POSTDEPLOY_BACKUP_INTENT');
      const postPayload=Buffer.from('synthetic retained postdeploy receipt');
      const postSha=createHash('sha256').update(postPayload).digest('hex');
      mkdirSync('/var/lib/servora-med/deploy/backups',{recursive:true,mode:0o700});
      writeFileSync('/var/lib/servora-med/deploy/backups/'+grant.attemptId+'-post.dump',postPayload,{mode:0o600});
      checkpointAttempt(grant.attemptId,{kind:'POSTDEPLOY_BACKUP_PASSED',receipt:{sha256:postSha,completedAtUTC:new Date().toISOString()}});
      checkpointAttempt(grant.attemptId,{kind:'OBSERVATION_PASSED',elapsedSeconds:1800});
      const finished=spawnSync('/usr/local/libexec/servora-med/deploy-production-host',['--phase','postdeploy','--sha',grant.releaseSha,'--fqdn','r4.synthetic.invalid','--attempt-id',grant.attemptId],{encoding:'utf8',timeout:60000});
      assert.equal(finished.status,0,finished.stdout+finished.stderr);
      const journal=readLatestCheckpoint(grant.attemptId).record;
      assert.equal(journal.phase,'COMPLETED');
      assert.equal(existsSync('/var/lib/servora-med/deploy/active.json'),false);
      assert.equal(existsSync(barrier),false);
      assert.equal(existsSync(policy),false);
      const pid=spawnSync('/usr/bin/systemctl',['show','servora-med.service','-p','MainPID','--value'],{encoding:'utf8'}).stdout;
      const dumps=readdirSync('/var/backups/servora-med').filter(x=>x.endsWith('.dump')).length;
      // The documented rerun: preflight must project the read-only confirmation
      // mode instead of rejecting the existing attempt directory.
      const preflight=spawnSync('/usr/local/libexec/servora-med/deploy-production-host',['--phase','attempt-preflight','--attempt-id',grant.attemptId],{encoding:'utf8',timeout:30000});
      assert.equal(preflight.status,0,preflight.stdout+preflight.stderr);
      assert.equal(JSON.parse(preflight.stdout).mode,'forward-recovery');
      const confirm=spawnSync('/usr/local/libexec/servora-med/deploy-production-host',['--phase','forward-recovery','--attempt-id',grant.attemptId],{encoding:'utf8',timeout:60000});
      assert.equal(confirm.status,0,confirm.stdout+confirm.stderr);
      assert.match(confirm.stdout,/FORWARD_RECOVERY=ALREADY_COMPLETED_READ_ONLY/);
      assert.equal(readLatestCheckpoint(grant.attemptId).record.starts,journal.starts,'confirmation must never spend a start');
      assert.equal(spawnSync('/usr/bin/systemctl',['show','servora-med.service','-p','MainPID','--value'],{encoding:'utf8'}).stdout,pid,'no service restart during read-only confirmation');
      assert.equal(readdirSync('/var/backups/servora-med').filter(x=>x.endsWith('.dump')).length,dumps,'no backup during read-only confirmation');
      console.log('COMPLETED_PREFLIGHT_READ_ONLY=PASS starts_unchanged=PASS pid_unchanged=PASS');
    });
  } finally {
    spawnSync('/usr/bin/systemctl',['stop','servora-med.service']);
    writeFileSync(envFile,saved.env);unlinkSync(current);symlinkSync(saved.pointer,current);
    writeFileSync(barrier,saved.barrier,{mode:0o600});
    if(saved.policy)writeFileSync(policy,saved.policy,{mode:0o600});else if(existsSync(policy))unlinkSync(policy);
    spawnSync('/usr/bin/systemctl',['daemon-reload']);
  }
});
