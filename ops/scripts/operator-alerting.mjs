// Servora-Med operator alerting monitor — one-shot, importable ESM.
//
// Runs once per invocation: probes application health, backup freshness and
// disk free space, deduplicates alerts through a versioned state file and
// delivers vendor-neutral JSON webhook events. Importing this module performs
// no work; only `main()` executes the monitor.
//
// Defaults are disabled: with SERVORA_ALERTING_ENABLED=false the process
// exits 0 without any network access or state mutation.

import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';

export const SCHEMA_VERSION = 1;
export const STATE_VERSION = 1;
export const APPLICATION_LABEL = 'Servora-Med';

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

export class StateVersionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StateVersionError';
  }
}

export class StateReadError extends Error {
  constructor(category) {
    super(`state read failed: ${category}`);
    this.name = 'StateReadError';
    this.category = category;
  }
}

export class StateQuarantineError extends Error {
  constructor(category) {
    super(`state quarantine failed: ${category}`);
    this.name = 'StateQuarantineError';
    this.category = category;
  }
}

export class StateDirError extends Error {
  constructor(category) {
    super(`state directory failed: ${category}`);
    this.name = 'StateDirError';
    this.category = category;
  }
}

export class LockError extends Error {
  constructor(category) {
    super(`lock ${category}`);
    this.name = 'LockError';
    this.category = category;
  }
}

export const CHECK_NAMES = ['health', 'backup', 'disk'];

const SAFE_LABEL_RE = /^[A-Za-z0-9._-]{1,64}$/;
const BACKUP_RE = /^servora-med-(\d{8}T\d{6}Z)\.dump$/;
const SIDECAR_RE = /^([0-9a-f]{64})  (servora-med-\d{8}T\d{6}Z\.dump)$/;

// Lock ownership contract.
export const LOCK_VERSION = 1;
const LOCK_TOKEN_RE = /^[A-Za-z0-9-]{8,128}$/;
const LOCK_CLOCK_SKEW_MS = 60_000;
const RECLAIM_GUARD_FILE = 'lock.reclaim';

export function classifyKillError(error) {
  if (error?.code === 'EPERM') return 'alive';
  if (error?.code === 'ESRCH') return 'dead';
  return 'unknown';
}

export function probeProcess(pid) {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    return classifyKillError(error);
  }
}

export function createDefaultDeps() {
  return {
    statfs: statfsSync,
    readdir: readdirSync,
    lstat: lstatSync,
    readFile: readFileSync,
    writeFile: writeFileSync,
    rename: renameSync,
    link: linkSync,
    unlink: unlinkSync,
    mkdir: mkdirSync,
    chmod: chmodSync,
    exists: existsSync,
    fetch: globalThis.fetch,
    hashFile: (filePath) => createHash('sha256').update(readFileSync(filePath)).digest('hex'),
    probeProcess,
    randomToken: () => randomBytes(16).toString('hex'),
    now: () => Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function strictBoolean(raw, name) {
  if (typeof raw !== 'string') throw new ConfigError(`${name} must be a strict boolean (true|false)`);
  const value = raw.trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new ConfigError(`${name} must be a strict boolean (true|false)`);
}

function finiteNumber(raw, name, { integer = false, min = 0 } = {}) {
  if (typeof raw !== 'string' || raw.trim() === '') throw new ConfigError(`${name} is required`);
  const value = Number(raw.trim());
  if (!Number.isFinite(value)) throw new ConfigError(`${name} must be a finite number`);
  if (integer && !Number.isInteger(value)) throw new ConfigError(`${name} must be an integer`);
  if (value < min) throw new ConfigError(`${name} must be >= ${min}`);
  return value;
}

function safeLabel(raw, name, fallback) {
  const value = raw === undefined || raw === null || String(raw).trim() === '' ? fallback : String(raw).trim();
  if (!SAFE_LABEL_RE.test(value)) throw new ConfigError(`${name} must match ${SAFE_LABEL_RE}`);
  return value;
}

function absoluteDirectory(raw, name) {
  if (typeof raw !== 'string' || raw.trim() === '') throw new ConfigError(`${name} is required when alerting is enabled`);
  if (!raw.startsWith('/')) throw new ConfigError(`${name} must be an absolute path`);
  return raw;
}

function backupSource(raw) {
  const value = raw === undefined || raw === '' ? 'legacy' : String(raw).trim();
  if (value !== 'legacy' && value !== 'verified-runs') {
    throw new ConfigError('SERVORA_ALERT_BACKUP_SOURCE must be legacy or verified-runs');
  }
  return value;
}

export function parseWebhookUrl(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') throw new ConfigError('SERVORA_ALERT_WEBHOOK_URL is required when alerting is enabled');
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ConfigError('SERVORA_ALERT_WEBHOOK_URL is malformed');
  }
  if (url.username || url.password) throw new ConfigError('SERVORA_ALERT_WEBHOOK_URL must not contain credentials');
  if (!url.hostname) throw new ConfigError('SERVORA_ALERT_WEBHOOK_URL must have a hostname');
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:') {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1';
    if (!loopback) throw new ConfigError('SERVORA_ALERT_WEBHOOK_URL plain http is only allowed for loopback hosts');
    return url;
  }
  throw new ConfigError(`SERVORA_ALERT_WEBHOOK_URL unsupported protocol ${url.protocol}`);
}

