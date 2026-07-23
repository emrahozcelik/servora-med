import { createECDH } from 'node:crypto';

export type NodeEnvironment = 'development' | 'test' | 'production';

export type TrustedProxy = 'loopback' | '127.0.0.1' | '::1';

export type WebPushConfig = {
  enabled: boolean;
  vapidSubject: string | null;
  vapidPublicKey: string | null;
  vapidPrivateKey: string | null;
};

export type ReverseGeocoderProvider = 'google';

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
  actionScopedGeolocationEnabled: boolean;
  reverseGeocoderProvider: ReverseGeocoderProvider | null;
  googleGeocodingApiKey: string | null;
  reverseGeocoderTimeoutMs: number;
  geocodingUserDailyLimit: number;
  geocodingOrganizationDailyLimit: number;
  geocodingGlobalMonthlyLimit: number;
  webPush: WebPushConfig;
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

function readDatabaseUrl(value: string | undefined): string {
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

function readHealthSchemaVersion(
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

  const nodeEnv = readNonEmpty(env.NODE_ENV, 'development', 'NODE_ENV');
  if (!NODE_ENVIRONMENTS.has(nodeEnv as NodeEnvironment)) {
    throw new Error('NODE_ENV must be development, test, or production');
  }

  const typedNodeEnv = nodeEnv as NodeEnvironment;
  const actionScopedGeolocationEnabled = readBoolean(
    env.ACTION_SCOPED_GEOLOCATION_ENABLED,
    'ACTION_SCOPED_GEOLOCATION_ENABLED',
  );
  const geocoding = readGeocodingConfig(env, actionScopedGeolocationEnabled);

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
    actionScopedGeolocationEnabled,
    ...geocoding,
    webPush: readWebPushConfig(env),
  };
}
