import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';

import { buildConnectionTestKey } from '../src/modules/backup/object-keys.js';
import { CloudflareR2Storage } from '../src/modules/backup/r2.js';

/**
 * OPT-IN REAL R2 ACCEPTANCE (spec §47). Never runs in CI: it activates only
 * when explicit DISPOSABLE test credentials are exported. Requirements:
 * dedicated non-production test bucket, synthetic artifact only, unique test
 * instance id, no production backup keys, and cleanup limited to objects this
 * run created. Never fabricate or search for production credentials — without
 * these env vars the suite reports REAL_R2_ACCEPTANCE = NOT EXECUTED.
 */

const accountId = process.env.BACKUP_R2_REAL_TEST_ACCOUNT_ID?.trim();
const accessKeyId = process.env.BACKUP_R2_REAL_TEST_ACCESS_KEY_ID?.trim();
const secretAccessKey = process.env.BACKUP_R2_REAL_TEST_SECRET_ACCESS_KEY?.trim();
const bucket = process.env.BACKUP_R2_REAL_TEST_BUCKET?.trim();
const instanceId = process.env.BACKUP_R2_REAL_TEST_INSTANCE_ID?.trim();

const enabled = Boolean(accountId && accessKeyId && secretAccessKey && bucket && instanceId
  && process.env.BACKUP_R2_REAL_TEST_CONFIRM === 'yes-dedicated-disposable-test-bucket');

function sha256OfFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  return new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

describe.skipIf(!enabled)('BR4 REAL R2 acceptance (disposable test bucket)', () => {
  const createStorage = () => new CloudflareR2Storage({
    config: {
      accountId: accountId!,
      accessKeyId: accessKeyId!,
      secretAccessKey: secretAccessKey!,
      bucket: bucket!,
    },
  });

  it('connection test probe succeeds without creating an object', async () => {
    const storage = createStorage();
    try {
      const result = await storage.testConnection(buildConnectionTestKey(instanceId!, randomUUID()));
      expect(result).toEqual({ ok: true });
    } finally {
      storage.destroy();
    }
  });

  it('uploads a synthetic artifact, streams it back byte-exactly, and cleans up', async () => {
    const storage = createStorage();
    const root = await mkdtemp(path.join(tmpdir(), 'servora-br4-real-'));
    const artifactPath = path.join(root, 'synthetic.sbk.age');
    await writeFile(artifactPath, Buffer.alloc(8 * 1024 * 1024, 7));
    const expectedSha = await sha256OfFile(artifactPath);
    const key = `production/${instanceId}/v1/.real-acceptance/${randomUUID()}.sbk.age`;

    try {
      const created = await storage.putObjectIfAbsent(key, {
        body: createReadStream(artifactPath),
        contentLength: (await stat(artifactPath)).size,
        metadata: {
          'servora-backup-id': randomUUID(),
          'servora-format': '1',
          'servora-sha256': expectedSha,
        },
      });
      expect(created).toEqual({ outcome: 'created' });

      const object = await storage.getObject(key);
      expect(object).not.toBeNull();
      expect(object!.metadata['servora-sha256']).toBe(expectedSha);
      const hash = createHash('sha256');
      let bytes = 0;
      for await (const chunk of object!.body) {
        bytes += chunk.byteLength;
        hash.update(chunk);
      }
      expect(bytes).toBe(8 * 1024 * 1024);
      expect(hash.digest('hex')).toBe(expectedSha);

      // Conditional create is genuinely atomic: a second identical PUT to the
      // same key must be refused, never overwrite.
      const second = await storage.putObjectIfAbsent(key, {
        body: createReadStream(artifactPath),
        contentLength: (await stat(artifactPath)).size,
        metadata: {
          'servora-backup-id': randomUUID(),
          'servora-format': '1',
          'servora-sha256': '0'.repeat(64),
        },
      });
      expect(second).toEqual({ outcome: 'precondition-failed' });
      const after = await storage.getObject(key);
      expect(after!.metadata['servora-sha256']).toBe(expectedSha);
    } finally {
      // Cleanup: ONLY the object this test created.
      const client = new S3Client({
        region: 'auto',
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey! },
      });
      try {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
        expect(await storage.headObject(key)).toBeNull();
      } finally {
        client.destroy();
        storage.destroy();
        await rm(root, { recursive: true, force: true });
      }
    }
  });
});
