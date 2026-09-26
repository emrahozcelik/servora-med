import { createECDH } from 'node:crypto';

import type {
  AuthenticatedCapabilities,
  AuthenticatedSupport,
} from './modules/capabilities/types.js';
import { validateBackupInstanceId } from './modules/backup/object-keys.js';
import { LIFECYCLE_INTENT_TTL_MS_DEFAULT } from './modules/job-cards/types.js';
import {
  OVERDUE_SUBMISSION_MANAGEMENT_ESCALATION_DELAY_MS,
  OVERDUE_SUBMISSION_STAFF_REMINDER_DELAY_MS,
} from './modules/job-cards/overdue-reminder-policy.js';
import {
  validateR2AccountId,
  validateR2BucketName,
  validateR2Credential,
} from './modules/backup/r2-config.js';

export type NodeEnvironment = 'development' | 'test' | 'production';

export type TrustedProxy = 'loopback' | '127.0.0.1' | '::1';

export type WebPushConfig = {
  enabled: boolean;
  vapidSubject: string | null;
  vapidPublicKey: string | null;
  vapidPrivateKey: string | null;
};

export type ReverseGeocoderProvider = 'google';

export type BackupLocalEngineConfig = {
  tempRoot: string | null;
  filesRoot: string | null;
};

export type BackupEncryptionConfig = {
  recipient: string | null;
};

export type BackupR2Config = {
  accountId: string | null;
  accessKeyId: string | null;
  secretAccessKey: string | null;
  bucket: string | null;
  bucketAlias: string | null;
  instanceId: string | null;
};

export type BackupWorkerConfig = {
  enabled: boolean;
  leaseMs: number;
  heartbeatIntervalMs: number;
  pollIntervalMs: number;
};

/**
 * Active backup observability provider (OPS-004 item 9). Exactly one provider
 * is selected at wiring time and mapped onto the shared public health contract,
 * so BR5/R2 and the host observation artifact can coexist later without being
 * forced into one table.
 *
 * `none` means the mechanism is intentionally disabled — which is a distinct,
 * truthful state and not a failed backup run.
 */
export type BackupProviderName = 'none' | 'host-observation' | 'br5-r2';

export type BackupProviderConfig = {
  provider: BackupProviderName;
  /**
   * Absolute path to the host-side `observation-v1.json`. Required for — and
   * only used by — the `host-observation` provider.
   */
  observationPath: string | null;
};

/**
 * OVR-3 clock-only breach scanner runtime configuration. Optional by design:
 * `OVERDUE_SCANNER_ENABLED` must be set explicitly, so an unconfigured
 * deployment never starts a background writer it did not ask for.
 */
export type OverdueScannerConfig = {
  enabled: boolean;
  pollIntervalMs: number;
  batchSize: number;
};

/**
 * OVR-4 automatic reminder / escalation worker runtime configuration.
 * Optional by design, mirroring the OVR-3 scanner: `OVERDUE_REMINDER_ENABLED`
 * must be set explicitly, so an unconfigured deployment never starts a
 * background notification writer it did not ask for. Threshold defaults live
 * in the domain policy module; this surface only carries them.
 */
export type OverdueReminderConfig = {
  enabled: boolean;
  pollIntervalMs: number;
  batchSize: number;
  staffReminderDelayMs: number;
  escalationDelayMs: number;
};

