import type { Readable } from 'node:stream';

import {
  AbortMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

import {
  buildR2Endpoint,
  R2_REGION,
  validateR2BucketName,
  validateR2Credential,
} from './r2-config.js';

/**
 * BR4 CLOUDFLARE R2 STORAGE ADAPTER (S3-compatible object client).
 *
 * The ONLY approved remote backup provider (BR0 decision 4). The endpoint is
 * derived strictly from the validated account id — there is deliberately no
 * arbitrary endpoint override, so credentials can never be sent to an
 * unintended host. region = "auto" per current Cloudflare guidance.
 *
 * This adapter owns object mechanics only: conditional upload, HEAD,
 * streamed GET, existence/conflict handling, and the create/abort-only
 * multipart connection probe. Domain state transitions and verification
 * composition live in RemoteBackupEngine.
 */

export type R2StorageConfig = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
};

export type R2RemoteMetadata = {
  'servora-backup-id': string;
  'servora-format': string;
  'servora-sha256': string;
};

export type R2ErrorClass =
  | 'AUTH'
  | 'NOT_FOUND'
  | 'PRECONDITION_FAILED'
  | 'OBJECT_TOO_LARGE'
  | 'TRANSPORT'
  | 'SERVICE'
  | 'UNKNOWN';

export class R2StorageError extends Error {
  constructor(
    readonly errorClass: R2ErrorClass,
    readonly operation: string,
    readonly detail: string | null = null,
  ) {
    super(`${operation} failed (${errorClass})`);
    this.name = 'R2StorageError';
  }
}

/** Narrow client surface so tests inject a deterministic fake; production
 * always uses the real S3Client below. */
export type R2SendableClient = {
  send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
  destroy?(): void;
};

export type R2AdapterOptions = {
  config: R2StorageConfig;
  client?: R2SendableClient;
  /** Cooperative cancellation hook for the future BR5 worker (unused by the
   * HTTP surface; BR4 never aborts an in-flight backup transfer itself). */
  signal?: AbortSignal;
};

// Current R2 S3 compatibility documents If-None-Match for PutObject but no
// equivalent atomic destination condition for CompleteMultipartUpload.
// BR4 therefore supports only the conditionally created single-PUT surface.
// Cloudflare labels the limit as 5 GiB, but its limits footnote defines the
// effective maximum as 5 MiB less than 5 GiB. Larger objects fail closed
// before any remote command; multipart remains a separately reconciled slice.
export const R2_MAX_SINGLE_PUT_BYTES = 5 * 1024 ** 3 - 5 * 1024 ** 2;
/** Per SDK operation, deliberately generous for the largest supported stream. */
export const R2_OPERATION_TIMEOUT_MS = 6 * 60 * 60 * 1_000;
/** Overall synchronous ADMIN connection-probe budget. */
export const R2_CONNECTION_TEST_TIMEOUT_MS = 15_000;
/** BR5 owns the phase retry budget; the SDK must not add hidden attempts. */
export const R2_SDK_MAX_ATTEMPTS = 1;

const AUTH_ERROR_NAMES = new Set([
  'InvalidAccessKeyId',
  'SignatureDoesNotMatch',
  'AccessDenied',
  'InvalidToken',
  'ExpiredToken',
  'Unauthorized',
  'Forbidden',
]);

