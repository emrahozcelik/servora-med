// Servora-Med operator alerting monitor tests — node:test, no external deps.
// Run: node --test ops/scripts/tests/operator-alerting.test.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync as realChmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync as realReaddirSync,
  rmSync,
  statSync,
} from 'node:fs';

function requireNodeFsExtra() {
  return { chmodSync: realChmodSync };
}
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  ConfigError,
  LockError,
  StateDirError,
  StateQuarantineError,
  StateReadError,
  StateVersionError,
  classifyKillError,
  probeProcess,
  acquireLock,
  buildPayload,
  createDefaultDeps,
  createDefaultState,
  deliverWebhook,
  evaluateBackup,
  evaluateVerifiedBackup,
  loadConfig,
  loadState,
  main,
  parseBackupTimestamp,
  parseSidecar,
  parseWebhookUrl,
  probeDisk,
  probeHealth,
  redactWebhookUrl,
  releaseLock,
  runMonitor,
  sanitizeState,
  transitionCheck,
  writeState,
} from '../operator-alerting.mjs';

// ---------------------------------------------------------------------------
// In-memory test doubles
// ---------------------------------------------------------------------------

class FakeFs {
  constructor() {
    this.entries = new Map();
    this.inoCounter = 1;
  }

  makeEntry(kind, content, mode) {
    return { kind, content, mode, ino: this.inoCounter++, dev: 1 };
  }

  file(path, content = '') {
    this.entries.set(path, this.makeEntry('file', Buffer.isBuffer(content) ? content : Buffer.from(content), 0o600));
  }

  dir(path) {
    this.entries.set(path, this.makeEntry('dir', null, 0o700));
  }

  symlink(path) {
    this.entries.set(path, this.makeEntry('symlink', Buffer.from('target'), 0o600));
  }

  linkSync = (from, to) => {
    const entry = this.stat(from);
    if (this.entries.has(to)) throw Object.assign(new Error(`EEXIST ${to}`), { code: 'EEXIST' });
    this.entries.set(to, { ...entry, ino: entry.ino });
  };

  stat(path) {
    const entry = this.entries.get(path);
    if (!entry) throw Object.assign(new Error(`ENOENT ${path}`), { code: 'ENOENT' });
    return entry;
  }

  readdirSync = (path) => {
    const entry = this.entries.get(path);
    if (!entry) throw Object.assign(new Error(`ENOENT ${path}`), { code: 'ENOENT' });
    if (entry.kind !== 'dir') throw Object.assign(new Error(`ENOTDIR ${path}`), { code: 'ENOTDIR' });
    const prefix = path.endsWith('/') ? path : `${path}/`;
    return Array.from(this.entries.keys())
      .filter((key) => key.startsWith(prefix) && !key.slice(prefix.length).includes('/'))
      .map((key) => key.slice(prefix.length));
  };

  lstatSync = (path) => {
    const entry = this.stat(path);
    return {
      isFile: () => entry.kind === 'file',
      isDirectory: () => entry.kind === 'dir',
      isSymbolicLink: () => entry.kind === 'symlink',
      ino: entry.ino,
      dev: entry.dev,
    };
  };

  readFileSync = (path, encoding) => {
    const entry = this.stat(path);
    if (entry.kind !== 'file') throw Object.assign(new Error(`EISDIR ${path}`), { code: 'EISDIR' });
    return encoding === 'utf8' ? entry.content.toString('utf8') : entry.content;
  };

  writeFileSync = (path, content, options = {}) => {
    const existing = this.entries.get(path);
    if (options.flag === 'wx' && existing) throw Object.assign(new Error(`EEXIST ${path}`), { code: 'EEXIST' });
    this.entries.set(path, this.makeEntry('file', Buffer.from(String(content)), typeof options.mode === 'number' ? options.mode : 0o600));
  };

  renameSync = (from, to) => {
    const entry = this.stat(from);
    this.entries.delete(from);
    this.entries.set(to, entry);
  };

  unlinkSync = (path) => {
    this.stat(path);
    this.entries.delete(path);
  };

  mkdirSync = (path, options) => {
    if (this.entries.has(path)) return;
    this.entries.set(path, this.makeEntry('dir', null, options?.mode ?? 0o700));
  };

  chmodSync = (path, mode) => {
    const entry = this.stat(path);
    entry.mode = mode;
  };

  existsSync = (path) => this.entries.has(path);
}

function fakeStatfs(result) {
  return () => {
    if (result instanceof Error) throw result;
    return result;
  };
}

function fakeDeps({ fs = new FakeFs(), health = null, webhook = null, statfsResult = null, nowMs = null } = {}) {
  const deps = createDefaultDeps();
  deps.readdir = fs.readdirSync;
  deps.lstat = fs.lstatSync;
  deps.readFile = fs.readFileSync;
  deps.writeFile = fs.writeFileSync;
  deps.rename = fs.renameSync;
  deps.link = fs.linkSync;
  deps.unlink = fs.unlinkSync;
  deps.mkdir = fs.mkdirSync;
  deps.chmod = fs.chmodSync;
  deps.exists = fs.existsSync;
  deps.hashFile = (filePath) => createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  deps.now = () => nowMs ?? 1_785_974_400_000; // 2026-08-06T00:00:00Z
  deps.probeProcess = () => 'dead';
  deps.randomToken = () => 'f'.repeat(32);
  deps.fetch = async (url, options) => {
    if (url.includes('/api/health')) {
      if (health instanceof Error) throw health;
      return health;
    }
    if (webhook instanceof Error) throw webhook;
    return webhook;
  };
  deps.statfs = fakeStatfs(statfsResult);
  return deps;
}

function webhookResponse(status, { payloads = null } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    url: 'https://hooks.example.com/alert',
    async arrayBuffer() { return Buffer.alloc(0); },
    async text() { return ''; },
  };
}

function healthResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    url: 'http://127.0.0.1:3000/api/health',
    async arrayBuffer() { return Buffer.from(JSON.stringify(body ?? {})); },
    async text() { return JSON.stringify(body ?? {}); },
  };
}

const BASE_ENV = {
  SERVORA_ALERTING_ENABLED: 'true',
  SERVORA_ALERT_WEBHOOK_URL: 'https://hooks.example.com/alert',
  SERVORA_ALERT_HEALTH_URL: 'http://127.0.0.1:3000/api/health',
  SERVORA_ALERT_BACKUP_DIR: '/backups',
  SERVORA_ALERT_BACKUP_MAX_AGE_HOURS: '26',
  SERVORA_ALERT_DISK_PATH: '/',
  SERVORA_ALERT_DISK_MIN_FREE_PERCENT: '15',
  SERVORA_ALERT_FAILURE_THRESHOLD: '3',
  SERVORA_ALERT_COOLDOWN_MINUTES: '60',
  SERVORA_ALERT_TIMEOUT_MS: '5000',
  SERVORA_ALERT_STATE_DIR: '/var/lib/servora-med-alerting',
  SERVORA_ALERT_ENVIRONMENT: 'test',
  SERVORA_ALERT_INSTANCE_LABEL: 'servora-med-test',
};

function backupPair(fs, dir, timestamp, { content = 'dump-data', sidecarContent = null } = {}) {
  const digest = createHash('sha256').update(content).digest('hex');
  fs.file(`${dir}/servora-med-${timestamp}.dump`, content);
  fs.file(`${dir}/servora-med-${timestamp}.dump.sha256`, sidecarContent ?? `${digest}  servora-med-${timestamp}.dump\n`);
  return digest;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

describe('configuration', () => {
  it('is disabled by default and requires nothing else', () => {
    const config = loadConfig({});
    assert.equal(config.enabled, false);
  });

  it('disabled main exits 0 without network or state mutation', async () => {
    let fetches = 0;
    const fs = new FakeFs();
    const deps = fakeDeps({ fs });
    deps.fetch = async () => { fetches += 1; throw new Error('must not fetch'); };
    const exit = await main({ env: { SERVORA_ALERTING_ENABLED: 'false' }, deps, log: () => {} });
    assert.equal(exit, 0);
    assert.equal(fetches, 0);
    assert.equal(fs.entries.size, 0);
  });

  it('rejects non-strict booleans', () => {
    for (const value of ['1', '0', 'yes', 'TRUE', '', 'enabled']) {
      assert.throws(() => loadConfig({ SERVORA_ALERTING_ENABLED: value }), ConfigError, value);
    }
  });

  it('requires webhook url, backup dir and state dir when enabled', () => {
    assert.throws(() => loadConfig({ ...BASE_ENV, SERVORA_ALERT_WEBHOOK_URL: '' }), ConfigError);
    assert.throws(() => loadConfig({ ...BASE_ENV, SERVORA_ALERT_BACKUP_DIR: '' }), ConfigError);
    assert.throws(() => loadConfig({ ...BASE_ENV, SERVORA_ALERT_STATE_DIR: '' }), ConfigError);
    assert.throws(() => loadConfig({ ...BASE_ENV, SERVORA_ALERT_BACKUP_DIR: 'relative' }), ConfigError);
  });

  it('rejects invalid number ranges', () => {
    assert.throws(() => loadConfig({ ...BASE_ENV, SERVORA_ALERT_BACKUP_MAX_AGE_HOURS: '-1' }), ConfigError);
    assert.throws(() => loadConfig({ ...BASE_ENV, SERVORA_ALERT_BACKUP_MAX_AGE_HOURS: 'abc' }), ConfigError);
    assert.throws(() => loadConfig({ ...BASE_ENV, SERVORA_ALERT_DISK_MIN_FREE_PERCENT: '101' }), ConfigError);
    assert.throws(() => loadConfig({ ...BASE_ENV, SERVORA_ALERT_DISK_MIN_FREE_PERCENT: '-5' }), ConfigError);
    assert.throws(() => loadConfig({ ...BASE_ENV, SERVORA_ALERT_FAILURE_THRESHOLD: '0' }), ConfigError);
    assert.throws(() => loadConfig({ ...BASE_ENV, SERVORA_ALERT_FAILURE_THRESHOLD: '2.5' }), ConfigError);
    assert.throws(() => loadConfig({ ...BASE_ENV, SERVORA_ALERT_COOLDOWN_MINUTES: '-1' }), ConfigError);
    assert.throws(() => loadConfig({ ...BASE_ENV, SERVORA_ALERT_TIMEOUT_MS: '0' }), ConfigError);
    assert.throws(() => loadConfig({ ...BASE_ENV, SERVORA_ALERT_TIMEOUT_MS: 'Infinity' }), ConfigError);
  });

  it('rejects unsafe labels', () => {
    assert.throws(() => loadConfig({ ...BASE_ENV, SERVORA_ALERT_INSTANCE_LABEL: 'bad label!' }), ConfigError);
    assert.throws(() => loadConfig({ ...BASE_ENV, SERVORA_ALERT_ENVIRONMENT: 'prod;rm' }), ConfigError);
  });

  it('requires https for non-loopback webhooks', () => {
    assert.throws(() => loadConfig({ ...BASE_ENV, SERVORA_ALERT_WEBHOOK_URL: 'http://hooks.example.com/alert' }), ConfigError);
    assert.throws(() => loadConfig({ ...BASE_ENV, SERVORA_ALERT_WEBHOOK_URL: 'http://example.com/alert' }), ConfigError);
    assert.throws(() => loadConfig({ ...BASE_ENV, SERVORA_ALERT_WEBHOOK_URL: 'ftp://example.com/alert' }), ConfigError);
    assert.throws(() => loadConfig({ ...BASE_ENV, SERVORA_ALERT_WEBHOOK_URL: 'https://' }), ConfigError);
    assert.throws(() => loadConfig({ ...BASE_ENV, SERVORA_ALERT_WEBHOOK_URL: 'not a url' }), ConfigError);
  });

  it('allows plain http only for loopback webhooks', () => {
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
      const config = loadConfig({ ...BASE_ENV, SERVORA_ALERT_WEBHOOK_URL: `http://${host}:9000/hook` });
      assert.ok(config.enabled);
    }
  });

  it('rejects credential-bearing webhook urls', () => {
    assert.throws(() => loadConfig({ ...BASE_ENV, SERVORA_ALERT_WEBHOOK_URL: 'https://user:pass@hooks.example.com/alert' }), ConfigError);
    assert.throws(() => loadConfig({ ...BASE_ENV, SERVORA_ALERT_WEBHOOK_URL: 'https://token@hooks.example.com/alert' }), ConfigError);
  });

  it('redacts webhook urls to scheme+host only', () => {
    const url = parseWebhookUrl('https://hooks.example.com/alert?token=secret');
    assert.equal(redactWebhookUrl(url), 'https://hooks.example.com');
  });
});

// ---------------------------------------------------------------------------
// Health probe
// ---------------------------------------------------------------------------

describe('health probe', () => {
  const config = loadConfig(BASE_ENV);

  it('accepts 200 with the current contract body', async () => {
    const deps = fakeDeps({ health: healthResponse(200, { status: 'ok' }) });
    const result = await probeHealth(config, deps);
    assert.equal(result.ok, true);
    assert.equal(result.errorCategory, null);
    assert.equal(typeof result.latencyMs, 'number');
  });

  it('treats timeout as failure', async () => {
    const timeoutError = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    const deps = fakeDeps({ health: timeoutError });
    const result = await probeHealth(config, deps);
    assert.equal(result.ok, false);
    assert.equal(result.errorCategory, 'timeout');
    assert.equal(result.timeout, true);
  });

  it('treats connection failure as failure', async () => {
    const deps = fakeDeps({ health: new TypeError('fetch failed') });
    const result = await probeHealth(config, deps);
    assert.equal(result.ok, false);
    assert.equal(result.errorCategory, 'connection');
  });

  it('treats redirects as failure', async () => {
    const deps = fakeDeps({ health: healthResponse(302, {}) });
    const result = await probeHealth(config, deps);
    assert.equal(result.ok, false);
    assert.equal(result.errorCategory, 'redirect');
  });

  it('treats non-200 as failure', async () => {
    const deps = fakeDeps({ health: healthResponse(503, { status: 'unavailable' }) });
    const result = await probeHealth(config, deps);
    assert.equal(result.ok, false);
    assert.equal(result.errorCategory, 'http-503');
  });

  it('treats malformed body as failure', async () => {
    const bad = { status: 200, ok: true, url: 'http://127.0.0.1:3000/api/health', async text() { return 'not-json'; }, async arrayBuffer() { return Buffer.alloc(0); } };
    const deps = fakeDeps({ health: bad });
    const result = await probeHealth(config, deps);
    assert.equal(result.ok, false);
    assert.equal(result.errorCategory, 'invalid-body');
  });

  it('treats valid json without ok status as failure', async () => {
    const deps = fakeDeps({ health: healthResponse(200, { status: 'unavailable' }) });
    const result = await probeHealth(config, deps);
    assert.equal(result.ok, false);
    assert.equal(result.errorCategory, 'invalid-body');
  });
});

