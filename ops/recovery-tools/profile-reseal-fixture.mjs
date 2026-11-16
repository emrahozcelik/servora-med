// Synthetic real-filesystem fixture for the root-only profile re-seal tool.
//
// This fixture never reads a production dump, approval, secret or profile. All
// bytes are synthetic. It is intentionally parameterised by uid/gid so the
// suite can run as an ordinary CI user and, in a disposable Linux container,
// as root.
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {environmentBaseline} from '../scripts/deployment-controller.mjs';
import {HISTORICAL_ARCHIVED_PATHS} from '../scripts/historical-recovery-evidence.mjs';

export const ATTEMPT='6ce4cff0-fa73-450e-b540-3f54ae429e7c';
export const DISPOSITION_ID='11111111-2222-4333-8444-555555555555';
export const MACHINE_ID='a'.repeat(32);

const sha256=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>JSON.stringify(value)+'\n';
const chownIfRoot=(file,uid,gid)=>{if(process.getuid()===0)fs.chownSync(file,uid,gid);};
const writeCanonical=(file,value,mode,uid,gid)=>{
  fs.writeFileSync(file,canonical(value),{mode});
  fs.chmodSync(file,mode);
  chownIfRoot(file,uid,gid);
  return fs.readFileSync(file);
};
const writeBytes=(file,bytes,mode,uid,gid)=>{
  fs.writeFileSync(file,bytes,{mode});
  fs.chmodSync(file,mode);
  chownIfRoot(file,uid,gid);
};
const mkdir=(directory,mode,uid,gid)=>{
  fs.mkdirSync(directory,{recursive:true,mode});
  fs.chmodSync(directory,mode);
  chownIfRoot(directory,uid,gid);
};

/**
 * @param {{uid?:number,gid?:number,oldProfileOverrides?:object,
 *   oldContracts?:Record<string,string>,liveContractOverrides?:Record<string,string>}} [options]
 */
