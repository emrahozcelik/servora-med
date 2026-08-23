import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import {
  buildConnectionTestKey,
  buildRemoteObjectKey,
  validateBackupInstanceId,
} from '../src/modules/backup/object-keys.js';
import {
  CloudflareR2Storage,
  R2_MAX_SINGLE_PUT_BYTES,
  R2StorageError,
  type R2SendableClient,
} from '../src/modules/backup/r2.js';
import {
  buildR2Endpoint,
  R2_REGION,
  validateR2BucketName,
} from '../src/modules/backup/r2-config.js';

const TEST_R2_CONFIG = {
  accountId: 'a'.repeat(32),
  accessKeyId: 'test-key',
  secretAccessKey: 'test-secret',
  bucket: 'servora-test-bucket',
};

describe('BR4 deterministic object key contract', () => {
  const instanceId = 'b7f3e2a1-9c4d-4e5f-8a6b-2d1c0b9a8e7f';
  const backupId = '1f0e3dad-9990-6f67-a2f3-2b2c55d5a6b7';

  it.each([
    ['DAILY', 'daily'],
    ['WEEKLY', 'weekly'],
    ['MONTHLY', 'monthly'],
    ['MANUAL', 'manual'],
    ['PRE_RESTORE', 'pre-restore'],
  ] as const)('maps %s to the exact canonical key', (retentionClass, segment) => {
    expect(buildRemoteObjectKey({ instanceId, retentionClass, backupId })).toBe(
      `production/${instanceId}/v1/${segment}/${backupId}.sbk.age`,
    );
  });

  it('normalizes an uppercase backup UUID to lowercase', () => {
    expect(buildRemoteObjectKey({
      instanceId,
      retentionClass: 'DAILY',
      backupId: backupId.toUpperCase(),
    })).toBe(`production/${instanceId}/v1/daily/${backupId}.sbk.age`);
  });

  it('contains no timestamps, names, or user input beyond the fixed derivation', () => {
    const key = buildRemoteObjectKey({ instanceId, retentionClass: 'MANUAL', backupId });
    expect(key.split('/')).toHaveLength(5);
    expect(key).not.toMatch(/20\d{2}-|clinic|doctor|servora-med\b/i);
  });

  it('connection test probe key lives under the reserved non-restore prefix', () => {
    const probeId = randomUUID();
    expect(buildConnectionTestKey(instanceId, probeId)).toBe(
      `production/${instanceId}/v1/.connection-test/${probeId}`,
    );
    expect(buildConnectionTestKey(instanceId, probeId)).not.toMatch(/\/(daily|weekly|monthly|manual|pre-restore)\//);
  });
});

describe('BR4 backup instance id grammar', () => {
  it('accepts opaque slugs (uuid, random slug, dotted)', () => {
    expect(validateBackupInstanceId('b7f3e2a1-9c4d-4e5f-8a6b-2d1c0b9a8e7f')).toBe(true);
    expect(validateBackupInstanceId('backup-01')).toBe(true);
    expect(validateBackupInstanceId('a.b_c-9')).toBe(true);
    expect(validateBackupInstanceId('A')).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['slash', 'prod/instance'],
    ['backslash', 'prod\\instance'],
    ['traversal', '../etc'],
    ['embedded traversal', 'ok..../bad'],
    ['whitespace', 'has space'],
    ['tab', 'has\ttab'],
    ['newline', 'has\nnewline'],
    ['control char', 'has\u0007ctl'],
    ['unicode', 'yedek-iş-01'],
    ['leading dot', '.hidden'],
    ['leading dash', '-lead'],
    ['too long', 'a'.repeat(64)],
  ])('rejects %s', (_label, value) => {
    expect(validateBackupInstanceId(value)).toBe(false);
    expect(() => buildRemoteObjectKey({
      instanceId: value,
      retentionClass: 'DAILY',
      backupId: randomUUID(),
    })).toThrow(/instance id/);
  });

  it('cannot mechanically reject customer-LIKE names — documented operator responsibility', () => {
    // The grammar is deliberately opaque; the "do not derive from
    // organization/customer names" rule is an operator contract documented
    // in architecture/env examples, not something a charset can prove.
    expect(validateBackupInstanceId('some-valid-slug')).toBe(true);
  });
});

describe('BR4 R2 adapter safety boundary', () => {
  it('derives the only allowed endpoint from a validated account id and uses region auto', () => {
    expect(buildR2Endpoint('a'.repeat(32))).toBe(
      `https://${'a'.repeat(32)}.r2.cloudflarestorage.com`,
    );
    expect(R2_REGION).toBe('auto');
    expect(() => buildR2Endpoint('attacker.example')).toThrow(/account id/);
    expect(validateR2BucketName('servora-backups-01')).toBe(true);
    expect(validateR2BucketName('servora.backups')).toBe(false);
  });

  it('passes AbortSignal through the SDK send options without mutating command input', async () => {
    const controller = new AbortController();
    let capturedOptions: { abortSignal?: AbortSignal } | undefined;
    let capturedInput: Record<string, unknown> | undefined;
    const client: R2SendableClient = {
      send: async (command, options) => {
        capturedOptions = options;
        capturedInput = (command as { input: Record<string, unknown> }).input;
        return { ContentLength: 1, Metadata: {}, ETag: '"etag"' };
      },
    };
    const storage = new CloudflareR2Storage({ config: TEST_R2_CONFIG, client, signal: controller.signal });

    await expect(storage.headObject('safe-key')).resolves.toMatchObject({ contentLength: 1, etag: '"etag"' });
    expect(capturedOptions?.abortSignal).toBeInstanceOf(AbortSignal);
    expect(capturedOptions?.abortSignal?.aborted).toBe(false);
    expect(capturedInput).not.toHaveProperty('abortSignal');
  });

  it('refuses an already-aborted operation before invoking the SDK client', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const client: R2SendableClient = {
      send: async () => {
        calls += 1;
        return {};
      },
    };
    const storage = new CloudflareR2Storage({ config: TEST_R2_CONFIG, client, signal: controller.signal });

    await expect(storage.headObject('safe-key')).rejects.toMatchObject({
      name: 'R2StorageError',
      errorClass: 'TRANSPORT',
    });
    expect(calls).toBe(0);
  });

  it('allows the exact effective R2 single-PUT maximum', async () => {
    let calls = 0;
    let contentLength: number | undefined;
    const client: R2SendableClient = {
      send: async (command) => {
        calls += 1;
        contentLength = (command as { input: { ContentLength?: number } }).input.ContentLength;
        return {};
      },
    };
    const storage = new CloudflareR2Storage({ config: TEST_R2_CONFIG, client });

    expect(R2_MAX_SINGLE_PUT_BYTES).toBe(5_363_466_240);
    await expect(storage.putObjectIfAbsent('safe-key', {
      body: Readable.from([Buffer.from('x')]),
      contentLength: R2_MAX_SINGLE_PUT_BYTES,
      metadata: {
        'servora-backup-id': randomUUID(),
        'servora-format': '1',
        'servora-sha256': '0'.repeat(64),
      },
    })).resolves.toEqual({ outcome: 'created' });
    expect(calls).toBe(1);
    expect(contentLength).toBe(R2_MAX_SINGLE_PUT_BYTES);
  });

  it('rejects one byte above the effective R2 single-PUT maximum before any client call', async () => {
    let calls = 0;
    const client: R2SendableClient = {
      send: async () => {
        calls += 1;
        return {};
      },
    };
    const storage = new CloudflareR2Storage({ config: TEST_R2_CONFIG, client });
    const upload = storage.putObjectIfAbsent('safe-key', {
      body: Readable.from([Buffer.from('x')]),
      contentLength: R2_MAX_SINGLE_PUT_BYTES + 1,
      metadata: {
        'servora-backup-id': randomUUID(),
        'servora-format': '1',
        'servora-sha256': '0'.repeat(64),
      },
    });

    await expect(upload).rejects.toMatchObject({
      errorClass: 'OBJECT_TOO_LARGE',
    });
    expect(calls).toBe(0);
  });

  it('rejects a literal 5 GiB single PUT before any client call', async () => {
    let calls = 0;
    const client: R2SendableClient = {
      send: async () => {
        calls += 1;
        return {};
      },
    };
    const storage = new CloudflareR2Storage({ config: TEST_R2_CONFIG, client });
    const upload = storage.putObjectIfAbsent('safe-key', {
      body: Readable.from([Buffer.from('x')]),
      contentLength: 5 * 1024 ** 3,
      metadata: {
        'servora-backup-id': randomUUID(),
        'servora-format': '1',
        'servora-sha256': '0'.repeat(64),
      },
    });

    await expect(upload).rejects.toMatchObject({
      errorClass: 'OBJECT_TOO_LARGE',
    });
    expect(calls).toBe(0);
  });

  it('fails the connection probe safely when R2 omits the multipart upload id', async () => {
    const operations: string[] = [];
    const client: R2SendableClient = {
      send: async (command) => {
        const operation = (command as { constructor: { name: string } }).constructor.name;
        operations.push(operation);
        if (operation === 'CreateMultipartUploadCommand') return {};
        return { Contents: [] };
      },
    };
    const storage = new CloudflareR2Storage({ config: TEST_R2_CONFIG, client });

    await expect(storage.testConnection('production/test/v1/.connection-test/probe'))
      .resolves.toEqual({ ok: false, errorClass: 'SERVICE' });
    expect(operations).toEqual(['ListObjectsV2Command', 'CreateMultipartUploadCommand']);
  });

  it('does not mistake a missing bucket for an absent object key', async () => {
    const client: R2SendableClient = {
      send: async () => {
        throw Object.assign(new Error('bucket missing'), {
          name: 'NoSuchBucket',
          $metadata: { httpStatusCode: 404 },
        });
      },
    };
    const storage = new CloudflareR2Storage({ config: TEST_R2_CONFIG, client });

    await expect(storage.headObject('safe-key')).rejects.toBeInstanceOf(R2StorageError);
    await expect(storage.headObject('safe-key')).rejects.toMatchObject({
      errorClass: 'NOT_FOUND',
      detail: 'NoSuchBucket (HTTP 404)',
    });
  });

  it('discards raw SDK error text and unsafe identifiers at the adapter boundary', async () => {
    const client: R2SendableClient = {
      send: async () => {
        throw Object.assign(new Error('https://secret-endpoint.invalid Authorization=secret'), {
          name: 'unsafe\nhttps://secret-endpoint.invalid',
        });
      },
    };
    const storage = new CloudflareR2Storage({ config: TEST_R2_CONFIG, client });

    const failure = await storage.headObject('safe-key').catch((error: unknown) => error);
    expect(failure).toMatchObject({ detail: 'error' });
    expect(JSON.stringify(failure)).not.toMatch(/secret-endpoint|Authorization=secret/);
  });
});
