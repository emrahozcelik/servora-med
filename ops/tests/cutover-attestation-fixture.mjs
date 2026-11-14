// Full synthetic host flow with synthetic archive/content pins. The separate
// pure tests use the unmodified production policy and assert its real pins.
// No real host, archive, approval or database is read here.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {adoptionHost,adoptionFixture67d3318} from './installed-old-adoption-fixture.mjs';
import {historicalFixture,installHistoricalSource,installHistoricalStage,STATE}
  from './historical-recovery-fixture.mjs';
import {timeEvidenceAt} from './trusted-time-fixture.mjs';
import {OPS_R4_002_POLICY} from '../scripts/deployment-controller.mjs';

export const json = value => JSON.stringify(value)+'\n';
export const hash = value => createHash('sha256').update(value).digest('hex');
export const ATTESTATION = STATE+'/installed-old-cutover-attestation-67d3318.json';
export const readRecord = (host,path) => JSON.parse(host.files.get(path).data.toString());

export function freshGrant(host,approval,overrides={}) {
  const now=timeEvidenceAt(Date.parse('2026-11-14T10:00:00.000Z'),
    {bootId:'22222222-2222-4222-8222-222222222222'});
  const grant={...approval,attemptId:'33333333-3333-4333-8333-333333333333',
    issuedAtUTC:now.wallAtUTC,expiresAtUTC:'2026-11-14T12:00:00.000Z',issuedTime:now,...overrides};
  host.now=now;
  host.add(STATE+'/approvals/'+grant.attemptId+'.json',json(grant));
  return grant;
}

export async function cutoverHost(t) {
  const historical=historicalFixture(),f=adoptionFixture67d3318();
  const host=await adoptionHost(f);
  t.after(host.cleanup);
  installHistoricalSource(host,historical);
  host.directories.set(STATE+'/historical-dispositions',0o700);
  host.controller.issueHistoricalRecoveryDisposition();
  installHistoricalStage(host,historical);
  Object.assign(f.context.approval,{issuedAtUTC:'2026-11-10T10:05:00.000Z',
    expiresAtUTC:'2026-11-10T12:40:00.000Z',
    issuedTime:timeEvidenceAt(Date.parse('2026-11-10T10:05:00.000Z'))});
  host.add(STATE+'/profile.json',json(f.context.profile));
  host.add(STATE+'/approvals/'+f.context.approval.attemptId+'.json',json(f.context.approval));
  host.rewriteController=source=>{
    const pairs=[
      [OPS_R4_002_POLICY.reconstructedArtifactSha256,f.record.adoptedArchiveSha256],
      [OPS_R4_002_POLICY.contentManifestSha256,f.record.oldContentManifestSha256]
    ];
    for(const [real,synthetic] of pairs){
      assert.equal(source.split(real).length,2,'one exact policy pin, never a runtime override');
      source=source.replace(real,synthetic);
    }
    return source;
  };
  host.controller=await host.restart();
  host.allowAdmissionWrites=true;
  return {f,host,approval:f.context.approval,historical};
}
