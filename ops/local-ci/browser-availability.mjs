// Used at image build and by the existing web-playwright-install evidence gate.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const metadataPath = '/opt/servora-playwright/image.json';
function systemMetadata() {
  const osRelease = fs.readFileSync('/etc/os-release', 'utf8');
  assert.match(osRelease, /^ID=debian$/m, 'BROWSER_OS_MISMATCH');
  assert.match(osRelease, /^VERSION_CODENAME=bookworm$/m, 'BROWSER_OS_VERSION_MISMATCH');
  const packages = execFileSync('dpkg-query', ['-W'], { encoding: 'utf8' });
  return { osRelease, packagesSha256: createHash('sha256').update(packages).digest('hex') };
}

export function installedMetadata(root) {
  const require = createRequire(path.join(root, 'package.json'));
  const bytes = fs.readFileSync(path.join(root, 'package-lock.json'));
  const lock = JSON.parse(bytes);
  const playwright = require('playwright/package.json').version;
  const core = require('playwright-core/package.json').version;
  assert.equal(playwright, lock.packages['node_modules/playwright'].version, 'PLAYWRIGHT_LOCK_MISMATCH');
  assert.equal(core, lock.packages['node_modules/playwright-core'].version, 'PLAYWRIGHT_CORE_LOCK_MISMATCH');
  assert.equal(core, playwright, 'PLAYWRIGHT_CORE_VERSION_MISMATCH');
  return {
    lockSha256: createHash('sha256').update(bytes).digest('hex'), playwright, core,
    node: process.version, npm: execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(),
    platform: process.platform, arch: process.arch,
  };
}

export async function verifyBrowsers({ installed, image, expectedKey, expectedArch, playwright }) {
  assert.match(expectedKey ?? '', /^[0-9a-f]{64}$/, 'BROWSER_IMAGE_KEY_REQUIRED');
  assert.equal(image.imageKey, expectedKey, 'BROWSER_IMAGE_KEY_MISMATCH');
  assert.equal(installed.platform, 'linux', 'BROWSER_PLATFORM_MISMATCH');
  assert.ok(['arm64', 'x64'].includes(expectedArch), 'BROWSER_ARCH_REQUIRED');
  assert.equal(installed.arch, expectedArch, 'BROWSER_ARCH_MISMATCH');
  assert.deepEqual(installed, image.installed, 'BROWSER_IMAGE_DEPENDENCY_MISMATCH');
  for (const [name, options] of [['chromium', {}], ['chromium', { channel: 'chromium' }], ['webkit', {}]]) {
    const browser = await playwright[name].launch({ headless: true, ...options });
    try {
      const page = await browser.newPage();
      await page.setContent('<title>Servora CI browser check</title><main>browser-ready</main>');
      assert.equal(await page.title(), 'Servora CI browser check');
      assert.equal(await page.locator('main').textContent(), 'browser-ready');
      console.log(`BROWSER_AVAILABLE engine=${name} channel=${options.channel ?? 'default'} version=${browser.version()}`);
    } finally {
      await browser.close();
    }
  }
  console.log('BROWSER_AVAILABILITY_PASS');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  const installed = installedMetadata(root);
  if (process.argv[2] === '--record') {
    assert.match(process.env.LOCAL_CI_IMAGE_DIGEST ?? '', /^[0-9a-f]{64}$/);
    fs.writeFileSync('/opt/servora-playwright/os-packages.txt', execFileSync('dpkg-query', ['-W']));
    fs.writeFileSync(metadataPath, JSON.stringify({ imageKey: process.env.LOCAL_CI_IMAGE_DIGEST, installed, system: systemMetadata() }) + '\n', { flag: 'wx' });
  } else {
    const require = createRequire(path.join(root, 'package.json'));
    const image = JSON.parse(fs.readFileSync(metadataPath));
    assert.deepEqual(systemMetadata(), image.system, 'BROWSER_OS_DEPENDENCY_MISMATCH');
    console.log(`BROWSER_IMAGE_VERIFIED ${JSON.stringify(image)}`);
    await verifyBrowsers({ installed, image,
      expectedKey: process.env.LOCAL_CI_WEB_IMAGE_KEY, expectedArch: process.env.LOCAL_CI_WEB_ARCH,
      playwright: require('playwright') });
  }
}
