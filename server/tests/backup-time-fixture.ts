import type {TimeEvidence} from '../../ops/scripts/trusted-time.mjs';

const origin=Date.parse('2026-01-01T00:00:00Z');
export function timeAt(ms:number, overrides:Partial<TimeEvidence>={}):TimeEvidence {
  return {formatVersion:1,source:'linux-boottime',bootId:'11111111-1111-4111-8111-111111111111',
    timeNamespaceId:'time:[4026531834]',bootLowerMs:ms-origin,bootUpperMs:ms-origin,
    wallAtUTC:new Date(ms).toISOString(),wallResolutionMs:1,
    synchronization:{service:'chrony',referenceAgeMs:1,rootDistanceMs:1,correctionMs:0,sourceCount:2},...overrides};
}

export function trustedDocument(doc:Record<string,unknown>):Record<string,unknown> {
  const next={...doc,schemaVersion:2,scheduledBaselineEstablished:doc.latestScheduledVerifiedAt!=null,
    latestAttemptId:doc.latestAttemptResult==null?null:'11111111-1111-4111-8111-111111111111',
    latestAttemptTime:null,latestScheduledAttemptId:doc.latestScheduledAttemptResult==null?null:'22222222-2222-4222-8222-222222222222',
    latestScheduledAttemptTime:null,latestVerifiedProof:null,latestScheduledVerifiedProof:null} as Record<string,unknown>;
  for(const [atKey,proofKey,trigger] of [['latestVerifiedAt','latestVerifiedProof',doc.latestVerifiedTrigger],
    ['latestScheduledVerifiedAt','latestScheduledVerifiedProof','scheduled']] as const) {
    if(typeof doc[atKey]!=='string')continue;
    const at=doc[atKey] as string;
    const id=trigger==='scheduled'?'22222222-2222-4222-8222-222222222222':'11111111-1111-4111-8111-111111111111';
    next[proofKey]={formatVersion:1,attemptId:id,trigger,startedAt:at,artifactSha256:'a'.repeat(64),sidecarSha256:'b'.repeat(64),
      before:timeAt(Date.parse(at)),after:timeAt(Date.parse(at))};
  }
  if(doc.latestAttemptResult==='success') {
    const proof=next.latestVerifiedProof as {attemptId:string;before:TimeEvidence}|null;
    next.latestAttemptId=proof?.attemptId??next.latestAttemptId;
    next.latestAttemptTime=proof?.before??null;
  }
  if(doc.latestScheduledAttemptResult==='success') {
    const proof=next.latestScheduledVerifiedProof as {before:TimeEvidence}|null;
    next.latestScheduledAttemptTime=proof?.before??null;
  }
  return next;
}
