import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {timeEvidenceAt} from './trusted-time-fixture.mjs';
import { elapsedTime, elapsedBootTime, parseSynchronization, evidenceFromLinuxReads, validateTimeEvidence, validateCurrentTimeEvidence } from '../scripts/trusted-time.mjs';

export const timeEvidence = (elapsed = 0, overrides = {}) => ({
  formatVersion: 1, source: 'linux-boottime',
  bootId: '11111111-1111-4111-8111-111111111111', timeNamespaceId: 'time:[4026531834]',
  bootLowerMs: 100000 + elapsed, bootUpperMs: 100000 + elapsed,
  wallAtUTC: new Date(Date.parse('2026-10-12T09:00:00.000Z') + elapsed).toISOString(),
  wallResolutionMs: 1,
  synchronization: { service: 'chrony', referenceAgeMs: 1000, rootDistanceMs: 1,
    correctionMs: 0, sourceCount: 2 },
  ...overrides,
});

test('TT-B: boot bounds remain available for a proven stale denial when UTC conflicts',()=>{
  const current=timeEvidence(27*3600000,{wallAtUTC:timeEvidence(25*3600000).wallAtUTC});
  assert.deepEqual(elapsedBootTime(timeEvidence(),current),{status:'KNOWN',lowerMs:27*3600000,upperMs:27*3600000});
  assert.deepEqual(elapsedTime(timeEvidence(),current),{status:'UNKNOWN'});
});

test('TT-01: wall rollback is UNKNOWN against the original persisted boot anchor', () => {
  assert.deepEqual(elapsedTime(timeEvidence(), timeEvidence(10800001, {
    wallAtUTC: timeEvidence(1000).wallAtUTC,
  })), { status: 'UNKNOWN' });
});

test('TT-02: a legacy two-source live report cannot establish new authenticated authority', () => {
  const now = Date.parse('2026-10-12T09:00:00.000Z');
  const tracking = `01020304,time.ume.tubitak.gov.tr,2,${now/1000-1},0.000001,0,0,0,0,0,0.002,0.001,64,Normal`;
  const sources = '^,*,time.ume.tubitak.gov.tr,1,6,377,1,0,0,0\n^,+,time.cloudflare.com,3,6,377,1,0,0,0\n';
  assert.throws(()=>parseSynchronization(tracking,sources,now),/TRUSTED_TIME_UNKNOWN/);
  for (const invalid of [sources.replace(',+,',',?,'),sources.replace('time.cloudflare.com','attacker.invalid'),'',sources+sources]) {
    assert.throws(()=>parseSynchronization(tracking,invalid,now),/TRUSTED_TIME_UNKNOWN/);
  }
  assert.throws(()=>parseSynchronization(tracking.replace(',Normal',',Not synchronised'),sources,now),/TRUSTED_TIME_UNKNOWN/);
});

test('TT-03: Linux uptime brackets preserve quantization and reject boot/namespace changes', () => {
  const sample=timeEvidenceAt();
  const reads={bootBefore:sample.bootId,bootAfter:sample.bootId,namespaceBefore:sample.timeNamespaceId,
    namespaceAfter:sample.timeNamespaceId,uptimeBefore:'100.00 1.00\n',uptimeAfter:'100.01 1.00\n',
    wallAtUTC:sample.wallAtUTC,synchronization:sample.synchronization};
  const evidence=evidenceFromLinuxReads(reads);
  assert.equal(evidence.bootLowerMs,100000);assert.equal(evidence.bootUpperMs,100020);
  assert.deepEqual(elapsedTime(evidence,{...evidence,bootLowerMs:100050,bootUpperMs:100080,
    wallAtUTC:new Date(Date.parse(sample.wallAtUTC)+60).toISOString()}),{status:'KNOWN',lowerMs:30,upperMs:80});
  for(const invalid of [{bootAfter:'22222222-2222-4222-8222-222222222222'},
    {namespaceAfter:'time:[9]'},{uptimeAfter:'99.00 1.00'},{uptimeBefore:'NaN 0'},
    {uptimeBefore:'1e6 0'},{uptimeBefore:'100.000 0'}])assert.throws(()=>evidenceFromLinuxReads({...reads,...invalid}),/TRUSTED_TIME_UNKNOWN/);
});

test('TT-04: historical Ubuntu two-source tracking is not sufficient new packet evidence',()=>{
  const tracking='C21BDE05,time.ume.tubitak.gov.tr,2,1793016588.506463721,-0.000010336,-0.012481262,0.012481262,4.911,-9.364,259.424,0.035545181,0.019027820,64.1,Normal';
  const sources='^,*,time.ume.tubitak.gov.tr,1,6,37,60,-0.000239742,-0.012717556,0.019729888\n^,-,time.cloudflare.com,3,6,37,57,0.012002185,0.012002185,0.033609279';
  assert.throws(()=>parseSynchronization(tracking,sources,1793016650000),/TRUSTED_TIME_UNKNOWN/);
});

