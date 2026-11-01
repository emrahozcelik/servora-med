/** Read-only infrastructure time evidence. No domain TTLs or clock setters. */
import { readFileSync, readlinkSync, constants, openSync, fstatSync, closeSync, lstatSync, readSync, writeSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { isIP, createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
const KEYS = ['formatVersion','source','bootId','timeNamespaceId','bootLowerMs',
  'bootUpperMs','wallAtUTC','wallResolutionMs','synchronization'];
const SYNC_KEYS = ['service','referenceAgeMs','rootDistanceMs','correctionMs','sourceCount'];
const QUORUM_SYNC_KEYS = [...SYNC_KEYS,'sourcePolicy','configSha256','configuredSourceCount',
  'authenticatedSourceCount','selectableSources','selectedSource'];
export const SOURCE_POLICY = 'nts-quorum-v1';
export const NTS_SOURCES = Object.freeze(['time.cloudflare.com','bevtime1.metrologie.at','1.ntp.ubuntu.com']);
export const MONITOR_SOURCE = 'time.ume.tubitak.gov.tr';
export const CHRONY_CONFIG_SHA256 = '540e7dbc2091f128b0115d0cbab082c9cf360bab478d5484531fddafcc2cb559';
export const MAX_REFERENCE_AGE_MS = 768000; // Three maximum 256-second polls.
export const MAX_ROOT_DISTANCE_MS = 1000;
export const MAX_CORRECTION_MS = 100;
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value,key));

export function validateTimeEvidence(value) {
  if (!exact(value,KEYS) || ![1,2].includes(value.formatVersion) || value.source !== 'linux-boottime'
    || typeof value.bootId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value.bootId)
    || typeof value.timeNamespaceId !== 'string' || !/^time:\[[0-9]+\]$/.test(value.timeNamespaceId)
    || !Number.isSafeInteger(value.bootLowerMs) || value.bootLowerMs < 0
    || !Number.isSafeInteger(value.bootUpperMs) || value.bootUpperMs < value.bootLowerMs
    || value.wallResolutionMs !== 1 || typeof value.wallAtUTC !== 'string'
    || !Number.isFinite(Date.parse(value.wallAtUTC))
    || new Date(value.wallAtUTC).toISOString() !== value.wallAtUTC) throw new Error('TRUSTED_TIME_UNKNOWN');
  const sync = value.synchronization;
  if (!(value.formatVersion === 1 ? exact(sync,SYNC_KEYS) && sync.sourceCount === 2
      : exact(sync,QUORUM_SYNC_KEYS) && sync.sourcePolicy === SOURCE_POLICY
        && sync.configSha256 === CHRONY_CONFIG_SHA256 && sync.configuredSourceCount === 3
        && [2,3].includes(sync.sourceCount) && sync.authenticatedSourceCount === sync.sourceCount
        && Array.isArray(sync.selectableSources) && sync.selectableSources.length === sync.sourceCount
        && sync.selectableSources.every((name,index,list) => NTS_SOURCES.includes(name)
          && (index === 0 || list[index-1] < name))
        && sync.selectableSources.includes(sync.selectedSource)) || sync.service !== 'chrony'
    || !Number.isFinite(sync.referenceAgeMs) || sync.referenceAgeMs < 0 || sync.referenceAgeMs > MAX_REFERENCE_AGE_MS
    || !Number.isFinite(sync.rootDistanceMs) || sync.rootDistanceMs < 0 || sync.rootDistanceMs > MAX_ROOT_DISTANCE_MS
    || !Number.isFinite(sync.correctionMs) || Math.abs(sync.correctionMs) > MAX_CORRECTION_MS) {
    throw new Error('TRUSTED_TIME_UNKNOWN');
  }
  return value;
}

export function validateCurrentTimeEvidence(value) {
  validateTimeEvidence(value);
  if (value.formatVersion !== 2) throw new Error('TRUSTED_TIME_UNKNOWN');
  return value;
}

/** Same-boot conservative bounds, including suspend; sufficient only to deny age. */
export function elapsedBootTime(event, current) {
  try { validateTimeEvidence(event); validateTimeEvidence(current); }
  catch { return {status:'UNKNOWN'}; }
  if (event.bootId !== current.bootId || event.timeNamespaceId !== current.timeNamespaceId
    || current.bootLowerMs < event.bootLowerMs || current.bootUpperMs < event.bootUpperMs) return {status:'UNKNOWN'};
  const lowerMs = Math.max(0,current.bootLowerMs-event.bootUpperMs);
  const upperMs = current.bootUpperMs-event.bootLowerMs;
  return {status:'KNOWN',lowerMs,upperMs};
}