export type AppConfig = {
  nodeEnv: NodeEnvironment;
  host: string;
  port: number;
  databaseUrl: string;
  logLevel: string;
  corsOrigin: string;
  sessionTtlSeconds: number;
  loginRateLimitMax: number;
  rateLimitWindowMs: number;
  trustedProxy: TrustedProxy;
  healthSchemaVersion: string | null;
  /**
   * Exact deployment Git SHA surfaced via health. Production requires an
   * exact 40-character SHA and fails closed otherwise; developer/test
   * environments fall back to `dev` unless a valid SHA is provided.
   */
  releaseSha: string;
  actionScopedGeolocationEnabled: boolean;
  reverseGeocoderProvider: ReverseGeocoderProvider | null;
  googleGeocodingApiKey: string | null;
  reverseGeocoderTimeoutMs: number;
  geocodingUserDailyLimit: number;
  geocodingOrganizationDailyLimit: number;
  geocodingGlobalMonthlyLimit: number;
  capabilities?: AuthenticatedCapabilities;
  calendarReminderLeadMinutes?: number;
  /**
   * 049: lifecycle intent processing budget in milliseconds. Positive
   * integer, default 60_000. Consumed by JobCard lifecycle reservation
   * (expires_at = reserved_at + TTL, no renewal).
   */
  lifecycleIntentTtlMs: number;
  support?: AuthenticatedSupport;
  webPush: WebPushConfig;
  backupLocalEngine: BackupLocalEngineConfig;
  backupEncryption: BackupEncryptionConfig;
  backupR2: BackupR2Config;
  /** Optional so existing API-only config fixtures remain source-compatible. */
  backupWorker?: BackupWorkerConfig;
  /**
   * Active backup observability provider. `loadConfig` always sets it; optional
   * here so existing API-only config fixtures remain source-compatible. An
   * absent value means "no provider configured", which is reported as
   * intentionally disabled rather than as a failed backup run.
   */
  backupProvider?: BackupProviderConfig;
  /** Optional: present only when OVERDUE_SCANNER_* is configured. */
  overdueScanner?: OverdueScannerConfig;
  /** Optional: present only when OVERDUE_REMINDER_* is configured. */
  overdueReminder?: OverdueReminderConfig;
  demoDataCreationEnabled: boolean;
};

const NODE_ENVIRONMENTS = new Set<NodeEnvironment>(['development', 'test', 'production']);
const LOG_LEVELS = new Set([
  'fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent',
]);
const TRUSTED_PROXIES = new Set<TrustedProxy>(['loopback', '127.0.0.1', '::1']);
const PRODUCTION_LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1']);

const DEFAULT_REVERSE_GEOCODER_TIMEOUT_MS = 2_000;
const DEFAULT_GEOCODING_USER_DAILY_LIMIT = 15;
const DEFAULT_GEOCODING_ORG_DAILY_LIMIT = 250;
const DEFAULT_GEOCODING_GLOBAL_MONTHLY_LIMIT = 8_000;

function readNonEmpty(value: string | undefined, fallback: string, name: string): string {
  const resolved = value?.trim() || fallback;
  if (!resolved) {
    throw new Error(`${name} must not be empty`);
  }
  return resolved;
}

/**
 * Canonical NODE_ENV validation, shared by the application config and the
 * narrow database-maintenance config so the accepted values cannot drift.
 */
export function readNodeEnvironment(value: string | undefined): NodeEnvironment {
  const nodeEnv = readNonEmpty(value, 'development', 'NODE_ENV');
  if (!NODE_ENVIRONMENTS.has(nodeEnv as NodeEnvironment)) {
    throw new Error('NODE_ENV must be development, test, or production');
  }
  return nodeEnv as NodeEnvironment;
}

function readPort(value: string | undefined): number {
  const port = Number(value ?? '3000');
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  return port;
}

function readPositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function readIntegerInRange(
  value: string | undefined,
  fallback: number,
  name: string,
  min: number,
  max: number,
): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function readBoolean(value: string | undefined, name: string): boolean {
  const resolved = value?.trim() ?? '';
  if (!resolved || resolved === 'false') return false;
  if (resolved === 'true') return true;
  throw new Error(`${name} must be true or false`);
}

function readBackupWorkerConfig(env: NodeJS.ProcessEnv): BackupWorkerConfig {
  const leaseMs = readPositiveInteger(env.BACKUP_WORKER_LEASE_MS, 60_000, 'BACKUP_WORKER_LEASE_MS');
  const heartbeatIntervalMs = readPositiveInteger(
    env.BACKUP_WORKER_HEARTBEAT_INTERVAL_MS,
    15_000,
    'BACKUP_WORKER_HEARTBEAT_INTERVAL_MS',
  );
  const pollIntervalMs = readPositiveInteger(
    env.BACKUP_WORKER_POLL_INTERVAL_MS,
    5_000,
    'BACKUP_WORKER_POLL_INTERVAL_MS',
  );
  if (heartbeatIntervalMs >= leaseMs) {
    throw new Error('BACKUP_WORKER_HEARTBEAT_INTERVAL_MS must be less than BACKUP_WORKER_LEASE_MS');
  }
  return {
    enabled: readBoolean(env.BACKUP_WORKER_ENABLED, 'BACKUP_WORKER_ENABLED'),
    leaseMs,
    heartbeatIntervalMs,
    pollIntervalMs,
  };
}

