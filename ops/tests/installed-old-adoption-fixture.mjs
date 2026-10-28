// In-memory Linux host boundary. Executes the actual controller and protected
// readers; never opens a real privileged path or invokes a real host command.
import * as fs from 'node:fs';
import * as attempt from '../scripts/deployment-attempt.mjs';
import * as clock from '../scripts/trusted-time.mjs';
import {createHash,randomUUID} from 'node:crypto';
import {posix} from 'node:path';

const hash=value=>createHash('sha256').update(value).digest('hex');
const json=value=>Buffer.from(JSON.stringify(value)+'\n');
const state='/var/lib/servora-med/deploy';
import {approvalFixture,timeEvidenceAt} from './trusted-time-fixture.mjs';
const jsonHash=value=>hash(JSON.stringify(value)+'\n');
const oldSha='71ae6df6dd0659ed6390a6785d4bab29ddf5b1fa';
const original='6f9dbb6a211813fd0d6d5e92396b71045d506eb959cd98d883e257663af79672';
const migrationDirectory=new URL('../../server/src/db/migrations/',import.meta.url);
const catalog=fs.readdirSync(migrationDirectory).filter(name=>/^\d{3}_.*\.sql$/.test(name)).sort().slice(0,55)
  .map(name=>({version:name.slice(0,-4),sha256:hash(fs.readFileSync(new URL(name,migrationDirectory)))}));

export function adoptionFixture() {
  const approval={...approvalFixture(),oldReleaseSha:oldSha,oldArtifactSha256:original,
    oldCatalog:catalog,targetCatalog:catalog};
  const databaseIdentity={clusterId:'1',databaseName:'servora_med_test_adoption',databaseOid:'1',role:'servora_app',host:'127.0.0.1',port:5432};
  const profile={machineId:'1'.repeat(32),databaseIdentity};
  const baseline={formatVersion:1,kind:'RECOVERY_BASELINE_NOT_ORIGINAL_ARTIFACT',
    baselineId:'20261012T090000Z-issue369-71ae6df6',createdAtUTC:approval.issuedAtUTC,completedAtUTC:approval.issuedAtUTC,
    machineId:profile.machineId,sourceReleaseSha:oldSha,originalArtifactSha256:original,
    installedContentManifestSha256:'5'.repeat(64),databaseIdentity,catalog,restoreAcceptance:false,
    verifications:{dumpList:true,dumpCatalogExact:true,adoptedArchiveComparedToInstalled:true,configurationArchiveCompared:true,originalObservationAndMarkerUnchanged:true,appPidUnchanged:true},
    files:Object.fromEntries(['database.dump','installed-old-release.adopted.tar.gz','configuration.tar.gz','database-metadata.json','installed-old-content.sha256'].map(name=>[name,{name,sha256:'6'.repeat(64),bytes:10}]))};
  const context={approval,approvalSha256:'4'.repeat(64),profile};
  baseline.files['installed-old-content.sha256'].sha256=baseline.installedContentManifestSha256;
  const record={formatVersion:1,kind:'ADOPTED_INSTALLED_OLD_FIRST_CUTOVER',attemptId:approval.attemptId,
    approvalSha256:context.approvalSha256,profileSha256:approval.profileSha256,machineId:profile.machineId,
    oldReleaseSha:oldSha,originalArtifactSha256:original,oldCatalogSha256:jsonHash(catalog),
    oldContentManifestSha256:baseline.installedContentManifestSha256,targetReleaseSha:approval.releaseSha,
    targetTreeSha:approval.treeSha,targetArtifactSha256:approval.artifactSha256,
    baselineId:baseline.baselineId,baselineManifestSha256:jsonHash(baseline),
    adoptedArchiveSha256:baseline.files['installed-old-release.adopted.tar.gz'].sha256,
    databaseDumpSha256:baseline.files['database.dump'].sha256,attestedTime:timeEvidenceAt()};
  return {record,context,baseline,baselineSha256:jsonHash(baseline)};
}

