import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';

import {
  buildRemoteObjectKey,
  validateBackupInstanceId,
} from '../object-keys.js';
import type { R2HeadResult, R2ObjectStream } from '../r2.js';
import type { BackupRetentionClass } from '../types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_RESTORE_CIPHERTEXT_BYTES = 5_363_466_240;
const RETENTION_BY_SEGMENT: Readonly<Record<string, BackupRetentionClass>> = {
  daily: 'DAILY',
  weekly: 'WEEKLY',
  monthly: 'MONTHLY',
  manual: 'MANUAL',
  'pre-restore': 'PRE_RESTORE',
};

export type RemoteListObject = {
  key?: string;
  size?: number | null;
  lastModified?: Date | null;
  etag?: string | null;
};

export type RemoteListPage = {
  objects: readonly RemoteListObject[];
  nextContinuationToken: string | null;
};

export type RestoreRemoteStore = {
  listObjects(prefix: string, continuationToken?: string): Promise<RemoteListPage>;
  headObject(key: string): Promise<R2HeadResult>;
  getObject(key: string, ifMatch?: string): Promise<R2ObjectStream | null>;
};

export type RemoteBackupDescriptor = {
  backupId: string;
  key: string;
  retentionClass: BackupRetentionClass;
  sizeBytes: number | null;
  lastModified: string | null;
  etag: string | null;
};

export class RestoreRemoteError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'RESTORE_MANIFEST_INVALID'
      | 'RESTORE_CHECKSUM_FAILED'
      | 'REMOTE_CHECKSUM_MISMATCH' = 'RESTORE_MANIFEST_INVALID',
  ) {
    super(message);
    this.name = 'RestoreRemoteError';
  }
}

function remoteRoot(instanceId: string): string {
  if (!validateBackupInstanceId(instanceId)) throw new RestoreRemoteError('backup instance id is invalid');
  return `production/${instanceId}/v1/`;
}

function parseCanonicalKey(key: string, instanceId: string): RemoteBackupDescriptor | null {
  const match = new RegExp(
    `^production/${instanceId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/v1/(daily|weekly|monthly|pre-restore|manual)/([0-9a-f-]{36})\\.sbk\\.age$`,
    'i',
  ).exec(key);
  if (!match || !UUID.test(match[2]!)) return null;
  const retentionClass = RETENTION_BY_SEGMENT[match[1]!.toLowerCase()];
  if (!retentionClass) return null;
  return {
    backupId: match[2]!.toLowerCase(),
    key,
    retentionClass,
    sizeBytes: null,
    lastModified: null,
    etag: null,
  };
}

export async function listRemoteBackups(
  store: Pick<RestoreRemoteStore, 'listObjects'>,
  instanceId: string,
  options: { maxPages?: number } = {},
): Promise<{ items: RemoteBackupDescriptor[]; pages: number }> {
  const prefix = remoteRoot(instanceId);
  const maxPages = options.maxPages ?? 100;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 10_000) {
    throw new RestoreRemoteError('remote list page budget is invalid');
  }
  const items: RemoteBackupDescriptor[] = [];
  const seen = new Set<string>();
  let token: string | undefined;
  let pages = 0;
  while (pages < maxPages) {
    const page = await store.listObjects(prefix, token);
    pages += 1;
    for (const object of page.objects) {
      if (typeof object.key !== 'string') continue;
      const descriptor = parseCanonicalKey(object.key, instanceId);
      if (!descriptor || seen.has(descriptor.key)) continue;
      seen.add(descriptor.key);
      items.push({
        ...descriptor,
        sizeBytes: typeof object.size === 'number' && Number.isSafeInteger(object.size)
          ? object.size
          : null,
        lastModified: object.lastModified?.toISOString() ?? null,
        etag: object.etag ?? null,
      });
    }
    if (!page.nextContinuationToken) return { items, pages };
    token = page.nextContinuationToken;
  }
  throw new RestoreRemoteError('remote listing exceeded the bounded page budget');
}

