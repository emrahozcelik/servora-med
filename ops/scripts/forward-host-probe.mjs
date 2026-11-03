/** Service-UID only. Fixed read-only DB protocol and PostgreSQL-17 dump.
 * No candidate JavaScript is executed as root; credentials stay in the child. */
import Module, {createRequire, isBuiltin} from 'node:module';
import {createInterface} from 'node:readline';
import {spawnSync} from 'node:child_process';
import {withDeploymentDatabaseLock} from './deployment-db-guard.mjs';
import {fileURLToPath} from 'node:url';
import {realpathSync} from 'node:fs';

/** The pg graph is CJS. Constrain every transitive resolution, including
 * ancestor node_modules fallbacks, before loading the first candidate byte.
 * This lives only in the short-lived unprivileged probe process. */
export function restrictReleaseRequires(releaseDirectory) {
  const resolve = Module._resolveFilename;
  Module._resolveFilename = function(request, ...args) {
    const path = resolve.call(this, request, ...args);
    if (!isBuiltin(path) && !realpathSync(path).startsWith(releaseDirectory + '/')) throw new Error('FORWARD_HOST_DB_DEPENDENCY_UNBOUND');
    return path;
  };
}

async function main() {
  if (process.getuid?.() === 0) throw new Error('FORWARD_HOST_DB_ROOT_FORBIDDEN');
  const input = createInterface({input: process.stdin, crlfDelay: Infinity});
  const lines = input[Symbol.asyncIterator]();
  const first = (await lines.next()).value;
  if (typeof first !== 'string' || first.length > 32768) throw new Error('FORWARD_HOST_DB_PROTOCOL_INVALID');
  const options = JSON.parse(first);
  if (!/^\/opt\/servora-med\/releases\/[a-f0-9]{40}$/.test(options.releaseDirectory)) throw new Error('FORWARD_HOST_DB_PROTOCOL_INVALID');
  const candidateRequire = createRequire(options.releaseDirectory + '/server/package.json');
  restrictReleaseRequires(options.releaseDirectory);
  if (!realpathSync(candidateRequire.resolve('pg')).startsWith(options.releaseDirectory + '/')) throw new Error('FORWARD_HOST_DB_DEPENDENCY_UNBOUND');
  const {Client} = candidateRequire('pg');
  const client = new Client({connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000, statement_timeout: 5000});
  try {
    await client.connect();
    const version = Number((await client.query('SHOW server_version_num')).rows[0].server_version_num);
    if (version < 170000 || version >= 180000) throw new Error('FORWARD_HOST_POSTGRES_17_REQUIRED');
    if (process.argv[2] === 'backup') {
      const url = new URL(process.env.DATABASE_URL);
      if (url.hostname !== options.expectedIdentity.host || decodeURIComponent(url.pathname.slice(1)) !== options.expectedIdentity.databaseName
        || decodeURIComponent(url.username) !== options.expectedIdentity.role || Number(url.port || 5432) !== options.expectedIdentity.port) throw new Error('FORWARD_HOST_DB_IDENTITY_INVALID');
      const result = spawnSync('/usr/lib/postgresql/17/bin/pg_dump', ['--format=custom', '--no-owner', '--no-acl'], {
        stdio: ['ignore', 'inherit', 'ignore'], timeout: 240000,
        env: {PATH: '/usr/bin:/bin', PGHOST: url.hostname, PGPORT: url.port || '5432',
          PGDATABASE: options.expectedIdentity.databaseName, PGUSER: options.expectedIdentity.role, PGPASSWORD: decodeURIComponent(url.password)},
      });
      if (result.status !== 0) throw new Error('FORWARD_HOST_BACKUP_FAILED');
      return;
    }
  } finally { await client.end().catch(() => {}); }
  if (process.argv[2] !== '--hold') throw new Error('FORWARD_HOST_DB_PROTOCOL_INVALID');
  await withDeploymentDatabaseLock(options, async ({assertExact, disconnected}) => {
    process.stdout.write('READY\n');
    for (let count = 0; count < 1000; count++) {
      const next = await Promise.race([lines.next(), disconnected.then(() => { throw new Error('FORWARD_HOST_DB_GUARD_LOST'); })]);
      if (next.done || next.value === 'RELEASE') return;
      if (next.value !== 'CHECK') throw new Error('FORWARD_HOST_DB_PROTOCOL_INVALID');
      await assertExact(); process.stdout.write('EXACT\n');
    }
    throw new Error('FORWARD_HOST_DB_PROTOCOL_INVALID');
  });
  input.close();
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(() => {
  process.stderr.write('FORWARD_HOST_DATABASE_CHECK_FAILED\n'); process.exitCode = 1; process.stdin.destroy();
});
