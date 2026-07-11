import { loadConfig } from '../config.js';
import { bootstrapAdmin, PostgresSetupRepository } from '../modules/auth/setup.js';
import { closeDatabase, createDatabase } from './index.js';

function requireEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const config = loadConfig();
const database = createDatabase(config.databaseUrl);

try {
  await bootstrapAdmin(new PostgresSetupRepository(database.pool), {
    organizationName: requireEnvironment('BOOTSTRAP_ORGANIZATION_NAME'),
    name: requireEnvironment('BOOTSTRAP_ADMIN_NAME'),
    email: requireEnvironment('BOOTSTRAP_ADMIN_EMAIL'),
    password: requireEnvironment('BOOTSTRAP_ADMIN_PASSWORD'),
  });
  console.info('Initial admin created successfully.');
} finally {
  await closeDatabase(database);
}