describe('verified-runs backup source', () => {
  it('keeps legacy backup freshness authoritative until V1 is explicitly selected', () => {
    assert.equal(loadConfig(BASE_ENV).backupSource, 'legacy');
  });

  it('uses safe health evidence and the existing freshness threshold', () => {
    const config = loadConfig({
      ...BASE_ENV,
      SERVORA_ALERT_BACKUP_SOURCE: 'verified-runs',
    });
    assert.equal(config.backupSource, 'verified-runs');
    const result = evaluateVerifiedBackup(config, {
      ok: true,
      backup: {
        status: 'ok',
        latestVerifiedAt: '2026-08-23T00:00:00.000Z',
        latestScheduledVerifiedAt: '2026-08-23T00:00:00.000Z',
        latestRunStatus: 'SUCCESS',
        latestScheduledRunStatus: 'SUCCESS',
        workerHeartbeatAt: '2026-08-23T01:00:00.000Z',
        schedulerLastTickAt: '2026-08-23T01:00:00.000Z',
      },
    }, { now: () => new Date('2026-08-23T02:00:00.000Z') });
    assert.equal(result.ok, true);
    assert.equal(result.ageHours, 2);
  });

  it('does not let a manual verified run satisfy scheduled freshness', () => {
    const config = loadConfig({
      ...BASE_ENV,
      SERVORA_ALERT_BACKUP_SOURCE: 'verified-runs',
    });
    const result = evaluateVerifiedBackup(config, {
      ok: true,
      backup: {
        status: 'ok',
        latestVerifiedAt: '2026-08-23T00:00:00.000Z',
        latestScheduledVerifiedAt: null,
        latestRunStatus: 'SUCCESS',
        latestScheduledRunStatus: 'FAILED',
        workerHeartbeatAt: '2026-08-23T01:00:00.000Z',
        schedulerLastTickAt: '2026-08-23T01:00:00.000Z',
      },
    }, { now: () => new Date('2026-08-23T02:00:00.000Z') });
    assert.equal(result.ok, false);
    assert.equal(result.errorCategory, 'scheduled-failure');
    assert.equal(result.latestProblem, 'FAILED');
  });

  it('treats the latest scheduled failure as unhealthy despite an older verified run', () => {
    const config = loadConfig({
      ...BASE_ENV,
      SERVORA_ALERT_BACKUP_SOURCE: 'verified-runs',
    });
    const result = evaluateVerifiedBackup(config, {
      ok: true,
      backup: {
        status: 'ok',
        latestVerifiedAt: '2026-08-23T00:00:00.000Z',
        latestScheduledVerifiedAt: '2026-08-23T00:00:00.000Z',
        latestRunStatus: 'FAILED',
        latestScheduledRunStatus: 'FAILED',
        workerHeartbeatAt: '2026-08-23T01:00:00.000Z',
        schedulerLastTickAt: '2026-08-23T01:00:00.000Z',
      },
    }, { now: () => new Date('2026-08-23T02:00:00.000Z') });
    assert.equal(result.ok, false);
    assert.equal(result.errorCategory, 'scheduled-failure');
  });

  it('does not accept SUCCESS without verified_at and fails on stale worker evidence', () => {
    const config = loadConfig({
      ...BASE_ENV,
      SERVORA_ALERT_BACKUP_SOURCE: 'verified-runs',
    });
    const missingVerification = evaluateVerifiedBackup(config, {
      ok: true,
      backup: {
        status: 'ok',
        latestVerifiedAt: null,
        latestScheduledVerifiedAt: null,
        latestRunStatus: 'SUCCESS',
        latestScheduledRunStatus: 'SUCCESS',
        workerHeartbeatAt: '2026-08-23T01:59:00.000Z',
        schedulerLastTickAt: '2026-08-23T01:59:00.000Z',
      },
    }, { now: () => new Date('2026-08-23T02:00:00.000Z') });
    assert.equal(missingVerification.ok, false);
    assert.equal(missingVerification.errorCategory, 'no-verified-backup');

    const staleWorker = evaluateVerifiedBackup(config, {
      ok: true,
      backup: {
        status: 'unavailable',
        latestVerifiedAt: '2026-08-23T01:00:00.000Z',
        latestScheduledVerifiedAt: '2026-08-23T01:00:00.000Z',
        latestRunStatus: 'SUCCESS',
        latestScheduledRunStatus: 'SUCCESS',
        workerHeartbeatAt: '2026-08-22T23:00:00.000Z',
        schedulerLastTickAt: '2026-08-23T01:59:00.000Z',
      },
    }, { now: () => new Date('2026-08-23T02:00:00.000Z') });
    assert.equal(staleWorker.ok, false);
    assert.equal(staleWorker.errorCategory, 'worker-unavailable');
  });
});

// ---------------------------------------------------------------------------
// Backup freshness
// ---------------------------------------------------------------------------

