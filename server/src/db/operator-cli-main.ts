import { closeDatabase, createDatabase } from './index.js';
import { runOperatorCli } from './operator-cli.js';

// Narrow DB configuration: only DATABASE_URL (no full application config), so
// the CLI also works from the host recovery path.
const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(2);
}

const database = createDatabase(databaseUrl, { max: 2, applicationName: 'servora-med-operator-cli' });
try {
  process.exitCode = await runOperatorCli(process.argv.slice(2), {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
  }, database.pool);
} catch {
  console.error('Operator CLI failed.');
  process.exitCode = 1;
} finally {
  await closeDatabase(database);
}