const ntsNames=['time.cloudflare.com','bevtime1.metrologie.at','1.ntp.ubuntu.com'];
const monitor='time.ume.tubitak.gov.tr';
function multiReads() {
  const now=Date.parse('2026-10-30T00:00:00.000Z');
  const states=['*','+','-','?'];
  const names=[...ntsNames,monitor];
  return {now,tracking:`01020304,${ntsNames[0]},4,${now/1000-1},0.000001,0,0,0,0,0,0.002,0.001,64,Normal`,
    sources:names.map((name,i)=>`^,${states[i]},${name},3,6,377,1,0,0,0`).join('\n'),
    details:{config:readFileSync(new URL('../chrony/servora-med.conf.example',import.meta.url),'utf8'),
      selectdata:names.map((name,i)=>`${i===3?'N':i===2?'D':states[i]} ${name} ${i===3?'N':'Y'} ${i===3?'N----':'-----'} ${i===3?'N----':'-----'} 1 1.0 -10ms +10ms N`).join('\n'),
      authdata:names.map((name,i)=>`${name} ${i===3?'-':'NTS'} 1 30 128 10 0 0 8 64`).join('\n'),
      packets:ntsNames.map((name,i)=>({name,address:`192.0.2.${i+1}`,data:`Remote address  : 192.0.2.${i+1} (01020304)\nRemote port     : 123\nLeap status     : Normal\nVersion         : 4\nMode            : Server\nAuthenticated   : Yes\nNTP tests       : 111 111 1111\nTotal good RX   : 1\n`}))}};
}
const parseMulti=r=>parseSynchronization(r.tracking,r.sources,r.now,r.details);
test('OPS-TT-003: three authenticated selectable operators produce truthful quorum evidence',()=>{
  const sync=parseMulti(multiReads());
  assert.equal(sync.sourceCount,3);
  assert.equal(sync.sourcePolicy,'nts-quorum-v1');
  assert.equal(sync.authenticatedSourceCount,3);
});

test('OPS-TT-003: losing one NTS operator still permits two authenticated selectable operators',()=>{
  const r=multiReads();
  r.sources=r.sources.replace('^,+,bevtime1.metrologie.at,3,6,377,1', '^,?,bevtime1.metrologie.at,0,6,0,9999');
  r.details.selectdata=r.details.selectdata.replace('+ bevtime1.metrologie.at','? bevtime1.metrologie.at');
  r.details.packets=r.details.packets.filter(p=>p.name!=='bevtime1.metrologie.at');
  const sync=parseMulti(r);
  assert.equal(sync.sourceCount,2);
  assert.deepEqual(sync.selectableSources,['1.ntp.ubuntu.com','time.cloudflare.com']);
});

test('OPS-TT-003 denial: one selectable cannot authorize',()=>{const r=multiReads();r.sources=r.sources.replace('^,+,','^,?,').replace('^,-,','^,?,');r.details.selectdata=r.details.selectdata.replace('+ bev','? bev').replace('D 1.ntp','? 1.ntp');assert.throws(()=>parseMulti(r),/TRUSTED_TIME_UNKNOWN/);});

test('OPS-TT-003 denial: packet authentication loss denies despite cookies',()=>{const r=multiReads();r.details.packets[1].data=r.details.packets[1].data.replace('Authenticated   : Yes','Authenticated   : No');assert.throws(()=>parseMulti(r),/TRUSTED_TIME_UNKNOWN/);});

test('OPS-TT-003 denial: symmetric authentication is not NTS',()=>{const r=multiReads();r.details.authdata=r.details.authdata.replace('NTS','SK');assert.throws(()=>parseMulti(r),/TRUSTED_TIME_UNKNOWN/);});

test('OPS-TT-003 denial: UME cannot be selected',()=>{const r=multiReads();r.sources=r.sources.replace('^,*,','^,+,').replace('^,?,time.ume','^,*,time.ume');r.tracking=r.tracking.replace('time.cloudflare.com','time.ume.tubitak.gov.tr');assert.throws(()=>parseMulti(r),/TRUSTED_TIME_UNKNOWN/);});

test('OPS-TT-003 denial: duplicate source denies',()=>{const r=multiReads();r.sources=r.sources.replace('bevtime1.metrologie.at','time.cloudflare.com');assert.throws(()=>parseMulti(r),/TRUSTED_TIME_UNKNOWN/);});