describe('backup freshness', () => {
  const config = loadConfig(BASE_ENV);

  it('accepts a fresh valid canonical pair', async () => {
    const fs = new FakeFs();
    fs.dir('/backups');
    backupPair(fs, '/backups', '20260805T120000Z');
    const deps = fakeDeps({ fs });
    const result = await evaluateBackup(config, deps);
    assert.equal(result.ok, true);
    assert.equal(result.checksumValid, true);
    assert.equal(result.basename, 'servora-med-20260805T120000Z.dump');
    assert.ok(result.ageHours < 26);
  });

  it('flags stale backups', async () => {
    const fs = new FakeFs();
    fs.dir('/backups');
    backupPair(fs, '/backups', '20260701T000000Z');
    const deps = fakeDeps({ fs });
    const result = await evaluateBackup(config, deps);
    assert.equal(result.ok, false);
    assert.equal(result.errorCategory, 'stale');
  });

  it('flags a missing directory', async () => {
    const deps = fakeDeps({ fs: new FakeFs() });
    const result = await evaluateBackup(config, deps);
    assert.equal(result.ok, false);
    assert.equal(result.errorCategory, 'missing-dir');
  });

  it('flags no backup at all', async () => {
    const fs = new FakeFs();
    fs.dir('/backups');
    const deps = fakeDeps({ fs });
    const result = await evaluateBackup(config, deps);
    assert.equal(result.errorCategory, 'no-backup');
  });

  it('ignores partial files', async () => {
    const fs = new FakeFs();
    fs.dir('/backups');
    fs.file('/backups/servora-med-20260805T120000Z.dump.partial', 'x');
    fs.file('/backups/servora-med-20260805T120000Z.dump.sha256.partial', 'x');
    const deps = fakeDeps({ fs });
    const result = await evaluateBackup(config, deps);
    assert.equal(result.errorCategory, 'no-backup');
  });

  it('flags a missing sidecar', async () => {
    const fs = new FakeFs();
    fs.dir('/backups');
    fs.file('/backups/servora-med-20260805T120000Z.dump', 'dump-data');
    const deps = fakeDeps({ fs });
    const result = await evaluateBackup(config, deps);
    assert.equal(result.errorCategory, 'invalid-backup');
    assert.equal(result.latestProblem, 'missing-sidecar');
  });

  it('flags a malformed sidecar', async () => {
    const fs = new FakeFs();
    fs.dir('/backups');
    fs.file('/backups/servora-med-20260805T120000Z.dump', 'dump-data');
    fs.file('/backups/servora-med-20260805T120000Z.dump.sha256', 'not-a-digest');
    const deps = fakeDeps({ fs });
    const result = await evaluateBackup(config, deps);
    assert.equal(result.latestProblem, 'malformed-sidecar');
  });

  it('rejects sidecars with absolute paths', () => {
    const result = parseSidecar(`${'a'.repeat(64)}  /var/backups/servora-med-20260805T120000Z.dump`);
    assert.equal(result.error, 'malformed-sidecar');
  });

  it('flags a wrong basename in the sidecar', async () => {
    const fs = new FakeFs();
    fs.dir('/backups');
    fs.file('/backups/servora-med-20260805T120000Z.dump', 'dump-data');
    fs.file('/backups/servora-med-20260805T120000Z.dump.sha256', `${'b'.repeat(64)}  servora-med-20260804T120000Z.dump`);
    const deps = fakeDeps({ fs });
    const result = await evaluateBackup(config, deps);
    assert.equal(result.latestProblem, 'bad-basename');
  });

  it('flags checksum mismatches and reports them as the latest problem', async () => {
    const fs = new FakeFs();
    fs.dir('/backups');
    fs.file('/backups/servora-med-20260805T120000Z.dump', 'dump-data');
    fs.file('/backups/servora-med-20260805T120000Z.dump.sha256', `${'c'.repeat(64)}  servora-med-20260805T120000Z.dump\n`);
    const deps = fakeDeps({ fs });
    const result = await evaluateBackup(config, deps);
    assert.equal(result.errorCategory, 'invalid-backup');
    assert.equal(result.latestProblem, 'checksum-mismatch');
    assert.equal(result.checksumValid, false);
  });

  it('fails closed when the latest backup is invalid even if an older backup is valid', async () => {
    const fs = new FakeFs();
    fs.dir('/backups');
    fs.file('/backups/servora-med-20260805T120000Z.dump', 'latest-tampered');
    fs.file('/backups/servora-med-20260805T120000Z.dump.sha256', `${'d'.repeat(64)}  servora-med-20260805T120000Z.dump\n`);
    backupPair(fs, '/backups', '20260805T100000Z', { content: 'older-valid' });
    const deps = fakeDeps({ fs });
    const result = await evaluateBackup(config, deps);
    assert.equal(result.ok, false);
    assert.equal(result.errorCategory, 'invalid-backup');
    assert.equal(result.latestProblem, 'checksum-mismatch');
    assert.equal(result.basename, 'servora-med-20260805T120000Z.dump');
    assert.equal(result.checksumValid, false);
  });

  it('rejects future-dated filenames as invalid without older fallback', async () => {
    const fs = new FakeFs();
    fs.dir('/backups');
    backupPair(fs, '/backups', '20990101T000000Z');
    const deps = fakeDeps({ fs });
    const result = await evaluateBackup(config, deps);
    assert.equal(result.errorCategory, 'invalid-backup');
    assert.equal(result.latestProblem, 'future-timestamp');
    assert.equal(result.ok, false);
  });

  it('rejects symlinked backup files as invalid', async () => {
    const fs = new FakeFs();
    fs.dir('/backups');
    fs.symlink('/backups/servora-med-20260805T120000Z.dump');
    const deps = fakeDeps({ fs });
    const result = await evaluateBackup(config, deps);
    assert.equal(result.errorCategory, 'invalid-backup');
    assert.equal(result.latestProblem, 'not-regular-file');
  });

  it('fails closed with the newest basename reported on checksum mismatch', async () => {
    const fs = new FakeFs();
    fs.dir('/backups');
    fs.file('/backups/servora-med-20260805T120000Z.dump', 'latest-tampered');
    fs.file('/backups/servora-med-20260805T120000Z.dump.sha256', `${'d'.repeat(64)}  servora-med-20260805T120000Z.dump\n`);
    backupPair(fs, '/backups', '20260805T100000Z', { content: 'older-valid' });
    const deps = fakeDeps({ fs });
    const result = await evaluateBackup(config, deps);
    assert.equal(result.ok, false);
    assert.equal(result.errorCategory, 'invalid-backup');
    assert.equal(result.latestProblem, 'checksum-mismatch');
    assert.equal(result.basename, 'servora-med-20260805T120000Z.dump');
    assert.equal(result.checksumValid, false);
  });

  it('fails closed when the newest sidecar is missing even if an older backup is valid', async () => {
    const fs = new FakeFs();
    fs.dir('/backups');
    fs.file('/backups/servora-med-20260805T120000Z.dump', 'newest-dump');
    backupPair(fs, '/backups', '20260805T100000Z', { content: 'older-valid' });
    const deps = fakeDeps({ fs });
    const result = await evaluateBackup(config, deps);
    assert.equal(result.ok, false);
    assert.equal(result.errorCategory, 'invalid-backup');
    assert.equal(result.latestProblem, 'missing-sidecar');
    assert.equal(result.basename, 'servora-med-20260805T120000Z.dump');
  });

  it('fails closed when the newest sidecar is malformed even if an older backup is valid', async () => {
    const fs = new FakeFs();
    fs.dir('/backups');
    fs.file('/backups/servora-med-20260805T120000Z.dump', 'newest-dump');
    fs.file('/backups/servora-med-20260805T120000Z.dump.sha256', 'garbage');
    backupPair(fs, '/backups', '20260805T100000Z', { content: 'older-valid' });
    const deps = fakeDeps({ fs });
    const result = await evaluateBackup(config, deps);
    assert.equal(result.errorCategory, 'invalid-backup');
    assert.equal(result.latestProblem, 'malformed-sidecar');
  });

  it('fails closed when the newest sidecar basename is wrong even if an older backup is valid', async () => {
    const fs = new FakeFs();
    fs.dir('/backups');
    fs.file('/backups/servora-med-20260805T120000Z.dump', 'newest-dump');
    fs.file('/backups/servora-med-20260805T120000Z.dump.sha256', `${'b'.repeat(64)}  servora-med-20260804T120000Z.dump`);
    backupPair(fs, '/backups', '20260805T100000Z', { content: 'older-valid' });
    const deps = fakeDeps({ fs });
    const result = await evaluateBackup(config, deps);
    assert.equal(result.errorCategory, 'invalid-backup');
    assert.equal(result.latestProblem, 'bad-basename');
  });

  it('fails closed when the newest backup is a symlink even if an older backup is valid', async () => {
    const fs = new FakeFs();
    fs.dir('/backups');
    fs.symlink('/backups/servora-med-20260805T120000Z.dump');
    backupPair(fs, '/backups', '20260805T100000Z', { content: 'older-valid' });
    const deps = fakeDeps({ fs });
    const result = await evaluateBackup(config, deps);
    assert.equal(result.ok, false);
    assert.equal(result.errorCategory, 'invalid-backup');
    assert.equal(result.latestProblem, 'not-regular-file');
  });

  it('fails closed when the newest backup is future-dated even if an older backup is valid', async () => {
    const fs = new FakeFs();
    fs.dir('/backups');
    backupPair(fs, '/backups', '20990101T000000Z');
    backupPair(fs, '/backups', '20260805T100000Z', { content: 'older-valid' });
    const deps = fakeDeps({ fs });
    const result = await evaluateBackup(config, deps);
    assert.equal(result.ok, false);
    assert.equal(result.errorCategory, 'invalid-backup');
    assert.equal(result.latestProblem, 'future-timestamp');
  });

  it('hashes only the newest candidate dump', async () => {
    const fs = new FakeFs();
    fs.dir('/backups');
    fs.file('/backups/servora-med-20260805T120000Z.dump', 'latest-tampered');
    fs.file('/backups/servora-med-20260805T120000Z.dump.sha256', `${'d'.repeat(64)}  servora-med-20260805T120000Z.dump\n`);
    backupPair(fs, '/backups', '20260805T100000Z', { content: 'older-valid' });
    let hashCalls = [];
    const deps = fakeDeps({ fs });
    deps.hashFile = (filePath) => { hashCalls.push(filePath); return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'); };
    const result = await evaluateBackup(config, deps);
    assert.equal(result.ok, false);
    assert.equal(hashCalls.length, 1);
    assert.ok(hashCalls[0].endsWith('servora-med-20260805T120000Z.dump'));
  });

  it('parses strict UTC timestamps only', () => {
    assert.ok(parseBackupTimestamp('20260805T120000Z'));
    assert.equal(parseBackupTimestamp('20260805120000Z'), null);
    assert.equal(parseBackupTimestamp('2026-08-05T12:00:00Z'), null);
    assert.equal(parseBackupTimestamp('20261305T120000Z'), null);
    assert.equal(parseBackupTimestamp('20260805T120060Z'), null);
  });

  it('computes portable SHA-256 digests', () => {
    const digest = createHash('sha256').update('hello').digest('hex');
    assert.equal(digest.length, 64);
    const parsed = parseSidecar(`${digest}  servora-med-20260805T120000Z.dump`);
    assert.equal(parsed.digest, digest);
    assert.equal(parsed.basename, 'servora-med-20260805T120000Z.dump');
  });
});

// ---------------------------------------------------------------------------
// Disk probe
// ---------------------------------------------------------------------------

describe('disk probe', () => {
  const config = loadConfig(BASE_ENV);

  it('reports a healthy percentage', () => {
    const deps = fakeDeps({ statfsResult: { bavail: 5000n, blocks: 10000n, bsize: 4096n } });
    const result = probeDisk(config, deps);
    assert.equal(result.ok, true);
    assert.equal(result.freePercent, 50);
    assert.equal(result.freeBytes, 5000 * 4096);
    assert.equal(result.totalBytes, 10000 * 4096);
  });

  it('flags below threshold', () => {
    const deps = fakeDeps({ statfsResult: { bavail: 1000n, blocks: 10000n, bsize: 4096n } });
    const result = probeDisk(config, deps);
    assert.equal(result.ok, false);
    assert.equal(result.errorCategory, 'below-threshold');
    assert.equal(result.freePercent, 10);
  });

  it('flags statfs failure', () => {
    const deps = fakeDeps({ statfsResult: new Error('ENOENT') });
    const result = probeDisk(config, deps);
    assert.equal(result.ok, false);
    assert.equal(result.errorCategory, 'statfs-failed');
  });

  it('flags zero total blocks', () => {
    const deps = fakeDeps({ statfsResult: { bavail: 0n, blocks: 0n, bsize: 4096n } });
    const result = probeDisk(config, deps);
    assert.equal(result.ok, false);
    assert.equal(result.errorCategory, 'total-zero');
  });

  it('is bigint-safe for large block counts', () => {
    const deps = fakeDeps({ statfsResult: { bavail: 1234567890123n, blocks: 4000000000000n, bsize: 4096n } });
    const result = probeDisk(config, deps);
    assert.equal(result.ok, true);
    assert.equal(result.freePercent, Number(1234567890123n * 10000n / 4000000000000n) / 100);
  });
});

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

describe('state model', () => {
  it('creates a default state when none exists', async () => {
    const fs = new FakeFs();
    fs.dir('/var/lib/servora-med-alerting');
    const config = loadConfig(BASE_ENV);
    const { state, monitorEvent } = await loadState(config, fakeDeps({ fs }));
    assert.equal(state.version, 1);
    assert.equal(monitorEvent, null);
    for (const name of ['health', 'backup', 'disk']) {
      assert.equal(state.checks[name].consecutiveFailures, 0);
      assert.equal(state.checks[name].alertActive, false);
    }
  });

  it('quarantines corrupt state and emits a monitor alert', async () => {
    const fs = new FakeFs();
    fs.dir('/var/lib/servora-med-alerting');
    fs.file('/var/lib/servora-med-alerting/state.json', '{not-json');
    const config = loadConfig(BASE_ENV);
    const { state, monitorEvent } = await loadState(config, fakeDeps({ fs }));
    assert.equal(state.version, 1);
    assert.equal(monitorEvent.event, 'monitor');
    assert.equal(monitorEvent.check, 'monitor');
    const quarantined = Array.from(fs.entries.keys()).find((key) => key.includes('state.json.corrupt-'));
    assert.ok(quarantined);
  });

  it('rejects unsupported future state versions without overwriting', async () => {
    const fs = new FakeFs();
    fs.dir('/var/lib/servora-med-alerting');
    fs.file('/var/lib/servora-med-alerting/state.json', JSON.stringify({ version: 99, checks: {} }));
    const config = loadConfig(BASE_ENV);
    await assert.rejects(() => loadState(config, fakeDeps({ fs })), StateVersionError);
    assert.ok(fs.entries.has('/var/lib/servora-med-alerting/state.json'));
  });

  it('sanitizes persisted state fields', () => {
    const sanitized = sanitizeState({
      version: 1,
      checks: {
        health: { consecutiveFailures: 2, alertActive: true, lastAlertAt: 1, lastReminderAt: null, lastRecoveryAt: null, lastDeliveredAt: 2 },
        backup: { consecutiveFailures: 0, alertActive: false, lastAlertAt: null, lastReminderAt: null, lastRecoveryAt: null, lastDeliveredAt: null },
        disk: { consecutiveFailures: 0, alertActive: false, lastAlertAt: null, lastReminderAt: null, lastRecoveryAt: null, lastDeliveredAt: null },
      },
    });
    assert.equal(sanitized.checks.health.consecutiveFailures, 2);
    assert.equal(sanitized.checks.health.alertActive, true);
  });

  it('rejects structurally invalid state', () => {
    assert.equal(sanitizeState({ version: 1, checks: { health: 'x' } }), null);
    assert.equal(sanitizeState({ version: 1 }), null);
    assert.equal(sanitizeState('garbage'), null);
  });

  it('writes state atomically with 0600 permissions', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'servora-alert-state-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const config = loadConfig({ ...BASE_ENV, SERVORA_ALERT_STATE_DIR: dir });
    writeState(config, createDefaultState(), createDefaultDeps());
    assert.equal(statSync(join(dir, 'state.json')).mode & 0o777, 0o600);
    assert.equal(realReaddirSync(dir).length, 1);
  });

  it('normalizes a pre-existing loose state directory to 0700', (t) => {
    const { chmodSync } = requireNodeFsExtra();
    const dir = mkdtempSync(join(tmpdir(), 'servora-alert-state-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    chmodSync(dir, 0o755);
    const config = loadConfig({ ...BASE_ENV, SERVORA_ALERT_STATE_DIR: dir });
    writeState(config, createDefaultState(), createDefaultDeps());
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  });
});

// ---------------------------------------------------------------------------
// Transitions: threshold, cooldown, recovery
// ---------------------------------------------------------------------------

describe('transitions', () => {
  const config = loadConfig({ ...BASE_ENV, SERVORA_ALERT_FAILURE_THRESHOLD: '3', SERVORA_ALERT_COOLDOWN_MINUTES: '60' });
  const fresh = () => createDefaultState().checks.health;

  it('increments failures below the threshold without events', () => {
    const first = transitionCheck({ check: 'health', ok: false, previous: fresh(), config, now: 1000, details: {} });
    assert.equal(first.event, null);
    assert.equal(first.observedNext.consecutiveFailures, 1);
    const second = transitionCheck({ check: 'health', ok: false, previous: first.observedNext, config, now: 2000, details: {} });
    assert.equal(second.event, null);
    assert.equal(second.observedNext.consecutiveFailures, 2);
  });

  it('emits an alert exactly at the threshold and keeps the alarm inactive until delivery', () => {
    const failed = { ...fresh(), consecutiveFailures: 2 };
    const transition = transitionCheck({ check: 'health', ok: false, previous: failed, config, now: 3000, details: {} });
    assert.equal(transition.event.event, 'alert');
    assert.equal(transition.observedNext.consecutiveFailures, 3);
    assert.equal(transition.observedNext.alertActive, false);
    assert.equal(transition.observedNext.lastDeliveredAt, null);
    assert.equal(transition.deliveredNext.alertActive, true);
    assert.equal(transition.deliveredNext.lastAlertAt, 3000);
    assert.equal(transition.deliveredNext.lastDeliveredAt, 3000);
  });

  it('suppresses further events during cooldown while active', () => {
    const active = {
      ...fresh(), consecutiveFailures: 4, alertActive: true,
      lastAlertAt: 3000, lastDeliveredAt: 3000,
    };
    const within = transitionCheck({ check: 'health', ok: false, previous: active, config, now: 3000 + 30 * 60 * 1000, details: {} });
    assert.equal(within.event, null);
  });

  it('emits a reminder after the cooldown expires and commits reminder timestamps only on delivery', () => {
    const active = {
      ...fresh(), consecutiveFailures: 5, alertActive: true,
      lastAlertAt: 3000, lastDeliveredAt: 3000,
    };
    const after = transitionCheck({ check: 'health', ok: false, previous: active, config, now: 3000 + 61 * 60 * 1000, details: {} });
    assert.equal(after.event.event, 'reminder');
    assert.equal(after.observedNext.lastReminderAt, null);
    assert.equal(after.observedNext.lastDeliveredAt, 3000);
    assert.equal(after.deliveredNext.lastReminderAt, 3000 + 61 * 60 * 1000);
    assert.equal(after.deliveredNext.lastDeliveredAt, 3000 + 61 * 60 * 1000);
  });

  it('keeps an active alarm open until a recovery is delivered, then closes it', () => {
    const active = {
      ...fresh(), consecutiveFailures: 3, alertActive: true,
      lastAlertAt: 3000, lastDeliveredAt: 3000,
    };
    const recovery = transitionCheck({ check: 'health', ok: true, previous: active, config, now: 4000, details: {} });
    assert.equal(recovery.event.event, 'recovery');
    assert.equal(recovery.observedNext.alertActive, true);
    assert.equal(recovery.observedNext.lastRecoveryAt, null);
    assert.equal(recovery.observedNext.lastDeliveredAt, 3000);
    assert.equal(recovery.deliveredNext.alertActive, false);
    assert.equal(recovery.deliveredNext.lastRecoveryAt, 4000);
    assert.equal(recovery.deliveredNext.consecutiveFailures, 0);
    const again = transitionCheck({ check: 'health', ok: true, previous: recovery.deliveredNext, config, now: 5000, details: {} });
    assert.equal(again.event, null);
  });

  it('does not emit recovery when no alert was ever delivered', () => {
    const transition = transitionCheck({ check: 'health', ok: true, previous: fresh(), config, now: 1000, details: {} });
    assert.equal(transition.event, null);
  });
});

// ---------------------------------------------------------------------------
// Lock
// ---------------------------------------------------------------------------

describe('lock', () => {
  const config = loadConfig(BASE_ENV);

  it('acquires and releases normally', () => {
    const fs = new FakeFs();
    const deps = fakeDeps({ fs });
    const acquired = acquireLock(config, deps);
    assert.equal(acquired.ok, true);
    assert.ok(fs.entries.has('/var/lib/servora-med-alerting/lock.lock'));
    const release = releaseLock(config, deps, { ownerToken: acquired.ownerToken });
    assert.equal(release.reason, 'ok');
    assert.ok(!fs.entries.has('/var/lib/servora-med-alerting/lock.lock'));
  });

  it('rejects a second process holding an active lock', () => {
    const fs = new FakeFs();
    fs.dir('/var/lib/servora-med-alerting');
    fs.file('/var/lib/servora-med-alerting/lock.lock', JSON.stringify({ version: 1, pid: 99999, createdAt: 1, ownerToken: 'a'.repeat(32) }));
    const deps = fakeDeps({ fs });
    deps.probeProcess = () => 'alive';
    const result = acquireLock(config, deps);
    assert.equal(result.ok, false);
  });

  it('reclaims a stale lock from a dead pid', () => {
    const fs = new FakeFs();
    fs.dir('/var/lib/servora-med-alerting');
    fs.file('/var/lib/servora-med-alerting/lock.lock', JSON.stringify({ version: 1, pid: 99999, createdAt: 1, ownerToken: 'a'.repeat(32) }));
    const deps = fakeDeps({ fs });
    deps.probeProcess = () => 'dead';
    const result = acquireLock(config, deps);
    assert.equal(result.ok, true);
    assert.equal(result.staleReclaimed, true);
  });

  it('fails safely on a malformed lock file', () => {
    const fs = new FakeFs();
    fs.dir('/var/lib/servora-med-alerting');
    fs.file('/var/lib/servora-med-alerting/lock.lock', 'garbage');
    assert.throws(() => acquireLock(config, fakeDeps({ fs })), LockError);
  });

  it('releases the lock even when the monitor errors', async () => {
    const fs = new FakeFs();
    fs.dir('/var/lib/servora-med-alerting');
    const deps = fakeDeps({
      fs,
      health: new Error('boom'),
      statfsResult: { bavail: 5000n, blocks: 10000n, bsize: 4096n },
    });
    deps.fetch = async () => { throw new TypeError('fetch failed'); };
    const exit = await main({ env: { ...BASE_ENV, SERVORA_ALERT_FAILURE_THRESHOLD: '1' }, deps, log: () => {} });
    assert.equal(exit, 3);
    assert.ok(!fs.entries.has('/var/lib/servora-med-alerting/lock.lock'));
  });
});

// ---------------------------------------------------------------------------
// Quarantine fail closed (R4)
// ---------------------------------------------------------------------------

describe('quarantine fail closed', () => {
  const config = loadConfig(BASE_ENV);
  const statePath = '/var/lib/servora-med-alerting/state.json';

  function corruptFs() {
    const fs = new FakeFs();
    fs.dir('/var/lib/servora-med-alerting');
    fs.file(statePath, 'corrupt{not-json');
    return fs;
  }

  it('fails closed with the original state preserved when the quarantine link fails with EACCES', async () => {
    const fs = corruptFs();
    const deps = fakeDeps({ fs });
    deps.link = () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); };
    await assert.rejects(() => loadState(config, deps), (error) => {
      assert.equal(error.name, 'StateQuarantineError');
      assert.equal(error.category, 'permission');
      return true;
    });
    assert.equal(fs.readFileSync(statePath, 'utf8'), 'corrupt{not-json');
    assert.ok(!Array.from(fs.entries.keys()).some((key) => key.includes('state.json.corrupt-')));
  });

  it('fails closed when the quarantine link fails with EIO', async () => {
    const fs = corruptFs();
    const deps = fakeDeps({ fs });
    deps.link = () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); };
    await assert.rejects(() => loadState(config, deps), (error) => {
      assert.equal(error.name, 'StateQuarantineError');
      assert.equal(error.category, 'io');
      return true;
    });
    assert.equal(fs.readFileSync(statePath, 'utf8'), 'corrupt{not-json');
  });

  it('resolves a quarantine destination collision with a unique suffix', async () => {
    const fs = corruptFs();
    const base = `state.json.corrupt-${new Date(1_785_974_400_000).toISOString().replace(/[:.]/g, '-')}`;
    fs.file(`/var/lib/servora-med-alerting/${base}`, 'old-quarantine');
    const deps = fakeDeps({ fs });
    const { state, monitorEvent, requiresInitialPersist } = await loadState(config, deps);
    assert.equal(requiresInitialPersist, true);
    assert.equal(monitorEvent.event, 'monitor');
    assert.equal(state.monitor.pendingIncident.kind, 'state-corrupt');
    const quarantineFiles = Array.from(fs.entries.keys()).filter((key) => key.includes('state.json.corrupt-'));
    assert.equal(quarantineFiles.length, 2);
    assert.ok(quarantineFiles.includes(`/var/lib/servora-med-alerting/${base}`));
    assert.ok(quarantineFiles.some((key) => key.endsWith(`-${'f'.repeat(32)}`)));
    assert.ok(!fs.entries.has(statePath));
  });

  it('fails closed when every atomic quarantine candidate collides', async () => {
    const fs = corruptFs();
    const base = `state.json.corrupt-${new Date(1_785_974_400_000).toISOString().replace(/[:.]/g, '-')}`;
    fs.file(`/var/lib/servora-med-alerting/${base}`, 'first');
    fs.file(`/var/lib/servora-med-alerting/${base}-${'f'.repeat(32)}`, 'second');
    const deps = fakeDeps({ fs });
    await assert.rejects(() => loadState(config, deps), (error) => {
      assert.equal(error.name, 'StateQuarantineError');
      assert.equal(error.category, 'collision');
      return true;
    });
    assert.ok(fs.entries.has(statePath));
    assert.equal(fs.readFileSync(statePath, 'utf8'), 'corrupt{not-json');
    assert.equal(fs.readFileSync(`/var/lib/servora-med-alerting/${base}`, 'utf8'), 'first');
    assert.equal(fs.readFileSync(`/var/lib/servora-med-alerting/${base}-${'f'.repeat(32)}`, 'utf8'), 'second');
  });

  it('resolves a quarantine rename failure to exit 1 with zero external work', async () => {
    const fs = new FakeFs();
    fs.dir('/backups');
    fs.dir('/var/lib/servora-med-alerting');
    backupPair(fs, '/backups', '20260805T120000Z');
    fs.file(statePath, 'corrupt{not-json');
    const deps = fakeDeps({
      fs,
      health: healthResponse(200, { status: 'ok' }),
      statfsResult: { bavail: 5000n, blocks: 10000n, bsize: 4096n },
    });
    let probeCount = 0;
    let webhookCount = 0;
    deps.fetch = async (url) => {
      if (url.includes('/api/health')) { probeCount += 1; return healthResponse(200, { status: 'ok' }); }
      webhookCount += 1;
      return webhookResponse(200);
    };
    deps.link = (from, to) => {
      if (String(to).includes('state.json.corrupt-')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return fs.linkSync(from, to);
    };
    const logLines = [];
    const env = { ...BASE_ENV, SERVORA_ALERT_FAILURE_THRESHOLD: '1' };
    const exit = await main({ env, deps, log: (entry) => logLines.push(JSON.stringify(entry)) });
    assert.equal(exit, 1);
    assert.equal(probeCount, 0);
    assert.equal(webhookCount, 0);
    assert.equal(fs.readFileSync(statePath, 'utf8'), 'corrupt{not-json');
    assert.ok(logLines.some((line) => line.includes('"run":"state-quarantine-failed"') && line.includes('"errorCategory":"permission"')));
    assert.ok(!logLines.some((line) => line.includes('EACCES') || line.includes('at ')));
  });
});

// ---------------------------------------------------------------------------
// State directory bootstrap (R5)
// ---------------------------------------------------------------------------