/**
 * Provider used when `BACKUP_PROVIDER` is unset.
 *
 * It is deliberately the provider that was wired before this slice existed, so
 * deploying this code changes no deployment's active provider by itself.
 * Activating the host observation provider is an explicit, reviewed
 * configuration change — and a set `BACKUP_OBSERVATION_PATH` alone never
 * activates it implicitly.
 */
export const DEFAULT_BACKUP_PROVIDER: BackupProviderName = 'br5-r2';

function readBackupProviderConfig(env: NodeJS.ProcessEnv): BackupProviderConfig {
  const raw = (env.BACKUP_PROVIDER ?? '').trim();
  if (raw === '') {
    // An observation path configured while the provider is off is still
    // validated, so a typo cannot hide until the provider is switched on.
    return {
      provider: DEFAULT_BACKUP_PROVIDER,
      observationPath: readObservationPath(env.BACKUP_OBSERVATION_PATH, false),
    };
  }
  if (raw !== 'none' && raw !== 'host-observation' && raw !== 'br5-r2') {
    throw new Error('BACKUP_PROVIDER must be one of none, host-observation, br5-r2');
  }
  return {
    provider: raw,
    observationPath: readObservationPath(env.BACKUP_OBSERVATION_PATH, raw === 'host-observation'),
  };
}

/**
 * Fail-closed validation of the observation artifact path. The reader must never
 * be pointed at a relative, ambiguous or traversing path: a wrong path is an
 * untrustworthy evidence source, not a degraded one.
 */
function readObservationPath(value: string | undefined, required: boolean): string | null {
  const raw = value ?? '';
  if (raw.length === 0) {
    if (required) {
      throw new Error('BACKUP_OBSERVATION_PATH is required when BACKUP_PROVIDER=host-observation');
    }
    return null;
  }
  if (raw !== raw.trim()) throw new Error('BACKUP_OBSERVATION_PATH must not have surrounding whitespace');
  if (raw.includes('\0') || raw.length > 4096) {
    throw new Error('BACKUP_OBSERVATION_PATH must be a single absolute filesystem path');
  }
  if (!raw.startsWith('/') || raw.endsWith('/') || raw.includes('//')) {
    throw new Error('BACKUP_OBSERVATION_PATH must be a normalized absolute filesystem path');
  }
  if (raw.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new Error('BACKUP_OBSERVATION_PATH must not contain . or .. segments');
  }
  return raw;
}

function readOverdueScannerConfig(env: NodeJS.ProcessEnv): OverdueScannerConfig {
  return {
    enabled: readBoolean(env.OVERDUE_SCANNER_ENABLED, 'OVERDUE_SCANNER_ENABLED'),
    pollIntervalMs: readIntegerInRange(
      env.OVERDUE_SCANNER_POLL_INTERVAL_MS,
      60_000,
      'OVERDUE_SCANNER_POLL_INTERVAL_MS',
      1_000,
      3_600_000,
    ),
    batchSize: readIntegerInRange(
      env.OVERDUE_SCANNER_BATCH_SIZE,
      50,
      'OVERDUE_SCANNER_BATCH_SIZE',
      1,
      500,
    ),
  };
}

function readOverdueReminderConfig(env: NodeJS.ProcessEnv): OverdueReminderConfig {
  return {
    enabled: readBoolean(env.OVERDUE_REMINDER_ENABLED, 'OVERDUE_REMINDER_ENABLED'),
    pollIntervalMs: readIntegerInRange(
      env.OVERDUE_REMINDER_POLL_INTERVAL_MS,
      60_000,
      'OVERDUE_REMINDER_POLL_INTERVAL_MS',
      1_000,
      3_600_000,
    ),
    batchSize: readIntegerInRange(
      env.OVERDUE_REMINDER_BATCH_SIZE,
      50,
      'OVERDUE_REMINDER_BATCH_SIZE',
      1,
      500,
    ),
    staffReminderDelayMs: readIntegerInRange(
      env.OVERDUE_REMINDER_STAFF_DELAY_MS,
      OVERDUE_SUBMISSION_STAFF_REMINDER_DELAY_MS,
      'OVERDUE_REMINDER_STAFF_DELAY_MS',
      60_000,
      86_400_000,
    ),
    escalationDelayMs: readIntegerInRange(
      env.OVERDUE_REMINDER_ESCALATION_DELAY_MS,
      OVERDUE_SUBMISSION_MANAGEMENT_ESCALATION_DELAY_MS,
      'OVERDUE_REMINDER_ESCALATION_DELAY_MS',
      60_000,
      86_400_000,
    ),
  };
}