export function loadConfig(env) {
  const enabled = strictBoolean(env.SERVORA_ALERTING_ENABLED ?? 'false', 'SERVORA_ALERTING_ENABLED');
  if (!enabled) {
    return {
      enabled: false,
      environment: safeLabel(env.SERVORA_ALERT_ENVIRONMENT, 'SERVORA_ALERT_ENVIRONMENT', 'local'),
      instanceLabel: safeLabel(env.SERVORA_ALERT_INSTANCE_LABEL, 'SERVORA_ALERT_INSTANCE_LABEL', 'servora-med'),
    };
  }

  const webhookUrl = parseWebhookUrl(env.SERVORA_ALERT_WEBHOOK_URL);
  const healthUrlRaw = env.SERVORA_ALERT_HEALTH_URL;
  let healthUrl;
  try {
    healthUrl = new URL(healthUrlRaw);
  } catch {
    throw new ConfigError('SERVORA_ALERT_HEALTH_URL is malformed');
  }
  if (!['http:', 'https:'].includes(healthUrl.protocol) || !healthUrl.hostname) {
    throw new ConfigError('SERVORA_ALERT_HEALTH_URL must be http(s) with a hostname');
  }

  const backupMaxAgeHours = finiteNumber(env.SERVORA_ALERT_BACKUP_MAX_AGE_HOURS, 'SERVORA_ALERT_BACKUP_MAX_AGE_HOURS');
  const diskMinFreePercent = finiteNumber(env.SERVORA_ALERT_DISK_MIN_FREE_PERCENT, 'SERVORA_ALERT_DISK_MIN_FREE_PERCENT', { min: 0 });
  if (diskMinFreePercent > 100) throw new ConfigError('SERVORA_ALERT_DISK_MIN_FREE_PERCENT must be <= 100');
  const failureThreshold = finiteNumber(env.SERVORA_ALERT_FAILURE_THRESHOLD, 'SERVORA_ALERT_FAILURE_THRESHOLD', { integer: true, min: 1 });
  const cooldownMinutes = finiteNumber(env.SERVORA_ALERT_COOLDOWN_MINUTES, 'SERVORA_ALERT_COOLDOWN_MINUTES');
  const timeoutMs = finiteNumber(env.SERVORA_ALERT_TIMEOUT_MS, 'SERVORA_ALERT_TIMEOUT_MS', { integer: true, min: 1 });

  return {
    enabled: true,
    webhookUrl: webhookUrl.toString(),
    webhookHostLabel: redactWebhookUrl(webhookUrl),
    healthUrl: healthUrl.toString(),
    backupDir: absoluteDirectory(env.SERVORA_ALERT_BACKUP_DIR, 'SERVORA_ALERT_BACKUP_DIR'),
    backupMaxAgeHours,
    diskPath: absoluteDirectory(env.SERVORA_ALERT_DISK_PATH ?? '/', 'SERVORA_ALERT_DISK_PATH'),
    diskLabel: safeLabel(env.SERVORA_ALERT_DISK_LABEL, 'SERVORA_ALERT_DISK_LABEL', 'disk-target'),
    diskMinFreePercent,
    failureThreshold,
    cooldownMinutes,
    cooldownMs: cooldownMinutes * 60 * 1000,
    timeoutMs,
    stateDir: absoluteDirectory(env.SERVORA_ALERT_STATE_DIR, 'SERVORA_ALERT_STATE_DIR'),
    environment: safeLabel(env.SERVORA_ALERT_ENVIRONMENT, 'SERVORA_ALERT_ENVIRONMENT', 'local'),
    instanceLabel: safeLabel(env.SERVORA_ALERT_INSTANCE_LABEL, 'SERVORA_ALERT_INSTANCE_LABEL', 'servora-med'),
    backupSource: backupSource(env.SERVORA_ALERT_BACKUP_SOURCE),
  };
}

export function redactWebhookUrl(url) {
  return `${url.protocol}//${url.host}`;
}

// ---------------------------------------------------------------------------
// Health probe
// ---------------------------------------------------------------------------

export async function probeHealth(config, deps) {
  const started = deps.now();
  const result = { ok: false, httpStatus: null, timeout: false, errorCategory: null, latencyMs: null, backup: null };
  try {
    const response = await deps.fetch(config.healthUrl, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    result.latencyMs = deps.now() - started;
    if (response.status >= 300 && response.status < 400) {
      result.errorCategory = 'redirect';
      return result;
    }
    result.httpStatus = response.status;
    if (response.status !== 200) {
      result.errorCategory = `http-${response.status}`;
      return result;
    }
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      result.errorCategory = 'invalid-body';
      return result;
    }
    if (body?.status !== 'ok') {
      result.errorCategory = 'invalid-body';
      return result;
    }
    const backup = body?.backup;
    if (backup && typeof backup === 'object') {
      result.backup = {
        status: backup.status === 'ok' ? 'ok' : 'unavailable',
        latestVerifiedAt: typeof backup.latestVerifiedAt === 'string' ? backup.latestVerifiedAt : null,
        latestScheduledVerifiedAt: typeof backup.latestScheduledVerifiedAt === 'string' ? backup.latestScheduledVerifiedAt : null,
        latestRunStatus: typeof backup.latestRunStatus === 'string' ? backup.latestRunStatus : null,
        latestScheduledRunStatus: typeof backup.latestScheduledRunStatus === 'string' ? backup.latestScheduledRunStatus : null,
        workerHeartbeatAt: typeof backup.workerHeartbeatAt === 'string' ? backup.workerHeartbeatAt : null,
        schedulerLastTickAt: typeof backup.schedulerLastTickAt === 'string' ? backup.schedulerLastTickAt : null,
      };
    }
    result.ok = true;
    result.errorCategory = null;
    return result;
  } catch (error) {
    result.latencyMs = deps.now() - started;
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      result.timeout = true;
      result.errorCategory = 'timeout';
    } else {
      result.errorCategory = 'connection';
    }
    return result;
  }
}