describe('state directory bootstrap', () => {
  const env = { ...BASE_ENV, SERVORA_ALERT_FAILURE_THRESHOLD: '1' };
  const dir = '/var/lib/servora-med-alerting';

  function readyFs() {
    const fs = new FakeFs();
    fs.dir('/backups');
    backupPair(fs, '/backups', '20260805T120000Z');
    return fs;
  }

  function healthyDeps(fs) {
    const deps = fakeDeps({ fs, health: healthResponse(200, { status: 'ok' }), statfsResult: { bavail: 5000n, blocks: 10000n, bsize: 4096n } });
    deps.fetch = async (url) => {
      if (url.includes('/api/health')) return healthResponse(200, { status: 'ok' });
      return webhookResponse(200);
    };
    return deps;
  }

  function zeroIoDeps(fs) {
    const deps = healthyDeps(fs);
    const counters = { probes: 0, webhooks: 0 };
    deps.fetch = async (url) => {
      if (url.includes('/api/health')) { counters.probes += 1; return healthResponse(200, { status: 'ok' }); }
      counters.webhooks += 1;
      return webhookResponse(200);
    };
    return { deps, counters };
  }

  it('creates a missing state directory as 0700 before any lock write', async () => {
    const fs = readyFs();
    const { deps } = zeroIoDeps(fs);
    const exit = await main({ env, deps, log: () => {} });
    assert.equal(exit, 0);
    assert.equal(fs.entries.get(dir).kind, 'dir');
    assert.equal(fs.entries.get(dir).mode, 0o700);
  });

  it('normalizes an existing permissive state directory to 0700 before lock write', async () => {
    const fs = readyFs();
    fs.dir(dir);
    fs.entries.get(dir).mode = 0o777;
    const deps = healthyDeps(fs);
    const realWrite = fs.writeFileSync;
    const lockModes = [];
    deps.writeFile = (target, content, options) => {
      if (String(target).endsWith('/lock.lock')) lockModes.push(fs.entries.get(dir).mode);
      return realWrite(target, content, options);
    };
    const exit = await main({ env, deps, log: () => {} });
    assert.equal(exit, 0);
    assert.equal(fs.entries.get(dir).mode, 0o700);
    assert.deepEqual(lockModes, [0o700]);
  });

  it('fails closed with zero lock/state/probe/webhook when chmod fails', async () => {
    const fs = readyFs();
    fs.dir(dir);
    fs.entries.get(dir).mode = 0o755;
    const { deps, counters } = zeroIoDeps(fs);
    const realChmod = deps.chmod;
    deps.chmod = (target, mode) => {
      if (target === dir) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return realChmod(target, mode);
    };
    const logLines = [];
    const exit = await main({ env, deps, log: (entry) => logLines.push(JSON.stringify(entry)) });
    assert.equal(exit, 1);
    assert.equal(counters.probes, 0);
    assert.equal(counters.webhooks, 0);
    assert.ok(!fs.entries.has(`${dir}/lock.lock`));
    assert.ok(!fs.entries.has(`${dir}/state.json`));
    assert.ok(logLines.some((line) => line.includes('"run":"state-dir-failed"') && line.includes('"errorCategory":"permission"')));
    assert.ok(!logLines.some((line) => line.includes('/var/lib') || line.includes('at ')));
  });

  it('fails closed when the state directory is a regular file', async () => {
    const fs = readyFs();
    fs.file(dir, 'not-a-dir');
    const { deps, counters } = zeroIoDeps(fs);
    const logLines = [];
    const exit = await main({ env, deps, log: (entry) => logLines.push(JSON.stringify(entry)) });
    assert.equal(exit, 1);
    assert.equal(counters.probes, 0);
    assert.equal(counters.webhooks, 0);
    assert.ok(logLines.some((line) => line.includes('"run":"state-dir-failed"') && line.includes('"errorCategory":"wrong-type"')));
    assert.ok(!logLines.some((line) => line.includes('/var/lib') || line.includes('at ')));
  });

  it('fails closed when the state directory is a symbolic link', async () => {
    const fs = readyFs();
    fs.symlink(dir);
    const { deps, counters } = zeroIoDeps(fs);
    const logLines = [];
    const exit = await main({ env, deps, log: (entry) => logLines.push(JSON.stringify(entry)) });
    assert.equal(exit, 1);
    assert.equal(counters.probes, 0);
    assert.equal(counters.webhooks, 0);
    assert.ok(logLines.some((line) => line.includes('"run":"state-dir-failed"') && line.includes('"errorCategory":"symlink"')));
  });

  it('fails closed when lstat fails with EIO', async () => {
    const fs = readyFs();
    fs.dir(dir);
    const { deps, counters } = zeroIoDeps(fs);
    const realLstat = deps.lstat;
    deps.lstat = (target) => {
      if (target === dir) throw Object.assign(new Error('EIO'), { code: 'EIO' });
      return realLstat(target);
    };
    const logLines = [];
    const exit = await main({ env, deps, log: (entry) => logLines.push(JSON.stringify(entry)) });
    assert.equal(exit, 1);
    assert.equal(counters.probes, 0);
    assert.equal(counters.webhooks, 0);
    assert.ok(logLines.some((line) => line.includes('"run":"state-dir-failed"') && line.includes('"errorCategory":"io"')));
    assert.ok(!logLines.some((line) => line.includes('at ')));
  });
});

// ---------------------------------------------------------------------------
// Atomic no-clobber quarantine (R5)
// ---------------------------------------------------------------------------

describe('atomic no-clobber quarantine', () => {
  const config = loadConfig(BASE_ENV);
  const statePath = '/var/lib/servora-med-alerting/state.json';
  const dir = '/var/lib/servora-med-alerting';

  function corruptFs() {
    const fs = new FakeFs();
    fs.dir(dir);
    fs.file(statePath, 'corrupt{not-json');
    return fs;
  }

  function quarantineNames(fs) {
    return Array.from(fs.entries.keys()).filter((key) => key.includes('state.json.corrupt-'));
  }

  it('retries with a new candidate when the transfer races a concurrent creator', async () => {
    const fs = corruptFs();
    const deps = fakeDeps({ fs });
    const realLink = fs.linkSync;
    let linkCalls = 0;
    deps.link = (from, to) => {
      linkCalls += 1;
      if (linkCalls === 1) {
        fs.file(String(to), 'concurrent-forensic');
        throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
      }
      return realLink(from, to);
    };
    const { state, requiresInitialPersist } = await loadState(config, deps);
    assert.equal(requiresInitialPersist, true);
    assert.equal(state.monitor.pendingIncident.kind, 'state-corrupt');
    const names = quarantineNames(fs);
    assert.equal(names.length, 2);
    assert.ok(names.some((key) => fs.readFileSync(key, 'utf8') === 'concurrent-forensic'));
    assert.ok(names.some((key) => fs.readFileSync(key, 'utf8') === 'corrupt{not-json'));
    assert.ok(!fs.entries.has(statePath));
  });

  for (const [code, category] of [['EACCES', 'permission'], ['EIO', 'io']]) {
    it(`fails closed preserving the original when the quarantine link fails with ${code}`, async () => {
      const fs = corruptFs();
      const deps = fakeDeps({ fs });
      deps.link = () => { throw Object.assign(new Error(code), { code }); };
      await assert.rejects(() => loadState(config, deps), (error) => {
        assert.equal(error.name, 'StateQuarantineError');
        assert.equal(error.category, category);
        return true;
      });
      assert.equal(fs.readFileSync(statePath, 'utf8'), 'corrupt{not-json');
      assert.equal(quarantineNames(fs).length, 0);
    });
  }

  it('fails closed without a fresh state when the source unlink fails after a successful link', async () => {
    const fs = corruptFs();
    const deps = fakeDeps({ fs });
    const realUnlink = fs.unlinkSync;
    deps.unlink = (target) => {
      if (target === statePath) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return realUnlink(target);
    };
    await assert.rejects(() => loadState(config, deps), (error) => {
      assert.equal(error.name, 'StateQuarantineError');
      return true;
    });
    assert.equal(fs.readFileSync(statePath, 'utf8'), 'corrupt{not-json');
    const names = quarantineNames(fs);
    assert.equal(names.length, 1);
    assert.equal(fs.readFileSync(names[0], 'utf8'), 'corrupt{not-json');
  });

  it('resolves a source unlink failure to exit 1 with no probes and no fresh state', async () => {
    const fs = new FakeFs();
    fs.dir('/backups');
    fs.dir(dir);
    backupPair(fs, '/backups', '20260805T120000Z');
    fs.file(statePath, 'corrupt{not-json');
    const deps = fakeDeps({ fs, health: healthResponse(200, { status: 'ok' }), statfsResult: { bavail: 5000n, blocks: 10000n, bsize: 4096n } });
    let probes = 0;
    let webhooks = 0;
    deps.fetch = async (url) => {
      if (url.includes('/api/health')) { probes += 1; return healthResponse(200, { status: 'ok' }); }
      webhooks += 1;
      return webhookResponse(200);
    };
    const realUnlink = fs.unlinkSync;
    deps.unlink = (target) => {
      if (target === statePath) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return realUnlink(target);
    };
    const logLines = [];
    const exit = await main({ env: { ...BASE_ENV, SERVORA_ALERT_FAILURE_THRESHOLD: '1' }, deps, log: (entry) => logLines.push(JSON.stringify(entry)) });
    assert.equal(exit, 1);
    assert.equal(probes, 0);
    assert.equal(webhooks, 0);
    assert.equal(fs.readFileSync(statePath, 'utf8'), 'corrupt{not-json');
    assert.equal(quarantineNames(fs).length, 1);
    assert.ok(logLines.some((line) => line.includes('"run":"state-quarantine-failed"')));
    assert.ok(!logLines.some((line) => line.includes('at ')));
  });

  it('does not quarantine or reset when the state path is a symbolic link', async () => {
    const fs = corruptFs();
    fs.entries.delete(statePath);
    fs.symlink(statePath);
    const deps = fakeDeps({ fs });
    deps.readFile = (target, enc) => {
      if (target === statePath) return 'corrupt{not-json';
      return fs.readFileSync(target, enc);
    };
    await assert.rejects(() => loadState(config, deps), (error) => {
      assert.equal(error.name, 'StateQuarantineError');
      assert.equal(error.category, 'symlink');
      return true;
    });
    assert.ok(fs.entries.has(statePath));
    assert.equal(fs.entries.get(statePath).kind, 'symlink');
    assert.equal(quarantineNames(fs).length, 0);
  });

  it('performs an atomic no-clobber quarantine and keeps the pending persist flow', async () => {
    const fs = corruptFs();
    const deps = fakeDeps({ fs });
    const { state, monitorEvent, requiresInitialPersist } = await loadState(config, deps);
    assert.equal(requiresInitialPersist, true);
    assert.equal(state.monitor.pendingIncident.kind, 'state-corrupt');
    assert.equal(monitorEvent.event, 'monitor');
    const names = quarantineNames(fs);
    assert.equal(names.length, 1);
    assert.equal(fs.readFileSync(names[0], 'utf8'), 'corrupt{not-json');
    assert.ok(!fs.entries.has(statePath));
  });
});

// ---------------------------------------------------------------------------
// Lock ownership and reclaim races (R4)
// ---------------------------------------------------------------------------