/** UTC remains a veto for positive authority; boot bounds alone only deny. */
export function elapsedTime(event, current) {
  if (event?.formatVersion !== current?.formatVersion) return {status:'UNKNOWN'};
  const bounds = elapsedBootTime(event,current);
  if (bounds.status !== 'KNOWN') return bounds;
  const {lowerMs,upperMs} = bounds;
  const wall = Date.parse(current.wallAtUTC)-Date.parse(event.wallAtUTC);
  if (wall+current.wallResolutionMs < lowerMs || wall-event.wallResolutionMs > upperMs) return {status:'UNKNOWN'};
  return {status:'KNOWN',lowerMs,upperMs};
}

/** chronyc 4.5 reports. Caller must supply source-bound packet evidence; no DNS inference. */
export function parseSynchronization(tracking, sources, nowMs, details) {
  const unknown = () => { throw new Error('TRUSTED_TIME_UNKNOWN'); };
  const number = text => text?.trim() && Number.isFinite(Number(text)) ? Number(text) : NaN;
  if (typeof tracking !== 'string' || typeof sources !== 'string' || !Number.isFinite(nowMs)
    || !details || !Array.isArray(details.packets) || details.packets.length > 3
    || details.packets.some(packet => !exact(packet,['name','address','data'])) || typeof details.config !== 'string'
    || createHash('sha256').update(details.config).digest('hex') !== CHRONY_CONFIG_SHA256) unknown();
  const interval = text => {
    const match = /^([+-]?[0-9]+(?:[.][0-9]+)?)(ns|us|ms|s)$/.exec(text ?? '');
    return match ? Number(match[1])*({ns:1e-9,us:1e-6,ms:1e-3,s:1})[match[2]] : NaN;
  };
  const fields = tracking.trim().split(',');
  if (fields.length !== 14 || !/^[0-9a-f]{8}$/i.test(fields[0]) || fields[0].toUpperCase() === '7F7F0101'
    || !Number.isInteger(number(fields[2])) || number(fields[2]) < 1 || number(fields[2]) > 15
    || fields[13] !== 'Normal' || !Number.isFinite(number(fields[10])) || number(fields[10]) < 0
    || !Number.isFinite(number(fields[11])) || number(fields[11]) < 0) unknown();
  const lines = sources.trim().split('\n').map(line => line.trim().split(','));
  const names = [...NTS_SOURCES,MONITOR_SOURCE];
  const report = (text,width,nameIndex) => {
    if (typeof text !== 'string') unknown();
    const rows = text.trim().split('\n').filter(line => line.trim() && !/^(?:S Name|Name\/IP|=)/.test(line))
      .map(line => line.trim().split(/\s+/));
    if (rows.length !== 4 || rows.some(row => row.length !== width || !names.includes(row[nameIndex]))
      || new Set(rows.map(row => row[nameIndex])).size !== 4) unknown();
    return new Map(rows.map(row => [row[nameIndex],row]));
  };
  const selections = report(details.selectdata,10,1), authentication = report(details.authdata,10,0);
  if (lines.length !== 4 || new Set(lines.map(line => line[2])).size !== 4
    || lines.some(line => line.length !== 10 || line[0] !== '^' || !names.includes(line[2])
      || !['*','+','-','?'].includes(line[1])
      || !Number.isInteger(number(line[3])) || number(line[3]) < 0 || number(line[3]) > 15
      || !Number.isInteger(number(line[4])) || number(line[4]) < 6 || number(line[4]) > 8
      || !/^[0-7]{1,3}$/.test(line[5])
      || !Number.isFinite(number(line[6])) || number(line[6]) < 0
      || line.slice(7).some(value => !Number.isFinite(number(value))))) unknown();
  const selectable = [];
  for (const line of lines) {
    const name = line[2], selection = selections.get(name), auth = authentication.get(name);
    if (name === MONITOR_SOURCE) {
      if (line[1] !== '?' || selection[0] !== 'N' || selection[2] !== 'N'
        || selection[3] !== 'N----' || selection[4] !== 'N----' || auth[1] !== '-') unknown();
      continue;
    }
    if (selection[3] !== '-----' || selection[4] !== '-----') unknown();
    const unavailable = line[1] === '?' || parseInt(line[5],8) === 0
      || number(line[6])*1000 > MAX_REFERENCE_AGE_MS;
    if (unavailable) {
      if (line[1] === '*' || !['?','s','M','d','S','w','+','D','P','U'].includes(selection[0])
        || !['N','Y'].includes(selection[2]) || !['NTS','-'].includes(auth[1])) unknown();
      continue; // No reachable/recent selectable vote; never count cached authentication.
    }
    if (selection[2] !== 'Y' || auth[1] !== 'NTS' || !['*','+','D','P','U'].includes(selection[0])
      || (line[1] === '*' ? selection[0] !== '*' : selection[0] === '*')
      || selection[9] !== 'N' || !Number.isFinite(interval(selection[7]))
      || !Number.isFinite(interval(selection[8])) || interval(selection[7]) > interval(selection[8])
      || !Number.isInteger(number(line[3])) || number(line[3]) < 1 || number(line[3]) > 15
      || !Number.isInteger(number(line[4])) || number(line[4]) < 6 || number(line[4]) > 8
      || !/^[0-7]{1,3}$/.test(line[5]) || parseInt(line[5],8) === 0
      || !Number.isFinite(number(line[6])) || number(line[6]) < 0 || number(line[6])*1000 > MAX_REFERENCE_AGE_MS) unknown();
    const packet = details.packets?.find(packet => packet.name === name);
    if (!packet || !isIP(packet.address) || typeof packet.data !== 'string') unknown();
    const entries = packet.data.trim().split('\n').map(row => row.split(/\s*:\s+/));
    if (entries.some(row => row.length !== 2) || new Set(entries.map(row => row[0].trim())).size !== entries.length) unknown();
    const data = Object.fromEntries(entries.map(([key,value]) => [key.trim(),value]));
    if (data['Remote address']?.split(' ')[0] !== packet.address || data['Remote port'] !== '123'
      || (line[1] === '*' && !data['Remote address'].endsWith(' ('+fields[0].toUpperCase()+')'))
      || data['Authenticated'] !== 'Yes' || data['Version'] !== '4' || data['Mode'] !== 'Server'
      || data['Leap status'] !== 'Normal' || data['NTP tests'] !== '111 111 1111'
      || !/^[1-9][0-9]*$/.test(data['Total good RX'] ?? '')) unknown();
    selectable.push(name);
  }
  if (!Array.isArray(details.packets) || new Set(details.packets.map(packet => packet.name)).size !== details.packets.length
    || new Set(details.packets.map(packet => packet.address)).size !== details.packets.length
    || details.packets.some(packet => !NTS_SOURCES.includes(packet.name))) unknown();
  const selected = lines.filter(line => line[1] === '*');
  if (selectable.length < 2 || selected.length !== 1 || selected[0][2] !== fields[1]) unknown();
  const selectedInterval = selections.get(selected[0][2]);
  if (selectable.filter(name => {
    const candidate = selections.get(name);
    return Math.max(interval(candidate[7]),interval(selectedInterval[7]))
      <= Math.min(interval(candidate[8]),interval(selectedInterval[8]));
  }).length < 2) unknown();
  const synchronization = {service:'chrony',referenceAgeMs:nowMs-number(fields[3])*1000,
    rootDistanceMs:(number(fields[10])/2+number(fields[11]))*1000,correctionMs:number(fields[4])*1000,
    sourceCount:selectable.length,sourcePolicy:SOURCE_POLICY,configSha256:CHRONY_CONFIG_SHA256,
    configuredSourceCount:3,authenticatedSourceCount:selectable.length,
    selectableSources:selectable.sort(),selectedSource:selected[0][2]};
  validateCurrentTimeEvidence({formatVersion:2,source:'linux-boottime',bootId:'00000000-0000-0000-0000-000000000000',
    timeNamespaceId:'time:[0]',bootLowerMs:0,bootUpperMs:0,wallAtUTC:new Date(nowMs).toISOString(),
    wallResolutionMs:1,synchronization});
  return synchronization;
}

