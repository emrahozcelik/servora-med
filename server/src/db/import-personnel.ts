import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { AppError } from '../errors/index.js';
import { loadConfig } from '../config.js';
import { closeDatabase, createDatabase } from './index.js';
import {
  formatPersonnelImportError,
  importPersonnel,
  parsePersonnelManifest,
  readSecurePersonnelCredentials,
  writePersonnelMappingArtifact,
} from '../modules/people/personnel-onboarding-import.js';

function argumentsFrom(argv: string[]) {
  const result: Record<string, string | boolean> = { apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index]!;
    if (entry === '--apply') { result.apply = true; continue; }
    if (!['--file', '--organization-id', '--actor-user-id', '--credentials-file', '--mapping-output'].includes(entry)) {
      throw new AppError('PERSONNEL_IMPORT_INVALID', 400, 'Unsupported argument.');
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new AppError('PERSONNEL_IMPORT_INVALID', 400, 'Argument value is missing.');
    result[entry.slice(2)] = value;
    index += 1;
  }
  for (const required of ['file', 'organization-id', 'actor-user-id']) {
    if (typeof result[required] !== 'string') throw new AppError('PERSONNEL_IMPORT_INVALID', 400, 'Required argument is missing.');
  }
  if (result.apply && typeof result['credentials-file'] !== 'string') {
    throw new AppError('MISSING_CREDENTIAL', 400, 'Credential file is required for apply.');
  }
  return result as {
    file: string;
    'organization-id': string;
    'actor-user-id': string;
    'credentials-file'?: string;
    'mapping-output'?: string;
    apply: boolean;
  };
}

async function main() {
  const args = argumentsFrom(process.argv.slice(2));
  const manifest = parsePersonnelManifest(JSON.parse(
    await readFile(path.resolve(args.file), 'utf8'),
  ));
  const credentials = args.apply
    ? await readSecurePersonnelCredentials(path.resolve(args['credentials-file']!))
    : null;
  const config = loadConfig();
  const database = createDatabase(config.databaseUrl, { max: 1, applicationName: 'personnel-onboarding-import' });
  try {
    const output = await importPersonnel(database.pool, {
      organizationId: args['organization-id'],
      actorUserId: args['actor-user-id'],
      manifest,
      credentials,
      apply: args.apply,
    });
    const mappingArtifact = args.apply && args['mapping-output']
      ? await writePersonnelMappingArtifact(args['mapping-output'], args['organization-id'], output.mappings)
      : undefined;
    process.stdout.write(`${JSON.stringify({
      ...output.result,
      mappings: output.mappings,
      ...(mappingArtifact ? { mappingArtifact: { path: mappingArtifact.path, sha256: mappingArtifact.sha256 } } : {}),
    })}\n`);
  } finally {
    await closeDatabase(database);
  }
}

await main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ error: formatPersonnelImportError(error) })}\n`);
  process.exitCode = 1;
});
