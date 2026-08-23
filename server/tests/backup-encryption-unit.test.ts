import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  HYBRID_RECIPIENT_PREFIX,
  ageVersionSupported,
  validateHybridRecipient,
} from '../src/modules/backup/encryption.js';

// Deterministic bech32-alphabet filler (charset-valid by construction).
const bech32 = (length: number) => 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'.repeat(
  Math.ceil(length / 30),
).slice(0, length);

const hybridRecipient = () => HYBRID_RECIPIENT_PREFIX + bech32(1_950);

describe('BR3 hybrid recipient policy (native age post-quantum only)', () => {
  it('accepts a native hybrid recipient (age1pq1…)', () => {
    const recipient = hybridRecipient();
    const result = validateHybridRecipient(recipient);
    expect(result).toEqual({ ok: true, recipient });
  });

  it('trims surrounding whitespace before validating', () => {
    const recipient = hybridRecipient();
    expect(validateHybridRecipient(`  ${recipient}\n`)).toEqual({ ok: true, recipient });
  });

  it('rejects an empty recipient', () => {
    expect(validateHybridRecipient('')).toEqual({ ok: false, reason: 'EMPTY' });
    expect(validateHybridRecipient('   ')).toEqual({ ok: false, reason: 'EMPTY' });
    expect(validateHybridRecipient(null)).toEqual({ ok: false, reason: 'EMPTY' });
    expect(validateHybridRecipient(undefined)).toEqual({ ok: false, reason: 'EMPTY' });
  });

  it('rejects a classic X25519 recipient (no downgrade path)', () => {
    const classic = `age1${bech32(58)}`;
    expect(classic).toMatch(/^age1(?!pq1)/);
    expect(validateHybridRecipient(classic)).toEqual({ ok: false, reason: 'WRONG_PREFIX' });
  });

  it('rejects SSH recipients', () => {
    expect(validateHybridRecipient('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample'))
      .toEqual({ ok: false, reason: 'WRONG_PREFIX' });
  });

  it('rejects plugin recipients', () => {
    expect(validateHybridRecipient(`age1yubikey1${bech32(58)}`))
      .toEqual({ ok: false, reason: 'WRONG_PREFIX' });
  });

  it('rejects a private identity pasted into the recipient slot', () => {
    expect(validateHybridRecipient(`AGE-SECRET-KEY-PQ-1${bech32(1_000)}`))
      .toEqual({ ok: false, reason: 'WRONG_PREFIX' });
    expect(validateHybridRecipient(`AGE-SECRET-KEY-1${bech32(52)}`))
      .toEqual({ ok: false, reason: 'WRONG_PREFIX' });
  });

  it('rejects shell-metacharacter and non-bech32 content', () => {
    expect(validateHybridRecipient(`${HYBRID_RECIPIENT_PREFIX}${bech32(1_900)};touch /tmp/pwned`))
      .toEqual({ ok: false, reason: 'INVALID_CHARSET' });
    expect(validateHybridRecipient(`${HYBRID_RECIPIENT_PREFIX}${bech32(1_900)}$(id)`))
      .toEqual({ ok: false, reason: 'INVALID_CHARSET' });
    expect(validateHybridRecipient(`${HYBRID_RECIPIENT_PREFIX}${bech32(500)}1BIObad`))
      .toEqual({ ok: false, reason: 'INVALID_CHARSET' });
    expect(validateHybridRecipient(`${HYBRID_RECIPIENT_PREFIX}${bech32(900)}\n${bech32(900)}`))
      .toEqual({ ok: false, reason: 'INVALID_CHARSET' });
  });

  it('rejects hybrid-prefixed values outside the native length window', () => {
    // A classic recipient that happens to start age1pq1 is still ~62 chars.
    const prefixCoincidentClassic = `${HYBRID_RECIPIENT_PREFIX}${bech32(55)}`;
    expect(prefixCoincidentClassic.length).toBeLessThan(100);
    expect(validateHybridRecipient(prefixCoincidentClassic))
      .toEqual({ ok: false, reason: 'LENGTH_OUT_OF_RANGE' });
    expect(validateHybridRecipient(`${HYBRID_RECIPIENT_PREFIX}${bech32(5_000)}`))
      .toEqual({ ok: false, reason: 'LENGTH_OUT_OF_RANGE' });
  });
});

describe('BR3 age version policy (>= 1.3, no classic fallback)', () => {
  it.each([
    ['v1.3.1', true],
    ['v1.3.0', true],
    ['v1.4.0', true],
    ['v1.2.1', false],
    ['v1.0.0', false],
    ['v2.0.0', false],
  ])('%s supported=%s', (raw, expected) => {
    const match = /(\d+)\.(\d+)/.exec(raw);
    expect(ageVersionSupported({ major: Number(match![1]), minor: Number(match![2]) })).toBe(expected);
  });
});

describe('BR3 key material privacy (no private identity in the repository)', () => {
  const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

  // A real PQ identity literal is ~4,000+ chars of base64-ish body; policy
  // code only ever names the PREFIX. No fixture may carry a complete,
  // functional identity.
  const FULL_IDENTITY_PATTERN = /^AGE-SECRET-KEY(-PQ)?-1[A-Z2-7]{500,}$/m;

  it('tracked source trees contain no functional private identity fixture', async () => {
    const scanRoots = ['src', 'tests', '../ops'].map((relative) => path.join(repositoryRoot, relative));
    const violations: string[] = [];
    const scan = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist') continue;
          await scan(entryPath);
          continue;
        }
        if (!/\.(ts|js|mjs|sh|sql|md|example)$/.test(entry.name)) continue;
        const content = await readFile(entryPath, 'utf8');
        if (FULL_IDENTITY_PATTERN.test(content)) violations.push(entryPath);
      }
    };
    for (const root of scanRoots) await scan(root);
    expect(violations).toEqual([]);
  });

  it('production config source exposes no private-identity setting', async () => {
    const configSource = await readFile(path.join(repositoryRoot, 'src/config.ts'), 'utf8');
    expect(configSource).not.toMatch(/BACKUP_ENCRYPTION_IDENTITY|BACKUP_PRIVATE_KEY|AGE_SECRET_KEY/);
  });
});