describe('lock ownership', () => {
  const config = loadConfig(BASE_ENV);
  const dir = '/var/lib/servora-med-alerting';

  function lockFs(content) {
    const fs = new FakeFs();
    fs.dir(dir);
    if (content !== null) fs.file(`${dir}/lock.lock`, content);
    return fs;
  }

  function lockJson(pid, { createdAt = 1, token = 'a'.repeat(32) } = {}) {
    return JSON.stringify({ version: 1, pid, createdAt, ownerToken: token });
  }

  it('classifies kill errors: EPERM alive, ESRCH dead, others unknown', () => {
    assert.equal(classifyKillError({ code: 'EPERM' }), 'alive');
    assert.equal(classifyKillError({ code: 'ESRCH' }), 'dead');
    assert.equal(classifyKillError({ code: 'EACCES' }), 'unknown');
    assert.equal(classifyKillError(new Error('nope')), 'unknown');
    assert.equal(probeProcess(process.pid), 'alive');
  });

  it('treats an EPERM-protected lock as active through main: exit 2, no probes, lock preserved', async () => {
    const fs = lockFs(lockJson(99999));
    const deps = fakeDeps({ fs, health: healthResponse(200, { status: 'ok' }), statfsResult: { bavail: 5000n, blocks: 10000n, bsize: 4096n } });
    deps.probeProcess = () => 'alive';
    let probes = 0;
    let webhooks = 0;
    deps.fetch = async (url) => {
      if (url.includes('/api/health')) { probes += 1; return healthResponse(200, { status: 'ok' }); }
      webhooks += 1;
      return webhookResponse(200);
    };
    const logLines = [];
    const exit = await main({ env: { ...BASE_ENV, SERVORA_ALERT_FAILURE_THRESHOLD: '1' }, deps, log: (entry) => logLines.push(JSON.stringify(entry)) });
    assert.equal(exit, 2);
    assert.equal(probes, 0);
    assert.equal(webhooks, 0);
    assert.equal(fs.readFileSync(`${dir}/lock.lock`, 'utf8'), lockJson(99999));
    assert.ok(logLines.some((line) => line.includes('"run":"lock-busy"')));
  });

  for (const [label, content] of [
    ['pid zero', JSON.stringify({ version: 1, pid: 0, createdAt: 1, ownerToken: 'a'.repeat(32) })],
    ['negative pid', JSON.stringify({ version: 1, pid: -1, createdAt: 1, ownerToken: 'a'.repeat(32) })],
    ['invalid createdAt', JSON.stringify({ version: 1, pid: 99999, createdAt: 'now', ownerToken: 'a'.repeat(32) })],
    ['future createdAt', JSON.stringify({ version: 1, pid: 99999, createdAt: 1_785_974_400_000 + 3_600_000, ownerToken: 'a'.repeat(32) })],
    ['missing owner token', JSON.stringify({ version: 1, pid: 99999, createdAt: 1 })],
    ['missing version', JSON.stringify({ pid: 99999, createdAt: 1, ownerToken: 'a'.repeat(32) })],
  ]) {
    it(`resolves a lock with ${label} to structured exit 1 with the lock preserved`, async () => {
      const fs = lockFs(content);
      const deps = fakeDeps({ fs, health: healthResponse(200, { status: 'ok' }), statfsResult: { bavail: 5000n, blocks: 10000n, bsize: 4096n } });
      let probes = 0;
      deps.fetch = async (url) => { probes += 1; return healthResponse(200, { status: 'ok' }); };
      const logLines = [];
      const exit = await main({ env: { ...BASE_ENV, SERVORA_ALERT_FAILURE_THRESHOLD: '1' }, deps, log: (entry) => logLines.push(JSON.stringify(entry)) });
      assert.equal(exit, 1);
      assert.equal(probes, 0);
      assert.equal(fs.readFileSync(`${dir}/lock.lock`, 'utf8'), content);
      assert.ok(logLines.some((line) => line.includes('"run":"lock-invalid"')));
      assert.ok(!logLines.some((line) => line.includes('at ')));
    });
  }

  it('stops reclaim when the lock is replaced by an active owner before the second read', () => {
    const fs = lockFs(lockJson(99999));
    const deps = fakeDeps({ fs });
    const realWrite = fs.writeFileSync;
    let probeCalls = 0;
    deps.probeProcess = () => {
      probeCalls += 1;
      return probeCalls === 1 ? 'dead' : 'alive';
    };
    const replacement = lockJson(55555, { token: 'b'.repeat(32) });
    deps.writeFile = (target, content, options) => {
      const result = realWrite(target, content, options);
      if (target.endsWith('/lock.reclaim') && options.flag === 'wx') {
        fs.entries.set(`${dir}/lock.lock`, { kind: 'file', content: Buffer.from(replacement), mode: 0o600 });
      }
      return result;
    };
    const result = acquireLock(config, deps);
    assert.equal(result.ok, false);
    assert.equal(probeCalls, 2);
    assert.equal(fs.readFileSync(`${dir}/lock.lock`, 'utf8'), replacement);
    assert.ok(!fs.entries.has(`${dir}/lock.reclaim`));
  });

  it('does not start the monitor when a competitor wins the lock after stale unlink', async () => {
    const fs = lockFs(lockJson(99999));
    const deps = fakeDeps({ fs, health: healthResponse(200, { status: 'ok' }), statfsResult: { bavail: 5000n, blocks: 10000n, bsize: 4096n } });
    const realWrite = fs.writeFileSync;
    const competitor = lockJson(55555, { token: 'c'.repeat(32) });
    let writeCalls = 0;
    let probes = 0;
    deps.probeProcess = () => 'dead';
    deps.writeFile = (target, content, options) => {
      writeCalls += 1;
      if (target.endsWith('/lock.lock') && options.flag === 'wx' && writeCalls >= 3) {
        fs.entries.set(target, { kind: 'file', content: Buffer.from(competitor), mode: 0o600 });
        throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
      }
      return realWrite(target, content, options);
    };
    deps.fetch = async (url) => {
      if (url.includes('/api/health')) { probes += 1; return healthResponse(200, { status: 'ok' }); }
      return webhookResponse(200);
    };
    const logLines = [];
    const exit = await main({ env: { ...BASE_ENV, SERVORA_ALERT_FAILURE_THRESHOLD: '1' }, deps, log: (entry) => logLines.push(JSON.stringify(entry)) });
    assert.equal(exit, 2);
    assert.equal(probes, 0);
    assert.equal(fs.readFileSync(`${dir}/lock.lock`, 'utf8'), competitor);
    assert.ok(!fs.entries.has(`${dir}/lock.reclaim`));
  });

  it('never removes a foreign lock on release (owner mismatch)', () => {
    const fs = lockFs(null);
    const deps = fakeDeps({ fs });
    const acquired = acquireLock(config, deps);
    assert.equal(acquired.ok, true);
    const foreign = lockJson(99999, { token: 'b'.repeat(32) });
    fs.file(`${dir}/lock.lock`, foreign);
    const release = releaseLock(config, deps, { ownerToken: acquired.ownerToken });
    assert.equal(release.reason, 'owner-mismatch');
    assert.equal(fs.readFileSync(`${dir}/lock.lock`, 'utf8'), foreign);
  });

  it('removes only the matching owner lock on release', () => {
    const fs = lockFs(null);
    const deps = fakeDeps({ fs });
    const acquired = acquireLock(config, deps);
    const release = releaseLock(config, deps, { ownerToken: acquired.ownerToken });
    assert.equal(release.reason, 'ok');
    assert.ok(!fs.entries.has(`${dir}/lock.lock`));
  });

  it('does not delete a malformed replacement during release', () => {
    const fs = lockFs(null);
    const deps = fakeDeps({ fs });
    const acquired = acquireLock(config, deps);
    fs.file(`${dir}/lock.lock`, 'garbage{');
    const release = releaseLock(config, deps, { ownerToken: acquired.ownerToken });
    assert.equal(release.reason, 'malformed');
    assert.equal(fs.readFileSync(`${dir}/lock.lock`, 'utf8'), 'garbage{');
  });

  it('treats a missing lock on release as idempotent', () => {
    const fs = lockFs(null);
    const deps = fakeDeps({ fs });
    const release = releaseLock(config, deps, { ownerToken: 'a'.repeat(32) });
    assert.equal(release.reason, 'missing');
  });

  it('leaves an active reclaim guard untouched and reports busy', () => {
    const fs = lockFs(lockJson(99999));
    fs.file(`${dir}/lock.reclaim`, lockJson(44444, { token: 'd'.repeat(32) }));
    const deps = fakeDeps({ fs });
    deps.probeProcess = (pid) => (pid === 99999 ? 'dead' : 'alive');
    const result = acquireLock(config, deps);
    assert.equal(result.ok, false);
    assert.ok(fs.entries.has(`${dir}/lock.lock`));
    assert.ok(fs.entries.has(`${dir}/lock.reclaim`));
  });

  it('preserves a stale reclaim guard and fails closed for manual recovery', () => {
    const fs = lockFs(lockJson(99999));
    const guard = lockJson(44444, { token: 'd'.repeat(32) });
    fs.file(`${dir}/lock.reclaim`, guard);
    const deps = fakeDeps({ fs });
    deps.probeProcess = () => 'dead';
    assert.throws(() => acquireLock(config, deps), (error) => {
      assert.equal(error.name, 'LockError');
      assert.equal(error.category, 'stale');
      return true;
    });
    assert.equal(fs.readFileSync(`${dir}/lock.reclaim`, 'utf8'), guard);
    assert.ok(fs.entries.has(`${dir}/lock.lock`));
  });

  it('resolves a stale reclaim guard to exit 1 with no probes and both locks preserved', async () => {
    const fs = lockFs(lockJson(99999));
    const guard = lockJson(44444, { token: 'd'.repeat(32) });
    fs.file(`${dir}/lock.reclaim`, guard);
    const deps = fakeDeps({ fs, health: healthResponse(200, { status: 'ok' }), statfsResult: { bavail: 5000n, blocks: 10000n, bsize: 4096n } });
    deps.probeProcess = () => 'dead';
    let probes = 0;
    let webhooks = 0;
    deps.fetch = async (url) => {
      if (url.includes('/api/health')) { probes += 1; return healthResponse(200, { status: 'ok' }); }
      webhooks += 1;
      return webhookResponse(200);
    };
    const logLines = [];
    const exit = await main({ env: { ...BASE_ENV, SERVORA_ALERT_FAILURE_THRESHOLD: '1' }, deps, log: (entry) => logLines.push(JSON.stringify(entry)) });
    assert.equal(exit, 1);
    assert.equal(probes, 0);
    assert.equal(webhooks, 0);
    assert.equal(fs.readFileSync(`${dir}/lock.reclaim`, 'utf8'), guard);
    assert.ok(fs.entries.has(`${dir}/lock.lock`));
    assert.ok(logLines.some((line) => line.includes('"run":"reclaim-guard-stale"')));
    assert.ok(!logLines.some((line) => line.includes('at ')));
  });

  it('resolves an active reclaim guard to exit 2 with the guard preserved', async () => {
    const fs = lockFs(lockJson(99999));
    const guard = lockJson(44444, { token: 'd'.repeat(32) });
    fs.file(`${dir}/lock.reclaim`, guard);
    const deps = fakeDeps({ fs, health: healthResponse(200, { status: 'ok' }), statfsResult: { bavail: 5000n, blocks: 10000n, bsize: 4096n } });
    deps.probeProcess = (pid) => (pid === 99999 ? 'dead' : 'alive');
    let probes = 0;
    deps.fetch = async (url) => {
      if (url.includes('/api/health')) { probes += 1; return healthResponse(200, { status: 'ok' }); }
      return webhookResponse(200);
    };
    const exit = await main({ env: { ...BASE_ENV, SERVORA_ALERT_FAILURE_THRESHOLD: '1' }, deps, log: () => {} });
    assert.equal(exit, 2);
    assert.equal(probes, 0);
    assert.equal(fs.readFileSync(`${dir}/lock.reclaim`, 'utf8'), guard);
  });

  it('resolves an unknown reclaim guard liveness to exit 1 with the guard preserved', async () => {
    const fs = lockFs(lockJson(99999));
    const guard = lockJson(44444, { token: 'd'.repeat(32) });
    fs.file(`${dir}/lock.reclaim`, guard);
    const deps = fakeDeps({ fs, health: healthResponse(200, { status: 'ok' }), statfsResult: { bavail: 5000n, blocks: 10000n, bsize: 4096n } });
    deps.probeProcess = () => 'unknown';
    let probes = 0;
    deps.fetch = async (url) => {
      if (url.includes('/api/health')) { probes += 1; return healthResponse(200, { status: 'ok' }); }
      return webhookResponse(200);
    };
    const logLines = [];
    const exit = await main({ env: { ...BASE_ENV, SERVORA_ALERT_FAILURE_THRESHOLD: '1' }, deps, log: (entry) => logLines.push(JSON.stringify(entry)) });
    assert.equal(exit, 1);
    assert.equal(probes, 0);
    assert.equal(fs.readFileSync(`${dir}/lock.reclaim`, 'utf8'), guard);
    assert.ok(logLines.some((line) => line.includes('"run":"lock-error"') && line.includes('"errorCategory":"unknown"')));
  });

  it('never deletes another reclaimer guard during concurrent reclaim simulation', () => {
    const fs = lockFs(lockJson(99999));
    const guard = lockJson(55555, { token: 'e'.repeat(32) });
    fs.file(`${dir}/lock.reclaim`, guard);
    const deps = fakeDeps({ fs });
    deps.probeProcess = (pid) => (pid === 99999 ? 'dead' : 'alive');
    const result = acquireLock(config, deps);
    assert.equal(result.ok, false);
    assert.equal(fs.readFileSync(`${dir}/lock.reclaim`, 'utf8'), guard);
    assert.equal(fs.readFileSync(`${dir}/lock.lock`, 'utf8'), lockJson(99999));
  });

  it('uses and releases the reclaim guard during a normal stale reclaim', () => {
    const fs = lockFs(lockJson(99999));
    const deps = fakeDeps({ fs });
    deps.probeProcess = () => 'dead';
    const result = acquireLock(config, deps);
    assert.equal(result.ok, true);
    assert.equal(result.staleReclaimed, true);
    assert.ok(!fs.entries.has(`${dir}/lock.reclaim`));
    assert.ok(fs.entries.has(`${dir}/lock.lock`));
  });

  it('releases an acquired reclaim guard with a matching token', () => {
    const fs = lockFs(null);
    const deps = fakeDeps({ fs });
    const token = 'g'.repeat(32);
    fs.file(`${dir}/lock.reclaim`, JSON.stringify({ version: 1, pid: process.pid, createdAt: 1, ownerToken: token }));
    const release = releaseLock(config, deps, { ownerToken: token }, 'lock.reclaim');
    assert.equal(release.reason, 'ok');
    assert.ok(!fs.entries.has(`${dir}/lock.reclaim`));
  });

  it('does not unlink when the lock is replaced with a foreign inode after the read', () => {
    const fs = lockFs(null);
    const deps = fakeDeps({ fs });
    const acquired = acquireLock(config, deps);
    const realRead = fs.readFileSync;
    const foreign = lockJson(99999, { token: 'b'.repeat(32) });
    deps.readFile = (target, enc) => {
      const content = realRead(target, enc);
      if (String(target).endsWith('/lock.lock')) {
        fs.entries.set(String(target), fs.makeEntry('file', Buffer.from(foreign), 0o600));
      }
      return content;
    };
    const release = releaseLock(config, deps, { ownerToken: acquired.ownerToken });
    assert.equal(release.reason, 'replaced');
    assert.equal(fs.readFileSync(`${dir}/lock.lock`, 'utf8'), foreign);
  });

  it('fails closed when liveness is unknown instead of reclaiming', () => {
    const fs = lockFs(lockJson(99999));
    const deps = fakeDeps({ fs });
    deps.probeProcess = () => 'unknown';
    assert.throws(() => acquireLock(config, deps), (error) => {
      assert.equal(error.name, 'LockError');
      assert.equal(error.category, 'unknown');
      return true;
    });
    assert.ok(fs.entries.has(`${dir}/lock.lock`));
  });
});

// ---------------------------------------------------------------------------
// Payload and webhook delivery
// ---------------------------------------------------------------------------

describe('webhook delivery', () => {
  const config = loadConfig(BASE_ENV);

  it('builds a versioned vendor-neutral payload without secrets', () => {
    const payload = buildPayload({
      config, event: 'alert', check: 'health', severity: 'critical',
      summary: 'Application health failing', details: { consecutiveFailures: 3, httpStatus: 503 },
      now: 1_752_782_400_000,
    });
    assert.equal(payload.schemaVersion, 1);
    assert.equal(payload.application, 'Servora-Med');
    assert.equal(payload.instance, 'servora-med-test');
    assert.equal(payload.environment, 'test');
    assert.equal(payload.observedAt, new Date(1_752_782_400_000).toISOString());
    assert.equal(payload.details.consecutiveFailures, 3);
    const serialized = JSON.stringify(payload);
    assert.ok(!serialized.includes('hooks.example.com'));
    assert.ok(!serialized.includes('/var/lib'));
    assert.ok(!serialized.includes('token'));
  });

  it('accepts 2xx delivery', async () => {
    const captured = [];
    const deps = fakeDeps({ webhook: webhookResponse(200) });
    deps.fetch = async (url, options) => { captured.push(JSON.parse(options.body)); return webhookResponse(200); };
    const delivery = await deliverWebhook(config, { schemaVersion: 1 }, deps);
    assert.equal(delivery.ok, true);
    assert.equal(captured.length, 1);
  });

  it('fails on non-2xx delivery', async () => {
    const deps = fakeDeps({ webhook: webhookResponse(500) });
    const delivery = await deliverWebhook(config, { schemaVersion: 1 }, deps);
    assert.equal(delivery.ok, false);
    assert.equal(delivery.status, 500);
  });

  it('fails on redirect responses', async () => {
    const deps = fakeDeps({ webhook: webhookResponse(302) });
    const delivery = await deliverWebhook(config, { schemaVersion: 1 }, deps);
    assert.equal(delivery.ok, false);
  });

  it('fails on timeout', async () => {
    const deps = fakeDeps({ webhook: Object.assign(new Error('timeout'), { name: 'TimeoutError' }) });
    const delivery = await deliverWebhook(config, { schemaVersion: 1 }, deps);
    assert.equal(delivery.ok, false);
    assert.equal(delivery.errorCategory, 'timeout');
  });
});

// ---------------------------------------------------------------------------
// runMonitor orchestration
// ---------------------------------------------------------------------------

