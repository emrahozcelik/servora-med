export type NodeEnvironment = 'development' | 'test' | 'production';

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
};

const NODE_ENVIRONMENTS = new Set<NodeEnvironment>(['development', 'test', 'production']);

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
    return url.origin;
  } catch {
    throw new Error('CORS_ORIGIN must be one http or https origin without a path');
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }

  const nodeEnv = readNonEmpty(env.NODE_ENV, 'development', 'NODE_ENV');
  if (!NODE_ENVIRONMENTS.has(nodeEnv as NodeEnvironment)) {
    throw new Error('NODE_ENV must be development, test, or production');
  }

  const typedNodeEnv = nodeEnv as NodeEnvironment;

  return {
    nodeEnv: typedNodeEnv,
    host: readNonEmpty(env.HOST, '127.0.0.1', 'HOST'),
    port: readPort(env.PORT),
    databaseUrl,
    logLevel: readNonEmpty(env.LOG_LEVEL, 'info', 'LOG_LEVEL'),
    corsOrigin: readCorsOrigin(env.CORS_ORIGIN, typedNodeEnv),
    sessionTtlSeconds: readPositiveInteger(env.SESSION_TTL_SECONDS, 28_800, 'SESSION_TTL_SECONDS'),
    loginRateLimitMax: readPositiveInteger(env.LOGIN_RATE_LIMIT_MAX, 5, 'LOGIN_RATE_LIMIT_MAX'),
    rateLimitWindowMs: readPositiveInteger(env.RATE_LIMIT_WINDOW_MS, 60_000, 'RATE_LIMIT_WINDOW_MS'),
  };
}
