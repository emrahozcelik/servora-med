import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { cacheKey } from '../local-ci/cache-key.mjs';
import { installedMetadata, verifyBrowsers } from '../local-ci/browser-availability.mjs';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const runtime = JSON.stringify({ node: 'v22.23.4', npm: '10.9.9', platform: 'linux', arch: 'arm64' });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'servora-ci-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const file of ['web/package.json', 'web/package-lock.json', 'server/package.json', 'server/package-lock.json', 'ops/local-ci/images/web.Dockerfile', 'ops/local-ci/browser-availability.mjs']) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.copyFileSync(path.join(repo, file), path.join(root, file));
  }
  return root;
}

test('browser image invalidates on either manifest, Dockerfile, probe or architecture changes', (t) => {
  const root = fixture(t);
  const original = cacheKey(root, 'web-image', 'linux/arm64');
  assert.equal(cacheKey(root, 'web-image', 'linux/arm64'), original);
  for (const file of ['web/package.json', 'web/package-lock.json', 'ops/local-ci/images/web.Dockerfile', 'ops/local-ci/browser-availability.mjs']) {
    const name = path.join(root, file), bytes = fs.readFileSync(name);
    fs.appendFileSync(name, '\n');
    assert.notEqual(cacheKey(root, 'web-image', 'linux/arm64'), original, file);
    fs.writeFileSync(name, bytes);
  }
  assert.notEqual(cacheKey(root, 'web-image', 'linux/amd64'), original);
});

test('npm caches separate server/web, platform, exact Node/npm and lockfile bytes', (t) => {
  const root = fixture(t);
  const original = cacheKey(root, 'web', 'linux/arm64', runtime);
  assert.equal(cacheKey(root, 'web', 'linux/arm64', runtime), original);
  assert.notEqual(cacheKey(root, 'server', 'linux/arm64', runtime), original);
  for (const replacement of [runtime.replace('v22.23.4', 'v22.23.5'), runtime.replace('10.9.9', '10.9.10')]) {
    assert.notEqual(cacheKey(root, 'web', 'linux/arm64', replacement), original);
  }
  assert.notEqual(cacheKey(root, 'web', 'linux/amd64', runtime.replace('arm64', 'x64')), original);
  fs.appendFileSync(path.join(root, 'web/package-lock.json'), '\n');
  assert.notEqual(cacheKey(root, 'web', 'linux/arm64', runtime), original);
  assert.throws(() => cacheKey(root, 'web', 'linux/amd64', runtime), /CACHE_TOOLCHAIN_INVALID/);
  assert.throws(() => cacheKey(root, 'web', 'linux/arm64', runtime.replace('v22.', 'v26.')), /CACHE_TOOLCHAIN_INVALID/);
  assert.throws(() => cacheKey(root, 'web', 'darwin/arm64', runtime), /CACHE_PLATFORM_INVALID/);
});

test('installed Playwright package and core must match the current lockfile', (t) => {
  const root = fixture(t);
  const web = path.join(root, 'web');
  const lock = JSON.parse(fs.readFileSync(path.join(web, 'package-lock.json')));
  for (const name of ['playwright', 'playwright-core']) {
    const directory = path.join(web, 'node_modules', name);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ version: lock.packages[`node_modules/${name}`].version }));
  }
  assert.equal(installedMetadata(web).playwright, lock.packages['node_modules/playwright'].version);
  fs.writeFileSync(path.join(web, 'node_modules/playwright-core/package.json'), '{"version":"0.0.0"}');
  // A new process avoids Node's package.json require cache.
  const mismatch = spawnSync(process.execPath, ['--input-type=module', '-e', 'const m=await import(process.argv[2]);m.installedMetadata(process.argv[3]);', 'fixture', path.join(repo, 'ops/local-ci/browser-availability.mjs'), web], { encoding: 'utf8' });
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /PLAYWRIGHT_CORE_LOCK_MISMATCH/);
});

function browserFixture() {
  const calls = [];
  const browser = { newPage: async () => ({ setContent: async () => calls.push('render'), title: async () => 'Servora CI browser check', locator: () => ({ textContent: async () => 'browser-ready' }) }), version: () => 'fixture', close: async () => calls.push('close') };
  const launch = async (options) => { calls.push(options); return browser; };
  const installed = { lockSha256: 'a'.repeat(64), platform: 'linux', arch: 'arm64', node: 'v22.23.4', npm: '10.9.9', playwright: '1.55.1', core: '1.55.1' };
  const expectedKey = 'b'.repeat(64);
  return { calls, options: { installed, image: { imageKey: expectedKey, installed: { ...installed } }, expectedKey, expectedArch: 'arm64', playwright: { chromium: { launch }, webkit: { launch } } } };
}

test('availability gate launches and renders headless shell, full Chromium and WebKit', async () => {
  const { calls, options } = browserFixture();
  await verifyBrowsers(options);
  assert.deepEqual(calls.filter((c) => typeof c === 'object'), [{ headless: true }, { headless: true, channel: 'chromium' }, { headless: true }]);
  assert.equal(calls.filter((c) => c === 'render').length, 3);
  assert.equal(calls.filter((c) => c === 'close').length, 3);
});

