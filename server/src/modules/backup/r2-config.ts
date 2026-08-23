/** Shared validation for the security-sensitive R2 endpoint boundary. */

const R2_ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/i;
const R2_BUCKET_PATTERN = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

export const R2_REGION = 'auto';

export function validateR2AccountId(value: string): boolean {
  return R2_ACCOUNT_ID_PATTERN.test(value);
}

export function validateR2BucketName(value: string): boolean {
  return R2_BUCKET_PATTERN.test(value);
}

export function validateR2Credential(value: string): boolean {
  return value.length > 0
    && value.length <= 255
    && !/[\s\u0000-\u001f\u007f]/.test(value);
}

export function buildR2Endpoint(accountId: string): string {
  if (!validateR2AccountId(accountId)) {
    throw new Error('R2 account id is invalid');
  }
  return `https://${accountId}.r2.cloudflarestorage.com`;
}
