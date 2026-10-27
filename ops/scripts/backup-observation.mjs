/** Shared, side-effect-free host backup schema. Freshness policy stays in the backend. */
import {elapsedTime, validateTimeEvidence} from './trusted-time.mjs';

export const BACKUP_OBSERVATION_SCHEMA_VERSION=2;
export const BACKUP_TRIGGER_CLASSES=['scheduled','predeploy','postdeploy','manual'];
export const BACKUP_ATTEMPT_RESULTS=['running','success','failure'];
export const BACKUP_FAILURE_CLASSES=['DUMP_FAILED','CHECKSUM_FAILED','ARTIFACT_FINALIZE_FAILED',
  'OFFSITE_COPY_FAILED','OBSERVATION_WRITE_FAILED','UNKNOWN'];
export const OBSERVATION_KEYS=['schemaVersion','updatedAt','latestAttemptTrigger','latestAttemptStartedAt',
  'latestAttemptCompletedAt','latestAttemptResult','latestAttemptFailureClass','latestVerifiedAt','latestVerifiedTrigger',
  'latestScheduledAttemptStartedAt','latestScheduledAttemptCompletedAt','latestScheduledAttemptResult',
  'latestScheduledAttemptFailureClass','latestScheduledVerifiedAt','latestAttemptId','latestAttemptTime',
  'latestScheduledAttemptId','latestScheduledAttemptTime','latestVerifiedProof','latestScheduledVerifiedProof',
  'scheduledBaselineEstablished'];
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH=/^[0-9a-f]{64}$/;
const record=value=>value!==null && typeof value==='object' && !Array.isArray(value);
const exact=(value,keys)=>record(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
export const eventLabel=time=>time.wallAtUTC.slice(0,19)+'Z';

export function parseObservationInstant(value) {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value))return null;
  const ms=Date.parse(value);
  return Number.isFinite(ms)&&new Date(ms).toISOString().slice(0,19)+'Z'===value?ms:null;
}

export function validateVerificationProof(value,trigger,verifiedAt) {
  if(!exact(value,['formatVersion','attemptId','trigger','startedAt','artifactSha256','sidecarSha256','before','after'])
    ||value.formatVersion!==1||typeof value.attemptId!=='string'||!UUID.test(value.attemptId)||value.trigger!==trigger
    ||parseObservationInstant(value.startedAt)===null||typeof value.artifactSha256!=='string'||typeof value.sidecarSha256!=='string'
    ||!HASH.test(value.artifactSha256)||!HASH.test(value.sidecarSha256))return false;
  try {validateTimeEvidence(value.before);validateTimeEvidence(value.after);}catch{return false;}
  return eventLabel(value.after)===verifiedAt&&elapsedTime(value.before,value.after).status==='KNOWN';
}

function attempt(value,scheduled,v2) {
  const prefix=scheduled?'latestScheduledAttempt':'latestAttempt';
  const result=value[prefix+'Result']??null;
  const fields=['StartedAt','CompletedAt','FailureClass'];
  if(result===null) {
    if(fields.some(key=>value[prefix+key]!=null)||(v2&&(value[prefix+'Id']!==null||value[prefix+'Time']!==null)))return false;
    return null;
  }
  const trigger=scheduled?'scheduled':value.latestAttemptTrigger;
  const startedAt=value[prefix+'StartedAt'],completedAt=value[prefix+'CompletedAt']??null;
  const failureClass=value[prefix+'FailureClass']??null;
  if(!BACKUP_ATTEMPT_RESULTS.includes(result)||!BACKUP_TRIGGER_CLASSES.includes(trigger)
    ||parseObservationInstant(startedAt)===null
    ||(result==='running'?completedAt!==null:parseObservationInstant(completedAt)===null)
    ||(result==='failure'?!BACKUP_FAILURE_CLASSES.includes(failureClass):failureClass!==null))return false;
  const id=v2?value[prefix+'Id']:null,time=v2?value[prefix+'Time']:null;
  if(v2) {
    if(id!==null&&(typeof id!=='string'||!UUID.test(id)))return false;
    if(time!==null) {try{validateTimeEvidence(time);}catch{return false;}if(id===null)return false;}
  }
  return {trigger,startedAt,completedAt,result,failureClass,id,time};
}

/** V1 is readable only as history. V2 is exact and never invents missing event time. */
export function parseBackupObservationState(value) {
  if(!record(value)||![1,2].includes(value.schemaVersion)||parseObservationInstant(value.updatedAt)===null)return null;
  const v2=value.schemaVersion===2;
  if(v2&&(!exact(value,OBSERVATION_KEYS)||typeof value.scheduledBaselineEstablished!=='boolean'))return null;
  const latestAttempt=attempt(value,false,v2),latestScheduledAttempt=attempt(value,true,v2);
  if(latestAttempt===false||latestScheduledAttempt===false)return null;
  if(latestAttempt===null&&value.latestAttemptTrigger!=null)return null;
  const verifiedAt=value.latestVerifiedAt??null,trigger=value.latestVerifiedTrigger??null;
  const scheduledAt=value.latestScheduledVerifiedAt??null;
  if((verifiedAt===null)!==(trigger===null)||(trigger!==null&&!BACKUP_TRIGGER_CLASSES.includes(trigger))
    ||(verifiedAt!==null&&parseObservationInstant(verifiedAt)===null)
    ||(scheduledAt!==null&&(parseObservationInstant(scheduledAt)===null||latestScheduledAttempt===null)))return null;
  const localProof=v2?value.latestVerifiedProof:null,scheduledProof=v2?value.latestScheduledVerifiedProof:null;
  if((localProof!==null&&(verifiedAt===null||!validateVerificationProof(localProof,trigger,verifiedAt)))
    ||(scheduledProof!==null&&(scheduledAt===null||!validateVerificationProof(scheduledProof,'scheduled',scheduledAt))))return null;
  const baseline=v2?value.scheduledBaselineEstablished:scheduledAt!==null;
  if(!baseline&&scheduledAt!==null)return null;
  if(v2&&latestAttempt?.result==='success'&&(latestAttempt.completedAt!==verifiedAt||latestAttempt.trigger!==trigger
    ||(localProof!==null&&(localProof.attemptId!==latestAttempt.id||localProof.startedAt!==latestAttempt.startedAt
      ||JSON.stringify(localProof.before)!==JSON.stringify(latestAttempt.time)))))return null;
  if(v2&&latestScheduledAttempt?.result==='success'&&(latestScheduledAttempt.completedAt!==scheduledAt
    ||(scheduledProof!==null&&(scheduledProof.attemptId!==latestScheduledAttempt.id||scheduledProof.startedAt!==latestScheduledAttempt.startedAt
      ||JSON.stringify(scheduledProof.before)!==JSON.stringify(latestScheduledAttempt.time)))))return null;
  if(v2&&trigger==='scheduled'&&(verifiedAt!==scheduledAt||JSON.stringify(localProof)!==JSON.stringify(scheduledProof)))return null;
  if(localProof&&scheduledProof&&localProof.attemptId===scheduledProof.attemptId
    &&JSON.stringify(localProof)!==JSON.stringify(scheduledProof))return null;
  return {schemaVersion:value.schemaVersion,updatedAt:value.updatedAt,latestAttempt,
    latestVerifiedSuccess:verifiedAt===null?null:{trigger,verifiedAt,proof:localProof},latestScheduledAttempt,
    latestScheduledVerifiedSuccess:scheduledAt===null?null:{trigger:'scheduled',verifiedAt:scheduledAt,proof:scheduledProof},
    scheduledBaselineEstablished:baseline};
}