test('stale image, lockfile, architecture or runtime fails before browser execution', async () => {
  for (const patch of [{ expectedKey: 'c'.repeat(64) }, { expectedArch: 'x64' }, { expectedKey: undefined }, { installed: { ...browserFixture().options.installed, npm: '11.0.0' } }]) {
    const { calls, options } = browserFixture();
    await assert.rejects(verifyBrowsers({ ...options, ...patch }));
    assert.equal(calls.length, 0);
  }
});

test('missing browser or shared library fails the gate; render errors close the browser', async () => {
  const { options } = browserFixture();
  await assert.rejects(verifyBrowsers({ ...options, playwright: { chromium: { launch: async () => { throw new Error('missing browser/shared library'); } } } }), /missing browser/);
  let closed = false;
  const broken = { launch: async () => ({ newPage: async () => { throw new Error('render failed'); }, close: async () => { closed = true; } }) };
  await assert.rejects(verifyBrowsers({ ...options, playwright: { chromium: broken } }), /render failed/);
  assert.equal(closed, true);
});

test('foreign npm volume is refused before any ownership mutation', (t) => {
  const root = fixture(t);
  const calls = path.join(root, 'calls');
  const result = spawnSync('bash', ['-c', `
source "$1/ops/local-ci/lib/cache.sh"
SCRIPT_DIR="$1/ops/local-ci"; EXPORT_DIR="$2"; CALLS="$3"
ci_assert_docker_daemon() { return 0; }
ci_docker() {
  printf '%s\\n' "$*" >> "$CALLS"
  case "$1 $2" in
    'run --rm') printf '%s' '${runtime}' ;;
    'volume create') echo cache ;;
    'volume inspect') echo 'local foreign-project wrong-key' ;;
    *) return 99 ;;
  esac
}
ci_prepare_npm_volume web linux/arm64 fixture 0
`, 'cache-fixture', repo, root, calls], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /VOLUME_OWNERSHIP_MISMATCH/);
  assert.ok(!fs.readFileSync(calls, 'utf8').includes('chown'));
});

test('guest builder daemon mismatch stops before building an image', (t) => {
  const root = fixture(t);
  const result = spawnSync('bash', ['-c', `
source "$1/ops/local-ci/lib/cache.sh"
SCRIPT_DIR="$1/ops/local-ci"; EXPORT_DIR="$2"; WEB_PLATFORM=linux/arm64; WEB_ARCH=arm64
LOCAL_CI_DOCKER_DAEMON_ID=expected
ci_assert_docker_daemon() { return 0; }
ci_docker() { if [[ "$1 $2" == 'image inspect' ]]; then return 1; fi; }
colima() { echo foreign; }
ci_prepare_web_image
`, 'cache-fixture', repo, root], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /GUEST_DAEMON_MISMATCH/);
});

test('failed image inspection and listing cannot become a cache miss/build', (t) => {
  const root = fixture(t);
  const result = spawnSync('bash', ['-c', `
source "$1/ops/local-ci/lib/cache.sh"
SCRIPT_DIR="$1/ops/local-ci"; EXPORT_DIR="$2"; WEB_PLATFORM=linux/arm64; WEB_ARCH=arm64
ci_docker() { return 7; }
colima() { echo UNEXPECTED_BUILD; return 99; }
ci_prepare_web_image
`, 'cache-fixture', repo, root], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /IMAGE_MISS|UNEXPECTED_BUILD|IMAGE_READY/);
});

test('owned npm cache mounts only its validated volume with the intended UID', (t) => {
  const root = fixture(t);
  const key = cacheKey(root, 'web', 'linux/arm64', runtime);
  const calls = path.join(root, 'calls');
  const result = spawnSync('bash', ['-c', `
source "$1/ops/local-ci/lib/cache.sh"
SCRIPT_DIR="$1/ops/local-ci"; EXPORT_DIR="$2"; CALLS="$3"
ci_assert_docker_daemon() { return 0; }
ci_docker() {
  printf '%s\\n' "$*" >> "$CALLS"
  if [[ "$*" == *chown* ]]; then return 0; fi
  case "$1 $2" in
    'run --rm') printf '%s' '${runtime}' ;;
    'volume create') echo cache ;;
    'volume inspect') echo 'local web-npm ${key}' ;;
    *) return 99 ;;
  esac
}
ci_prepare_npm_volume web linux/arm64 fixture 0
`, 'cache-fixture', repo, root, calls], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `servora-localci-npm-web-${key}`);
  assert.match(fs.readFileSync(calls, 'utf8'), new RegExp(`type=volume,source=servora-localci-npm-web-${key},target=/npm-cache fixture chown 0:0 /npm-cache`));
});

test('cache shell helper passes syntax and ShellCheck', () => {
  for (const [command, args] of [['bash', ['-n']], ['shellcheck', ['-x']]]) {
    const result = spawnSync(command, [...args, path.join(repo, 'ops/local-ci/lib/cache.sh')], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
});