export function createFixture(options={}) {
  const uid=options.uid??process.getuid();
  const gid=options.gid??process.getgid();
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'servora-profile-reseal-'));
  const state=path.join(root,'state');
  const installed=path.join(root,'installed');
  const stagingParent=path.join(root,'staging');
  const envFile=path.join(root,'servora-med.env');
  const machineIdFile=path.join(root,'machine-id');
  const dbFile=path.join(root,'database-identity.json');
  const dispositionFile=path.join(state,'historical-dispositions',ATTEMPT+'.json');
  const stagingDir=path.join(stagingParent,ATTEMPT);
  const receiptFile=path.join(stagingParent,ATTEMPT+'.stage-receipt.json');
  const lockFile=path.join(state,'host.lock');
  const pendingRoot=path.join(root,'pending');

  mkdir(state,0o700,uid,gid);
  mkdir(installed,0o755,uid,gid);
  mkdir(stagingParent,0o700,uid,gid);
  mkdir(path.join(state,'historical-dispositions'),0o700,uid,gid);
  mkdir(path.join(state,'approvals'),0o700,uid,gid);
  mkdir(path.join(state,'initializations'),0o700,uid,gid);
  mkdir(pendingRoot,0o700,uid,gid);

  const contractSpecs=[
    {key:'helperSha256',path:path.join(installed,'deploy-production-host'),mode:0o755},
    {key:'nodeSha256',path:path.join(installed,'node'),mode:0o755},
    {key:'unitSha256',path:path.join(installed,'servora-med.service'),mode:0o644},
    {key:'attemptModuleSha256',path:path.join(installed,'deployment-attempt.mjs'),mode:0o644},
    {key:'dbGuardModuleSha256',path:path.join(installed,'deployment-db-guard.mjs'),mode:0o644},
    {key:'reconciliationModuleSha256',path:path.join(installed,'migration-reconciliation.mjs'),mode:0o644},
    {key:'controllerModuleSha256',path:path.join(installed,'deployment-controller.mjs'),mode:0o644},
    {key:'timeModuleSha256',path:path.join(installed,'trusted-time.mjs'),mode:0o644},
    {key:'timeConfigSha256',path:path.join(installed,'chrony.conf'),mode:0o644}
  ];
  const contractBytes={};
  for(const spec of contractSpecs){
    const bytes=Buffer.from('synthetic contract: '+spec.key+'\n');
    contractBytes[spec.key]=bytes;
    writeBytes(spec.path,bytes,spec.mode,uid,gid);
  }
  const liveContracts=Object.fromEntries(
    contractSpecs.map(spec=>[spec.key,sha256(contractBytes[spec.key])]));
  for(const [key,value] of Object.entries(options.liveContractOverrides??{}))liveContracts[key]=value;
  // The pre-reseal profile pins deliberately stale values so the happy path
  // proves that the candidate is built from the live installed bytes. A test
  // that wants an already-current old profile can pass `oldContracts`.
  const oldContracts=options.oldContracts
    ?? Object.fromEntries(contractSpecs.map(spec=>[spec.key,'0'.repeat(64)]));

  const envText='DATABASE_URL=postgresql://servora:synthetic@127.0.0.1:5432/servora_med\n'
    +'PORT=3000\nHEALTH_SCHEMA_VERSION=060_synthetic\nSERVORA_RELEASE_SHA='+'a'.repeat(40)+'\n';
  writeBytes(envFile,Buffer.from(envText),0o640,uid,gid);
  const profile={
    formatVersion:2,
    machineId:MACHINE_ID,
    fqdn:'synthetic.example',
    databaseIdentity:{clusterId:'1',databaseName:'servora_med',databaseOid:'1',
      role:'servora',host:'127.0.0.1',port:5432},
    envBaselineSha256:environmentBaseline(envText),
    contracts:oldContracts
  };
  Object.assign(profile,options.oldProfileOverrides??{});
  const profileBytes=writeCanonical(path.join(state,'profile.json'),profile,0o600,uid,gid);
  const oldProfileSha256=sha256(profileBytes);
  const expectedProfile={...profile,contracts:liveContracts};
  const expectedCandidate=sha256(canonical(expectedProfile));

  writeBytes(machineIdFile,Buffer.from(MACHINE_ID+'\n'),0o600,uid,gid);
  writeBytes(dbFile,Buffer.from(canonical(profile.databaseIdentity)),0o600,uid,gid);
  writeBytes(lockFile,Buffer.alloc(0),0o600,uid,gid);

  const disposition={
    formatVersion:1,kind:'HISTORICAL_RECOVERY_DISPOSITION',
    dispositionId:DISPOSITION_ID,attemptId:ATTEMPT,
    classification:'ABANDONED_SUPERSEDED',terminal:false,r4Acceptance:'NOT_ACCEPTED',
    lastPhase:'POSTDEPLOY_BACKUP_PASSED',lastSequence:17,starts:2,
    profileSha256:oldProfileSha256
  };
  const dispositionBytes=writeCanonical(dispositionFile,disposition,0o600,uid,gid);
  const dispositionSha256=sha256(dispositionBytes);

  // The 26 live source files are synthetic stand-ins. The re-seal tool must
  // not touch them; tests snapshot these bytes before and after.
  const liveRoot=state;
  for(const rel of HISTORICAL_ARCHIVED_PATHS){
    const file=path.join(liveRoot,rel);
    mkdir(path.dirname(file),0o700,uid,gid);
    writeBytes(file,Buffer.from('live historical evidence: '+rel+'\n'),
      rel.startsWith('logs/'+ATTEMPT+'/postdeploy-operator-')?0o644:0o600,uid,gid);
  }
  writeCanonical(path.join(state,'approvals',ATTEMPT+'.json'),{synthetic:true},0o600,uid,gid);
  writeCanonical(path.join(state,'installed-old-adoption.json'),{synthetic:true},0o600,uid,gid);
  writeCanonical(path.join(state,'emergency-receipt.json'),{synthetic:true},0o600,uid,gid);

  const stagedPaths=[...HISTORICAL_ARCHIVED_PATHS,
    'preserved/profile.json','preserved/disposition.json'];
  mkdir(stagingDir,0o700,uid,gid);
  for(const dir of ['.','attempts','attempts/'+ATTEMPT,'admission-proofs','backups',
    'logs','logs/'+ATTEMPT,'preserved'])mkdir(path.join(stagingDir,dir),0o700,uid,gid);
  const stagedBytes={};
  for(const rel of stagedPaths){
    stagedBytes[rel]=rel==='preserved/profile.json'?profileBytes
      :rel==='preserved/disposition.json'?dispositionBytes
      :Buffer.from('staged historical evidence: '+rel+'\n');
    const file=path.join(stagingDir,rel);
    writeBytes(file,stagedBytes[rel],0o600,uid,gid);
  }
  const stagedEntries=stagedPaths.map(rel=>{
    const stat=fs.lstatSync(path.join(stagingDir,rel),{bigint:true});
    return {archivePath:rel,sha256:sha256(stagedBytes[rel]),size:stagedBytes[rel].length,
      mtimeNs:stat.mtimeNs.toString(),mode:'0600'};
  });
  const receipt={
    formatVersion:1,kind:'HISTORICAL_RECOVERY_STAGE_ONLY',
    authority:'NOT_ARCHIVED_NOT_RETAINED_NO_SOURCE_REMOVAL',
    attemptId:ATTEMPT,sourceInventorySha256:'b'.repeat(64),
    dispositionSha256,profileSha256:oldProfileSha256,files:stagedEntries
  };
  const receiptBytes=writeCanonical(receiptFile,receipt,0o600,uid,gid);

  const snapshot=()=>Object.fromEntries([
    ...HISTORICAL_ARCHIVED_PATHS.map(rel=>['live/'+rel,sha256(fs.readFileSync(path.join(liveRoot,rel)))]),
    ['approval',sha256(fs.readFileSync(path.join(state,'approvals',ATTEMPT+'.json')))],
    ['adoption',sha256(fs.readFileSync(path.join(state,'installed-old-adoption.json')))],
    ['emergency',sha256(fs.readFileSync(path.join(state,'emergency-receipt.json')))],
    ['disposition',dispositionSha256],
    ['receipt',sha256(receiptBytes)],
    ...stagedPaths.map(rel=>['staged/'+rel,
      sha256(fs.readFileSync(path.join(stagingDir,rel)))])
  ]);
  const before=snapshot();

  const paths={
    stateRoot:state,
    profileFile:path.join(state,'profile.json'),
    installedDir:installed,
    envFile,
    machineIdFile,
    dispositionFile,
    stagingDir,
    receiptFile,
    lockFile,
    attemptId:ATTEMPT,
    pendingMarkers:[
      path.join(pendingRoot,'active.json'),
      path.join(pendingRoot,'activation.block'),
      path.join(pendingRoot,'start.permit'),
      path.join(pendingRoot,'90-servora-recovery.conf')
    ],
    initializationsDir:path.join(state,'initializations'),
    contractSpecs
  };
  paths.trustedAnchor=root;

  return {
    root,uid,gid,paths,profile,profileBytes,oldProfileSha256,
    liveContracts,expectedProfile,expectedCandidate,
    disposition,dispositionSha256,stagedEntries,receipt,receiptBytes,
    lockFile,envFile,machineIdFile,dbFile,pendingRoot,before,snapshot,
    cleanup:()=>fs.rmSync(root,{recursive:true,force:true})
  };
}
