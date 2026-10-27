import assert from 'node:assert/strict';
import test from 'node:test';
import { elapsedTime, elapsedBootTime, parseSynchronization, evidenceFromLinuxReads } from '../scripts/trusted-time.mjs';

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

test('TT-02: chrony requires two named selectable sources and bounded tracking health', () => {
  const now = Date.parse('2026-10-12T09:00:00.000Z');
  const tracking = `01020304,time.ume.tubitak.gov.tr,2,${now/1000-1},0.000001,0,0,0,0,0,0.002,0.001,64,Normal`;
  const sources = '^,*,time.ume.tubitak.gov.tr,1,6,377,1,0,0,0\n^,+,time.cloudflare.com,3,6,377,1,0,0,0\n';
  assert.equal(parseSynchronization(tracking,sources,now).sourceCount,2);
  for (const invalid of [sources.replace(',+,',',?,'),sources.replace('time.cloudflare.com','attacker.invalid'),'',sources+sources]) {
    assert.throws(()=>parseSynchronization(tracking,invalid,now),/TRUSTED_TIME_UNKNOWN/);
  }
  assert.throws(()=>parseSynchronization(tracking.replace(',Normal',',Not synchronised'),sources,now),/TRUSTED_TIME_UNKNOWN/);
});

test('TT-03: Linux uptime brackets preserve quantization and reject boot/namespace changes', () => {
  const sample=timeEvidence();
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

test('TT-04: actual Ubuntu chrony 4.5 tracking includes the reference name and selectable minus state',()=>{
  const tracking='C21BDE05,time.ume.tubitak.gov.tr,2,1793016588.506463721,-0.000010336,-0.012481262,0.012481262,4.911,-9.364,259.424,0.035545181,0.019027820,64.1,Normal';
  const sources='^,*,time.ume.tubitak.gov.tr,1,6,37,60,-0.000239742,-0.012717556,0.019729888\n^,-,time.cloudflare.com,3,6,37,57,0.012002185,0.012002185,0.033609279';
  assert.equal(parseSynchronization(tracking,sources,1793016650000).service,'chrony');
});