function readSupportConfig(env: NodeJS.ProcessEnv): AuthenticatedSupport {
  const displayLabel = env.SUPPORT_DISPLAY_LABEL?.trim() || 'Sistem yöneticiniz';
  if (displayLabel.length > 120 || /[\u0000-\u001f\u007f]/.test(displayLabel)) {
    throw new Error('SUPPORT_DISPLAY_LABEL must be at most 120 safe characters');
  }
  const email = env.SUPPORT_EMAIL?.trim() || null;
  if (
    email
    && (
      email.length > 254
      || !/^[A-Za-z0-9.!#$%&'*+/=_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(email)
    )
  ) {
    throw new Error('SUPPORT_EMAIL must be a valid email address');
  }
  const helpUrl = env.SUPPORT_HELP_URL?.trim() || null;
  if (helpUrl) {
    try {
      const url = new URL(helpUrl);
      if (
        url.protocol !== 'https:'
        || url.username
        || url.password
      ) throw new Error('invalid');
    } catch {
      throw new Error('SUPPORT_HELP_URL must be an https URL');
    }
  }
  return { displayLabel, email, helpUrl };
}

/**
 * Single validation authority for DATABASE_URL semantics. Shared by the
 * application config and the narrow database-maintenance config (migrate,
 * schema-check) so maintenance tooling never needs full application config.
 */
export function readDatabaseUrl(value: string | undefined): string {
  const databaseUrl = value?.trim();
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }
  if (!/^postgres(ql)?:\/\//i.test(databaseUrl)) {
    throw new Error('DATABASE_URL must be a postgresql:// or postgres:// URL');
  }
  return databaseUrl;
}

function readLogLevel(value: string | undefined): string {
  const logLevel = readNonEmpty(value, 'info', 'LOG_LEVEL');
  if (!LOG_LEVELS.has(logLevel)) {
    throw new Error(
      'LOG_LEVEL must be one of fatal, error, warn, info, debug, trace, silent',
    );
  }
  return logLevel;
}

function readCorsOrigin(value: string | undefined, nodeEnv: NodeEnvironment): string {
  const resolved = value?.trim() || (nodeEnv === 'production' ? '' : 'http://127.0.0.1:5173');
  if (!resolved) {
    throw new Error('CORS_ORIGIN is required in production');
  }

  try {
    const url = new URL(resolved);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== resolved) {
      throw new Error('invalid origin');
    }
    if (nodeEnv === 'production' && url.protocol !== 'https:') {
      throw new Error('CORS_ORIGIN must use https in production');
    }
    return url.origin;
  } catch (error) {
    if (error instanceof Error && error.message === 'CORS_ORIGIN must use https in production') {
      throw error;
    }
    throw new Error('CORS_ORIGIN must be one http or https origin without a path');
  }
}

function readHost(value: string | undefined, nodeEnv: NodeEnvironment): string {
  const host = readNonEmpty(value, '127.0.0.1', 'HOST');
  if (nodeEnv === 'production' && !PRODUCTION_LOOPBACK_HOSTS.has(host)) {
    throw new Error('HOST must be 127.0.0.1 or ::1 in production');
  }
  return host;
}

function readTrustedProxy(
  value: string | undefined,
  nodeEnv: NodeEnvironment,
): TrustedProxy {
  const raw = value?.trim();
  if (!raw) {
    if (nodeEnv === 'production') {
      throw new Error('TRUSTED_PROXY is required in production');
    }
    return 'loopback';
  }
  if (!TRUSTED_PROXIES.has(raw as TrustedProxy)) {
    throw new Error('TRUSTED_PROXY must be loopback, 127.0.0.1, or ::1');
  }
  return raw as TrustedProxy;
}

/**
 * Single validation authority for HEALTH_SCHEMA_VERSION semantics. Shared by
 * the application config and schema-check so the production requirement
 * cannot drift between them.
 */