test('OPS-TT-003 denial: foreign source denies',()=>{const r=multiReads();r.sources=r.sources.replace('bevtime1.metrologie.at','attacker.invalid');assert.throws(()=>parseMulti(r),/TRUSTED_TIME_UNKNOWN/);});

test('OPS-TT-003 denial: missing selected denies',()=>{const r=multiReads();r.sources=r.sources.replace('^,*,','^,+,');assert.throws(()=>parseMulti(r),/TRUSTED_TIME_UNKNOWN/);});

test('OPS-TT-003 denial: multiple selected denies',()=>{const r=multiReads();r.sources=r.sources.replace('^,+,','^,*,');assert.throws(()=>parseMulti(r),/TRUSTED_TIME_UNKNOWN/);});

test('OPS-TT-003 denial: falseticker denies',()=>{const r=multiReads();r.sources=r.sources.replace('^,-,','^,x,');assert.throws(()=>parseMulti(r),/TRUSTED_TIME_UNKNOWN/);});

test('OPS-TT-003 denial: unreachable falseticker denies',()=>{const r=multiReads();r.sources=r.sources.replace('^,-,','^,?,');r.details.selectdata=r.details.selectdata.replace('D 1.ntp','x 1.ntp');assert.throws(()=>parseMulti(r),/TRUSTED_TIME_UNKNOWN/);});

test('OPS-TT-003 denial: trusted-source disagreement denies',()=>{const r=multiReads();r.sources=r.sources.replace('^,-,','^,?,');r.details.selectdata=r.details.selectdata.replace('D 1.ntp','T 1.ntp');assert.throws(()=>parseMulti(r),/TRUSTED_TIME_UNKNOWN/);});

test('OPS-TT-003 denial: excess jitter denies',()=>{const r=multiReads();r.sources=r.sources.replace('^,-,','^,~,');assert.throws(()=>parseMulti(r),/TRUSTED_TIME_UNKNOWN/);});

test('OPS-TT-003 denial: bad tracking denies',()=>{const r=multiReads();r.tracking=r.tracking.replace('Normal','Not synchronised');assert.throws(()=>parseMulti(r),/TRUSTED_TIME_UNKNOWN/);});

test('OPS-TT-003 denial: stale reference denies',()=>{const r=multiReads();r.now+=768000;assert.throws(()=>parseMulti(r),/TRUSTED_TIME_UNKNOWN/);});

test('OPS-TT-003 denial: excess root distance denies',()=>{const r=multiReads();r.tracking=r.tracking.replace('0.002,0.001','2,0.001');assert.throws(()=>parseMulti(r),/TRUSTED_TIME_UNKNOWN/);});

test('OPS-TT-003 denial: excess correction denies',()=>{const r=multiReads();r.tracking=r.tracking.replace('0.000001','0.101');assert.throws(()=>parseMulti(r),/TRUSTED_TIME_UNKNOWN/);});

test('OPS-TT-003 denial: config trust drift denies',()=>{const r=multiReads();r.details.config=r.details.config.replace('iburst nts','iburst nts trust require');assert.throws(()=>parseMulti(r),/TRUSTED_TIME_UNKNOWN/);});

test('OPS-TT-003 denial: effective policy drift denies',()=>{const r=multiReads();r.details.selectdata=r.details.selectdata.replace('----- -----','----- --TR-');assert.throws(()=>parseMulti(r),/TRUSTED_TIME_UNKNOWN/);});

test('OPS-TT-003 denial: explicit configured trust denies',()=>{const r=multiReads();r.details.selectdata=r.details.selectdata.replace('----- -----','--TR- -----');assert.throws(()=>parseMulti(r),/TRUSTED_TIME_UNKNOWN/);});

test('OPS-TT-003 denial: monitor loses noselect denies',()=>{const r=multiReads();r.details.selectdata=r.details.selectdata.replace('N---- N----','N---- -----');assert.throws(()=>parseMulti(r),/TRUSTED_TIME_UNKNOWN/);});

test('OPS-TT-003 denial: duplicate packet source denies',()=>{const r=multiReads();r.details.packets.push(r.details.packets[0]);assert.throws(()=>parseMulti(r),/TRUSTED_TIME_UNKNOWN/);});

test('OPS-TT-003 denial: aliased packet address denies',()=>{const r=multiReads();r.details.packets[1].address=r.details.packets[0].address;assert.throws(()=>parseMulti(r),/TRUSTED_TIME_UNKNOWN/);});

test('OPS-TT-003 denial: packet remote mismatch denies',()=>{const r=multiReads();r.details.packets[0].data=r.details.packets[0].data.replace('192.0.2.1','192.0.2.9');assert.throws(()=>parseMulti(r),/TRUSTED_TIME_UNKNOWN/);});

