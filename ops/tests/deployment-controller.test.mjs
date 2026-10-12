import assert from 'node:assert/strict';
import test from 'node:test';
import { alignIdentityEnvironment, environmentBaseline, validateIdentityTuple } from '../scripts/deployment-controller.mjs';

test('identity alignment changes both pins and preserves every non-identity byte', () => {
  const source = '# protected\nDATABASE_URL=synthetic-only\nHEALTH_SCHEMA_VERSION=001_old\nSERVORA_RELEASE_SHA=' + 'a'.repeat(40) + '\n';
  const next = alignIdentityEnvironment(source, '002_new', 'b'.repeat(40));
  assert.equal(environmentBaseline(next), environmentBaseline(source));
  assert.ok(next.includes('HEALTH_SCHEMA_VERSION=002_new\n'));
  assert.ok(next.includes('SERVORA_RELEASE_SHA=' + 'b'.repeat(40) + '\n'));
  assert.throws(() => alignIdentityEnvironment(source + 'HEALTH_SCHEMA_VERSION=003_extra\n', '002_new', 'b'.repeat(40)), /ENV_IDENTITY_INVALID/);
});

test('env replay accepts only the two approved identities and rejects a third release', () => {
  const grant = { oldReleaseSha: 'a'.repeat(40), releaseSha: 'b'.repeat(40),
    oldCatalog: [{ version: '001_old' }], targetCatalog: [{ version: '002_new' }] };
  assert.doesNotThrow(() => validateIdentityTuple('HEALTH_SCHEMA_VERSION=001_old\nSERVORA_RELEASE_SHA=' + 'b'.repeat(40) + '\n', grant));
  assert.throws(() => validateIdentityTuple('HEALTH_SCHEMA_VERSION=001_old\nSERVORA_RELEASE_SHA=' + 'c'.repeat(40) + '\n', grant), /ENV_IDENTITY_DRIFT/);
});