describe('runMonitor orchestration', () => {
  const env = BASE_ENV;
  const healthyDeps = () => {
    const fs = new FakeFs();
    fs.dir('/backups');
    fs.dir('/var/lib/servora-med-alerting');
    backupPair(fs, '/backups', '20260805T120000Z');
    const deps = fakeDeps({
      fs,
      health: healthResponse(200, { status: 'ok' }),
      statfsResult: { bavail: 5000n, blocks: 10000n, bsize: 4096n },
    });
    deps.fetch = async (url, options) => {
      if (url.includes('/api/health')) return healthResponse(200, { status: 'ok' });
      return webhookResponse(200);
    };
    return deps;
  };

  it('healthy run: no events, zero exit, state persisted', async () => {
    const deps = healthyDeps();
    const result = await runMonitor(loadConfig(env), deps);
    assert.equal(result.exitCode, 0);
    assert.equal(result.events.length, 0);
    assert.ok(deps.exists('/var/lib/servora-med-alerting/state.json'));
    const persisted = JSON.parse(deps.readFile('/var/lib/servora-med-alerting/state.json', 'utf8'));
    assert.equal(persisted.checks.health.consecutiveFailures, 0);
  });

  it('alerts after the third consecutive health failure and marks delivered', async () => {
    let failures = 0;
    const fs = new FakeFs();
    fs.dir('/backups');
    fs.dir('/var/lib/servora-med-alerting');
    backupPair(fs, '/backups', '20260805T120000Z');
    const deps = fakeDeps({
      fs,
      health: healthResponse(503, { status: 'unavailable' }),
      statfsResult: { bavail: 5000n, blocks: 10000n, bsize: 4096n },
    });
    const deliveries = [];
    deps.fetch = async (url, options) => {
      if (url.includes('/api/health')) return healthResponse(503, { status: 'unavailable' });
      deliveries.push(JSON.parse(options.body));
      return webhookResponse(200);
    };
    const config = loadConfig(env);
    for (let run = 1; run <= 3; run += 1) {
      const result = await runMonitor(config, deps);
      assert.equal(result.exitCode, 0);
      failures = result.state.checks.health.consecutiveFailures;
      assert.equal(failures, run);
      if (run < 3) assert.equal(result.events.length, 0);
    }
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].event, 'alert');
    assert.equal(deliveries[0].check, 'health');
    assert.equal(deliveries[0].details.consecutiveFailures, 3);
    const persisted = JSON.parse(deps.readFile('/var/lib/servora-med-alerting/state.json', 'utf8'));
    assert.equal(persisted.checks.health.alertActive, true);
  });

  it('respects cooldown and sends a reminder after it expires', async () => {
    let clock = 1_785_974_400_000;
    const fs = new FakeFs();
    fs.dir('/backups');
    fs.dir('/var/lib/servora-med-alerting');
    backupPair(fs, '/backups', '20260805T120000Z');
    const deps = fakeDeps({
      fs,
      health: healthResponse(503, { status: 'unavailable' }),
      statfsResult: { bavail: 5000n, blocks: 10000n, bsize: 4096n },
      nowMs: 1_785_974_400_000,
    });
    const deliveries = [];
    deps.fetch = async (url, options) => {
      if (url.includes('/api/health')) return healthResponse(503, { status: 'unavailable' });
      deliveries.push(JSON.parse(options.body));
      return webhookResponse(200);
    };
    deps.now = () => clock;
    const config = loadConfig(env);
    for (let run = 1; run <= 3; run += 1) {
      const result = await runMonitor(config, deps);
      assert.equal(result.exitCode, 0);
      clock += 60_000;
    }
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].event, 'alert');
    const active = JSON.parse(deps.readFile('/var/lib/servora-med-alerting/state.json', 'utf8'));
    assert.equal(active.checks.health.alertActive, true);
    clock += 60 * 60 * 1000;
    const after = await runMonitor(config, deps);
    assert.equal(after.events.length, 1);
    assert.equal(after.events[0].event, 'reminder');
  });

  it('sends exactly one recovery and then stays quiet', async () => {
    let healthOk = false;
    const fs = new FakeFs();
    fs.dir('/backups');
    fs.dir('/var/lib/servora-med-alerting');
    backupPair(fs, '/backups', '20260805T120000Z');
    const deps = fakeDeps({
      fs,
      health: healthResponse(503, { status: 'unavailable' }),
      statfsResult: { bavail: 5000n, blocks: 10000n, bsize: 4096n },
    });
    const deliveries = [];
    deps.fetch = async (url, options) => {
      if (url.includes('/api/health')) return healthOk ? healthResponse(200, { status: 'ok' }) : healthResponse(503, { status: 'unavailable' });
      deliveries.push(JSON.parse(options.body));
      return webhookResponse(200);
    };
    const config = loadConfig(env);
    for (let run = 1; run <= 3; run += 1) await runMonitor(config, deps);
    assert.equal(deliveries.length, 1);
    healthOk = true;
    const recovered = await runMonitor(config, deps);
    assert.equal(recovered.events.length, 1);
    assert.equal(recovered.events[0].event, 'recovery');
    const quiet = await runMonitor(config, deps);
    assert.equal(quiet.events.length, 0);
  });

  it('does not mark delivery on webhook failure and retries next run', async () => {
    let webhookDown = true;
    const fs = new FakeFs();
    fs.dir('/backups');
    fs.dir('/var/lib/servora-med-alerting');
    backupPair(fs, '/backups', '20260805T120000Z');
    const deps = fakeDeps({
      fs,
      health: healthResponse(503, { status: 'unavailable' }),
      statfsResult: { bavail: 5000n, blocks: 10000n, bsize: 4096n },
    });
    deps.fetch = async (url, options) => {
      if (url.includes('/api/health')) return healthResponse(503, { status: 'unavailable' });
      return webhookDown ? webhookResponse(500) : webhookResponse(200);
    };
    const config = loadConfig(env);
    for (let run = 1; run <= 3; run += 1) await runMonitor(config, deps);
    const failed = await runMonitor(config, deps);
    assert.equal(failed.exitCode, 3);
    const persisted = JSON.parse(deps.readFile('/var/lib/servora-med-alerting/state.json', 'utf8'));
    assert.equal(persisted.checks.health.alertActive, false);
    assert.equal(persisted.checks.health.lastDeliveredAt, null);
    webhookDown = false;
    const retried = await runMonitor(config, deps);
    assert.equal(retried.exitCode, 0);
    assert.equal(retried.events.length, 1);
    assert.equal(retried.events[0].event, 'alert');
    const after = JSON.parse(deps.readFile('/var/lib/servora-med-alerting/state.json', 'utf8'));
    assert.equal(after.checks.health.alertActive, true);
  });

  it('emits separate events per check transition in the same run', async () => {
    const fs = new FakeFs();
    fs.dir('/backups');
    fs.dir('/var/lib/servora-med-alerting');
    const deps = fakeDeps({
      fs,
      health: healthResponse(503, { status: 'unavailable' }),
      statfsResult: { bavail: 100n, blocks: 10000n, bsize: 4096n },
    });
    const deliveries = [];
    deps.fetch = async (url, options) => {
      if (url.includes('/api/health')) return healthResponse(503, { status: 'unavailable' });
      deliveries.push(JSON.parse(options.body));
      return webhookResponse(200);
    };
    const config = loadConfig({ ...env, SERVORA_ALERT_FAILURE_THRESHOLD: '1' });
    const result = await runMonitor(config, deps);
    assert.equal(result.exitCode, 0);
    const events = result.events.map((event) => event.check).sort();
    assert.deepEqual(events, ['backup', 'disk', 'health']);
    assert.equal(deliveries.length, 3);
    const kinds = deliveries.map((delivery) => `${delivery.check}:${delivery.event}`).sort();
    assert.deepEqual(kinds, ['backup:alert', 'disk:alert', 'health:alert']);
  });

  it('produces a monitor alert when the state file is corrupt', async () => {
    const fs = new FakeFs();
    fs.dir('/backups');
    fs.dir('/var/lib/servora-med-alerting');
    backupPair(fs, '/backups', '20260805T120000Z');
    fs.file('/var/lib/servora-med-alerting/state.json', 'corrupt{');
    const deps = fakeDeps({
      fs,
      health: healthResponse(200, { status: 'ok' }),
      statfsResult: { bavail: 5000n, blocks: 10000n, bsize: 4096n },
    });
    const deliveries = [];
    deps.fetch = async (url, options) => {
      if (url.includes('/api/health')) return healthResponse(200, { status: 'ok' });
      deliveries.push(JSON.parse(options.body));
      return webhookResponse(200);
    };
    const result = await runMonitor(loadConfig(env), deps);
    assert.equal(result.exitCode, 0);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].event, 'monitor');
  });
});


// ---------------------------------------------------------------------------
// Partial multi-event delivery
// ---------------------------------------------------------------------------