export function evidenceFromLinuxReads(reads) {
  const uptime = text => {
    const first = typeof text === 'string' ? text.trim().split(/\s+/)[0] : '';
    if (!/^[0-9]+\.[0-9]{2}$/.test(first)) throw new Error('TRUSTED_TIME_UNKNOWN');
    const [seconds,fraction] = first.split('.');
    const ms = Number(seconds)*1000+Number(fraction)*10;
    if (!Number.isSafeInteger(ms)) throw new Error('TRUSTED_TIME_UNKNOWN');
    return ms;
  };
  if (!reads || reads.bootBefore !== reads.bootAfter || reads.namespaceBefore !== reads.namespaceAfter) {
    throw new Error('TRUSTED_TIME_UNKNOWN');
  }
  const before = uptime(reads.uptimeBefore), after = uptime(reads.uptimeAfter);
  if (after < before) throw new Error('TRUSTED_TIME_UNKNOWN');
  return validateCurrentTimeEvidence({formatVersion:2,source:'linux-boottime',bootId:reads.bootBefore,
    timeNamespaceId:reads.namespaceBefore,bootLowerMs:before,bootUpperMs:after+10,
    wallAtUTC:reads.wallAtUTC,wallResolutionMs:1,synchronization:reads.synchronization});
}

/**
 * Compares two `chronyc -N -c sources -a` reports for a source replacement,
 * selection, reachability, poll or identity change during one collection.
 * Field 6 is `LastRx`, a per-second age counter rather than a source property;
 * it is omitted so ordinary time progression cannot be mistaken for a change.
 * Every other field remains significant, including offsets and root distance,
 * so a real poll or source replacement is still denied.
 */
