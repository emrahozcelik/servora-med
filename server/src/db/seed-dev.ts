import { loadConfig } from '../config.js';
import { PostgresSetupRepository, seedDevelopment } from '../modules/auth/setup.js';
import { closeDatabase, createDatabase } from './index.js';

function requireEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const config = loadConfig();
const database = createDatabase(config.databaseUrl);

try {
  await seedDevelopment(
    new PostgresSetupRepository(database.pool),
    {
      organizationName: process.env.DEV_SEED_ORGANIZATION_NAME?.trim() || 'Servora Med Demo',
      password: requireEnvironment('DEV_SEED_PASSWORD'),
    },
    config.nodeEnv,
  );
  console.info('Development users created successfully.');
} finally {
  await closeDatabase(database);
}
