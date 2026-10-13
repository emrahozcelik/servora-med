/** Resume only the owned interruption fixture on the authorized disposable VM. */
import assert from 'node:assert/strict';
import {hostname} from 'node:os';
import {readFileSync,writeFileSync,readlinkSync,unlinkSync,symlinkSync,existsSync,readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {readLatestCheckpoint} from '../scripts/deployment-attempt.mjs';
assert.equal(hostname(),'lima-servora-r4-20261012');assert.equal(process.getuid(),0);
const state='/var/lib/servora-med/deploy',file='/var/lib/servora-med/r4-final-reboot-current.json';
const record=JSON.parse(readFileSync(file));assert.ok(['admission','accepted','abort'].includes(record.kind));
assert.notEqual(readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(),record.bootId);
assert.equal(JSON.parse(readFileSync(state+'/active.json')).attemptId,record.attemptId);
const run=(cmd,args)=>spawnSync(cmd,args,{encoding:'utf8',timeout:90000});
const pid=run('/usr/bin/systemctl',['show','servora-med.service','-p','MainPID','--value']).stdout.trim();
// Ordinary systemd boot is permitted after accepted handoff. Compare the PID
// before/after the post-boot confirmation, never across different boot IDs.
assert.notEqual(pid,'0');
const before=record.kind==='admission'?null:readLatestCheckpoint(record.attemptId).record;
const command=record.kind==='admission'
 ? ['/usr/bin/node',['/usr/local/libexec/servora-med/deployment-controller.mjs','admit',record.attemptId]]
 : ['/usr/local/libexec/servora-med/deploy-production-host',['--phase',record.kind==='abort'?'pre-migration-abort':'forward-recovery','--attempt-id',record.attemptId]];
const result=run(...command);assert.equal(result.status,0,result.stderr);console.log(result.stdout.trim());
const after=readLatestCheckpoint(record.attemptId).record;
assert.equal(after.phase,record.kind==='admission'?'ADMITTED':record.kind==='abort'?'COMPLETED_ABORT':'COMPLETED');
assert.equal(after.starts,before?.starts??0);assert.equal(after.abortStarts,before?.abortStarts??0);
assert.equal(run('/usr/bin/systemctl',['show','servora-med.service','-p','MainPID','--value']).stdout.trim(),pid);
assert.equal(readdirSync('/var/backups/servora-med').length,record.dumps);
console.log('REAL_INTERRUPTION_REBOOT=PASS kind='+record.kind+' pid_after_boot_unchanged=PASS starts_unchanged=PASS backups_unchanged=PASS');
// Owned non-production teardown: preserve grant, journal and a private reboot
// record; never recover an unknown production owner or reset its journal.
run('/usr/bin/systemctl',['stop','servora-med.service']);
if(existsSync(state+'/active.json')){assert.equal(JSON.parse(readFileSync(state+'/active.json')).attemptId,record.attemptId);unlinkSync(state+'/active.json');}
writeFileSync('/etc/servora-med/servora-med.env',record.saved.env);
writeFileSync('/etc/servora-med/servora-med-backup.env',record.saved.backup);
unlinkSync('/opt/servora-med/current');symlinkSync(record.saved.pointer,'/opt/servora-med/current');
writeFileSync(state+'/activation.block',record.saved.barrier,{mode:0o600});
writeFileSync('/etc/systemd/system/servora-med.service.d/90-servora-recovery.conf',record.saved.policy,{mode:0o600});
if(record.saved.profile)writeFileSync(state+'/profile.json',record.saved.profile);else unlinkSync(state+'/profile.json');
assert.equal(run('/usr/bin/systemctl',['daemon-reload']).status,0);
writeFileSync('/var/lib/servora-med/r4-final-test-snapshots/'+record.attemptId+'-reboot.json',JSON.stringify(record)+'\n',{mode:0o600,flag:'wx'});
unlinkSync(file);
