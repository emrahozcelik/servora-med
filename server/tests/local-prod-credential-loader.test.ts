import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const loader = fileURLToPath(new URL('../../ops/local-ci/load-prod-env.sh', import.meta.url));
const runner = fileURLToPath(new URL('../../ops/deploy-production.sh', import.meta.url));

function tempDir(prefix: string) {
  return mkdtempSync(join(tmpdir(), `servora-cred-${prefix}-`));
}

/** Synthetic credential set: throwaway ed25519 key, never real material. */
function makeSyntheticCreds() {
  const dir = tempDir('keys');
  execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', join(dir, 'id_synth'), '-q']);
  chmodSync(join(dir, 'id_synth'), 0o600);
  const keyPath = join(dir, 'id_synth');
  const knownHosts = join(dir, 'known_hosts');
  writeFileSync(knownHosts, 'prod.example ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFN5bnRoZXRpY2tleW1hdGVyaWFsZm9ydGVzdGluZw\n');
  chmodSync(knownHosts, 0o644);
  return { dir, keyPath, knownHosts };
}

function writeEnvFile(dir: string, lines: string[]) {
  const file = join(dir, 'prod.env');
  writeFileSync(file, `${lines.join('\n')}\n`);
  chmodSync(file, 0o600);
  return file;
}

function goodLines(creds: { keyPath: string; knownHosts: string }) {
  return [
    'SERVORA_PROD_HOST=prod.example',
    'SERVORA_PROD_SSH_USER=servora-deploy',
    `SERVORA_PROD_SSH_KEY_FILE=${creds.keyPath}`,
    `SERVORA_PROD_KNOWN_HOSTS_FILE=${creds.knownHosts}`,
    'SERVORA_PROD_FQDN=prod.example',
  ];
}

function runLoader(args: string[]) {
  return spawnSync('bash', [loader, ...args], { encoding: 'utf8' });
}

describe('load-prod-env.sh key-file credential format', () => {
  it('accepts a protected key-file reference without exposing key material', () => {
    const creds = makeSyntheticCreds();
    try {
      const file = writeEnvFile(creds.dir, goodLines(creds));
      const check = runLoader(['--check', '--file', file]);
      expect(check.status).toBe(0);
      expect(check.stdout).toContain('CRED_CHECK_PASS');
      const keyMaterial = readFileSync(creds.keyPath, 'utf8').trim().split('\n')[1] ?? '';
      expect(`${check.stdout}${check.stderr}`).not.toContain(keyMaterial);

      const loaded = runLoader(['--file', file]);
      expect(loaded.status).toBe(0);
      expect(loaded.stdout).toContain(`SERVORA_PROD_SSH_KEY_FILE=${creds.keyPath}`);
      expect(`${loaded.stdout}${loaded.stderr}`).not.toContain(keyMaterial);
    } finally {
      rmSync(creds.dir, { recursive: true, force: true });
    }
  });

  it('rejects symlink, permissive-mode, missing, malformed and oversized key files', () => {
    const setups: Array<[string, (creds: { dir: string; keyPath: string; knownHosts: string }) => void, RegExp]> = [
      ['symlink', (creds) => {
        const link = join(creds.dir, 'link-key');
        symlinkSync(creds.keyPath, link);
        writeEnvFile(creds.dir, goodLines(creds).map((l) =>
          (l.startsWith('SERVORA_PROD_SSH_KEY_FILE=') ? `SERVORA_PROD_SSH_KEY_FILE=${link}` : l)));
      }, /SYMLINK/],
      ['group-readable', (creds) => {
        chmodSync(creds.keyPath, 0o640);
        writeEnvFile(creds.dir, goodLines(creds));
      }, /PERMISSIONS/],
      ['missing', (creds) => {
        writeEnvFile(creds.dir, goodLines(creds).map((l) =>
          (l.startsWith('SERVORA_PROD_SSH_KEY_FILE=') ? 'SERVORA_PROD_SSH_KEY_FILE=/nonexistent/key' : l)));
      }, /MISSING|NOT_FOUND/],
      ['malformed', (creds) => {
        writeFileSync(creds.keyPath, 'not a private key\n');
        chmodSync(creds.keyPath, 0o600);
        writeEnvFile(creds.dir, goodLines(creds));
      }, /FORMAT/],
      ['oversized', (creds) => {
        writeFileSync(creds.keyPath, `-----BEGIN OPENSSH PRIVATE KEY-----\n${'A'.repeat(20000)}\n-----END OPENSSH PRIVATE KEY-----\n`);
        chmodSync(creds.keyPath, 0o600);
        writeEnvFile(creds.dir, goodLines(creds));
      }, /SIZE/],
      ['inline-key-forbidden', (creds) => {
        writeEnvFile(creds.dir, [...goodLines(creds), 'SERVORA_PROD_SSH_KEY=inline-material']);
      }, /INLINE/],
    ];
    for (const [name, setup, pattern] of setups) {
      const creds = makeSyntheticCreds();
      try {
        setup(creds);
        const file = join(creds.dir, 'prod.env');
        const result = runLoader(['--check', '--file', file]);
        expect(result.status, name).not.toBe(0);
        expect(`${result.stdout}${result.stderr}`, name).toMatch(pattern);
      } finally {
        rmSync(creds.dir, { recursive: true, force: true });
      }
    }
  });

  it('rejects malformed known_hosts identity without exposing secrets', () => {
    const creds = makeSyntheticCreds();
    try {
      writeFileSync(creds.knownHosts, 'this is not a known_hosts line\n');
      const file = writeEnvFile(creds.dir, goodLines(creds));
      const result = runLoader(['--check', '--file', file]);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toMatch(/KNOWN_HOSTS/);
    } finally {
      rmSync(creds.dir, { recursive: true, force: true });
    }
  });

  it('lets the deploy gate use the key file and refuses root SSH', () => {
    const creds = makeSyntheticCreds();
    try {
      const file = writeEnvFile(creds.dir, goodLines(creds));
      const check = runLoader(['--check', '--file', file]);
      expect(check.status).toBe(0);
      const runSourced = (body: string, env: NodeJS.ProcessEnv) => spawnSync('bash',
        ['-c', `source "$1"\n${body}`, 'sourced-test', runner],
        { encoding: 'utf8', env: { ...process.env, ...env } });
      const baseEnv = {
        SERVORA_PROD_HOST: 'prod.example',
        SERVORA_PROD_SSH_KEY_FILE: creds.keyPath,
        SERVORA_PROD_KNOWN_HOSTS_FILE: creds.knownHosts,
        SERVORA_PROD_FQDN: 'prod.example',
        SERVORA_PROD_SSH_USER: 'servora-deploy',
      };
      const ok = runSourced('validate_host_identity; echo IDENTITY_OK', baseEnv);
      expect(ok.status).toBe(0);
      expect(ok.stdout).toContain('IDENTITY_OK');
      const root = runSourced('validate_host_identity', { ...baseEnv, SERVORA_PROD_SSH_USER: 'root' });
      expect(root.status).not.toBe(0);
      expect(`${root.stdout}${root.stderr}`).toContain('ROOT_SSH_USER_FORBIDDEN');
      const missing = runSourced('validate_host_identity',
        { ...baseEnv, SERVORA_PROD_SSH_KEY_FILE: '/nonexistent/key' });
      expect(missing.status).not.toBe(0);
    } finally {
      rmSync(creds.dir, { recursive: true, force: true });
    }
  });
});