test('OPS-TT-003 denial: invalid packet tests deny',()=>{const r=multiReads();r.details.packets[0].data=r.details.packets[0].data.replace('111 111 1111','111 111 1011');assert.throws(()=>parseMulti(r),/TRUSTED_TIME_UNKNOWN/);});

test('OPS-TT-003 denial: missing packet authentication denies',()=>{const r=multiReads();r.details.packets[0].data=r.details.packets[0].data.replace('Authenticated   : Yes\n','');assert.throws(()=>parseMulti(r),/TRUSTED_TIME_UNKNOWN/);});

test('OPS-TT-003 denial: duplicate packet fields deny',()=>{const r=multiReads();r.details.packets[0].data+='Authenticated   : Yes\n';assert.throws(()=>parseMulti(r),/TRUSTED_TIME_UNKNOWN/);});

test('OPS-TT-003: actual chrony human selectdata interval units are parsed as bounded seconds',()=>{
  const r=multiReads();
  r.details.selectdata=r.details.selectdata.replaceAll('-10ms +10ms','-10000us +10000000ns');
  assert.equal(parseMulti(r).sourceCount,3);
});

test('OPS-TT-003: disjoint selectable intervals cannot establish agreement',()=>{
  const r=multiReads();
  r.details.selectdata=r.details.selectdata.replace('+ bevtime1.metrologie.at Y ----- ----- 1 1.0 -10ms +10ms',
    '+ bevtime1.metrologie.at Y ----- ----- 1 1.0 +20ms +30ms')
    .replace('D 1.ntp.ubuntu.com Y ----- ----- 1 1.0 -10ms +10ms','D 1.ntp.ubuntu.com Y ----- ----- 1 1.0 +20ms +30ms');
  assert.throws(()=>parseMulti(r),/TRUSTED_TIME_UNKNOWN/);
});

test('OPS-TT-003: tracking reference identity must match the selected packet source',()=>{
  const r=multiReads();r.tracking=r.tracking.replace('01020304','12345678');
  assert.throws(()=>parseMulti(r),/TRUSTED_TIME_UNKNOWN/);
});

test('OPS-TT-003: a cold unavailable operator without an established NTS session cannot veto two valid voters',()=>{
  const r=multiReads();
  r.sources=r.sources.replace('^,+,bevtime1.metrologie.at,3,6,377,1','^,?,bevtime1.metrologie.at,0,6,0,9999');
  r.details.selectdata=r.details.selectdata.replace('+ bevtime1.metrologie.at Y','? bevtime1.metrologie.at N');
  r.details.authdata=r.details.authdata.replace('bevtime1.metrologie.at NTS','bevtime1.metrologie.at -');
  r.details.packets=r.details.packets.filter(p=>p.name!=='bevtime1.metrologie.at');
  assert.equal(parseMulti(r).sourceCount,2);
});

test('OPS-TT-003: unavailable is not permission to accept a malformed source record',()=>{
  const r=multiReads();
  r.sources=r.sources.replace('^,+,bevtime1.metrologie.at,3,6,377,1','^,?,bevtime1.metrologie.at,0,6,invalid,9999');
  r.details.selectdata=r.details.selectdata.replace('+ bevtime1.metrologie.at','? bevtime1.metrologie.at');
  assert.throws(()=>parseMulti(r),/TRUSTED_TIME_UNKNOWN/);
});

test('OPS-TT-003: zero-reach nonselected source cannot veto two remaining authenticated voters',()=>{
  const r=multiReads();
  r.sources=r.sources.replace('^,-,1.ntp.ubuntu.com,3,6,377,1','^,-,1.ntp.ubuntu.com,3,6,0,900');
  r.details.packets=r.details.packets.filter(p=>p.name!=='1.ntp.ubuntu.com');
  assert.equal(parseMulti(r).sourceCount,2);
});

test('OPS-TT-003: selected-source reach loss always denies even with two other valid operators',()=>{
  const r=multiReads();r.sources=r.sources.replace('^,*,time.cloudflare.com,3,6,377,1','^,*,time.cloudflare.com,3,6,0,900');
  assert.throws(()=>parseMulti(r),/TRUSTED_TIME_UNKNOWN/);
});

test('OPS-TT-003: changing a legacy format number cannot manufacture new quorum evidence',()=>{
  const legacy=timeEvidence();
  assert.equal(validateTimeEvidence(legacy),legacy);
  assert.throws(()=>validateCurrentTimeEvidence(legacy),/TRUSTED_TIME_UNKNOWN/);
  assert.throws(()=>validateTimeEvidence({...legacy,formatVersion:2}),/TRUSTED_TIME_UNKNOWN/);
});