export async function resolveRemoteBackup(
  store: Pick<RestoreRemoteStore, 'listObjects'>,
  instanceId: string,
  archiveOrId: string,
): Promise<RemoteBackupDescriptor> {
  const direct = parseCanonicalKey(archiveOrId, instanceId);
  if (direct) return direct;
  if (!UUID.test(archiveOrId)) throw new RestoreRemoteError('archive-or-id must be a UUID or canonical remote key');
  const result = await listRemoteBackups(store, instanceId);
  const matches = result.items.filter((item) => item.backupId === archiveOrId.toLowerCase());
  if (matches.length === 0) throw new RestoreRemoteError('backup id was not found');
  if (matches.length !== 1) throw new RestoreRemoteError('backup id is ambiguous across retention prefixes');
  return matches[0]!;
}

function metadataValue(metadata: Record<string, string>, key: string): string | undefined {
  const wanted = key.toLowerCase();
  const entry = Object.entries(metadata).find(([name]) => name.toLowerCase() === wanted);
  return entry?.[1];
}

export type VerifiedRemoteArtifact = {
  key: string;
  backupId: string;
  ciphertextPath: string;
  contentLength: number;
  sha256: string;
  etag: string | null;
};

/** HEAD metadata and streamed GET bytes/hash are verified before decryption. */
export async function downloadAndVerifyRemote(
  store: Pick<RestoreRemoteStore, 'headObject' | 'getObject'>,
  descriptor: RemoteBackupDescriptor,
  destination: string,
  signal?: AbortSignal,
): Promise<VerifiedRemoteArtifact> {
  if (signal?.aborted) throw new RestoreRemoteError('remote restore was cancelled', 'RESTORE_CHECKSUM_FAILED');
  const head = await store.headObject(descriptor.key);
  if (!head) throw new RestoreRemoteError('remote backup object is missing', 'RESTORE_CHECKSUM_FAILED');
  const backupId = metadataValue(head.metadata, 'servora-backup-id');
  const format = metadataValue(head.metadata, 'servora-format');
  const expectedSha = metadataValue(head.metadata, 'servora-sha256');
  if (backupId?.toLowerCase() !== descriptor.backupId || format !== '1' || !expectedSha || !/^[0-9a-f]{64}$/.test(expectedSha)) {
    throw new RestoreRemoteError('remote metadata is incomplete or inconsistent', 'RESTORE_CHECKSUM_FAILED');
  }
  if (!Number.isSafeInteger(head.contentLength) || head.contentLength <= 0 || head.contentLength > MAX_RESTORE_CIPHERTEXT_BYTES) {
    throw new RestoreRemoteError('remote content length is invalid', 'RESTORE_CHECKSUM_FAILED');
  }

  if (signal?.aborted) throw new RestoreRemoteError('remote restore was cancelled', 'RESTORE_CHECKSUM_FAILED');
  const object = await store.getObject(descriptor.key, head.etag ?? undefined);
  if (!object) throw new RestoreRemoteError('remote backup disappeared before GET', 'RESTORE_CHECKSUM_FAILED');
  if (object.contentLength !== head.contentLength) {
    throw new RestoreRemoteError('HEAD and GET content lengths differ', 'REMOTE_CHECKSUM_MISMATCH');
  }

  const file = await open(destination, 'wx', 0o600);
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    for await (const chunk of object.body) {
      if (signal?.aborted) throw new RestoreRemoteError('remote restore was cancelled', 'RESTORE_CHECKSUM_FAILED');
      const value = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      bytes += value.byteLength;
      if (!Number.isSafeInteger(bytes)) throw new RestoreRemoteError('remote byte count overflow', 'REMOTE_CHECKSUM_MISMATCH');
      hash.update(value);
      await file.write(value);
    }
  } finally {
    await file.close();
  }
  const sha256 = hash.digest('hex');
  if (bytes !== head.contentLength || sha256 !== expectedSha) {
    throw new RestoreRemoteError('remote byte count or SHA-256 does not match metadata', 'REMOTE_CHECKSUM_MISMATCH');
  }
  return {
    key: descriptor.key,
    backupId: descriptor.backupId,
    ciphertextPath: destination,
    contentLength: bytes,
    sha256,
    etag: head.etag,
  };
}

/** Exposed for exact-key tests and to avoid ad-hoc key construction in CLI. */
export function canonicalRemoteKey(input: {
  instanceId: string;
  retentionClass: BackupRetentionClass;
  backupId: string;
}): string {
  return buildRemoteObjectKey(input);
}
