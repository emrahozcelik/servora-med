export type NodeEnvironment = 'development' | 'test' | 'production';

export type TrustedProxy = 'loopback' | '127.0.0.1' | '::1';

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
};

const NODE_ENVIRONMENTS = new Set<NodeEnvironment>(['development', 'test', 'production']);
const LOG_LEVELS = new Set([
  'fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent',
]);
const TRUSTED_PROXIES = new Set<TrustedProxy>(['loopback', '127.0.0.1', '::1']);
const PRODUCTION_LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1']);

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
  };
}