export function sameSourceReport(before, after) {
  if (typeof before !== 'string' || typeof after !== 'string') return false;
  const normalize = report => report.split('\n').map(line => {
    const fields = line.split(',');
    return fields.length === 10 ? [...fields.slice(0,6),...fields.slice(7)].join(',') : line;
  }).join('\n');
  return normalize(before) === normalize(after);
}

/** Fixed production paths/commands only. Never accepts caller clock overrides. */
function collectChronyTime() {
  try {
    if (process.platform !== 'linux' || !collectorUidAllowed()) throw new Error('TRUSTED_TIME_UNKNOWN');
    const started=performance.now();
    const run = (file,args) => {
      const remaining=2000-Math.ceil(performance.now()-started);
      if(remaining<=0)throw new Error('TRUSTED_TIME_UNKNOWN');
      return fixedRun(file,file==='/usr/bin/chronyc'?['-h','/run/chrony/chronyd.sock',...args]:args,remaining);
    };
    if (run('/usr/bin/systemctl',['is-active','chrony.service']) !== 'active') throw new Error('TRUSTED_TIME_UNKNOWN');
    // systemctl exits nonzero for an inactive unit. No service mutation is used.
    try {
      run('/usr/bin/systemctl',['is-active','systemd-timesyncd.service']);
      throw new Error('TRUSTED_TIME_UNKNOWN');
    } catch (error) {
      if (![3,4].includes(error.status) || !['inactive','failed'].includes(String(error.stdout).trim())) throw new Error('TRUSTED_TIME_UNKNOWN');
    }
    const bootBefore = readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
    const namespaceBefore = readlinkSync('/proc/self/ns/time');
    if (!/^monotonic\s+0\s+0\s+boottime\s+0\s+0\s*$/.test(readFileSync('/proc/self/timens_offsets','utf8').trim())) {
      throw new Error('TRUSTED_TIME_UNKNOWN');
    }
    const uptimeBefore = readFileSync('/proc/uptime','utf8');
    const configFd = openSync('/etc/chrony/chrony.conf',constants.O_RDONLY|constants.O_NOFOLLOW);
    let config;
    try {
      const info = fstatSync(configFd);
      if (!info.isFile() || info.uid !== 0 || info.gid !== 0 || info.nlink !== 1
        || (info.mode & 0o7777) !== 0o644 || info.size > 16384) throw new Error('TRUSTED_TIME_UNKNOWN');
      config = readFileSync(configFd,'utf8');
    } finally { closeSync(configFd); }
    const tracking = run('/usr/bin/chronyc',['-N','-c','tracking']);
    const sources = run('/usr/bin/chronyc',['-N','-c','sources','-a']);
    // These monitoring reports require Chrony's privileged socket in 4.5.
    // Never grant the app that socket: unavailable access is UNKNOWN, not a fallback.
    const selectdata = run('/usr/bin/chronyc',['-N','selectdata','-a']);
    const authdata = run('/usr/bin/chronyc',['-N','authdata','-a']);
    const ntpdata = run('/usr/bin/chronyc',['-n','ntpdata']);
    const blocks = ntpdata.split(/(?=Remote address\s+:)/).map(block => block.trim()).filter(Boolean);
    if (blocks.length > 4) throw new Error('TRUSTED_TIME_UNKNOWN');
    const packets = [];
    for (const data of blocks) {
      const address = /^Remote address\s+: ([^ ]+)/.exec(data)?.[1];
      if (!isIP(address)) throw new Error('TRUSTED_TIME_UNKNOWN');
      // Ask the daemon for its ORIGINAL configured name, never reverse DNS.
      const name = run('/usr/bin/chronyc',['sourcename',address]);
      if (name === MONITOR_SOURCE) continue;
      if (!NTS_SOURCES.includes(name)) throw new Error('TRUSTED_TIME_UNKNOWN');
      packets.push({name,address,data});
    }
    // A poll/selection/source replacement during collection denies this sample.
    if (!sameSourceReport(sources,run('/usr/bin/chronyc',['-N','-c','sources','-a']))
      || selectdata !== run('/usr/bin/chronyc',['-N','selectdata','-a'])
      || config !== readFileSync('/etc/chrony/chrony.conf','utf8')) throw new Error('TRUSTED_TIME_UNKNOWN');
    const wallAtUTC = new Date().toISOString();
    const synchronization = parseSynchronization(tracking,sources,Date.parse(wallAtUTC),{config,selectdata,authdata,packets});
    return evidenceFromLinuxReads({bootBefore,namespaceBefore,uptimeBefore,wallAtUTC,synchronization,
      uptimeAfter:readFileSync('/proc/uptime','utf8'),
      bootAfter:readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(),namespaceAfter:readlinkSync('/proc/self/ns/time')});
  } catch { throw new Error('TRUSTED_TIME_UNKNOWN'); }
}

