// Release packaging policy: the root-only bootstrap tool must be reviewed and
// transferred separately, never silently shipped in the production artifact.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';

test('the release artifact excludes the root-only recovery tooling',()=>{
  const script=readFileSync(new URL('../deploy-production.sh',import.meta.url),'utf8');
  assert.match(script,/--exclude='\.\/ops\/recovery-tools\/\*'/);
});