function httpStatus(error: unknown): number | undefined {
  const metadata = (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata;
  return metadata?.httpStatusCode;
}

function classify(error: unknown, operation: string): R2StorageError {
  const rawName = typeof error === 'object' && error !== null
    ? String((error as { name?: unknown }).name ?? '')
    : '';
  const rawCode = typeof error === 'object' && error !== null
    ? String((error as { code?: unknown }).code ?? '')
    : '';
  const safeIdentifier = (value: string) => (
    /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(value) ? value : ''
  );
  const name = safeIdentifier(rawName);
  const code = safeIdentifier(rawCode);
  const status = httpStatus(error);
  let errorClass: R2ErrorClass;
  if (AUTH_ERROR_NAMES.has(name) || status === 401 || status === 403) {
    errorClass = 'AUTH';
  } else if (name === 'NoSuchKey' || name === 'NotFound' || status === 404) {
    errorClass = 'NOT_FOUND';
  } else if (name === 'PreconditionFailed' || status === 412) {
    errorClass = 'PRECONDITION_FAILED';
  } else if ((status ?? 0) >= 500) {
    errorClass = 'SERVICE';
  } else if (name === 'AbortError'
    || /^E(AI|CONN|NSS|HOST|NET|TLS|TIMEOUT|PIPE|EOF)/.test(code)
    || code === 'UND_ERR_CONNECT_TIMEOUT'
    || code === 'UND_ERR_HEADERS_TIMEOUT'
    || (status === undefined && !name)) {
    errorClass = 'TRANSPORT';
  } else {
    errorClass = 'UNKNOWN';
  }
  // Raw SDK messages may contain endpoints, canonical requests, or other
  // request context. Keep only the bounded classification identifiers needed
  // for internal diagnostics; credentials and wire details never cross this
  // adapter boundary.
  const detail = `${name || code || 'error'}${status === undefined ? '' : ` (HTTP ${status})`}`;
  return new R2StorageError(errorClass, operation, detail);
}

function requireCommandOutput<T>(value: unknown): T {
  return value as T;
}

export type R2HeadResult = {
  contentLength: number;
  metadata: Record<string, string>;
  etag: string | null;
} | null;

export type R2ObjectStream = {
  contentLength: number;
  metadata: Record<string, string>;
  body: AsyncIterable<Uint8Array>;
};

export type R2ListObject = {
  key: string;
  size: number | null;
  lastModified: Date | null;
  etag: string | null;
};

export type R2ListResult = {
  objects: R2ListObject[];
  nextContinuationToken: string | null;
};

export type R2UploadOutcome =
  | { outcome: 'created' }
  | { outcome: 'precondition-failed' };

export class CloudflareR2Storage {
  private readonly client: R2SendableClient;
  private readonly bucket: string;
  private readonly signal: AbortSignal | undefined;

  constructor(options: R2AdapterOptions) {
    const endpoint = buildR2Endpoint(options.config.accountId);
    if (!validateR2BucketName(options.config.bucket)
      || !validateR2Credential(options.config.accessKeyId)
      || !validateR2Credential(options.config.secretAccessKey)) {
      throw new Error('R2 storage configuration is invalid');
    }
    this.bucket = options.config.bucket;
    this.signal = options.signal;
    this.client = options.client ?? new S3Client({
      region: R2_REGION,
      endpoint,
      maxAttempts: R2_SDK_MAX_ATTEMPTS,
      credentials: {
        accessKeyId: options.config.accessKeyId,
        secretAccessKey: options.config.secretAccessKey,
      },
    });
  }

  destroy(): void {
    this.client.destroy?.();
  }

  private async send(command: unknown): Promise<unknown> {
    if (this.signal?.aborted) throw new R2StorageError('TRANSPORT', 'aborted', 'operation cancelled');
    const timeoutSignal = AbortSignal.timeout(R2_OPERATION_TIMEOUT_MS);
    const abortSignal = this.signal
      ? AbortSignal.any([this.signal, timeoutSignal])
      : timeoutSignal;
    try {
      return await this.client.send(
        command,
        { abortSignal },
      );
    } catch (error) {
      if (error instanceof R2StorageError) throw error;
      const operation = (command as { constructor: { name: string } }).constructor.name;
      throw classify(error, operation);
    }
  }

  /** HEAD the object; null when it does not exist. */
  async headObject(key: string): Promise<R2HeadResult> {
    try {
      const output = requireCommandOutput<{
        ContentLength?: number;
        Metadata?: Record<string, string>;
        ETag?: string;
      }>(
        await this.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key })),
      );
      return {
        contentLength: output.ContentLength ?? 0,
        metadata: output.Metadata ?? {},
        etag: output.ETag ?? null,
      };
    } catch (error) {
      // A missing object is normal idempotency input. A missing bucket is a
      // configuration failure and must not be mistaken for an absent key.
      if (error instanceof R2StorageError
        && error.errorClass === 'NOT_FOUND'
        && /^(NoSuchKey|NotFound)(?:\s|$)/.test(error.detail ?? '')) return null;
      throw error;
    }
  }

  /**
   * Single atomic no-overwrite PUT (R2 supports If-None-Match on PutObject).
   * Returns 'precondition-failed' when the key already exists — the caller
   * resolves idempotency/conflict; nothing is ever overwritten here.
   */
  async putObjectIfAbsent(key: string, input: {
    body: Readable;
    contentLength: number;
    metadata: R2RemoteMetadata;
  }): Promise<R2UploadOutcome> {
    if (!Number.isSafeInteger(input.contentLength) || input.contentLength <= 0) {
      throw new R2StorageError('UNKNOWN', 'PutObject', 'invalid content length');
    }
    if (input.contentLength > R2_MAX_SINGLE_PUT_BYTES) {
      throw new R2StorageError(
        'OBJECT_TOO_LARGE',
        'PutObject',
        'atomic single-put limit exceeded',
      );
    }
    try {
      await this.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: input.body,
        ContentLength: input.contentLength,
        ContentType: 'application/octet-stream',
        Metadata: input.metadata,
        IfNoneMatch: '*',
      }));
      return { outcome: 'created' };
    } catch (error) {
      if (error instanceof R2StorageError && error.errorClass === 'PRECONDITION_FAILED') {
        return { outcome: 'precondition-failed' };
      }
      throw error;
    }
  }

  /** Streamed GET. The body is an async iterable — never materialized. */
  async getObject(key: string, ifMatch?: string): Promise<R2ObjectStream | null> {
    try {
      const output = requireCommandOutput<{
        ContentLength?: number;
        Metadata?: Record<string, string>;
        Body?: AsyncIterable<Uint8Array>;
      }>(await this.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(ifMatch ? { IfMatch: ifMatch } : {}),
      })));
      if (!output.Body) throw new R2StorageError('UNKNOWN', 'GetObject', 'missing body');
      return {
        contentLength: output.ContentLength ?? 0,
        metadata: output.Metadata ?? {},
        body: output.Body,
      };
    } catch (error) {
      if (error instanceof R2StorageError && error.errorClass === 'NOT_FOUND') return null;
      throw error;
    }
  }

  /** Read-only paginated listing used by the operator restore CLI. */
  async listObjects(prefix: string, continuationToken?: string): Promise<R2ListResult> {
    const output = requireCommandOutput<{
      Contents?: Array<{
        Key?: string;
        Size?: number;
        LastModified?: Date;
        ETag?: string;
      }>;
      NextContinuationToken?: string;
    }>(await this.send(new ListObjectsV2Command({
      Bucket: this.bucket,
      Prefix: prefix,
      MaxKeys: 1_000,
      ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
    })));
    return {
      objects: (output.Contents ?? [])
        .filter((entry): entry is { Key: string; Size?: number; LastModified?: Date; ETag?: string } => (
          typeof entry.Key === 'string'
        ))
        .map((entry) => ({
          key: entry.Key,
          size: typeof entry.Size === 'number' && Number.isSafeInteger(entry.Size) ? entry.Size : null,
          lastModified: entry.LastModified ?? null,
          etag: entry.ETag ?? null,
        })),
      nextContinuationToken: output.NextContinuationToken ?? null,
    };
  }

  /**
   * Connection test probe: bucket read (ListObjectsV2) + write-capability
   * proof via CreateMultipartUpload + immediate AbortMultipartUpload on a
   * reserved probe key. No part is ever uploaded and no completed object is
   * created, so nothing inside a locked retention prefix can retain a probe.
   */
  async testConnection(probeKey: string): Promise<{ ok: true } | { ok: false; errorClass: R2ErrorClass }> {
    try {
      await this.send(new ListObjectsV2Command({ Bucket: this.bucket, MaxKeys: 1 }));
      const create = requireCommandOutput<{ UploadId: string }>(
        await this.send(new CreateMultipartUploadCommand({
          Bucket: this.bucket,
          Key: probeKey,
          ContentType: 'application/octet-stream',
        })),
      );
      if (typeof create.UploadId !== 'string' || create.UploadId.length === 0) {
        return { ok: false, errorClass: 'SERVICE' };
      }
      try {
        await this.send(new AbortMultipartUploadCommand({
          Bucket: this.bucket,
          Key: probeKey,
          UploadId: create.UploadId,
        }));
      } catch (error) {
        // Abort failure is NOT a clean success: report it as a failed probe
        // rather than silently leaving the incomplete upload behind.
        return {
          ok: false,
          errorClass: error instanceof R2StorageError ? error.errorClass : 'UNKNOWN',
        };
      }
      return { ok: true };
    } catch (error) {
      if (error instanceof R2StorageError) return { ok: false, errorClass: error.errorClass };
      return { ok: false, errorClass: 'UNKNOWN' };
    }
  }
}
