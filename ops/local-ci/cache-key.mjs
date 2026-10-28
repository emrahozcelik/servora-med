import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function cacheKey(root, kind, platform, toolchain = '') {
  if (!['linux/arm64', 'linux/amd64'].includes(platform)) throw new Error('CACHE_PLATFORM_INVALID');
  const files = kind === 'web-image'
    ? ['web/package.json', 'web/package-lock.json', 'ops/local-ci/images/web.Dockerfile', 'ops/local-ci/browser-availability.mjs']
    : kind === 'server' || kind === 'web' ? [`${kind}/package.json`, `${kind}/package-lock.json`] : [];
  if (!files.length) throw new Error('CACHE_KIND_INVALID');
  if (kind !== 'web-image') {
    const runtime = JSON.parse(toolchain);
    if (runtime.platform !== 'linux' || runtime.arch !== (platform === 'linux/amd64' ? 'x64' : 'arm64')
      || !/^v22\./.test(runtime.node) || !/^\d+\.\d+\.\d+$/.test(runtime.npm)) throw new Error('CACHE_TOOLCHAIN_INVALID');
  }
  const hash = createHash('sha256').update(JSON.stringify(['servora-localci-cache-v1', kind, platform, toolchain]));
  for (const file of files) hash.update(file).update('\0').update(fs.readFileSync(path.join(root, file))).update('\0');
  return hash.digest('hex');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [kind, root, platform, toolchain] = process.argv.slice(2);
  console.log(cacheKey(root, kind, platform, toolchain));
}
