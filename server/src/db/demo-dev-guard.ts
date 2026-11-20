/**
 * Development-only demo dataset command — pure argument and safety rules.
 *
 * The I/O entry point is `./demo-dev.ts`. The managed demo lifecycle itself is
 * unchanged (`DemoDatasetService`, DECISIONS.md D4); this command only drives
 * it from a terminal on a local development database.
 */

export class DemoDevError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'DemoDevError';
  }
}

export type DemoDevArgs =
  | { command: 'list'; adminEmail: string }
  | { command: 'create'; adminEmail: string }
  | { command: 'purge'; adminEmail: string; datasetId: string };

const USAGE =
  'Usage: demo:dev -- <list|create|purge> --admin-email <email> [--dataset <id> --yes]';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseDemoDevArgs(argv: readonly string[]): DemoDevArgs {
  const [command, ...rest] = argv;
  if (command !== 'list' && command !== 'create' && command !== 'purge') {
    throw new DemoDevError('DEMO_DEV_USAGE', USAGE);
  }
  let adminEmail: string | null = null;
  let datasetId: string | null = null;
  let yes = false;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--admin-email' || arg === '--dataset') {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new DemoDevError('DEMO_DEV_USAGE', `${arg} requires a value. ${USAGE}`);
      }
      if (arg === '--admin-email') adminEmail = value.trim().toLowerCase();
      else datasetId = value.trim();
      index += 1;
    } else if (arg === '--yes') {
      yes = true;
    } else {
      throw new DemoDevError('DEMO_DEV_USAGE', `Unknown argument: ${arg}. ${USAGE}`);
    }
  }
  if (!adminEmail) throw new DemoDevError('DEMO_DEV_USAGE', `--admin-email is required. ${USAGE}`);
  if (command !== 'purge') {
    if (datasetId !== null || yes) throw new DemoDevError('DEMO_DEV_USAGE', `--dataset/--yes are only valid with purge. ${USAGE}`);
    return { command, adminEmail };
  }
  if (datasetId === null || !UUID.test(datasetId)) {
    throw new DemoDevError('DEMO_DEV_USAGE', `purge requires --dataset <dataset UUID>. ${USAGE}`);
  }
  if (!yes) {
    throw new DemoDevError(
      'DEMO_DEV_PURGE_CONFIRMATION_REQUIRED',
      'purge permanently removes every record of the demo dataset; review the preview and repeat with --yes.',
    );
  }
  return { command, adminEmail, datasetId };
}

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1'];

/**
 * Fail closed unless this is unmistakably a local development database:
 * NODE_ENV must be exactly `development`, the host must be loopback, and the
 * database must not be the staging database or a test database.
 */
export function assertLocalDevelopmentTarget(input: { nodeEnv: string; databaseUrl: string }): { databaseName: string } {
  if (input.nodeEnv !== 'development') {
    throw new DemoDevError(
      'DEMO_DEV_NODE_ENV_REFUSED',
      `This command runs only with an explicit NODE_ENV=development (received "${input.nodeEnv || '<unset>'}"). Use the Admin Demo data page in other environments.`,
    );
  }
  let url: URL;
  try {
    url = new URL(input.databaseUrl);
  } catch {
    throw new DemoDevError('DEMO_DEV_DATABASE_URL_MALFORMED', 'DATABASE_URL could not be parsed.');
  }
  const host = url.hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  if (!LOOPBACK_HOSTS.includes(host)) {
    throw new DemoDevError('DEMO_DEV_NON_LOOPBACK_DATABASE', `DATABASE_URL must target a loopback host; received "${host}".`);
  }
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!databaseName) {
    throw new DemoDevError('DEMO_DEV_DATABASE_NAME_REQUIRED', 'DATABASE_URL must name a database.');
  }
  if (databaseName === 'servora_med_staging') {
    throw new DemoDevError('DEMO_DEV_PROTECTED_DATABASE', 'The staging database is never a demo-dev target.');
  }
  if (databaseName === 'servora_med_test' || databaseName.startsWith('servora_med_test_')) {
    throw new DemoDevError(
      'DEMO_DEV_TEST_DATABASE',
      'Test databases must stay empty for the suite; point DATABASE_URL at the development database.',
    );
  }
  return { databaseName };
}