export function readHealthSchemaVersion(
  value: string | undefined,
  nodeEnv: NodeEnvironment,
): string | null {
  const resolved = value?.trim() ?? '';
  if (nodeEnv === 'production') {
    if (!resolved) {
      throw new Error('HEALTH_SCHEMA_VERSION is required in production');
    }
    return resolved;
  }
  return resolved || null;
}

const RELEASE_SHA_PATTERN = /^[0-9a-f]{40}$/;
export const DEVELOPMENT_RELEASE_SHA = 'dev';

function readReleaseSha(value: string | undefined, nodeEnv: NodeEnvironment): string {
  const normalized = (value ?? '').trim().toLowerCase();
  if (RELEASE_SHA_PATTERN.test(normalized)) return normalized;
  if (nodeEnv === 'production') {
    throw new Error('SERVORA_RELEASE_SHA must be an exact 40-character lowercase Git SHA in production');
  }
  return DEVELOPMENT_RELEASE_SHA;
}

function readRequiredWebPushValue(
  value: string | undefined,
  name: string,
): string {
  const resolved = value?.trim();
  if (!resolved) {
    throw new Error(`${name} is required when WEB_PUSH_ENABLED=true`);
  }
  return resolved;
}

function readVapidSubject(value: string | undefined): string {
  const subject = readRequiredWebPushValue(value, 'WEB_PUSH_VAPID_SUBJECT');

  try {
    const url = new URL(subject);
    if (
      url.protocol === 'mailto:'
      && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(url.pathname)
      && !url.search
      && !url.hash
    ) {
      return subject;
    }

    const hostname = url.hostname.toLowerCase();
    const isLocalHost = hostname === 'localhost'
      || hostname.endsWith('.localhost')
      || hostname === '127.0.0.1'
      || hostname === '::1'
      || hostname === '0.0.0.0';
    if (
      url.protocol === 'https:'
      && !url.username
      && !url.password
      && !isLocalHost
    ) {
      return subject;
    }
  } catch {
    // Normalize every malformed contact value to the public config contract.
  }

  throw new Error('WEB_PUSH_VAPID_SUBJECT must be a public https URL or mailto address');
}

function readVapidKey(
  value: string | undefined,
  name: 'WEB_PUSH_VAPID_PUBLIC_KEY' | 'WEB_PUSH_VAPID_PRIVATE_KEY',
  expectedLength: number,
): { encoded: string; decoded: Buffer } {
  const encoded = readRequiredWebPushValue(value, name);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error(`${name} must be a URL-safe Base64 P-256 key`);
  }

  const decoded = Buffer.from(encoded, 'base64url');
  if (
    decoded.length !== expectedLength
    || decoded.toString('base64url') !== encoded
    || (name === 'WEB_PUSH_VAPID_PUBLIC_KEY' && decoded[0] !== 4)
  ) {
    throw new Error(`${name} must be a URL-safe Base64 P-256 key`);
  }

  return { encoded, decoded };
}

function readWebPushConfig(env: NodeJS.ProcessEnv): WebPushConfig {
  const enabled = readBoolean(env.WEB_PUSH_ENABLED, 'WEB_PUSH_ENABLED');
  if (!enabled) {
    return {
      enabled: false,
      vapidSubject: null,
      vapidPublicKey: null,
      vapidPrivateKey: null,
    };
  }

  const vapidSubject = readVapidSubject(env.WEB_PUSH_VAPID_SUBJECT);
  const vapidPublicKey = readVapidKey(
    env.WEB_PUSH_VAPID_PUBLIC_KEY,
    'WEB_PUSH_VAPID_PUBLIC_KEY',
    65,
  );
  const vapidPrivateKey = readVapidKey(
    env.WEB_PUSH_VAPID_PRIVATE_KEY,
    'WEB_PUSH_VAPID_PRIVATE_KEY',
    32,
  );

  try {
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(vapidPrivateKey.decoded);
    if (!ecdh.getPublicKey().equals(vapidPublicKey.decoded)) {
      throw new Error('incompatible');
    }
  } catch {
    throw new Error(
      'WEB_PUSH_VAPID_PUBLIC_KEY and WEB_PUSH_VAPID_PRIVATE_KEY must be compatible',
    );
  }

  return {
    enabled: true,
    vapidSubject,
    vapidPublicKey: vapidPublicKey.encoded,
    vapidPrivateKey: vapidPrivateKey.encoded,
  };
}

