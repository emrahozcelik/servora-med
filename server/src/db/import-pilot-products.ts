import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { closeDatabase, createDatabase } from './index.js';
import {
  importPilotProducts,
  parsePilotProductDocument,
} from '../modules/products/pilot-import.js';

function argumentsFrom(argv: string[]) {
  const result: Record<string, string | boolean> = { apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index]!;
    if (entry === '--apply') { result.apply = true; continue; }
    if (!['--file', '--organization-id', '--actor-user-id'].includes(entry)) {
      throw new Error(`Unsupported argument: ${entry}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${entry} requires a value`);
    result[entry.slice(2)] = value; index += 1;
  }
  for (const required of ['file', 'organization-id', 'actor-user-id']) {
    if (typeof result[required] !== 'string') throw new Error(`--${required} is required`);
  }
  return result as {
    file: string; 'organization-id': string; 'actor-user-id': string; apply: boolean;
  };
}

const args = argumentsFrom(process.argv.slice(2));
const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const document = parsePilotProductDocument(JSON.parse(
  await readFile(path.resolve(args.file), 'utf8'),
));
const database = createDatabase(databaseUrl, { max: 1, applicationName: 'pilot-product-import' });
try {
  const result = await importPilotProducts(database.pool, {
    organizationId: args['organization-id'], actorUserId: args['actor-user-id'],
    document, apply: args.apply,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await closeDatabase(database);
}
