import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { decryptAgeArchive, resolveOperatorIdentity } from '../src/modules/backup/restore/decrypt.js';

describe('BR7 age identity boundary', () => {
  it('requires an explicit operator identity path and never falls back to producer config', () => {
    expect(() => resolveOperatorIdentity({})).toThrow(/identity file/);
    expect(() => resolveOperatorIdentity({ identityPath: 'relative/operator.age' })).toThrow(/absolute/);
    expect(resolveOperatorIdentity({ identityPath: '/secure/operator.age' })).toBe('/secure/operator.age');
  });

  it('invokes age with identity/output argv and writes a non-empty plaintext', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'br7-age-'));
    const identity = path.join(root, 'identity');
    const ciphertext = path.join(root, 'artifact.sbk.age');
    const plaintext = path.join(root, 'package.sbk.tar');
    const fakeAge = path.join(root, 'age');
    await writeFile(identity, 'operator identity\n', { mode: 0o600 });
    await writeFile(ciphertext, 'ciphertext');
    await writeFile(fakeAge, `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'age 1.3.1\\n'; exit 0; fi
if [ "$1" != "--decrypt" ] || [ "$2" != "--identity" ] || [ "$4" != "--output" ]; then exit 9; fi
cp "$6" "$5"
`, { mode: 0o700 });
    try {
      await decryptAgeArchive({ ciphertextPath: ciphertext, plaintextPath: plaintext, identityPath: identity, ageBin: fakeAge });
      expect(await readFile(plaintext, 'utf8')).toBe('ciphertext');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