function readGeocodingConfig(env: NodeJS.ProcessEnv, actionScopedGeolocationEnabled: boolean): Pick<
  AppConfig,
  | 'reverseGeocoderProvider'
  | 'googleGeocodingApiKey'
  | 'reverseGeocoderTimeoutMs'
  | 'geocodingUserDailyLimit'
  | 'geocodingOrganizationDailyLimit'
  | 'geocodingGlobalMonthlyLimit'
> {
  if (!actionScopedGeolocationEnabled) {
    return {
      reverseGeocoderProvider: null,
      googleGeocodingApiKey: null,
      reverseGeocoderTimeoutMs: DEFAULT_REVERSE_GEOCODER_TIMEOUT_MS,
      geocodingUserDailyLimit: DEFAULT_GEOCODING_USER_DAILY_LIMIT,
      geocodingOrganizationDailyLimit: DEFAULT_GEOCODING_ORG_DAILY_LIMIT,
      geocodingGlobalMonthlyLimit: DEFAULT_GEOCODING_GLOBAL_MONTHLY_LIMIT,
    };
  }

  const providerRaw = env.REVERSE_GEOCODER_PROVIDER?.trim() ?? '';
  if (!providerRaw) {
    throw new Error(
      'REVERSE_GEOCODER_PROVIDER is required when ACTION_SCOPED_GEOLOCATION_ENABLED=true',
    );
  }
  if (providerRaw !== 'google') {
    throw new Error('REVERSE_GEOCODER_PROVIDER must be google');
  }

  const apiKey = env.GOOGLE_GEOCODING_API_KEY?.trim() ?? '';
  if (!apiKey) {
    throw new Error(
      'GOOGLE_GEOCODING_API_KEY is required when ACTION_SCOPED_GEOLOCATION_ENABLED=true',
    );
  }

  const reverseGeocoderTimeoutMs = readIntegerInRange(
    env.REVERSE_GEOCODER_TIMEOUT_MS,
    DEFAULT_REVERSE_GEOCODER_TIMEOUT_MS,
    'REVERSE_GEOCODER_TIMEOUT_MS',
    500,
    5_000,
  );
  const geocodingUserDailyLimit = readIntegerInRange(
    env.GEOCODING_USER_DAILY_LIMIT,
    DEFAULT_GEOCODING_USER_DAILY_LIMIT,
    'GEOCODING_USER_DAILY_LIMIT',
    1,
    100,
  );
  const geocodingOrganizationDailyLimit = readIntegerInRange(
    env.GEOCODING_ORG_DAILY_LIMIT,
    DEFAULT_GEOCODING_ORG_DAILY_LIMIT,
    'GEOCODING_ORG_DAILY_LIMIT',
    1,
    2_000,
  );
  const geocodingGlobalMonthlyLimit = readIntegerInRange(
    env.GEOCODING_GLOBAL_MONTHLY_LIMIT,
    DEFAULT_GEOCODING_GLOBAL_MONTHLY_LIMIT,
    'GEOCODING_GLOBAL_MONTHLY_LIMIT',
    1,
    9_000,
  );

  if (geocodingUserDailyLimit > geocodingOrganizationDailyLimit) {
    throw new Error(
      'GEOCODING_USER_DAILY_LIMIT must not exceed GEOCODING_ORG_DAILY_LIMIT',
    );
  }

  return {
    reverseGeocoderProvider: 'google',
    googleGeocodingApiKey: apiKey,
    reverseGeocoderTimeoutMs,
    geocodingUserDailyLimit,
    geocodingOrganizationDailyLimit,
    geocodingGlobalMonthlyLimit,
  };
}

