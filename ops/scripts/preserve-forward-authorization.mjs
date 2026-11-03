#!/usr/bin/env node
// One-time post-recovery preparation. Preserves the exact current top-level
// authorization under its attempt directory BEFORE a successor continuity
// grant replaces it. No history is rewritten: the file is copied byte-for-byte,
// its SHA-256 is verified, and an existing copy must match exactly.
//
// Production execution is a separate, explicitly authorized operation.
import {existsSync, lstatSync} from 'node:fs';
import {dirname} from 'node:path';
import {preserveAttemptAuthorization} from './forward-host-continuity.mjs';

const HELP = 'usage: preserve-forward-authorization --attempt-id <uuid> --expected-sha256 <64-hex> '
  + '[--source <path>] [--destination <path>]';
const fail = code => { console.error(code); process.exit(1); };
const argv = process.argv.slice(2);
if (argv.includes('--help')) { console.log(HELP); process.exit(0); }
const flags = {};
for (let index = 0; index < argv.length; index += 2) {
  const key = argv[index];
  if (!['--attempt-id', '--expected-sha256', '--source', '--destination'].includes(key)
    || argv[index + 1] === undefined) fail('ARGUMENTS_INVALID');
  flags[key.slice(2)] = argv[index + 1];
}
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(flags['attempt-id'] ?? '')
  || !/^[0-9a-f]{64}$/.test(flags['expected-sha256'] ?? '')) fail('ARGUMENTS_INVALID');
if (process.getuid?.() !== 0) fail('ROOT_REQUIRED');
const source = flags.source ?? '/var/lib/servora-med/deploy/forward/authorization.json';
const destination = flags.destination
  ?? '/var/lib/servora-med/deploy/forward/' + flags['attempt-id'] + '/authorization.json';
const directory = dirname(destination);
if (!existsSync(directory)) fail('ATTEMPT_DIRECTORY_MISSING');
const info = lstatSync(directory);
if (!info.isDirectory() || info.uid !== 0 || (info.mode & 0o7777) !== 0o700) fail('ATTEMPT_DIRECTORY_UNTRUSTED');
try {
  const created = preserveAttemptAuthorization({source, destination,
    expectedSha: flags['expected-sha256']});
  console.log(JSON.stringify({status: 'FORWARD_AUTHORIZATION_PRESERVED',
    attemptId: flags['attempt-id'], destination, created, sha256: flags['expected-sha256']}));
} catch (error) {
  fail(error.message || 'PRESERVATION_FAILED');
}