export function evaluateVerifiedBackup(config, healthResult, deps) {
  const result = {
    ok: false,
    errorCategory: null,
    latestProblem: null,
    ageHours: null,
    basename: null,
    checksumValid: null,
    latestBackupTimestamp: null,
    workerHeartbeatAt: null,
    schedulerLastTickAt: null,
  };
  const evidence = healthResult?.backup;
  if (!healthResult?.ok || !evidence) {
    result.errorCategory = 'health-unavailable';
    return result;
  }
  result.workerHeartbeatAt = evidence.workerHeartbeatAt;
  result.schedulerLastTickAt = evidence.schedulerLastTickAt;
  if (evidence.latestScheduledRunStatus === 'FAILED') {
    result.errorCategory = 'scheduled-failure';
    result.latestProblem = 'FAILED';
    return result;
  }
  const verifiedAt = evidence.latestScheduledVerifiedAt
    ? new Date(evidence.latestScheduledVerifiedAt)
    : null;
  if (!verifiedAt || !Number.isFinite(verifiedAt.getTime())) {
    result.errorCategory = 'no-verified-backup';
    result.latestProblem = evidence.latestScheduledRunStatus ?? 'no-scheduled-success';
    return result;
  }
  const now = deps.now();
  if (verifiedAt.getTime() > now) {
    result.errorCategory = 'invalid-backup';
    result.latestProblem = 'future-timestamp';
    return result;
  }
  result.latestBackupTimestamp = verifiedAt.toISOString();
  result.ageHours = (now - verifiedAt.getTime()) / 3_600_000;
  result.ok = evidence.status === 'ok' && result.ageHours <= config.backupMaxAgeHours;
  result.errorCategory = result.ok ? null : (evidence.status === 'ok' ? 'stale' : 'worker-unavailable');
  return result;
}

// ---------------------------------------------------------------------------
// Backup freshness
// ---------------------------------------------------------------------------

export function parseBackupTimestamp(timestamp) {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(timestamp);
  if (!match) return null;
  const date = new Date(Date.UTC(
    Number(match[1]), Number(match[2]) - 1, Number(match[3]),
    Number(match[4]), Number(match[5]), Number(match[6]),
  ));
  const roundTripOk = date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() + 1 === Number(match[2])
    && date.getUTCDate() === Number(match[3])
    && date.getUTCHours() === Number(match[4])
    && date.getUTCMinutes() === Number(match[5])
    && date.getUTCSeconds() === Number(match[6]);
  return roundTripOk ? date : null;
}

export function parseSidecar(content) {
  const match = SIDECAR_RE.exec(String(content).replace(/\r\n/g, '\n').trim());
  if (!match) return { error: 'malformed-sidecar' };
  return { digest: match[1], basename: match[2] };
}

export async function evaluateBackup(config, deps) {
  const result = {
    ok: false,
    errorCategory: null,
    latestProblem: null,
    ageHours: null,
    basename: null,
    checksumValid: null,
    latestBackupTimestamp: null,
  };
  let entries;
  try {
    entries = deps.readdir(config.backupDir);
  } catch {
    result.errorCategory = 'missing-dir';
    return result;
  }

  const candidates = [];
  const now = deps.now();
  for (const entry of entries) {
    const match = BACKUP_RE.exec(entry);
    if (!match) continue;
    const timestamp = parseBackupTimestamp(match[1]);
    if (!timestamp) continue;
    candidates.push({ basename: entry, timestamp });
  }

  candidates.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  if (candidates.length === 0) {
    result.errorCategory = 'no-backup';
    return result;
  }

  // The newest canonical backup is authoritative. An invalid newest backup
  // fails closed: older backups are never hashed or accepted as fallback.
  const candidate = candidates[0];
  result.basename = candidate.basename;
  result.latestBackupTimestamp = candidate.timestamp.toISOString();

  if (candidate.timestamp.getTime() > now) {
    result.errorCategory = 'invalid-backup';
    result.latestProblem = 'future-timestamp';
    result.checksumValid = false;
    return result;
  }

  const dumpPath = `${config.backupDir}/${candidate.basename}`;
  const sidecarPath = `${dumpPath}.sha256`;

  let dumpStat;
  try {
    dumpStat = deps.lstat(dumpPath);
  } catch {
    result.errorCategory = 'invalid-backup';
    result.latestProblem = 'unreadable';
    result.checksumValid = false;
    return result;
  }
  if (!dumpStat.isFile()) {
    result.errorCategory = 'invalid-backup';
    result.latestProblem = 'not-regular-file';
    result.checksumValid = false;
    return result;
  }

  let sidecarStat;
  try {
    sidecarStat = deps.lstat(sidecarPath);
  } catch {
    result.errorCategory = 'invalid-backup';
    result.latestProblem = 'missing-sidecar';
    result.checksumValid = false;
    return result;
  }
  if (!sidecarStat.isFile()) {
    result.errorCategory = 'invalid-backup';
    result.latestProblem = 'missing-sidecar';
    result.checksumValid = false;
    return result;
  }

  let sidecar;
  try {
    sidecar = parseSidecar(deps.readFile(sidecarPath, 'utf8'));
  } catch {
    result.errorCategory = 'invalid-backup';
    result.latestProblem = 'malformed-sidecar';
    result.checksumValid = false;
    return result;
  }
  if (sidecar.error) {
    result.errorCategory = 'invalid-backup';
    result.latestProblem = sidecar.error;
    result.checksumValid = false;
    return result;
  }
  if (sidecar.basename !== candidate.basename) {
    result.errorCategory = 'invalid-backup';
    result.latestProblem = 'bad-basename';
    result.checksumValid = false;
    return result;
  }

  let digest;
  try {
    digest = deps.hashFile(dumpPath);
  } catch {
    result.errorCategory = 'invalid-backup';
    result.latestProblem = 'unreadable';
    result.checksumValid = false;
    return result;
  }
  if (digest !== sidecar.digest) {
    result.errorCategory = 'invalid-backup';
    result.latestProblem = 'checksum-mismatch';
    result.checksumValid = false;
    return result;
  }

  result.checksumValid = true;
  result.ageHours = (now - candidate.timestamp.getTime()) / 3_600_000;
  result.ok = result.ageHours <= config.backupMaxAgeHours;
  result.errorCategory = result.ok ? null : 'stale';
  return result;
}

