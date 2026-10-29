/** Read-only infrastructure time evidence. No domain TTLs or clock setters. */
import { readFileSync, readlinkSync, constants, openSync, fstatSync, closeSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
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
    if (line[1] === '?') {
      if (!['?','s','M','d','S','w'].includes(selection[0])
        || !['N','Y'].includes(selection[2]) || !['NTS','-'].includes(auth[1])) unknown();
      continue; // Unavailable sources never vote and need no historical packet proof.
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

/** Fixed production paths/commands only. Never accepts caller clock overrides. */
export function sampleTrustedTime() {
  try {
    if (process.platform !== 'linux') throw new Error('TRUSTED_TIME_UNKNOWN');
    const run = (file,args) => execFileSync(file,args,{encoding:'utf8',timeout:2000,maxBuffer:16384,
      env:{PATH:'/usr/bin:/bin',LC_ALL:'C'},stdio:['ignore','pipe','pipe']}).trim();
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
    if (sources !== run('/usr/bin/chronyc',['-N','-c','sources','-a'])
      || selectdata !== run('/usr/bin/chronyc',['-N','selectdata','-a'])
      || config !== readFileSync('/etc/chrony/chrony.conf','utf8')) throw new Error('TRUSTED_TIME_UNKNOWN');
    const wallAtUTC = new Date().toISOString();
    const synchronization = parseSynchronization(tracking,sources,Date.parse(wallAtUTC),{config,selectdata,authdata,packets});
    return evidenceFromLinuxReads({bootBefore,namespaceBefore,uptimeBefore,wallAtUTC,synchronization,
      uptimeAfter:readFileSync('/proc/uptime','utf8'),
      bootAfter:readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(),namespaceAfter:readlinkSync('/proc/self/ns/time')});
  } catch { throw new Error('TRUSTED_TIME_UNKNOWN'); }
}
