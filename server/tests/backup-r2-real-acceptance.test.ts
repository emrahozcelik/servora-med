import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';

import { buildConnectionTestKey } from '../src/modules/backup/object-keys.js';
import { CloudflareR2Storage } from '../src/modules/backup/r2.js';
import { buildR2Endpoint } from '../src/modules/backup/r2-config.js';

/**
 * OPTIONAL BR4-ONLY REAL R2 TRANSPORT PROBE. The full DR acceptance lives in
 * backup-dr-full-acceptance.test.ts. This narrow regression never runs in CI:
 * it activates only when the shared dedicated acceptance credentials and an
 * additional BR4-probe opt-in are exported. Requirements:
 * dedicated non-production test bucket, synthetic artifact only, unique test
 * instance id, no production backup keys, and cleanup limited to objects this
 * run created. Never fabricate or search for production credentials — without
 * these env vars the test is skipped. It is not authoritative DR evidence.
 */

const accountId = process.env.SERVORA_ACCEPTANCE_R2_ACCOUNT_ID?.trim();
const accessKeyId = process.env.SERVORA_ACCEPTANCE_R2_ACCESS_KEY_ID?.trim();
const secretAccessKey = process.env.SERVORA_ACCEPTANCE_R2_SECRET_ACCESS_KEY?.trim();
const bucket = process.env.SERVORA_ACCEPTANCE_R2_BUCKET?.trim();
const instanceId = `acceptance-br4-${randomUUID().replaceAll('-', '').slice(0, 16)}`;
const productionDistinct = bucket !== process.env.BACKUP_R2_BUCKET?.trim()
  && !(accessKeyId === process.env.BACKUP_R2_ACCESS_KEY_ID?.trim()
    && secretAccessKey === process.env.BACKUP_R2_SECRET_ACCESS_KEY?.trim());

const enabled = Boolean(accountId && accessKeyId && secretAccessKey && bucket && instanceId
  && productionDistinct
  && process.env.SERVORA_ACCEPTANCE_REAL_R2 === '1'
  && process.env.SERVORA_ACCEPTANCE_REAL_R2_CONFIRM === 'explicit-operator-opt-in'
  && process.env.SERVORA_ACCEPTANCE_BR4_R2_PROBE === '1');

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
        endpoint: buildR2Endpoint(accountId!),
        maxAttempts: 1,
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