export async function adoptionHost(f) {
  const files=new Map(),directories=new Map([['/',0o755],[state,0o700]]),fds=new Map(),commands=[];
  let nextFd=10;
  const add=(path,data,mode=0o600)=>{
    files.set(path,{data:Buffer.from(data),mode,uid:0,gid:0,nlink:1});
    let parent=path.slice(0,path.lastIndexOf('/'));
    while(parent){if(!directories.has(parent))directories.set(parent,parent.startsWith(state+'/')?0o700:0o755);parent=parent.slice(0,parent.lastIndexOf('/'));}
  };
  const info=path=>{
    path=posix.normalize(path);
    const file=files.get(path),dir=directories.has(path);
    if(!file&&!dir)throw Object.assign(new Error('not found'),{code:'ENOENT'});
    return {uid:0,gid:0,nlink:1,dev:1,ino:parseInt(hash(path).slice(0,8),16),mode:dir?directories.get(path):file.mode,size:file?.data.length??0,
      isDirectory:()=>dir,isFile:()=>!dir,isSymbolicLink:()=>false,...file};
  };
  const children=path=>{
    path=posix.normalize(path);
    return [...new Set([...files.keys(),...directories.keys()].filter(p=>p.startsWith(path+'/'))
      .map(p=>p.slice(path.length+1).split('/')[0]))].sort();
  };
  const root='/opt/servora-med/releases/'+f.context.approval.oldReleaseSha;
  add(root+'/payload','installed OLD',0o640);
  const migrations=new URL('../../server/src/db/migrations/',import.meta.url);
  for(const entry of f.context.approval.oldCatalog)add(root+'/server/dist/db/migrations/'+entry.version+'.sql',
    fs.readFileSync(new URL(entry.version+'.sql',migrations)),0o640);
  const entries=[...directories.keys()].filter(p=>p.startsWith(root+'/')).map(p=>[p.slice(root.length+1),'d'])
    .concat([...files.keys()].filter(p=>p.startsWith(root+'/')).map(p=>[p.slice(root.length+1),'f']))
    .map(([p,t])=>[ './'+p,t ]).sort(([a,t],[b,u])=>Buffer.compare(Buffer.from(t+' '+a),Buffer.from(u+' '+b)));
  const manifest=entries.map(([p,t])=>t+' '+p+(t==='f'?' '+hash(files.get(root+'/'+p.slice(2)).data):'')).join('\n')+'\n';
  add(root+'/.servora-release-artifact.sha256',f.context.approval.oldArtifactSha256+'\n');
  add(root+'/.servora-release-content.sha256',manifest);
  const environment='HEALTH_SCHEMA_VERSION='+f.context.approval.oldCatalog.at(-1).version+'\nSERVORA_RELEASE_SHA='+f.context.approval.oldReleaseSha+'\n';
  add('/etc/servora-med/servora-med.env',environment,0o640);
  add('/etc/machine-id',f.context.profile.machineId+'\n',0o444);
  const contractFiles={helperSha256:['/usr/local/libexec/servora-med/deploy-production-host',0o755],
    nodeSha256:['/usr/bin/node',0o755],unitSha256:['/etc/systemd/system/servora-med.service',0o644],
    attemptModuleSha256:['/usr/local/libexec/servora-med/deployment-attempt.mjs',0o644],
    dbGuardModuleSha256:['/usr/local/libexec/servora-med/deployment-db-guard.mjs',0o644],
    reconciliationModuleSha256:['/usr/local/libexec/servora-med/migration-reconciliation.mjs',0o644],
    controllerModuleSha256:['/usr/local/libexec/servora-med/deployment-controller.mjs',0o644],
    timeModuleSha256:['/usr/local/libexec/servora-med/trusted-time.mjs',0o644],
    timeConfigSha256:['/etc/chrony/chrony.conf',0o644]};
  for(const [path,mode] of Object.values(contractFiles))add(path,'reviewed contract',mode);
  f.context.profile={...f.context.profile,formatVersion:2,fqdn:'synthetic.example',envBaselineSha256:hash(''),
    contracts:Object.fromEntries(Object.keys(contractFiles).map(key=>[key,hash('reviewed contract')]))};
  f.context.approval.profileSha256=hash(json(f.context.profile));
  f.context.approvalSha256=hash(json(f.context.approval));
  add(state+'/profile.json',json(f.context.profile));
  add(state+'/approvals/'+f.context.approval.attemptId+'.json',json(f.context.approval));
  const baselineRoot='/var/lib/servora-med-recovery-baselines/'+f.baseline.baselineId;
  for(const entry of Object.values(f.baseline.files)){
    const bytes=entry.name==='installed-old-content.sha256'?manifest:'synthetic '+entry.name;
    add(baselineRoot+'/'+entry.name,bytes);entry.sha256=hash(bytes);entry.bytes=Buffer.byteLength(bytes);
  }
  f.baseline.installedContentManifestSha256=hash(manifest);
  f.baselineSha256=hash(json(f.baseline));add(baselineRoot+'/baseline-manifest.json',json(f.baseline));
  Object.assign(f.record,{approvalSha256:f.context.approvalSha256,profileSha256:f.context.approval.profileSha256,
    oldContentManifestSha256:hash(manifest),baselineManifestSha256:f.baselineSha256,
    adoptedArchiveSha256:f.baseline.files['installed-old-release.adopted.tar.gz'].sha256,
    databaseDumpSha256:f.baseline.files['database.dump'].sha256});
  const key='adoption-host-'+randomUUID();
  add(state+'/host.lock','');fds.set(9,state+'/host.lock');
  const forbidden=()=>{throw new Error('unexpected host filesystem mutation');};
  const fakeFs={...fs,
    mkdirSync:forbidden,renameSync:forbidden,unlinkSync:forbidden,linkSync:forbidden,
    symlinkSync:forbidden,fchownSync:forbidden,fchmodSync:forbidden,writeSync:forbidden,
    lstatSync:info,fstatSync:fd=>{if(!fds.has(fd))throw Object.assign(new Error('bad fd'),{code:'EBADF'});return info(fds.get(fd));},
    readdirSync:children,realpathSync:path=>path==='/opt/servora-med/current'?root:path,
    openSync:(path,flags)=>{
      path=posix.normalize(path);
      if((flags&fs.constants.O_EXCL)&&files.has(path))throw Object.assign(new Error('exists'),{code:'EEXIST'});
      if(flags&fs.constants.O_CREAT)add(path,'');else info(path);
      const fd=nextFd++;fds.set(fd,path);return fd;
    },
    closeSync:fd=>fds.delete(fd),fsyncSync:()=>{},
    readFileSync:(path,encoding)=>{const value=files.get(typeof path==='number'?fds.get(path):posix.normalize(path))?.data;
      if(!value)throw Object.assign(new Error('missing'),{code:'ENOENT'});return encoding?value.toString():Buffer.from(value);},
    writeFileSync:(fd,data)=>{
      files.get(fds.get(fd)).data=Buffer.from(data);
      if(host.interruptWrite){files.get(fds.get(fd)).data=Buffer.from(data).subarray(0,20);throw new Error('simulated interruption');}
    },
  };
  const names=['./',...entries.map(([p,t])=>p+(t==='d'?'/':'')),
    './.servora-release-artifact.sha256','./.servora-release-content.sha256'];
  const types=['d',...entries.map(([,t])=>t==='f'?'-':'d'),'-','-'];
  const properties={User:'servora-med',Group:'servora-med',WorkingDirectory:'/opt/servora-med/current/server',
    FragmentPath:'/etc/systemd/system/servora-med.service',DropInPaths:'',
    ExecStart:'{ path=/usr/bin/node ; argv[]=/usr/bin/node dist/index.js ; ignore_errors=no ; mock=yes }',
    EnvironmentFiles:'/etc/servora-med/servora-med.env (ignore_errors=no)',NeedDaemonReload:'no',Restart:'on-failure'};
  const host={fs:fakeFs,fds,properties,process:{...process,getuid:()=>0},commands,files,directories,add,root,names,types,failCommand:null};
  host.dumpLedger='COPY public.schema_migrations (version, applied_at) FROM stdin;\n'
    +f.context.approval.oldCatalog.map(entry=>entry.version+'\t2026-10-12 09:00:00+00').join('\n')+'\n\\.\n';
  host.child={spawn:()=>{throw new Error('unexpected subprocess');},execFileSync:(file,args,options)=>{
    commands.push([file,...args]);if(host.failCommand===file)throw new Error('command failed');
    if(file==='/usr/bin/flock')return '';
    if(host.realTools&&['/usr/bin/tar','/usr/bin/pg_restore'].includes(file))return host.realTools(file,args,options);
    if(file==='/usr/bin/systemctl')return Object.entries(properties).map(([k,v])=>k+'='+v).join('\n');
    if(file==='/usr/bin/tar'&&args.includes('--list'))return (args.includes('--verbose')?host.types:host.names).join('\n')+'\n';
    if(file==='/usr/bin/tar'&&args.includes('--compare'))return '';
    if(file==='/usr/bin/pg_restore'&&args[0]==='--list')return 'synthetic dump TOC';
    if(file==='/usr/bin/pg_restore'&&args.includes('--table=schema_migrations'))return host.dumpLedger;
    throw new Error('unexpected host command');
  }};
  globalThis[key]=host;
  const url=source=>'data:text/javascript;base64,'+Buffer.from(source).toString('base64');
  const mockModule=(name,values)=>url(`const values=globalThis[${JSON.stringify(key)}][${JSON.stringify(name)}];\n`+
    Object.keys(values).map(k=>k==='default'?'export default values.default;':`export const ${k}=values.${k};`).join('\n'));
  const fsUrl=mockModule('fs',fakeFs),childUrl=mockModule('child',host.child);
  host.now=f.record.attestedTime;
  host.clock={...clock,sampleTrustedTime:()=>host.now};
  const clockUrl=mockModule('clock',host.clock);
  const scripts=new URL('../scripts/',import.meta.url);
  const rewrite=(name,extra={})=>{
    const source=fs.readFileSync(new URL(name,scripts),'utf8').replace(/from '([^']+)'/g,(whole,path)=>{
      const target=extra[path]??(path==='node:fs'?fsUrl:path==='node:child_process'?childUrl:
        path==='./trusted-time.mjs'?clockUrl:path.startsWith('.')?new URL(path,scripts).href:path);
      return `from '${target}'`;
    });
    return url(`const process=globalThis[${JSON.stringify(key)}].process;\n`+source
      +`\n// instance ${randomUUID()}\n//# sourceURL=servora-test/${name}\n`);
  };
  host.restart=()=>import(rewrite('deployment-controller.mjs',{'./deployment-attempt.mjs':rewrite('deployment-attempt.mjs')}));
  host.controller=await host.restart();
  host.cleanup=()=>delete globalThis[key];
  host.recordFile=state+'/installed-old-adoption.json';
  // The returned pure lifecycle functions are the real reviewed implementation.
  host.attempt=attempt;
  return host;
}