describe('partial delivery persistence', () => {
  const env = { ...BASE_ENV, SERVORA_ALERT_FAILURE_THRESHOLD: '1' };

  function buildDeps({ healthMode = 'fail', backupResponse = 'ok', fs = null, statfsResult = null } = {}) {
    const realFs = fs ?? new FakeFs();
    realFs.dir('/backups');
    realFs.dir('/var/lib/servora-med-alerting');
    if (backupResponse !== 'absent') backupPair(realFs, '/backups', '20260805T120000Z');
    const healthProbe = healthMode === 'ok'
      ? healthResponse(200, { status: 'ok' })
      : healthResponse(503, { status: 'unavailable' });
    const deps = fakeDeps({
      fs: realFs,
      health: healthProbe,
      statfsResult: statfsResult ?? { bavail: 5000n, blocks: 10000n, bsize: 4096n },
    });
    return deps;
  }

  function readState(deps) {
    return JSON.parse(deps.readFile('/var/lib/servora-med-alerting/state.json', 'utf8'));
  }

  it('persists a successfully delivered first event when a later delivery fails, and retries only the failed one', async () => {
    const fs = new FakeFs();
    const deps = buildDeps({ healthMode: 'fail', backupResponse: 'fail', fs });
    // backup alert must also be pending at threshold 1: no backup dir content? backup fails because no pair -> use fresh pair + tamper
    fs.file('/backups/servora-med-20260805T120000Z.dump', 'tampered');
    fs.file('/backups/servora-med-20260805T120000Z.dump.sha256', `${'0'.repeat(64)}  servora-med-20260805T120000Z.dump\n`);
    deps.fetch = async (url, options) => {
      if (url.includes('/api/health')) return healthResponse(503, { status: 'unavailable' });
      const payload = JSON.parse(options.body);
      if (payload.check === 'health') return webhookResponse(200);
      return webhookResponse(500);
    };
    const config = loadConfig(env);

    const first = await runMonitor(config, deps);
    assert.equal(first.exitCode, 3);
    const afterFirst = readState(deps);
    assert.equal(afterFirst.checks.health.alertActive, true);
    assert.equal(typeof afterFirst.checks.health.lastDeliveredAt, 'number');
    assert.equal(afterFirst.checks.backup.alertActive, false);
    assert.equal(afterFirst.checks.backup.lastDeliveredAt, null);
    assert.equal(afterFirst.checks.backup.consecutiveFailures, 1);

    deps.fetch = async (url, options) => {
      if (url.includes('/api/health')) return healthResponse(503, { status: 'unavailable' });
      return webhookResponse(200);
    };
    const second = await runMonitor(config, deps);
    assert.equal(second.exitCode, 0);
    const afterSecond = readState(deps);
    assert.equal(afterSecond.checks.health.alertActive, true);
    assert.equal(afterSecond.checks.backup.alertActive, true);
    assert.equal(afterSecond.checks.health.consecutiveFailures, 2);
    assert.equal(afterSecond.checks.backup.consecutiveFailures, 2);
  });

  it('delivers the retried backup alert exactly once without duplicating the earlier health alert', async () => {
    const fs = new FakeFs();
    const deps = buildDeps({ fs });
    fs.file('/backups/servora-med-20260805T120000Z.dump', 'tampered');
    fs.file('/backups/servora-med-20260805T120000Z.dump.sha256', `${'0'.repeat(64)}  servora-med-20260805T120000Z.dump\n`);
    const deliveries = [];
    deps.fetch = async (url, options) => {
      if (url.includes('/api/health')) return healthResponse(503, { status: 'unavailable' });
      const payload = JSON.parse(options.body);
      if (payload.check === 'health') {
        deliveries.push(payload);
        return webhookResponse(200);
      }
      return webhookResponse(500);
    };
    const config = loadConfig(env);
    const first = await runMonitor(config, deps);
    assert.equal(first.exitCode, 3);
    const healthDeliveriesAfterFirst = deliveries.filter((d) => d.check === 'health').length;
    assert.equal(healthDeliveriesAfterFirst, 1);
    deps.fetch = async (url, options) => {
      if (url.includes('/api/health')) return healthResponse(503, { status: 'unavailable' });
      const payload = JSON.parse(options.body);
      deliveries.push(payload);
      return webhookResponse(200);
    };
    const second = await runMonitor(config, deps);
    assert.equal(second.exitCode, 0);
    const healthAlerts = deliveries.filter((d) => d.check === 'health' && d.event === 'alert').length;
    const backupAlerts = deliveries.filter((d) => d.check === 'backup' && d.event === 'alert').length;
    assert.equal(healthAlerts, 1);
    assert.equal(backupAlerts, 1);
  });

  it('persists a delivered reminder across a later delivery failure without duplicate reminder on retry', async () => {
    const now = 1_785_974_400_000;
    const fs = new FakeFs();
    fs.dir('/backups');
    fs.dir('/var/lib/servora-med-alerting');
    const active = {
      version: 1,
      checks: {
        health: { consecutiveFailures: 3, alertActive: true, lastAlertAt: now - 3600e3, lastReminderAt: null, lastRecoveryAt: null, lastDeliveredAt: now - 3600e3 },
        backup: { consecutiveFailures: 0, alertActive: false, lastAlertAt: null, lastReminderAt: null, lastRecoveryAt: null, lastDeliveredAt: null },
        disk: { consecutiveFailures: 0, alertActive: false, lastAlertAt: null, lastReminderAt: null, lastRecoveryAt: null, lastDeliveredAt: null },
      },
    };
    fs.file('/var/lib/servora-med-alerting/state.json', JSON.stringify(active));
    const deps = fakeDeps({
      fs,
      health: healthResponse(503, { status: 'unavailable' }),
      statfsResult: { bavail: 5000n, blocks: 10000n, bsize: 4096n },
      nowMs: now + 61 * 60e3,
    });
    deps.fetch = async (url, options) => {
      if (url.includes('/api/health')) return healthResponse(503, { status: 'unavailable' });
      const payload = JSON.parse(options.body);
      if (payload.check === 'health') return webhookResponse(200);
      return webhookResponse(500);
    };
    const config = loadConfig(env);
    const first = await runMonitor(config, deps);
    assert.equal(first.exitCode, 3);
    const afterFirst = readState(deps);
    assert.equal(typeof afterFirst.checks.health.lastReminderAt, 'number');
    assert.equal(afterFirst.checks.health.alertActive, true);
    assert.equal(afterFirst.checks.backup.alertActive, false);
    // Second run within the new reminder cooldown: no duplicate reminder, backup retried.
    deps.fetch = async (url, options) => {
      if (url.includes('/api/health')) return healthResponse(503, { status: 'unavailable' });
      return webhookResponse(200);
    };
    const second = await runMonitor(config, deps);
    assert.equal(second.exitCode, 0);
    const reminders = second.events.filter((event) => event.check === 'health' && event.event === 'reminder').length;
    assert.equal(reminders, 0);
    const backupAlert = second.events.find((event) => event.check === 'backup' && event.event === 'alert');
    assert.ok(backupAlert);
  });

  it('persists a delivered recovery across a later delivery failure without duplicate recovery on retry', async () => {
    const now = 1_785_974_400_000;
    const fs = new FakeFs();
    fs.dir('/backups');
    fs.dir('/var/lib/servora-med-alerting');
    const active = {
      version: 1,
      checks: {
        health: { consecutiveFailures: 3, alertActive: true, lastAlertAt: now - 60e3, lastReminderAt: null, lastRecoveryAt: null, lastDeliveredAt: now - 60e3 },
        backup: { consecutiveFailures: 0, alertActive: false, lastAlertAt: null, lastReminderAt: null, lastRecoveryAt: null, lastDeliveredAt: null },
        disk: { consecutiveFailures: 0, alertActive: false, lastAlertAt: null, lastReminderAt: null, lastRecoveryAt: null, lastDeliveredAt: null },
      },
    };
    fs.file('/var/lib/servora-med-alerting/state.json', JSON.stringify(active));
    const deps = fakeDeps({
      fs,
      health: healthResponse(200, { status: 'ok' }),
      statfsResult: { bavail: 5000n, blocks: 10000n, bsize: 4096n },
      nowMs: now,
    });
    deps.fetch = async (url, options) => {
      if (url.includes('/api/health')) return healthResponse(200, { status: 'ok' });
      const payload = JSON.parse(options.body);
      if (payload.check === 'health') return webhookResponse(200);
      return webhookResponse(500);
    };
    const config = loadConfig(env);
    const first = await runMonitor(config, deps);
    assert.equal(first.exitCode, 3);
    const afterFirst = readState(deps);
    assert.equal(afterFirst.checks.health.alertActive, false);
    assert.equal(typeof afterFirst.checks.health.lastRecoveryAt, 'number');
    deps.fetch = async (url, options) => {
      if (url.includes('/api/health')) return healthResponse(200, { status: 'ok' });
      return webhookResponse(200);
    };
    const second = await runMonitor(config, deps);
    assert.equal(second.exitCode, 0);
    const recoveries = second.events.filter((event) => event.check === 'health' && event.event === 'recovery').length;
    assert.equal(recoveries, 0);
  });

  it('advances no-event counters for all checks before any delivery failure', async () => {
    const fs = new FakeFs();
    fs.dir('/backups');
    fs.dir('/var/lib/servora-med-alerting');
    backupPair(fs, '/backups', '20260805T120000Z');
    const deps = fakeDeps({
      fs,
      health: healthResponse(200, { status: 'ok' }),
      statfsResult: { bavail: 5000n, blocks: 10000n, bsize: 4096n },
    });
    deps.fetch = async (url, options) => {
      if (url.includes('/api/health')) return healthResponse(200, { status: 'ok' });
      const payload = JSON.parse(options.body);
      if (payload.check === 'health') return webhookResponse(200);
      return webhookResponse(500);
    };
    const config = loadConfig({ ...env, SERVORA_ALERT_DISK_MIN_FREE_PERCENT: '99.9' });
    const first = await runMonitor(config, deps);
    assert.equal(first.exitCode, 3);
    const state = readState(deps);
    assert.equal(state.checks.disk.consecutiveFailures, 1);
    assert.equal(state.checks.disk.alertActive, false);
    assert.equal(state.checks.health.consecutiveFailures, 0);
    assert.equal(state.checks.backup.consecutiveFailures, 0);
  });

  it('handles a state write failure safely with a non-zero exit', async () => {
    const fs = new FakeFs();
    fs.dir('/backups');
    fs.dir('/var/lib/servora-med-alerting');
    backupPair(fs, '/backups', '20260805T120000Z');
    const deps = fakeDeps({
      fs,
      health: healthResponse(503, { status: 'unavailable' }),
      statfsResult: { bavail: 5000n, blocks: 10000n, bsize: 4096n },
    });
    deps.fetch = async (url, options) => {
      if (url.includes('/api/health')) return healthResponse(503, { status: 'unavailable' });
      return webhookResponse(200);
    };
    const realWrite = deps.writeFile;
    deps.writeFile = (target, content, options) => {
      if (target.includes('state.json')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return realWrite(target, content, options);
    };
    const result = await runMonitor(loadConfig(env), deps);
    assert.equal(result.exitCode, 1);
    assert.equal(result.stateWriteFailed, true);
  });
});


// ---------------------------------------------------------------------------
// Disk path privacy
// ---------------------------------------------------------------------------

describe('disk path privacy', () => {
  const PRIVATE_PATH = '/Users/private/servora-data';
  const env = { ...BASE_ENV, SERVORA_ALERT_DISK_PATH: PRIVATE_PATH, SERVORA_ALERT_FAILURE_THRESHOLD: '1' };

  it('validates the disk label config', () => {
    const config = loadConfig(BASE_ENV);
    assert.equal(config.diskLabel, 'disk-target');
    const custom = loadConfig({ ...BASE_ENV, SERVORA_ALERT_DISK_LABEL: 'data-vol' });
    assert.equal(custom.diskLabel, 'data-vol');
    assert.throws(() => loadConfig({ ...BASE_ENV, SERVORA_ALERT_DISK_LABEL: '/data' }), ConfigError);
    assert.throws(() => loadConfig({ ...BASE_ENV, SERVORA_ALERT_DISK_LABEL: 'data vol' }), ConfigError);
    assert.throws(() => loadConfig({ ...BASE_ENV, SERVORA_ALERT_DISK_LABEL: 'data;rm' }), ConfigError);
    assert.throws(() => loadConfig({ ...BASE_ENV, SERVORA_ALERT_DISK_LABEL: BASE_ENV.SERVORA_ALERT_DISK_PATH }), ConfigError);
  });

  it('keeps the absolute disk path out of alert and recovery payloads delivered by runMonitor', async () => {
    const fs = new FakeFs();
    fs.dir('/backups');
    fs.dir('/var/lib/servora-med-alerting');
    backupPair(fs, '/backups', '20260805T120000Z');
    const payloads = [];
    const deps = fakeDeps({
      fs,
      health: healthResponse(200, { status: 'ok' }),
      statfsResult: { bavail: 100n, blocks: 10000n, bsize: 4096n },
    });
    deps.fetch = async (url, options) => {
      if (url.includes('/api/health')) return healthResponse(200, { status: 'ok' });
      const payload = JSON.parse(options.body);
      payloads.push(payload);
      return webhookResponse(200);
    };
    const config = loadConfig(env);
    const alertRun = await runMonitor(config, deps);
    assert.equal(alertRun.exitCode, 0);
    const diskAlert = payloads.find((p) => p.check === 'disk' && p.event === 'alert');
    assert.ok(diskAlert);
    assert.equal(diskAlert.details.target, 'disk-target');
    assert.ok(!JSON.stringify(diskAlert).includes(PRIVATE_PATH));
    assert.ok(!JSON.stringify(diskAlert).includes('/Users'));
    // recovery payload
    const healthyDeps = fakeDeps({
      fs: new FakeFs(),
      health: healthResponse(200, { status: 'ok' }),
      statfsResult: { bavail: 5000n, blocks: 10000n, bsize: 4096n },
    });
    healthyDeps.readdir = fs.readdirSync;
    healthyDeps.lstat = fs.lstatSync;
    healthyDeps.readFile = fs.readFileSync;
    healthyDeps.writeFile = fs.writeFileSync;
    healthyDeps.rename = fs.renameSync;
    healthyDeps.unlink = fs.unlinkSync;
    healthyDeps.mkdir = fs.mkdirSync;
    healthyDeps.chmod = fs.chmodSync;
    healthyDeps.exists = fs.existsSync;
    healthyDeps.hashFile = deps.hashFile;
    healthyDeps.now = deps.now;
    healthyDeps.fetch = async (url, options) => {
      if (url.includes('/api/health')) return healthResponse(200, { status: 'ok' });
      const payload = JSON.parse(options.body);
      payloads.push(payload);
      return webhookResponse(200);
    };
    const recoveryRun = await runMonitor(config, healthyDeps);
    assert.equal(recoveryRun.exitCode, 0);
    const diskRecovery = payloads.find((p) => p.check === 'disk' && p.event === 'recovery');
    assert.ok(diskRecovery);
    assert.ok(!JSON.stringify(diskRecovery).includes(PRIVATE_PATH));
  });

  it('keeps the absolute disk path out of persisted state', async () => {
    const fs = new FakeFs();
    fs.dir('/backups');
    fs.dir('/var/lib/servora-med-alerting');
    backupPair(fs, '/backups', '20260805T120000Z');
    const deps = fakeDeps({
      fs,
      health: healthResponse(200, { status: 'ok' }),
      statfsResult: { bavail: 100n, blocks: 10000n, bsize: 4096n },
    });
    deps.fetch = async (url, options) => {
      if (url.includes('/api/health')) return healthResponse(200, { status: 'ok' });
      return webhookResponse(200);
    };
    const result = await runMonitor(loadConfig(env), deps);
    assert.equal(result.exitCode, 0);
    const stateText = deps.readFile('/var/lib/servora-med-alerting/state.json', 'utf8');
    assert.ok(!stateText.includes(PRIVATE_PATH));
  });

  it('keeps the absolute disk path out of monitor logs', async () => {
    const fs = new FakeFs();
    fs.dir('/backups');
    fs.dir('/var/lib/servora-med-alerting');
    backupPair(fs, '/backups', '20260805T120000Z');
    const deps = fakeDeps({
      fs,
      health: healthResponse(200, { status: 'ok' }),
      statfsResult: { bavail: 100n, blocks: 10000n, bsize: 4096n },
    });
    deps.fetch = async (url, options) => {
      if (url.includes('/api/health')) return healthResponse(200, { status: 'ok' });
      return webhookResponse(200);
    };
    const logLines = [];
    const exit = await main({ env, deps, log: (entry) => logLines.push(JSON.stringify(entry)) });
    assert.equal(exit, 0);
    const allLogs = logLines.join('\n');
    assert.ok(!allLogs.includes(PRIVATE_PATH));
    assert.ok(!allLogs.includes('/Users'));
  });
});


// ---------------------------------------------------------------------------
// R2 — recovery commit-on-delivery and pending monitor incident
// ---------------------------------------------------------------------------

describe('recovery commit-on-delivery', () => {
  const env = { ...BASE_ENV, SERVORA_ALERT_FAILURE_THRESHOLD: '1' };
  const NOW = 1_785_974_400_000;

  function seedActiveState(fs, checkName) {
    fs.dir('/backups');
    fs.dir('/var/lib/servora-med-alerting');
    backupPair(fs, '/backups', '20260805T120000Z');
    const check = (failures, active) => ({
      consecutiveFailures: failures, alertActive: active,
      lastAlertAt: active ? NOW - 60e3 : null, lastReminderAt: null, lastRecoveryAt: null,
      lastDeliveredAt: active ? NOW - 60e3 : null,
    });
    const checks = {
      health: check(0, false),
      backup: check(0, false),
      disk: check(0, false),
    };
    checks[checkName] = check(3, true);
    fs.file('/var/lib/servora-med-alerting/state.json', JSON.stringify({ version: 1, checks }));
  }

  function readState(deps) {
    return JSON.parse(deps.readFile('/var/lib/servora-med-alerting/state.json', 'utf8'));
  }

  it('keeps a failed health recovery active and retryable', async () => {
    const fs = new FakeFs();
    seedActiveState(fs, 'health');
    const deps = fakeDeps({
      fs,
      health: healthResponse(200, { status: 'ok' }),
      statfsResult: { bavail: 5000n, blocks: 10000n, bsize: 4096n },
      nowMs: NOW,
    });
    deps.fetch = async (url, options) => {
      if (url.includes('/api/health')) return healthResponse(200, { status: 'ok' });
      const payload = JSON.parse(options.body);
      if (payload.check === 'health') return webhookResponse(500);
      return webhookResponse(200);
    };
    const config = loadConfig(env);
    const first = await runMonitor(config, deps);
    assert.equal(first.exitCode, 3);
    const state = readState(deps);
    assert.equal(state.checks.health.alertActive, true);
    assert.equal(state.checks.health.lastRecoveryAt, null);
    assert.equal(state.checks.health.lastDeliveredAt, NOW - 60e3);
    assert.equal(first.events.length, 0);
    deps.fetch = async (url, options) => {
      if (url.includes('/api/health')) return healthResponse(200, { status: 'ok' });
      return webhookResponse(200);
    };
    const second = await runMonitor(config, deps);
    assert.equal(second.exitCode, 0);
    const recoveries = second.events.filter((event) => event.check === 'health' && event.event === 'recovery').length;
    assert.equal(recoveries, 1);
    const closed = readState(deps);
    assert.equal(closed.checks.health.alertActive, false);
    assert.equal(typeof closed.checks.health.lastRecoveryAt, 'number');
    const third = await runMonitor(config, deps);
    const recoveriesAfter = third.events.filter((event) => event.check === 'health' && event.event === 'recovery').length;
    assert.equal(recoveriesAfter, 0);
  });

  it('keeps a failed backup recovery active and retryable', async () => {
    const fs = new FakeFs();
    seedActiveState(fs, 'backup');
    const deps = fakeDeps({
      fs,
      health: healthResponse(200, { status: 'ok' }),
      statfsResult: { bavail: 5000n, blocks: 10000n, bsize: 4096n },
      nowMs: NOW,
    });
    deps.fetch = async (url, options) => {
      if (url.includes('/api/health')) return healthResponse(200, { status: 'ok' });
      const payload = JSON.parse(options.body);
      if (payload.check === 'backup') return webhookResponse(500);
      return webhookResponse(200);
    };
    const config = loadConfig(env);
    const first = await runMonitor(config, deps);
    assert.equal(first.exitCode, 3);
    const state = readState(deps);
    assert.equal(state.checks.backup.alertActive, true);
    assert.equal(state.checks.backup.lastRecoveryAt, null);
    deps.fetch = async (url, options) => {
      if (url.includes('/api/health')) return healthResponse(200, { status: 'ok' });
      return webhookResponse(200);
    };
    const second = await runMonitor(config, deps);
    assert.equal(second.exitCode, 0);
    const recoveries = second.events.filter((event) => event.check === 'backup' && event.event === 'recovery').length;
    assert.equal(recoveries, 1);
    const third = await runMonitor(config, deps);
    assert.equal(third.events.filter((event) => event.check === 'backup' && event.event === 'recovery').length, 0);
  });

  it('keeps a failed disk recovery active and retryable', async () => {
    const fs = new FakeFs();
    seedActiveState(fs, 'disk');
    const deps = fakeDeps({
      fs,
      health: healthResponse(200, { status: 'ok' }),
      statfsResult: { bavail: 5000n, blocks: 10000n, bsize: 4096n },
      nowMs: NOW,
    });
    deps.fetch = async (url, options) => {
      if (url.includes('/api/health')) return healthResponse(200, { status: 'ok' });
      const payload = JSON.parse(options.body);
      if (payload.check === 'disk') return webhookResponse(500);
      return webhookResponse(200);
    };
    const config = loadConfig(env);
    const first = await runMonitor(config, deps);
    assert.equal(first.exitCode, 3);
    const state = readState(deps);
    assert.equal(state.checks.disk.alertActive, true);
    deps.fetch = async (url, options) => {
      if (url.includes('/api/health')) return healthResponse(200, { status: 'ok' });
      return webhookResponse(200);
    };
    const second = await runMonitor(config, deps);
    assert.equal(second.exitCode, 0);
    assert.equal(second.events.filter((event) => event.check === 'disk' && event.event === 'recovery').length, 1);
    const third = await runMonitor(config, deps);
    assert.equal(third.events.filter((event) => event.check === 'disk' && event.event === 'recovery').length, 0);
  });

  it('preserves an earlier delivered alert when a later recovery delivery fails', async () => {
    const fs = new FakeFs();
    seedActiveState(fs, 'backup');
    const deps = fakeDeps({
      fs,
      health: healthResponse(503, { status: 'unavailable' }),
      statfsResult: { bavail: 5000n, blocks: 10000n, bsize: 4096n },
      nowMs: NOW,
    });
    const deliveries = [];
    deps.fetch = async (url, options) => {
      if (url.includes('/api/health')) return healthResponse(503, { status: 'unavailable' });
      const payload = JSON.parse(options.body);
      deliveries.push(payload);
      if (payload.check === 'health') return webhookResponse(200);
      return webhookResponse(500);
    };
    const config = loadConfig(env);
    const first = await runMonitor(config, deps);
    assert.equal(first.exitCode, 3);
    const state = readState(deps);
    assert.equal(state.checks.health.alertActive, true);
    assert.equal(state.checks.backup.alertActive, true);
    assert.equal(state.checks.backup.lastRecoveryAt, null);
    deps.fetch = async (url, options) => {
      if (url.includes('/api/health')) return healthResponse(503, { status: 'unavailable' });
      return webhookResponse(200);
    };
    const second = await runMonitor(config, deps);
    assert.equal(second.exitCode, 0);
    const healthAlerts = deliveries.filter((d) => d.check === 'health' && d.event === 'alert').length;
    const backupRecoveries = deliveries.filter((d) => d.check === 'backup' && d.event === 'recovery').length;
    assert.equal(healthAlerts, 1);
    assert.equal(backupRecoveries, 1);
  });

  it('reports a state write failure after a successful recovery delivery as non-zero', async () => {
    const fs = new FakeFs();
    seedActiveState(fs, 'health');
    const deps = fakeDeps({
      fs,
      health: healthResponse(200, { status: 'ok' }),
      statfsResult: { bavail: 5000n, blocks: 10000n, bsize: 4096n },
      nowMs: NOW,
    });
    deps.fetch = async (url, options) => {
      if (url.includes('/api/health')) return healthResponse(200, { status: 'ok' });
      return webhookResponse(200);
    };
    const realWrite = deps.writeFile;
    deps.writeFile = (target, content, options) => {
      if (target.includes('state.json')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return realWrite(target, content, options);
    };
    const result = await runMonitor(loadConfig(env), deps);
    assert.equal(result.exitCode, 1);
    assert.equal(result.stateWriteFailed, true);
  });
});

describe('pending monitor incident', () => {
  const env = { ...BASE_ENV, SERVORA_ALERT_FAILURE_THRESHOLD: '1' };
  const NOW = 1_785_974_400_000;

  function corruptStateDeps({ monitorStatus = 200, healthStatus = 200, healthProbe = 'ok', statfs = null }) {
    const fs = new FakeFs();
    fs.dir('/backups');
    fs.dir('/var/lib/servora-med-alerting');
    backupPair(fs, '/backups', '20260805T120000Z');
    fs.file('/var/lib/servora-med-alerting/state.json', 'corrupt{not-json');
    const deps = fakeDeps({
      fs,
      health: healthProbe === 'fail'
        ? healthResponse(503, { status: 'unavailable' })
        : healthResponse(200, { status: 'ok' }),
      statfsResult: statfs ?? { bavail: 5000n, blocks: 10000n, bsize: 4096n },
      nowMs: NOW,
    });
    deps.fetch = async (url, options) => {
      if (url.includes('/api/health')) {
        return healthProbe === 'fail'
          ? healthResponse(503, { status: 'unavailable' })
          : healthResponse(200, { status: 'ok' });
      }
      const payload = JSON.parse(options.body);
      if (payload.check === 'monitor') return webhookResponse(monitorStatus);
      if (payload.check === 'health') return webhookResponse(healthStatus);
      return webhookResponse(200);
    };
    deps.__fs = fs;
    return deps;
  }

  function readState(deps) {
    return JSON.parse(deps.readFile('/var/lib/servora-med-alerting/state.json', 'utf8'));
  }

  it('persists a pending monitor incident when the monitor webhook fails', async () => {
    const deps = corruptStateDeps({ monitorStatus: 500 });
    const first = await runMonitor(loadConfig(env), deps);
    assert.equal(first.exitCode, 3);
    const state = readState(deps);
    assert.equal(state.monitor.pendingIncident.kind, 'state-corrupt');
    assert.equal(typeof state.monitor.pendingIncident.detectedAt, 'number');
    assert.ok(Array.from(deps.__fs.entries.keys()).some((key) => key.includes('state.json.corrupt-')));
  });

  it('retries the monitor event on the next run exactly once and clears the pending incident', async () => {
    const deps = corruptStateDeps({ monitorStatus: 500 });
    const config = loadConfig(env);
    await runMonitor(config, deps);
    deps.fetch = async (url, options) => {
      if (url.includes('/api/health')) return healthResponse(200, { status: 'ok' });
      const payload = JSON.parse(options.body);
      if (payload.check === 'monitor') return webhookResponse(200);
      return webhookResponse(200);
    };
    const second = await runMonitor(config, deps);
    assert.equal(second.exitCode, 0);
    const monitorEvents = second.events.filter((event) => event.check === 'monitor').length;
    assert.equal(monitorEvents, 1);
    const state = readState(deps);
    assert.equal(state.monitor.pendingIncident, null);
    const third = await runMonitor(config, deps);
    assert.equal(third.events.filter((event) => event.check === 'monitor').length, 0);
  });

  it('does not duplicate the monitor event when a later check delivery fails', async () => {
    const deps = corruptStateDeps({ monitorStatus: 200, healthStatus: 500, healthProbe: 'fail' });
    const config = loadConfig(env);
    const first = await runMonitor(config, deps);
    assert.equal(first.exitCode, 3);
    const state = readState(deps);
    assert.equal(state.monitor.pendingIncident, null);
    deps.fetch = async (url, options) => {
      if (url.includes('/api/health')) return healthResponse(503, { status: 'unavailable' });
      return webhookResponse(200);
    };
    const second = await runMonitor(config, deps);
    assert.equal(second.exitCode, 0);
    assert.equal(second.events.filter((event) => event.check === 'monitor').length, 0);
    assert.equal(second.events.filter((event) => event.check === 'health' && event.event === 'alert').length, 1);
  });

  it('loads legacy version-1 states without a monitor field safely', async () => {
    const fs = new FakeFs();
    fs.dir('/var/lib/servora-med-alerting');
    fs.file('/var/lib/servora-med-alerting/state.json', JSON.stringify({ version: 1, checks: createDefaultState().checks }));
    const config = loadConfig(env);
    const { state, monitorEvent } = await loadState(config, fakeDeps({ fs }));
    assert.equal(state.monitor.pendingIncident, null);
    assert.equal(monitorEvent, null);
  });

  it('sanitizes pending monitor incidents safely', () => {
    const base = createDefaultState();
    const checks = base.checks;
    const withUnknown = sanitizeState({ version: 1, monitor: { pendingIncident: { kind: 'mystery', detectedAt: 1 } }, checks });
    assert.equal(withUnknown.monitor.pendingIncident, null);
    const withGarbage = sanitizeState({ version: 1, monitor: { pendingIncident: 'garbage' }, checks });
    assert.equal(withGarbage.monitor.pendingIncident, null);
    const withValid = sanitizeState({ version: 1, monitor: { pendingIncident: { kind: 'state-corrupt', detectedAt: 123 } }, checks });
    assert.deepEqual(withValid.monitor.pendingIncident, { kind: 'state-corrupt', detectedAt: 123 });
    const serialized = JSON.stringify(withValid);
    assert.ok(!serialized.includes('secret'));
  });
});




// ---------------------------------------------------------------------------
// R3 — state bootstrap and lock safety
// ---------------------------------------------------------------------------

describe('state bootstrap', () => {
  const env = { ...BASE_ENV, SERVORA_ALERT_FAILURE_THRESHOLD: '1' };

  function corruptFs() {
    const fs = new FakeFs();
    fs.dir('/backups');
    fs.dir('/var/lib/servora-med-alerting');
    backupPair(fs, '/backups', '20260805T120000Z');
    fs.file('/var/lib/servora-med-alerting/state.json', 'corrupt{not-json');
    return fs;
  }

  function instrumentedDeps(fs) {
    const order = [];
    const deps = fakeDeps({
      fs,
      health: healthResponse(200, { status: 'ok' }),
      statfsResult: { bavail: 5000n, blocks: 10000n, bsize: 4096n },
    });
    const realWrite = deps.writeFile;
    deps.writeFile = (target, content, options) => {
      if (target.includes('state.json')) order.push('state-write');
      return realWrite(target, content, options);
    };
    const realHash = deps.hashFile;
    deps.hashFile = (filePath) => { order.push('hash'); return realHash(filePath); };
    const realStatfs = deps.statfs;
    deps.statfs = (target, options) => { order.push('statfs'); return realStatfs(target, options); };
    deps.fetch = async (url, options) => {
      if (url.includes('/api/health')) { order.push('probe-health'); return healthResponse(200, { status: 'ok' }); }
      order.push('webhook');
      return webhookResponse(200);
    };
    deps.order = order;
    return deps;
  }

  it('persists a newly detected corrupt incident before any probe or webhook', async () => {
    const fs = corruptFs();
    const deps = instrumentedDeps(fs);
    const result = await runMonitor(loadConfig(env), deps);
    assert.equal(result.exitCode, 0);
    assert.equal(deps.order[0], 'state-write');
    const writeIndex = deps.order.indexOf('state-write');
    const probeIndex = deps.order.indexOf('probe-health');
    const webhookIndex = deps.order.indexOf('webhook');
    const hashIndex = deps.order.indexOf('hash');
    const statfsIndex = deps.order.indexOf('statfs');
    assert.ok(writeIndex < probeIndex, `state-write (${writeIndex}) must precede probe-health (${probeIndex})`);
    assert.ok(writeIndex < webhookIndex);
    assert.ok(writeIndex < hashIndex);
    assert.ok(writeIndex < statfsIndex);
  });

  it('retries a persisted incident after a crash between the initial persist and the probes', async () => {
    const fs = corruptFs();
    let nowCalls = 0;
    const deps = fakeDeps({
      fs,
      health: healthResponse(200, { status: 'ok' }),
      statfsResult: { bavail: 5000n, blocks: 10000n, bsize: 4096n },
    });
    deps.now = () => {
      nowCalls += 1;
      if (nowCalls === 5) throw new Error('simulated crash after initial persist');
      return 1_785_974_400_000;
    };
    deps.fetch = async (url, options) => {
      if (url.includes('/api/health')) return healthResponse(200, { status: 'ok' });
      return webhookResponse(200);
    };
    const config = loadConfig(env);
    await assert.rejects(() => runMonitor(config, deps));
    const pending = JSON.parse(fs.readFileSync('/var/lib/servora-med-alerting/state.json', 'utf8'));
    assert.equal(pending.monitor.pendingIncident.kind, 'state-corrupt');
    const fresh = fakeDeps({
      fs,
      health: healthResponse(200, { status: 'ok' }),
      statfsResult: { bavail: 5000n, blocks: 10000n, bsize: 4096n },
    });
    fresh.fetch = async (url, options) => {
      if (url.includes('/api/health')) return healthResponse(200, { status: 'ok' });
      return webhookResponse(200);
    };
    const second = await runMonitor(config, fresh);
    assert.equal(second.exitCode, 0);
    assert.equal(second.events.filter((event) => event.check === 'monitor').length, 1);
  });

  it('fails closed with no external work when the initial pending persist fails', async () => {
    const fs = corruptFs();
    const deps = instrumentedDeps(fs);
    const realWrite = deps.writeFile;
    deps.writeFile = (target, content, options) => {
      if (target.includes('state.json')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return realWrite(target, content, options);
    };
    const result = await runMonitor(loadConfig(env), deps);
    assert.equal(result.exitCode, 1);
    assert.equal(result.stateWriteFailed, true);
    assert.ok(!deps.order.includes('probe-health'));
    assert.ok(!deps.order.includes('hash'));
    assert.ok(!deps.order.includes('statfs'));
    assert.ok(!deps.order.includes('webhook'));
  });

  it('treats missing state as a default first run', async () => {
    const fs = new FakeFs();
    fs.dir('/backups');
    fs.dir('/var/lib/servora-med-alerting');
    backupPair(fs, '/backups', '20260805T120000Z');
    const config = loadConfig(env);
    const { state, monitorEvent, requiresInitialPersist } = await loadState(config, fakeDeps({ fs }));
    assert.equal(state.version, 1);
    assert.equal(monitorEvent, null);
    assert.equal(requiresInitialPersist, false);
  });

  for (const [code, category] of [['EACCES', 'permission'], ['EPERM', 'permission'], ['EIO', 'io']]) {
    it(`fails closed on state read error ${code}`, async () => {
      const fs = new FakeFs();
      fs.dir('/var/lib/servora-med-alerting');
      fs.file('/var/lib/servora-med-alerting/state.json', JSON.stringify(createDefaultState()));
      const deps = fakeDeps({ fs });
      const realRead = deps.readFile;
      deps.readFile = (target, encoding) => {
        if (target.includes('state.json')) throw Object.assign(new Error(code), { code });
        return realRead(target, encoding);
      };
      const config = loadConfig(env);
      await assert.rejects(() => loadState(config, deps), (error) => {
        assert.equal(error.name, 'StateReadError');
        assert.equal(error.category, category);
        return true;
      });
      const logLines = [];
      const exit = await main({ env, deps, log: (entry) => logLines.push(JSON.stringify(entry)) });
      assert.equal(exit, 1);
      assert.ok(logLines.some((line) => line.includes('"run":"state-read-failed"') && line.includes(category)));
      assert.ok(!logLines.some((line) => line.includes('EACCES') || line.includes('/var/lib')));
    });
  }

  it('fails closed when the state path is a directory', async () => {
    const fs = new FakeFs();
    fs.dir('/backups');
    fs.dir('/var/lib/servora-med-alerting/state.json');
    const deps = fakeDeps({ fs });
    const config = loadConfig(env);
    await assert.rejects(() => loadState(config, deps), (error) => {
      assert.equal(error.name, 'StateReadError');
      assert.equal(error.category, 'wrong-type');
      return true;
    });
  });
});

describe('lock safety through main', () => {
  const env = { ...BASE_ENV, SERVORA_ALERT_FAILURE_THRESHOLD: '1' };

  function lockFs(lockContent) {
    const fs = new FakeFs();
    fs.dir('/backups');
    fs.dir('/var/lib/servora-med-alerting');
    backupPair(fs, '/backups', '20260805T120000Z');
    if (lockContent !== null) fs.file('/var/lib/servora-med-alerting/lock.lock', lockContent);
    return fs;
  }

  function healthyDeps(fs, { alive = false } = {}) {
    const deps = fakeDeps({
      fs,
      health: healthResponse(200, { status: 'ok' }),
      statfsResult: { bavail: 5000n, blocks: 10000n, bsize: 4096n },
    });
    deps.probeProcess = () => (alive ? 'alive' : 'dead');
    deps.fetch = async (url, options) => {
      if (url.includes('/api/health')) return healthResponse(200, { status: 'ok' });
      return webhookResponse(200);
    };
    return deps;
  }

  it('resolves a malformed lock to exit 1 with a safe log and no external work', async () => {
    const fs = lockFs('garbage-lock-content');
    const deps = healthyDeps(fs);
    const logLines = [];
    const exit = await main({ env, deps, log: (entry) => logLines.push(JSON.stringify(entry)) });
    assert.equal(exit, 1);
    assert.ok(logLines.some((line) => line.includes('"run":"lock-invalid"')));
    assert.ok(!logLines.some((line) => line.includes('garbage-lock-content')));
    assert.ok(fs.entries.has('/var/lib/servora-med-alerting/lock.lock'));
  });

  it('resolves an active lock to exit 2 without probes', async () => {
    const fs = lockFs(JSON.stringify({ version: 1, pid: 99999, createdAt: 1, ownerToken: 'a'.repeat(32) }));
    const deps = healthyDeps(fs, { alive: true });
    const logLines = [];
    const exit = await main({ env, deps, log: (entry) => logLines.push(JSON.stringify(entry)) });
    assert.equal(exit, 2);
    assert.ok(logLines.some((line) => line.includes('"run":"lock-busy"')));
  });

  it('reclaims a stale dead-pid lock and runs the monitor', async () => {
    const fs = lockFs(JSON.stringify({ version: 1, pid: 99999, createdAt: 1, ownerToken: 'a'.repeat(32) }));
    const deps = healthyDeps(fs, { alive: false });
    const exit = await main({ env, deps, log: () => {} });
    assert.equal(exit, 0);
    assert.ok(!fs.entries.has('/var/lib/servora-med-alerting/lock.lock'));
  });

  it('resolves an unexpected lock write error to exit 1 without a stack trace', async () => {
    const fs = lockFs(null);
    const deps = healthyDeps(fs);
    const realWrite = deps.writeFile;
    deps.writeFile = (target, content, options) => {
      if (target.includes('lock.lock')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return realWrite(target, content, options);
    };
    const logLines = [];
    const exit = await main({ env, deps, log: (entry) => logLines.push(JSON.stringify(entry)) });
    assert.equal(exit, 1);
    assert.ok(logLines.some((line) => line.includes('"run":"lock-error"')));
    assert.ok(!logLines.some((line) => line.includes('EACCES') || line.includes('at ')));
  });

  it('does not report consecutiveFailures on a successful disk recovery payload', async () => {
    const fs = new FakeFs();
    fs.dir('/backups');
    fs.dir('/var/lib/servora-med-alerting');
    backupPair(fs, '/backups', '20260805T120000Z');
    const now = 1_785_974_400_000;
    fs.file('/var/lib/servora-med-alerting/state.json', JSON.stringify({
      version: 1,
      checks: {
        health: { consecutiveFailures: 0, alertActive: false, lastAlertAt: null, lastReminderAt: null, lastRecoveryAt: null, lastDeliveredAt: null },
        backup: { consecutiveFailures: 0, alertActive: false, lastAlertAt: null, lastReminderAt: null, lastRecoveryAt: null, lastDeliveredAt: null },
        disk: { consecutiveFailures: 3, alertActive: true, lastAlertAt: now - 60e3, lastReminderAt: null, lastRecoveryAt: null, lastDeliveredAt: now - 60e3 },
      },
    }));
    const deps = fakeDeps({
      fs,
      health: healthResponse(200, { status: 'ok' }),
      statfsResult: { bavail: 5000n, blocks: 10000n, bsize: 4096n },
      nowMs: now,
    });
    const payloads = [];
    deps.fetch = async (url, options) => {
      if (url.includes('/api/health')) return healthResponse(200, { status: 'ok' });
      const payload = JSON.parse(options.body);
      payloads.push(payload);
      return webhookResponse(200);
    };
    const result = await runMonitor(loadConfig(env), deps);
    assert.equal(result.exitCode, 0);
    const recovery = payloads.find((payload) => payload.check === 'disk' && payload.event === 'recovery');
    assert.ok(recovery);
    assert.equal(recovery.details.consecutiveFailures, undefined);
  });
});


// ---------------------------------------------------------------------------
// Unit definition contracts (repo files)
// ---------------------------------------------------------------------------

describe('unit definitions', () => {
  const root = resolve(import.meta.dirname, '..', '..', '..');

  it('keeps the env example disabled with no secrets', () => {
    const example = readFileSync(resolve(root, 'ops/examples/operator-alerting.env.example'), 'utf8');
    assert.match(example, /SERVORA_ALERTING_ENABLED=false/);
    assert.ok(!example.includes('https://hooks.'));
    assert.ok(!example.includes('secret'));
  });

  it('keeps the launchd plist example on a 300-second schedule without credentials', () => {
    const plist = readFileSync(resolve(root, 'ops/launchd/com.servora-med.alerting.plist.example'), 'utf8');
    assert.match(plist, /<key>StartInterval<\/key>\s*<integer>300<\/integer>/);
    assert.match(plist, /<key>RunAtLoad<\/key>\s*<false\/>/);
    assert.match(plist, /run-alerting\.sh/);
    assert.ok(!plist.includes('https://'));
    assert.ok(!plist.includes('hooks.'));
    assert.ok(!plist.includes('token'));
    assert.ok(!plist.includes('WEBHOOK_URL'));
    assert.equal((plist.match(/<key>/g) ?? []).length, (plist.match(/<\/key>/g) ?? []).length);
    assert.equal((plist.match(/<dict>/g) ?? []).length, (plist.match(/<\/dict>/g) ?? []).length);
  });

  it('keeps the systemd service oneshot and hardened with EnvironmentFile', () => {
    const service = readFileSync(resolve(root, 'ops/systemd/servora-med-alerting.service'), 'utf8');
    assert.match(service, /Type=oneshot/);
    assert.match(service, /EnvironmentFile=\/etc\/servora-med\/servora-med-alerting\.env/);
    assert.match(service, /NoNewPrivileges=true/);
    assert.match(service, /UMask=0077/);
    assert.match(service, /operator-alerting\.mjs/);
    assert.ok(!service.includes('hook'));
    assert.ok(!service.includes('secret'));
  });

  it('keeps the systemd timer on a five-minute cadence', () => {
    const timer = readFileSync(resolve(root, 'ops/systemd/servora-med-alerting.timer'), 'utf8');
    assert.match(timer, /OnUnitActiveSec=5m/);
    assert.match(timer, /Persistent=true/);
    assert.match(timer, /Unit=servora-med-alerting\.service/);
  });

  it('keeps the BR5 worker persistent and separate from the legacy timer', () => {
    const service = readFileSync(resolve(root, 'ops/systemd/servora-med-backup-worker.service'), 'utf8');
    assert.match(service, /Type=simple/);
    assert.match(service, /Restart=on-failure/);
    assert.match(service, /dist\/backup-worker\.js/);
    assert.match(service, /EnvironmentFile=\/etc\/servora-med\/servora-med\.env/);
    assert.match(service, /NoNewPrivileges=true/);
    const plist = readFileSync(resolve(root, 'ops/launchd/com.servora-med.backup-worker.plist.example'), 'utf8');
    assert.match(plist, /com\.servora-med\.backup-worker/);
    assert.match(plist, /KeepAlive/);
    assert.match(plist, /run-backup-worker\.sh/);
    assert.ok(!plist.includes('secret'));
  });
});
