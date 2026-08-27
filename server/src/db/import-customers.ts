import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { loadConfig } from '../config.js';
import { closeDatabase, createDatabase } from './index.js';
import {
  importCustomers,
  parseCustomerOnboardingManifest,
  parseStaffMappings,
} from '../modules/crm/customer-onboarding-import.js';

function argumentsFrom(argv: string[]) {
  const result: Record<string, string | boolean> = { apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index]!;
    if (entry === '--apply') { result.apply = true; continue; }
    if (!['--manifest', '--staff-map', '--organization-id', '--actor-user-id'].includes(entry)) {
      throw new Error(`Unsupported argument: ${entry}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${entry} requires a value`);
    result[entry.slice(2)] = value;
    index += 1;
  }
  for (const required of ['manifest', 'staff-map', 'organization-id', 'actor-user-id']) {
    if (typeof result[required] !== 'string') throw new Error(`--${required} is required`);
  }
  return result as {
    manifest: string; 'staff-map': string; 'organization-id': string; 'actor-user-id': string; apply: boolean;
  };
}

const args = argumentsFrom(process.argv.slice(2));
const manifest = parseCustomerOnboardingManifest(JSON.parse(
  await readFile(path.resolve(args.manifest), 'utf8'),
));
const mappings = parseStaffMappings(JSON.parse(
  await readFile(path.resolve(args['staff-map']), 'utf8'),
));
const config = loadConfig();
const database = createDatabase(config.databaseUrl, { max: 1, applicationName: 'customer-onboarding-import' });

try {
  const result = await importCustomers(database.pool, {
    organizationId: args['organization-id'],
    actorUserId: args['actor-user-id'],
    manifest,
    mappings,
    apply: args.apply,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await closeDatabase(database);
}
