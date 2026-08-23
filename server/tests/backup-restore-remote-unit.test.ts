import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { downloadAndVerifyRemote, listRemoteBackups, resolveRemoteBackup } from '../src/modules/backup/restore/remote.js';

describe('BR7 remote discovery', () => {
  it('lists only canonical restore-point objects across paginated R2 pages', async () => {
    const pages = [
      {
        objects: [
          { key: 'production/clinic-01/v1/daily/11111111-2222-4333-8444-555555555555.sbk.age', size: 10 },
          { key: 'production/clinic-01/v1/.connection-test/probe', size: 1 },
        ],
        nextContinuationToken: 'next',
      },
      {
        objects: [
          { key: 'production/clinic-01/v1/manual/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.sbk.age', size: 20 },
          { key: 'production/other/v1/daily/99999999-9999-4999-8999-999999999999.sbk.age', size: 30 },
        ],
        nextContinuationToken: null,
      },
    ];
    let call = 0;
    const result = await listRemoteBackups({
      listObjects: async () => pages[call++]!,
    }, 'clinic-01');

    expect(result.items.map((item) => item.backupId)).toEqual([
      '11111111-2222-4333-8444-555555555555',
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    ]);
    expect(call).toBe(2);
  });

  it('hashes streamed GET bytes against R2 metadata before decrypting', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'br7-remote-'));
    const destination = path.join(root, 'artifact.sbk.age');
    try {
      const body = new TextEncoder().encode('ciphertext');
      const descriptor = {
        backupId: '11111111-2222-4333-8444-555555555555',
        key: 'production/clinic-01/v1/daily/11111111-2222-4333-8444-555555555555.sbk.age',
        retentionClass: 'DAILY' as const,
        sizeBytes: body.byteLength,
        lastModified: null,
        etag: '"etag"',
      };
      const artifact = await downloadAndVerifyRemote({
        headObject: async () => ({
          contentLength: body.byteLength,
          metadata: {
            'servora-backup-id': descriptor.backupId,
            'servora-format': '1',
            'servora-sha256': createHash('sha256').update(body).digest('hex'),
          },
          etag: '"etag"',
        }),
        getObject: async () => ({ contentLength: body.byteLength, metadata: {}, body: [body] }),
      }, descriptor, destination);

      expect(artifact.contentLength).toBe(body.byteLength);
      expect(await readFile(destination, 'utf8')).toBe('ciphertext');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed when one UUID appears in more than one retention directory', async () => {
    const id = '11111111-2222-4333-8444-555555555555';
    const keys = [
      `production/clinic-01/v1/daily/${id}.sbk.age`,
      `production/clinic-01/v1/manual/${id}.sbk.age`,
    ];
    await expect(resolveRemoteBackup({
      listObjects: async () => ({ objects: keys.map((key) => ({ key, size: 1 })), nextContinuationToken: null }),
    }, 'clinic-01', id)).rejects.toThrow(/ambiguous/);
  });

  it('rejects bad metadata before issuing a streamed GET', async () => {
    let getCalls = 0;
    const id = '11111111-2222-4333-8444-555555555555';
    await expect(downloadAndVerifyRemote({
      headObject: async () => ({ contentLength: 1, metadata: { 'servora-format': '1' }, etag: null }),
      getObject: async () => { getCalls += 1; return null; },
    }, {
      backupId: id,
      key: `production/clinic-01/v1/daily/${id}.sbk.age`,
      retentionClass: 'DAILY', sizeBytes: 1, lastModified: null, etag: null,
    }, path.join(os.tmpdir(), 'br7-never-created'))).rejects.toThrow(/metadata/);
    expect(getCalls).toBe(0);
  });

  it('honours cancellation before issuing the remote GET', async () => {
    const controller = new AbortController();
    controller.abort();
    let headCalls = 0;
    await expect(downloadAndVerifyRemote({
      headObject: async () => {
        headCalls += 1;
        return null;
      },
      getObject: async () => null,
    }, {
      backupId: '11111111-2222-4333-8444-555555555555',
      key: 'production/clinic-01/v1/daily/11111111-2222-4333-8444-555555555555.sbk.age',
      retentionClass: 'DAILY', sizeBytes: 1, lastModified: null, etag: null,
    }, path.join(os.tmpdir(), 'br7-cancelled'), controller.signal)).rejects.toThrow(/cancelled/);
    expect(headCalls).toBe(0);
  });
});