/** Fastify trustProxy option derived from validated config. Never "true" for all peers. */
export function resolveTrustProxyOption(trustedProxy: TrustedProxy): boolean | string {
  if (trustedProxy === 'loopback') return 'loopback';
  return trustedProxy;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrl = readDatabaseUrl(env.DATABASE_URL);

  const typedNodeEnv = readNodeEnvironment(env.NODE_ENV);
  const actionScopedGeolocationEnabled = readBoolean(
    env.ACTION_SCOPED_GEOLOCATION_ENABLED,
    'ACTION_SCOPED_GEOLOCATION_ENABLED',
  );
  const geocoding = readGeocodingConfig(env, actionScopedGeolocationEnabled);
  const hasBackupWorkerConfig = Object.keys(env).some((key) => key.startsWith('BACKUP_WORKER_'));
  const hasOverdueScannerConfig = Object.keys(env).some((key) => key.startsWith('OVERDUE_SCANNER_'));
  const hasOverdueReminderConfig = Object.keys(env).some((key) => key.startsWith('OVERDUE_REMINDER_'));

  return {
    nodeEnv: typedNodeEnv,
    host: readHost(env.HOST, typedNodeEnv),
    port: readPort(env.PORT),
    databaseUrl,
    logLevel: readLogLevel(env.LOG_LEVEL),
    corsOrigin: readCorsOrigin(env.CORS_ORIGIN, typedNodeEnv),
    sessionTtlSeconds: readPositiveInteger(env.SESSION_TTL_SECONDS, 28_800, 'SESSION_TTL_SECONDS'),
    loginRateLimitMax: readPositiveInteger(env.LOGIN_RATE_LIMIT_MAX, 5, 'LOGIN_RATE_LIMIT_MAX'),
    rateLimitWindowMs: readPositiveInteger(env.RATE_LIMIT_WINDOW_MS, 60_000, 'RATE_LIMIT_WINDOW_MS'),
    trustedProxy: readTrustedProxy(env.TRUSTED_PROXY, typedNodeEnv),
    healthSchemaVersion: readHealthSchemaVersion(env.HEALTH_SCHEMA_VERSION, typedNodeEnv),
    releaseSha: readReleaseSha(env.SERVORA_RELEASE_SHA, typedNodeEnv),
    actionScopedGeolocationEnabled,
    ...geocoding,
    capabilities: {
      overviewDashboard: readBoolean(
        env.OVERVIEW_DASHBOARD_ENABLED,
        'OVERVIEW_DASHBOARD_ENABLED',
      ),
      calendar: readBoolean(env.CALENDAR_ENABLED, 'CALENDAR_ENABLED'),
      messaging: readBoolean(env.MESSAGING_ENABLED, 'MESSAGING_ENABLED'),
      // Backup & Recovery domain capability (BR1 foundation). BR2–BR4 execution
      // configuration is optional; present values are validated, but the app
      // must keep starting while this flag is off and those values are absent.
      backup: readBoolean(env.BACKUP_ENABLED, 'BACKUP_ENABLED'),
      demoDatasetCreation: readBoolean(env.DEMO_DATA_CREATION_ENABLED, 'DEMO_DATA_CREATION_ENABLED'),
    },
    calendarReminderLeadMinutes: readIntegerInRange(
      env.CALENDAR_REMINDER_LEAD_MINUTES,
      30,
      'CALENDAR_REMINDER_LEAD_MINUTES',
      5,
      1_440,
    ),
    lifecycleIntentTtlMs: readPositiveInteger(
      env.JOB_CARD_LIFECYCLE_INTENT_TTL_MS,
      LIFECYCLE_INTENT_TTL_MS_DEFAULT,
      'JOB_CARD_LIFECYCLE_INTENT_TTL_MS',
    ),
    support: readSupportConfig(env),
    webPush: readWebPushConfig(env),
    // BR2 local engine paths. Optional by design: "not configured" is NOT
    // invalid configuration — the app must keep starting (and BR3/BR4 secrets
    // stay unnecessary) while these are absent.
    backupLocalEngine: {
      tempRoot: readOptionalPath(env.BACKUP_TEMP_ROOT, 'BACKUP_TEMP_ROOT'),
      filesRoot: readOptionalPath(env.BACKUP_FILES_ROOT, 'BACKUP_FILES_ROOT'),
    },
    // BR3 encryption config: the PUBLIC age hybrid recipient only. Structural
    // sanity here; the full hybrid-recipient policy is validated lazily by
    // the encryption engine when encryption is actually invoked, so a
    // disabled deployment never needs age or a recipient to start. There is
    // deliberately NO private-identity field (operator-held only).
    backupEncryption: {
      recipient: readOptionalRecipient(env.BACKUP_ENCRYPTION_RECIPIENT, 'BACKUP_ENCRYPTION_RECIPIENT'),
    },
    // BR4 remote storage config. All fields optional: "not configured" is a
    // valid state (lazy validation at connection test / remote stage time),
    // so a disabled deployment starts without any R2 credentials. Values
    // present-but-invalid fail fast with a precise message. The secret never
    // appears in any DTO, audit row, or log field.
    backupR2: {
      accountId: readOptionalValidated(env.BACKUP_R2_ACCOUNT_ID, 'BACKUP_R2_ACCOUNT_ID', validateR2AccountId),
      accessKeyId: readOptionalCredential(env.BACKUP_R2_ACCESS_KEY_ID, 'BACKUP_R2_ACCESS_KEY_ID'),
      secretAccessKey: readOptionalCredential(env.BACKUP_R2_SECRET_ACCESS_KEY, 'BACKUP_R2_SECRET_ACCESS_KEY'),
      bucket: readOptionalValidated(env.BACKUP_R2_BUCKET, 'BACKUP_R2_BUCKET', validateR2BucketName),
      bucketAlias: readOptionalSafeLabel(env.BACKUP_R2_BUCKET_ALIAS, 'BACKUP_R2_BUCKET_ALIAS', 200),
      instanceId: readOptionalInstanceId(env.BACKUP_INSTANCE_ID, 'BACKUP_INSTANCE_ID'),
    },
    demoDataCreationEnabled: readBoolean(env.DEMO_DATA_CREATION_ENABLED, 'DEMO_DATA_CREATION_ENABLED'),
    backupProvider: readBackupProviderConfig(env),
    ...(hasBackupWorkerConfig ? { backupWorker: readBackupWorkerConfig(env) } : {}),
    ...(hasOverdueScannerConfig ? { overdueScanner: readOverdueScannerConfig(env) } : {}),
    ...(hasOverdueReminderConfig ? { overdueReminder: readOverdueReminderConfig(env) } : {}),
  };
}