/** Transport validation is separate from persisted TimeEvidence format2. */
export function validateRestrictedReply(reply,context) {
  try {
    if (!exact(reply,['formatVersion','nonce','identity','time']) || reply.formatVersion!==1 || !/^[0-9a-f]{64}$/.test(context.nonce) || reply.nonce!==context.nonce) throw new Error('TRUSTED_TIME_UNKNOWN');
    if (JSON.stringify(reply.identity)!==JSON.stringify(context.before.identity) || JSON.stringify(reply.identity)!==JSON.stringify(context.after.identity)) throw new Error('TRUSTED_TIME_UNKNOWN');
    if(reply.time.bootId!==reply.identity.bootId || reply.time.timeNamespaceId!==context.before.namespace || context.before.namespace!==context.after.namespace) throw new Error('TRUSTED_TIME_UNKNOWN');
    if(!Number.isSafeInteger(context.before.bootMs) || !Number.isSafeInteger(context.after.bootMs) || context.after.bootMs<context.before.bootMs || context.after.bootMs-context.before.bootMs>2500) throw new Error('TRUSTED_TIME_UNKNOWN');
    if(reply.time.bootLowerMs<context.before.bootMs || reply.time.bootUpperMs>context.after.bootMs+10) throw new Error('TRUSTED_TIME_UNKNOWN');
    return validateCurrentTimeEvidence(reply.time);
  } catch {throw new Error('TRUSTED_TIME_UNKNOWN');}
}