// ---------------------------------------------------------------------------
// Disk probe
// ---------------------------------------------------------------------------

export function probeDisk(config, deps) {
  const result = { ok: false, errorCategory: null, freePercent: null, freeBytes: null, totalBytes: null };
  let stat;
  try {
    stat = deps.statfs(config.diskPath, { bigint: true });
  } catch {
    result.errorCategory = 'statfs-failed';
    return result;
  }
  if (stat.blocks === 0n) {
    result.errorCategory = 'total-zero';
    return result;
  }
  result.totalBytes = Number(stat.blocks * stat.bsize);
  result.freeBytes = Number(stat.bavail * stat.bsize);
  result.freePercent = Number((stat.bavail * 10000n) / stat.blocks) / 100;
  result.ok = result.freePercent >= config.diskMinFreePercent;
  if (!result.ok) result.errorCategory = 'below-threshold';
  return result;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export function createDefaultState() {
  return {
    version: STATE_VERSION,
    monitor: { pendingIncident: null },
    checks: Object.fromEntries(CHECK_NAMES.map((name) => [
      name,
      {
        consecutiveFailures: 0,
        alertActive: false,
        lastAlertAt: null,
        lastReminderAt: null,
        lastRecoveryAt: null,
        lastDeliveredAt: null,
      },
    ])),
  };
}

function isSafeCheckState(value) {
  return typeof value === 'object' && value !== null
    && typeof value.consecutiveFailures === 'number'
    && typeof value.alertActive === 'boolean';
}

export function sanitizeState(raw) {
  if (typeof raw !== 'object' || raw === null) return null;
  if (raw.version !== STATE_VERSION) return raw.version === undefined ? null : { futureVersion: raw.version };
  const checks = {};
  for (const name of CHECK_NAMES) {
    const value = raw.checks?.[name];
    if (!isSafeCheckState(value)) return null;
    checks[name] = {
      consecutiveFailures: value.consecutiveFailures,
      alertActive: value.alertActive,
      lastAlertAt: typeof value.lastAlertAt === 'number' ? value.lastAlertAt : null,
      lastReminderAt: typeof value.lastReminderAt === 'number' ? value.lastReminderAt : null,
      lastRecoveryAt: typeof value.lastRecoveryAt === 'number' ? value.lastRecoveryAt : null,
      lastDeliveredAt: typeof value.lastDeliveredAt === 'number' ? value.lastDeliveredAt : null,
    };
  }
  let pendingIncident = null;
  const monitor = raw.monitor;
  if (monitor && typeof monitor === 'object') {
    const pending = monitor.pendingIncident;
    if (pending && typeof pending === 'object'
      && pending.kind === 'state-corrupt'
      && typeof pending.detectedAt === 'number') {
      pendingIncident = { kind: 'state-corrupt', detectedAt: pending.detectedAt };
    }
  }
  return { version: STATE_VERSION, monitor: { pendingIncident }, checks };
}

function monitorEventForIncident(incident, now) {
  if (!incident || incident.kind !== 'state-corrupt') return null;
  return {
    event: 'monitor',
    check: 'monitor',
    severity: 'critical',
    summary: 'Alerting state was corrupt and has been reset',
    details: {},
  };
}

function readErrorCategory(error) {
  const code = error?.code;
  if (code === 'EACCES' || code === 'EPERM') return 'permission';
  if (code === 'EISDIR' || code === 'ENOTDIR') return 'wrong-type';
  if (code === 'EIO') return 'io';
  return 'other';
}

function quarantineErrorCategory(error) {
  const code = error?.code;
  if (code === 'EACCES' || code === 'EPERM') return 'permission';
  if (code === 'EIO') return 'io';
  return 'other';
}

function quarantineCandidates(config, deps) {
  const base = `state.json.corrupt-${new Date(deps.now()).toISOString().replace(/[:.]/g, '-')}`;
  const candidates = [];
  for (let attempt = 0; attempt < 10; attempt += 1) {
    candidates.push(attempt === 0 ? base : `${base}-${deps.randomToken()}`);
  }
  return candidates;
}

// Atomic no-clobber quarantine: a hard link to the corrupt state file is
// created with `link` (EEXIST on collision is caught atomically), and only
// after the forensic link exists is the source unlinked. A failure in either
// step fails closed: the original state is preserved and no fresh state is
// ever written. Quarantine names never leave this function.
function quarantineState(config, deps, statePath) {
  let stateStats;
  try {
    stateStats = deps.lstat(statePath);
  } catch (error) {
    throw new StateQuarantineError(quarantineErrorCategory(error));
  }
  if (stateStats.isSymbolicLink()) throw new StateQuarantineError('symlink');
  if (!stateStats.isFile()) throw new StateQuarantineError('wrong-type');

  let transferred = false;
  for (const candidate of quarantineCandidates(config, deps)) {
    try {
      deps.link(statePath, `${config.stateDir}/${candidate}`);
      transferred = true;
      break;
    } catch (error) {
      if (error?.code === 'EEXIST') continue;
      throw new StateQuarantineError(quarantineErrorCategory(error));
    }
  }
  if (!transferred) throw new StateQuarantineError('collision');

  try {
    deps.unlink(statePath);
  } catch (error) {
    throw new StateQuarantineError(quarantineErrorCategory(error));
  }
}

export async function loadState(config, deps) {
  const statePath = `${config.stateDir}/state.json`;
  let raw;
  try {
    raw = deps.readFile(statePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { state: createDefaultState(), monitorEvent: null, requiresInitialPersist: false };
    }
    throw new StateReadError(readErrorCategory(error));
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const sanitized = parsed === null ? null : sanitizeState(parsed);
  if (sanitized?.futureVersion !== undefined) {
    throw new StateVersionError(`unsupported state version ${sanitized.futureVersion}`);
  }
  if (sanitized) {
    const incident = sanitized.monitor?.pendingIncident ?? null;
    if (incident) {
      return { state: sanitized, monitorEvent: monitorEventForIncident(incident, deps.now()), requiresInitialPersist: false };
    }
    return { state: sanitized, monitorEvent: null, requiresInitialPersist: false };
  }

  quarantineState(config, deps, statePath);
  const fresh = createDefaultState();
  fresh.monitor.pendingIncident = { kind: 'state-corrupt', detectedAt: deps.now() };
  return {
    state: fresh,
    monitorEvent: monitorEventForIncident(fresh.monitor.pendingIncident, deps.now()),
    requiresInitialPersist: true,
  };
}

// Validates that the state directory is a real directory (no symlinks) and
// normalizes it to 0700 before any lock or state IO happens.
export function ensurePrivateStateDirectory(config, deps) {
  try {
    deps.mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new StateDirError(stateDirErrorCategory(error));
  }
  let stats;
  try {
    stats = deps.lstat(config.stateDir);
  } catch (error) {
    throw new StateDirError(stateDirErrorCategory(error));
  }
  if (stats.isSymbolicLink()) throw new StateDirError('symlink');
  if (!stats.isDirectory()) throw new StateDirError('wrong-type');
  try {
    deps.chmod(config.stateDir, 0o700);
  } catch (error) {
    throw new StateDirError(stateDirErrorCategory(error));
  }
  let post;
  try {
    post = deps.lstat(config.stateDir);
  } catch (error) {
    throw new StateDirError(stateDirErrorCategory(error));
  }
  if (!post.isDirectory() || post.isSymbolicLink()) throw new StateDirError('unexpected');
}

function stateDirErrorCategory(error) {
  const code = error?.code;
  if (code === 'EACCES' || code === 'EPERM') return 'permission';
  if (code === 'EIO') return 'io';
  return 'unexpected';
}

export function writeState(config, state, deps) {
  deps.mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  deps.chmod(config.stateDir, 0o700);
  const payload = `${JSON.stringify(state, null, 2)}\n`;
  const statePath = `${config.stateDir}/state.json`;
  const tmpPath = `${config.stateDir}/state.json.tmp-${process.pid}`;
  deps.writeFile(tmpPath, payload, { mode: 0o600 });
  deps.rename(tmpPath, statePath);
  deps.chmod(statePath, 0o600);
}

// ---------------------------------------------------------------------------
// Lock
// ---------------------------------------------------------------------------

function lockPayload(ownerToken, now) {
  return `${JSON.stringify({ version: LOCK_VERSION, pid: process.pid, createdAt: now, ownerToken })}\n`;
}

// Strict parse of a lock file. Returns the parsed lock object or null when the
// file is absent; throws LockError('malformed'|'unreadable') otherwise.
function readLockFile(config, deps, fileName) {
  let raw;
  try {
    raw = deps.readFile(`${config.stateDir}/${fileName}`, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new LockError('unreadable');
  }
  let lock;
  try {
    lock = JSON.parse(raw);
  } catch {
    throw new LockError('malformed');
  }
  if (
    lock === null || typeof lock !== 'object'
    || lock.version !== LOCK_VERSION
    || typeof lock.pid !== 'number' || !Number.isSafeInteger(lock.pid) || lock.pid <= 0
    || typeof lock.createdAt !== 'number' || !Number.isFinite(lock.createdAt) || lock.createdAt <= 0
    || lock.createdAt > deps.now() + LOCK_CLOCK_SKEW_MS
    || typeof lock.ownerToken !== 'string' || !LOCK_TOKEN_RE.test(lock.ownerToken)
  ) {
    throw new LockError('malformed');
  }
  return lock;
}

// Atomically claims `lock.reclaim` to serialize stale-lock reclamation. A
// guard held by a live owner reports busy; an unknown liveness fails closed;
// a dead owner is NEVER auto-deleted — the stale guard is preserved for
// manual operator recovery (structured `reclaim-guard-stale`, exit 1).
function acquireReclaimGuard(config, deps) {
  const guardPath = `${config.stateDir}/${RECLAIM_GUARD_FILE}`;
  const ownerToken = deps.randomToken();
  const attempt = () => {
    try {
      deps.writeFile(guardPath, lockPayload(ownerToken, deps.now()), { flag: 'wx', mode: 0o600 });
      return { ok: true, ownerToken };
    } catch (error) {
      if (error?.code === 'EEXIST') return null;
      throw new LockError('unexpected');
    }
  };
  const first = attempt();
  if (first) return first;
  const existing = readLockFile(config, deps, RECLAIM_GUARD_FILE);
  const liveness = deps.probeProcess(existing.pid);
  if (liveness === 'alive') return { ok: false };
  if (liveness === 'unknown') throw new LockError('unknown');
  throw new LockError('stale');
}

export function acquireLock(config, deps) {
  deps.mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const lockPath = `${config.stateDir}/lock.lock`;
  const ownerToken = deps.randomToken();
  const attempt = () => {
    try {
      deps.writeFile(lockPath, lockPayload(ownerToken, deps.now()), { flag: 'wx', mode: 0o600 });
      return { ok: true, staleReclaimed: false, ownerToken };
    } catch (error) {
      if (error?.code === 'EEXIST') return null;
      throw new LockError('unexpected');
    }
  };
  const first = attempt();
  if (first) return first;

  const existing = readLockFile(config, deps, 'lock.lock');
  if (existing === null) {
    const second = attempt();
    if (second) return second;
    return { ok: false, staleReclaimed: false };
  }
  const liveness = deps.probeProcess(existing.pid);
  if (liveness === 'alive') return { ok: false, staleReclaimed: false };
  if (liveness === 'unknown') throw new LockError('unknown');

  const guard = acquireReclaimGuard(config, deps);
  if (!guard.ok) return { ok: false, staleReclaimed: false };

  let reclaimed = false;
  try {
    const revalidated = readLockFile(config, deps, 'lock.lock');
    if (revalidated !== null) {
      const liveness2 = deps.probeProcess(revalidated.pid);
      if (liveness2 === 'alive') return { ok: false, staleReclaimed: false };
      if (liveness2 === 'unknown') throw new LockError('unknown');
      try {
        deps.unlink(lockPath);
        reclaimed = true;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw new LockError('unexpected');
      }
    }
    const next = attempt();
    if (next) return { ok: true, staleReclaimed: reclaimed, ownerToken };
    return { ok: false, staleReclaimed: reclaimed };
  } finally {
    releaseLock(config, deps, { ownerToken: guard.ownerToken }, RECLAIM_GUARD_FILE);
  }
}

// Owner-safe release: only the lock whose ownerToken matches the current run
// is removed. A foreign, malformed or missing lock is never deleted. An
// lstat identity post-check between the read and the unlink shrinks the
// read-to-unlink replacement window: if the inode changed, the lock was
// replaced and is left untouched.
export function releaseLock(config, deps, ownership, fileName = 'lock.lock') {
  const lockPath = `${config.stateDir}/${fileName}`;
  let before;
  try {
    before = deps.lstat(lockPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return { released: false, reason: 'missing' };
    return { released: false, reason: 'unreadable' };
  }
  let existing;
  try {
    existing = readLockFile(config, deps, fileName);
  } catch {
    return { released: false, reason: 'malformed' };
  }
  if (existing === null) return { released: false, reason: 'missing' };
  if (existing.ownerToken !== ownership.ownerToken) return { released: false, reason: 'owner-mismatch' };
  let after;
  try {
    after = deps.lstat(lockPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return { released: false, reason: 'missing' };
    return { released: false, reason: 'unexpected' };
  }
  if (after.ino !== before.ino || after.dev !== before.dev) return { released: false, reason: 'replaced' };
  try {
    deps.unlink(lockPath);
    return { released: true, reason: 'ok' };
  } catch (error) {
    if (error?.code === 'ENOENT') return { released: false, reason: 'missing' };
    return { released: false, reason: 'unexpected' };
  }
}

// ---------------------------------------------------------------------------
// Webhook delivery
// ---------------------------------------------------------------------------

export function buildPayload({ config, event, check, severity, summary, details, now }) {
  return {
    schemaVersion: SCHEMA_VERSION,
    application: APPLICATION_LABEL,
    instance: config.instanceLabel,
    environment: config.environment,
    event,
    check,
    severity,
    summary,
    observedAt: new Date(now).toISOString(),
    details,
  };
}

export async function deliverWebhook(config, payload, deps) {
  try {
    const response = await deps.fetch(config.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'manual',
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    if (response.status < 200 || response.status >= 300) {
      return { ok: false, status: response.status, errorCategory: `http-${response.status}` };
    }
    await response.arrayBuffer();
    return { ok: true, status: response.status, errorCategory: null };
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      return { ok: false, status: null, errorCategory: 'timeout' };
    }
    return { ok: false, status: null, errorCategory: 'connection' };
  }
}

// ---------------------------------------------------------------------------
// Check transitions
// ---------------------------------------------------------------------------

export function severityForCheck(check, event) {
  if (check === 'disk' && event !== 'recovery') return 'warning';
  return 'critical';
}

export function transitionCheck({ check, ok, previous, config, now, details }) {
  const failures = ok ? 0 : (previous.consecutiveFailures ?? 0) + 1;
  const wasActive = previous.alertActive && previous.lastDeliveredAt !== null;

  if (ok) {
    if (!wasActive) {
      const observedNext = {
        consecutiveFailures: 0,
        alertActive: false,
        lastAlertAt: null,
        lastReminderAt: null,
        lastRecoveryAt: previous.lastRecoveryAt,
        lastDeliveredAt: null,
      };
      return { event: null, observedNext, deliveredNext: observedNext };
    }
    // Recovery: the alarm stays open until the recovery webhook is delivered.
    const observedNext = {
      consecutiveFailures: 0,
      alertActive: true,
      lastAlertAt: previous.lastAlertAt,
      lastReminderAt: previous.lastReminderAt,
      lastRecoveryAt: previous.lastRecoveryAt,
      lastDeliveredAt: previous.lastDeliveredAt,
    };
    const deliveredNext = {
      consecutiveFailures: 0,
      alertActive: false,
      lastAlertAt: null,
      lastReminderAt: null,
      lastRecoveryAt: now,
      lastDeliveredAt: null,
    };
    return {
      event: {
        event: 'recovery',
        check,
        severity: severityForCheck(check, 'recovery'),
        summary: `${checkLabel(check)} recovered`,
        details,
      },
      observedNext,
      deliveredNext,
    };
  }

  const observedNext = {
    consecutiveFailures: failures,
    alertActive: previous.alertActive,
    lastAlertAt: previous.lastAlertAt,
    lastReminderAt: previous.lastReminderAt,
    lastRecoveryAt: previous.lastRecoveryAt,
    lastDeliveredAt: previous.lastDeliveredAt,
  };

  if (!previous.alertActive) {
    if (failures >= config.failureThreshold) {
      return {
        event: {
          event: 'alert',
          check,
          severity: severityForCheck(check, 'alert'),
          summary: `${checkLabel(check)} failing after ${failures} consecutive failures`,
          details,
        },
        observedNext,
        deliveredNext: {
          ...observedNext,
          alertActive: true,
          lastAlertAt: now,
          lastDeliveredAt: now,
        },
      };
    }
    return { event: null, observedNext, deliveredNext: observedNext };
  }

  const cooldownPassed = previous.lastDeliveredAt !== null
    && now - previous.lastDeliveredAt >= config.cooldownMs;
  if (cooldownPassed) {
    return {
      event: {
        event: 'reminder',
        check,
        severity: severityForCheck(check, 'reminder'),
        summary: `${checkLabel(check)} still failing`,
        details,
      },
      observedNext,
      deliveredNext: {
        ...observedNext,
        lastReminderAt: now,
        lastDeliveredAt: now,
      },
    };
  }
  return { event: null, observedNext, deliveredNext: observedNext };
}

function checkLabel(check) {
  return { health: 'Application health', backup: 'Backup freshness', disk: 'Disk space' }[check] ?? check;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export async function runMonitor(config, deps) {
  const now = deps.now();
  const deliveredEvents = [];

  const { state: loadedState, monitorEvent, requiresInitialPersist } = await loadState(config, deps);

  const persist = (state) => {
    try {
      writeState(config, state, deps);
      return true;
    } catch {
      return false;
    }
  };

  // A newly detected corrupt incident must be persisted before any probe or
  // webhook work; a failed initial persist fails closed with no external IO.
  if (requiresInitialPersist) {
    if (!persist(loadedState)) {
      return { state: loadedState, events: deliveredEvents, outcomes: null, exitCode: 1, stateWriteFailed: true };
    }
  }

  const health = await probeHealth(config, deps);
  const outcomes = {
    health,
    backup: config.backupSource === 'verified-runs'
      ? evaluateVerifiedBackup(config, health, deps)
      : await evaluateBackup(config, deps),
    disk: probeDisk(config, deps),
  };

  // Phase 1 — compute every transition in deterministic order (health,
  // backup, disk) and apply the observed state, so counters advance for all
  // checks even when a later delivery fails. Delivery-applied state
  // (alertActive/timestamps) is never applied before its webhook succeeds.
  let currentState = loadedState;
  const transitions = {};
  for (const name of CHECK_NAMES) {
    const outcome = outcomes[name];
    const transition = transitionCheck({
      check: name,
      ok: outcome.ok,
      previous: currentState.checks[name],
      config,
      now,
      details: detailsForCheck(name, outcome, currentState.checks[name], config),
    });
    currentState = { version: STATE_VERSION, monitor: currentState.monitor, checks: { ...currentState.checks, [name]: transition.observedNext } };
    transitions[name] = transition;
  }

  // Phase 2 — pending monitor incident first (retry until delivered), then
  // check events in deterministic order. Each successful delivery applies
  // its delivered state and is persisted before the next event is attempted.
  if (monitorEvent) {
    const delivery = await deliverWebhook(config, buildPayload({ config, ...monitorEvent, now }), deps);
    if (!delivery.ok) {
      if (!persist(currentState)) return { state: currentState, events: deliveredEvents, outcomes, exitCode: 1, stateWriteFailed: true, deliveryFailure: { event: monitorEvent, delivery } };
      return { state: currentState, events: deliveredEvents, outcomes, exitCode: 3, deliveryFailure: { event: monitorEvent, delivery } };
    }
    deliveredEvents.push(monitorEvent);
    currentState = { ...currentState, monitor: { pendingIncident: null } };
    if (!persist(currentState)) return { state: currentState, events: deliveredEvents, outcomes, exitCode: 1, stateWriteFailed: true };
  }

  for (const name of CHECK_NAMES) {
    const transition = transitions[name];
    if (!transition.event) continue;
    const event = transition.event;
    const delivery = await deliverWebhook(config, buildPayload({ config, ...event, now }), deps);
    if (!delivery.ok) {
      if (!persist(currentState)) return { state: currentState, events: deliveredEvents, outcomes, exitCode: 1, stateWriteFailed: true, deliveryFailure: { event, delivery } };
      return { state: currentState, events: deliveredEvents, outcomes, exitCode: 3, deliveryFailure: { event, delivery } };
    }
    deliveredEvents.push(event);
    currentState = { version: STATE_VERSION, monitor: currentState.monitor, checks: { ...currentState.checks, [name]: transition.deliveredNext } };
    if (!persist(currentState)) return { state: currentState, events: deliveredEvents, outcomes, exitCode: 1, stateWriteFailed: true };
  }

  if (!persist(currentState)) return { state: currentState, events: deliveredEvents, outcomes, exitCode: 1, stateWriteFailed: true };
  return { state: currentState, events: deliveredEvents, outcomes, exitCode: 0, deliveryFailure: null };
}

function detailsForCheck(name, outcome, previous, config) {
  if (name === 'health') {
    return outcome.ok ? {} : {
      consecutiveFailures: previous.consecutiveFailures + 1,
      timeout: outcome.timeout,
      httpStatus: outcome.httpStatus,
      latencyMs: outcome.latencyMs,
    };
  }
  if (name === 'backup') {
    return outcome.ok ? { ageHours: round2(outcome.ageHours), basename: outcome.basename, checksumValid: true } : {
      consecutiveFailures: previous.consecutiveFailures + 1,
      errorCategory: outcome.errorCategory,
      latestProblem: outcome.latestProblem,
      ageHours: outcome.ageHours === null ? null : round2(outcome.ageHours),
      basename: outcome.basename,
      checksumValid: outcome.checksumValid,
      latestBackupTimestamp: outcome.latestBackupTimestamp,
      workerHeartbeatAt: outcome.workerHeartbeatAt ?? null,
      schedulerLastTickAt: outcome.schedulerLastTickAt ?? null,
    };
  }
  if (name === 'disk') {
    const base = {
      target: config.diskLabel,
      freePercent: outcome.freePercent === null ? null : round2(outcome.freePercent),
      freeBytes: outcome.freeBytes,
      totalBytes: outcome.totalBytes,
    };
    if (outcome.ok) return base;
    return {
      ...base,
      errorCategory: outcome.errorCategory,
      consecutiveFailures: previous.consecutiveFailures + 1,
    };
  }
  return {};
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

export async function main({ env = process.env, deps = createDefaultDeps(), log = (entry) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...entry })) } = {}) {
  let config;
  try {
    config = loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) {
      log({ level: 'error', run: 'config', error: 'configuration-error' });
      return 1;
    }
    throw error;
  }

  if (!config.enabled) {
    log({ level: 'info', run: 'disabled', enabled: false });
    return 0;
  }

  let ownership = null;
  let exitCode = 0;
  try {
    ensurePrivateStateDirectory(config, deps);
    const lock = acquireLock(config, deps);
    if (!lock.ok) {
      log({ level: 'warn', run: 'lock-busy', staleReclaimed: lock.staleReclaimed });
      return 2;
    }
    ownership = { ownerToken: lock.ownerToken };

    const result = await runMonitor(config, deps);
    if (result.stateWriteFailed) {
      log({ level: 'error', run: 'state-write-failed' });
      exitCode = 1;
    } else if (result.exitCode !== 0) {
      const { event, delivery } = result.deliveryFailure;
      log({
        level: 'error',
        run: 'delivery-failed',
        event: event.event,
        check: event.check,
        status: delivery.status,
        errorCategory: delivery.errorCategory,
      });
      exitCode = result.exitCode;
    } else {
      log({
        level: 'info',
        run: 'completed',
        events: result.events.map((event) => ({ event: event.event, check: event.check })),
        health: result.outcomes.health.ok,
        backup: result.outcomes.backup.ok,
        disk: result.outcomes.disk.ok,
      });
    }
  } catch (error) {
    if (error instanceof LockError) {
      const run = error.category === 'malformed' ? 'lock-invalid' : error.category === 'stale' ? 'reclaim-guard-stale' : 'lock-error';
      log({ level: 'error', run, errorCategory: error.category });
      exitCode = 1;
    } else if (error instanceof StateDirError) {
      log({ level: 'error', run: 'state-dir-failed', errorCategory: error.category });
      exitCode = 1;
    } else if (error instanceof StateQuarantineError) {
      log({ level: 'error', run: 'state-quarantine-failed', errorCategory: error.category });
      exitCode = 1;
    } else if (error instanceof StateReadError) {
      log({ level: 'error', run: 'state-read-failed', errorCategory: error.category });
      exitCode = 1;
    } else if (error instanceof StateVersionError) {
      log({ level: 'error', run: 'state-version', error: 'unsupported-state-version' });
      exitCode = 1;
    } else {
      log({ level: 'error', run: 'monitor-error', error: 'unexpected' });
      exitCode = 1;
    }
  } finally {
    if (ownership) {
      const release = releaseLock(config, deps, ownership);
      if (release.reason === 'owner-mismatch') log({ level: 'warn', run: 'release-owner-mismatch' });
      else if (release.reason === 'unexpected') log({ level: 'warn', run: 'release-failed' });
    }
  }
  return exitCode;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const exitCode = await main();
  process.exitCode = exitCode;
}
