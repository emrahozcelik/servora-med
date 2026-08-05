// Servora-Med operator alerting monitor — one-shot, importable ESM.
//
// Runs once per invocation: probes application health, backup freshness and
// disk free space, deduplicates alerts through a versioned state file and
// delivers vendor-neutral JSON webhook events. Importing this module performs
// no work; only `main()` executes the monitor.
//
// Defaults are disabled: with SERVORA_ALERTING_ENABLED=false the process
// exits 0 without any network access or state mutation.

import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
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

export const CHECK_NAMES = ['health', 'backup', 'disk'];

const SAFE_LABEL_RE = /^[A-Za-z0-9._-]{1,64}$/;
const BACKUP_RE = /^servora-med-(\d{8}T\d{6}Z)\.dump$/;
const SIDECAR_RE = /^([0-9a-f]{64})  (servora-med-\d{8}T\d{6}Z\.dump)$/;

export function createDefaultDeps() {
  return {
    statfs: statfsSync,
    readdir: readdirSync,
    lstat: lstatSync,
    readFile: readFileSync,
    writeFile: writeFileSync,
    rename: renameSync,
    unlink: unlinkSync,
    mkdir: mkdirSync,
    chmod: chmodSync,
    exists: existsSync,
    fetch: globalThis.fetch,
    hashFile: (filePath) => createHash('sha256').update(readFileSync(filePath)).digest('hex'),
    isProcessAlive(pid) {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
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
  const result = { ok: false, httpStatus: null, timeout: false, errorCategory: null, latencyMs: null };
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
  return { version: STATE_VERSION, checks };
}

export async function loadState(config, deps) {
  const statePath = `${config.stateDir}/state.json`;
  let raw;
  try {
    raw = deps.readFile(statePath, 'utf8');
  } catch {
    return { state: createDefaultState(), monitorEvent: null };
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
  if (sanitized) return { state: sanitized, monitorEvent: null };

  const quarantineName = `state.json.corrupt-${new Date(deps.now()).toISOString().replace(/[:.]/g, '-')}`;
  try {
    deps.rename(statePath, `${config.stateDir}/${quarantineName}`);
  } catch {
    // Quarantine failure must not expose the corrupt content; fall through.
  }
  return {
    state: createDefaultState(),
    monitorEvent: {
      event: 'monitor',
      check: 'monitor',
      severity: 'critical',
      summary: 'Alerting state was corrupt and has been reset',
      details: {},
    },
  };
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

export function acquireLock(config, deps) {
  deps.mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const lockPath = `${config.stateDir}/lock.lock`;
  const attempt = () => {
    try {
      deps.writeFile(lockPath, `${JSON.stringify({ pid: process.pid, createdAt: deps.now() })}\n`, { flag: 'wx', mode: 0o600 });
      return { ok: true, staleReclaimed: false };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      return { ok: false, staleReclaimed: false };
    }
  };
  const first = attempt();
  if (first.ok) return first;
  let raw;
  try {
    raw = deps.readFile(lockPath, 'utf8');
  } catch {
    return attempt();
  }
  let lock;
  try {
    lock = JSON.parse(raw);
  } catch {
    throw new ConfigError('lock file is malformed');
  }
  if (typeof lock.pid !== 'number' || !Number.isInteger(lock.pid)) {
    throw new ConfigError('lock file has no valid pid');
  }
  if (deps.isProcessAlive(lock.pid)) {
    return { ok: false, staleReclaimed: false };
  }
  try {
    deps.unlink(lockPath);
  } catch {
    // Another process may have reclaimed it; retry below.
  }
  const second = attempt();
  if (!second.ok) return { ok: false, staleReclaimed: true };
  return { ok: true, staleReclaimed: true };
}

export function releaseLock(config, deps) {
  try {
    deps.unlink(`${config.stateDir}/lock.lock`);
  } catch {
    // Lock already gone or never acquired — safe to ignore.
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
    const event = wasActive
      ? {
          event: 'recovery',
          check,
          severity: severityForCheck(check, 'recovery'),
          summary: `${checkLabel(check)} recovered`,
          details,
        }
      : null;
    return {
      event,
      next: {
        consecutiveFailures: 0,
        alertActive: false,
        lastAlertAt: null,
        lastReminderAt: null,
        lastRecoveryAt: wasActive ? now : previous.lastRecoveryAt,
        lastDeliveredAt: null,
      },
    };
  }

  const base = {
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
        next: base,
      };
    }
    return { event: null, next: base };
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
      next: base,
    };
  }
  return { event: null, next: base };
}

function checkLabel(check) {
  return { health: 'Application health', backup: 'Backup freshness', disk: 'Disk space' }[check] ?? check;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export async function runMonitor(config, deps) {
  const now = deps.now();
  const events = [];
  const deliveredEvents = [];

  const { state: loadedState, monitorEvent } = await loadState(config, deps);
  if (monitorEvent) events.push(monitorEvent);

  const outcomes = {
    health: await probeHealth(config, deps),
    backup: await evaluateBackup(config, deps),
    disk: probeDisk(config, deps),
  };

  // Phase 1 — compute every transition in deterministic order (health,
  // backup, disk) so no-event counters advance for all checks even when a
  // later delivery fails.
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
    currentState = { version: STATE_VERSION, checks: { ...currentState.checks, [name]: transition.next } };
    transitions[name] = transition;
  }

  // Phase 2 — deliver monitor event first, then transition events in the
  // same deterministic order. Each successful delivery is applied to the
  // in-memory state and persisted immediately, so a later delivery failure
  // can never lose an earlier successful delivery.
  const persist = (state) => {
    try {
      writeState(config, state, deps);
    } catch {
      return false;
    }
    return true;
  };

  for (const event of events) {
    const delivery = await deliverWebhook(config, buildPayload({ config, ...event, now }), deps);
    if (!delivery.ok) {
      if (!persist(currentState)) return { state: currentState, events: deliveredEvents, outcomes, exitCode: 1, stateWriteFailed: true, deliveryFailure: { event, delivery } };
      return { state: currentState, events: deliveredEvents, outcomes, exitCode: 3, deliveryFailure: { event, delivery } };
    }
    deliveredEvents.push(event);
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
    const applied = { ...currentState.checks[name] };
    if (event.event === 'alert') {
      applied.alertActive = true;
      applied.lastAlertAt = now;
      applied.lastDeliveredAt = now;
    } else if (event.event === 'reminder') {
      applied.lastReminderAt = now;
      applied.lastDeliveredAt = now;
    } else if (event.event === 'recovery') {
      applied.lastRecoveryAt = now;
    }
    currentState = { version: STATE_VERSION, checks: { ...currentState.checks, [name]: applied } };
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
    };
  }
  return {
    target: config.diskLabel,
    freePercent: outcome.freePercent === null ? null : round2(outcome.freePercent),
    freeBytes: outcome.freeBytes,
    totalBytes: outcome.totalBytes,
    consecutiveFailures: previous.consecutiveFailures + 1,
  };
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

  const lock = acquireLock(config, deps);
  if (!lock.ok) {
    log({ level: 'warn', run: 'lock-busy', staleReclaimed: lock.staleReclaimed });
    return 2;
  }

  let exitCode = 0;
  try {
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
    if (error instanceof StateVersionError) {
      log({ level: 'error', run: 'state-version', error: error.message });
      exitCode = 1;
    } else {
      log({ level: 'error', run: 'monitor-error', error: 'unexpected' });
      exitCode = 1;
    }
  } finally {
    releaseLock(config, deps);
  }
  return exitCode;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const exitCode = await main();
  process.exitCode = exitCode;
}