function collectorUidAllowed() {
  const uid=process.getuid();
  if(uid===0)return true;
  const account=fixedRun('/usr/bin/getent',['passwd','_chrony']).split(':');
  return account.length===7 && /^\d+$/.test(account[2]) && uid===Number(account[2]);
}
export const READER_UNIT_SHA256='62549b2245f5f712a816268eec74364b4291a4ee597ceab99e9a59d4076ac6b4';
export const READER_SOCKET_UNIT_SHA256='2ea5811188acd78013fa89dd0734169eb2cddceeef4ea223d0492834f1b3ed55';
const READER_SOCKET='/run/servora-med-time/evidence.sock';
const INSTALLED_TIME='/usr/local/libexec/servora-med/trusted-time.mjs';
const RELEASE_TIME=/^\/opt\/servora-med\/releases\/[0-9a-f]{40}\/ops\/scripts\/trusted-time\.mjs$/;
const MAX_READER_BYTES=16384;
function fixedRun(file,args,timeout=500) {
  return execFileSync(file,args,{encoding:'utf8',timeout,maxBuffer:MAX_READER_BYTES,
    env:{PATH:'/usr/bin:/bin',LC_ALL:'C'},stdio:['ignore','pipe','pipe']}).trim();
}
function descriptor(info) {
  return {kind:info.isFile()?'file':info.isDirectory()?'directory':'other',uid:info.uid,gid:info.gid,mode:info.mode&0o7777,nlink:info.nlink};
}
function ancestorDescriptors(path) {
  const ancestors=[];
  for(let parent=path.slice(0,path.lastIndexOf('/'));parent;parent=parent.slice(0,parent.lastIndexOf('/'))) ancestors.push(descriptor(lstatSync(parent)));
  return ancestors;
}
function protectedAncestors(path) {
  for(const ancestor of ancestorDescriptors(path)) if(ancestor.kind!=='directory'||ancestor.uid!==0||ancestor.gid!==0||(ancestor.mode&0o022)) throw new Error('TRUSTED_TIME_UNKNOWN');
}
/** Installed code is root:root 0644. The deployed release copy is root:servora-med 0650
 * under 0750 release directories. Neither group can write. No other executing path is accepted. */