function readOptionalPath(value: string | undefined, name: string): string | null {
  const trimmed = value?.trim() ?? '';
  if (trimmed.length === 0) return null;
  if (trimmed.includes('\0') || trimmed.length > 4096) {
    throw new Error(`${name} must be a single filesystem path`);
  }
  return trimmed;
}

function readOptionalValidated(
  value: string | undefined,
  name: string,
  validate: (candidate: string) => boolean,
): string | null {
  const raw = value ?? '';
  if (raw.length === 0) return null;
  if (raw !== raw.trim() || !validate(raw)) throw new Error(`${name} is not a valid value`);
  return raw;
}

/** Credential-shaped env value: non-empty single line, no whitespace or
 * control characters, bounded. Never echoed anywhere. */
function readOptionalCredential(value: string | undefined, name: string): string | null {
  const raw = value ?? '';
  if (raw.length === 0) return null;
  if (raw !== raw.trim() || !validateR2Credential(raw)) {
    throw new Error(`${name} must be a single-line credential value`);
  }
  return raw;
}

function readOptionalSafeLabel(
  value: string | undefined,
  name: string,
  maxLength: number,
): string | null {
  const trimmed = value?.trim() ?? '';
  if (trimmed.length === 0) return null;
  if (trimmed.length > maxLength || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new Error(`${name} must be a safe display label of at most ${maxLength} characters`);
  }
  return trimmed;
}

/** Opaque installation identifier (BR0 grammar): visible ASCII slug without
 * separators' dangerous forms; no silent normalization. */
function readOptionalInstanceId(value: string | undefined, name: string): string | null {
  const raw = value ?? '';
  if (raw.length === 0) return null;
  if (raw !== raw.trim() || !validateBackupInstanceId(raw)) {
    throw new Error(`${name} must be an opaque identifier (ASCII letters, digits, . _ -; no "..", max 63 chars)`);
  }
  return raw;
}

/** Optional single-line PUBLIC recipient value. Empty = not configured
 * (valid: encryption simply cannot run until BR5 enables the worker). */
function readOptionalRecipient(value: string | undefined, name: string): string | null {
  const trimmed = value?.trim() ?? '';
  if (trimmed.length === 0) return null;
  if (trimmed.includes('\n') || trimmed.includes('\r') || trimmed.includes('\0') || trimmed.length > 4096) {
    throw new Error(`${name} must be a single-line recipient value`);
  }
  return trimmed;
}