export function validateTimeModuleContract(path,info,ancestors,releaseGid) {
  if(path===INSTALLED_TIME) {
    if(info.kind!=='file'||info.uid!==0||info.gid!==0||info.nlink!==1||info.mode!==0o644) throw new Error('TRUSTED_TIME_UNKNOWN');
    for(const ancestor of ancestors) if(ancestor.kind!=='directory'||ancestor.uid!==0||ancestor.gid!==0||(ancestor.mode&0o022)) throw new Error('TRUSTED_TIME_UNKNOWN');
    return 'installed';
  }
  if(!RELEASE_TIME.test(path)) throw new Error('TRUSTED_TIME_UNKNOWN');
  if(!Number.isSafeInteger(releaseGid)||releaseGid<1) throw new Error('TRUSTED_TIME_UNKNOWN');
  if(info.kind!=='file'||info.uid!==0||info.gid!==releaseGid||info.nlink!==1||info.mode!==0o650) throw new Error('TRUSTED_TIME_UNKNOWN');
  if(ancestors.length!==6) throw new Error('TRUSTED_TIME_UNKNOWN');
  for(const ancestor of ancestors.slice(0,3)) {
    if(ancestor.kind!=='directory'||ancestor.uid!==0||ancestor.gid!==releaseGid||ancestor.mode!==0o750) throw new Error('TRUSTED_TIME_UNKNOWN');
  }
  for(const ancestor of ancestors.slice(3)) {
    if(ancestor.kind!=='directory'||ancestor.uid!==0||![0,releaseGid].includes(ancestor.gid)||(ancestor.mode&0o022)) throw new Error('TRUSTED_TIME_UNKNOWN');
  }
  return 'release';
}
function releaseGroupGid() {
  const group=fixedRun('/usr/bin/getent',['group','servora-med']).split(':');
  if(group.length!==4||!/^\d+$/.test(group[2])||Number(group[2])<1) throw new Error('TRUSTED_TIME_UNKNOWN');
  return Number(group[2]);
}
function protectedModuleBytes(path) {
  const ancestors=ancestorDescriptors(path);
  const releaseGid=RELEASE_TIME.test(path)?releaseGroupGid():-1;
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const before=fstatSync(fd),byPath=lstatSync(path);
    if(before.size>262144 || before.ino!==byPath.ino || before.dev!==byPath.dev) throw new Error('TRUSTED_TIME_UNKNOWN');
    validateTimeModuleContract(path,descriptor(before),ancestors,releaseGid);
    const bytes=readFileSync(fd),after=fstatSync(fd);
    if(before.size!==after.size || before.mtimeMs!==after.mtimeMs || before.ctimeMs!==after.ctimeMs || bytes.length!==before.size) throw new Error('TRUSTED_TIME_UNKNOWN');
    return {bytes,dev:before.dev,ino:before.ino,ctimeMs:before.ctimeMs};
  } finally {closeSync(fd);}
}
function protectedBytes(path) {
  protectedAncestors(path);
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const before=fstatSync(fd),byPath=lstatSync(path);
    if(!before.isFile() || before.uid!==0 || before.gid!==0 || before.nlink!==1
      || (before.mode&0o7777)!==0o644 || before.size>262144 || before.ino!==byPath.ino || before.dev!==byPath.dev) throw new Error('TRUSTED_TIME_UNKNOWN');
    const bytes=readFileSync(fd),after=fstatSync(fd);
    if(before.size!==after.size || before.mtimeMs!==after.mtimeMs || before.ctimeMs!==after.ctimeMs || bytes.length!==before.size) throw new Error('TRUSTED_TIME_UNKNOWN');
    return {bytes,dev:before.dev,ino:before.ino,ctimeMs:before.ctimeMs};
  } finally {closeSync(fd);}
}
function clockRead() {
  const bootId=readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
  const namespace=readlinkSync('/proc/self/ns/time');
  if(!/^monotonic\s+0\s+0\s+boottime\s+0\s+0\s*$/.test(readFileSync('/proc/self/timens_offsets','utf8').trim())) throw new Error('TRUSTED_TIME_UNKNOWN');
  const uptime=readFileSync('/proc/uptime','utf8').split(' ')[0];
  if(!/^\d+\.\d{2}$/.test(uptime))throw new Error('TRUSTED_TIME_UNKNOWN');
  return {bootId,namespace,bootMs:Math.round(Number(uptime)*1000)};
}
function chronyIdentity() {
  const props=fixedRun('/usr/bin/systemctl',['show','chrony.service','--property=ActiveState,MainPID,InvocationID']);
  const rows=Object.fromEntries(props.split('\n').map(row=>row.split('=')));
  if(Object.keys(rows).length!==3 || rows.ActiveState!=='active' || !/^[1-9]\d*$/.test(rows.MainPID) || !/^[0-9a-f]{32}$/.test(rows.InvocationID))throw new Error('TRUSTED_TIME_UNKNOWN');
  const pid=Number(rows.MainPID),stat=readFileSync(`/proc/${pid}/stat`,'utf8');
  const fields=stat.slice(stat.lastIndexOf(')')+2).split(' '),startTicks=fields[19];
  if(!/^\d+$/.test(startTicks))throw new Error('TRUSTED_TIME_UNKNOWN');
  // Reject alternate config/command-line directives: Ubuntu24.04's fixed default only.
  const argv=readFileSync(`/proc/${pid}/cmdline`,'utf8').split('\0').filter(Boolean);
  if(!['["/usr/sbin/chronyd","-F","1"]','["/usr/sbin/chronyd"]'].includes(JSON.stringify(argv)))throw new Error('TRUSTED_TIME_UNKNOWN');
  const config=protectedBytes('/etc/chrony/chrony.conf');
  const configSha256=createHash('sha256').update(config.bytes).digest('hex');
  if(configSha256!==CHRONY_CONFIG_SHA256)throw new Error('TRUSTED_TIME_UNKNOWN');
  const module=protectedModuleBytes(fileURLToPath(import.meta.url));
  const endpoint=collectorUidAllowed()?'/run/chrony/chronyd.sock':'127.0.0.1';
  const sourceRows=fixedRun('/usr/bin/chronyc',['-h',endpoint,'-N','-c','sources','-a']).split('\n').map(row=>row.split(',').slice(0,6));
  const tracking=fixedRun('/usr/bin/chronyc',['-h',endpoint,'-N','-c','tracking']).split(',').slice(0,4);
  const selectionSha256=createHash('sha256').update(JSON.stringify({sourceRows,tracking})).digest('hex');
  return {bootId:clockRead().bootId,service:rows.ActiveState,pid,startTicks,invocationId:rows.InvocationID,
    configSha256,configDev:config.dev,configIno:config.ino,configCtimeMs:config.ctimeMs,selectionSha256,moduleSha256:createHash('sha256').update(module.bytes).digest('hex')};
}
export function validateReaderSocketMetadata(info,gid) {
  if(!Number.isSafeInteger(gid) || gid<1 || !info.isSocket() || info.uid!==0 || info.gid!==gid || info.nlink!==1 || (info.mode&0o7777)!==0o660 || !Number.isSafeInteger(info.ino) || info.ino<1)throw new Error('TRUSTED_TIME_UNKNOWN');
  return {dev:info.dev,ino:info.ino};
}
function readerSocketIdentity() {
  if(createHash('sha256').update(protectedBytes('/etc/systemd/system/servora-med-time-evidence@.service').bytes).digest('hex')!==READER_UNIT_SHA256)throw new Error('TRUSTED_TIME_UNKNOWN');
  if(createHash('sha256').update(protectedBytes('/etc/systemd/system/servora-med-time-evidence.socket').bytes).digest('hex')!==READER_SOCKET_UNIT_SHA256)throw new Error('TRUSTED_TIME_UNKNOWN');
  protectedAncestors(READER_SOCKET);
  const info=lstatSync(READER_SOCKET);
  const group=fixedRun('/usr/bin/getent',['group','servora-med']).split(':');
  if(group.length!==4 || !/^\d+$/.test(group[2]))throw new Error('TRUSTED_TIME_UNKNOWN');
  return validateReaderSocketMetadata(info,Number(group[2]));
}
/** No caller arguments, privilege escalation, cache, fallback or persistent snapshot. */
export async function readRestrictedTime() {
  try {
  const socketBefore=readerSocketIdentity(),clockBefore=clockRead(),identity=chronyIdentity();
  const nonce=randomBytes(32).toString('hex');
  const payload=await new Promise((resolve,reject)=>{
    let output=Buffer.alloc(0),done=false;
    const connection=createConnection({path:READER_SOCKET});
    const finish=(error)=>{if(done)return;done=true;clearTimeout(timer);connection.destroy();error?reject(error):resolve(output);};
    const timer=setTimeout(()=>finish(new Error('TRUSTED_TIME_UNKNOWN')),2200);
    connection.on('connect',()=>connection.end(nonce+'\n'));
    connection.on('data',chunk=>{if(output.length+chunk.length>MAX_READER_BYTES)finish(new Error('TRUSTED_TIME_UNKNOWN'));else output=Buffer.concat([output,chunk]);});
    connection.on('error',finish);connection.on('end',()=>finish());
  });
  const afterIdentity=chronyIdentity(),clockAfter=clockRead(),socketAfter=readerSocketIdentity();
  if(JSON.stringify(socketBefore)!==JSON.stringify(socketAfter))throw new Error('TRUSTED_TIME_UNKNOWN');
  return validateRestrictedReply(JSON.parse(payload.toString('utf8')),{nonce,
    before:{identity,bootMs:clockBefore.bootMs,namespace:clockBefore.namespace},
    after:{identity:afterIdentity,bootMs:clockAfter.bootMs,namespace:clockAfter.namespace}});
  } catch {throw new Error('TRUSTED_TIME_UNKNOWN');}
}
/** Existing synchronous API, bounded child; all consumers use the same restricted path. */
export function sampleTrustedTime() {
  try {
    if(process.platform!=='linux')throw new Error('TRUSTED_TIME_UNKNOWN');
    const bytes=execFileSync(process.execPath,['--no-addons',fileURLToPath(import.meta.url),'--read-chrony'],{
      encoding:'utf8',timeout:2800,maxBuffer:MAX_READER_BYTES,env:{PATH:'/usr/bin:/bin',LC_ALL:'C'},stdio:['ignore','pipe','ignore']});
    return validateCurrentTimeEvidence(JSON.parse(bytes));
  } catch {throw new Error('TRUSTED_TIME_UNKNOWN');}
}
function collectRestrictedReply() {
  if(!collectorUidAllowed() || fileURLToPath(import.meta.url)!==INSTALLED_TIME)throw new Error('TRUSTED_TIME_UNKNOWN');
  const input=Buffer.alloc(66);let count=0;
  while(count<input.length) {const n=readSync(0,input,count,input.length-count,null);if(!n)break;count+=n;}
  const nonce=input.subarray(0,count).toString('utf8');
  if(!/^[0-9a-f]{64}\n$/.test(nonce))throw new Error('TRUSTED_TIME_UNKNOWN');
  const before=chronyIdentity(),time=collectChronyTime(),after=chronyIdentity();
  if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('TRUSTED_TIME_UNKNOWN');
  return {formatVersion:1,nonce:nonce.trim(),identity:before,time};
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  try {
    if(process.argv.length!==3)throw new Error('TRUSTED_TIME_UNKNOWN');
    let result;
    if(process.argv[2]==='--collect-chrony')result=collectRestrictedReply();
    else if(process.argv[2]==='--read-chrony')result=await readRestrictedTime();
    else throw new Error('TRUSTED_TIME_UNKNOWN');
    writeSync(1,JSON.stringify(result)+'\n');
  } catch {process.exitCode=1;}
}
