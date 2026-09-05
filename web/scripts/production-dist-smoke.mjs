/**
 * Production-dist browser boot smoke.
 *
 * The application shell is served from the built `dist` directory with the
 * same document/static fallback boundary used in production. The anonymous
 * auth endpoint is stubbed to the repository-defined 401 response so this
 * check exercises frontend startup without requiring a backend or database.
 */
import { createServer } from 'node:http';
import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const scriptDirectory = resolve(fileURLToPath(new URL('.', import.meta.url)));
const defaultDistDirectory = resolve(scriptDirectory, '..', 'dist');
const distDirectory = resolve(process.env.SERVORA_PRODUCTION_DIST_DIR ?? defaultDistDirectory);

/**
 * Optional fail-closed release-identity gate. When the deploy path builds
 * with an exact SHA it exports SERVORA_EXPECTED_BUILD_SHA, and this smoke
 * proves the dist embeds that SHA (deterministic evidence beyond hashed
 * asset filenames) plus the browser-visible parity contract.
 */
const expectedBuildSha = (process.env.SERVORA_EXPECTED_BUILD_SHA ?? '').trim().toLowerCase();
if (expectedBuildSha !== '' && !/^[0-9a-f]{40}$/.test(expectedBuildSha)) {
  console.error('SERVORA_EXPECTED_BUILD_SHA must be an exact 40-character lowercase Git SHA.');
  process.exit(2);
}

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

function pathnameFromRequest(request) {
  return decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname);
}

function isUnsafePath(pathname) {
  return pathname.includes('\0') || pathname.split('/').includes('..');
}

async function existingFile(pathname) {
  const filePath = resolve(distDirectory, `.${pathname}`);
  if (!filePath.startsWith(`${distDirectory}/`)) return null;
  try {
    const fileStats = await stat(filePath);
    return fileStats.isFile() ? filePath : null;
  } catch {
    return null;
  }
}

async function startStaticServer() {
  const indexPath = await existingFile('/index.html');
  if (!indexPath) throw new Error(`Production dist index.html bulunamadı: ${distDirectory}`);

  const server = createServer(async (request, response) => {
    let pathname;
    try {
      pathname = pathnameFromRequest(request);
    } catch {
      response.writeHead(400).end();
      return;
    }

    if (isUnsafePath(pathname)) {
      response.writeHead(400).end();
      return;
    }

    const filePath = await existingFile(pathname);
    const isStaticAsset = pathname.startsWith('/assets/') || pathname === '/service-worker.js';
    const resolvedPath = filePath ?? (isStaticAsset ? null : indexPath);
    if (!resolvedPath) {
      response.writeHead(404).end();
      return;
    }

    const body = await readFile(resolvedPath);
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': contentTypes[extname(resolvedPath)] ?? 'application/octet-stream',
      'Content-Length': body.byteLength,
    });
    response.end(body);
  });

  await new Promise((resolveServer, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveServer);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Smoke sunucusu portu alınamadı.');
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function assertLoginBoot(browser, baseUrl, routePath) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  const failedRequests = [];
  let auth401Observed = false;

  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('requestfailed', (request) => {
    failedRequests.push(`${request.method()} ${request.url()} (${request.failure()?.errorText ?? 'unknown'})`);
  });
  await page.route('**/api/auth/me', async (route) => {
    auth401Observed = true;
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Oturum açmanız gerekiyor.', code: 'UNAUTHENTICATED' }),
    });
  });

  let navigationError = null;
  try {
    const response = await page.goto(`${baseUrl}${routePath}`, { waitUntil: 'networkidle' });
    if (!response || response.status() !== 200) {
      navigationError = `document HTTP ${response?.status() ?? 'none'}`;
    }
    await page.locator('#login-title').waitFor({ state: 'visible', timeout: 10_000 });
  } catch (error) {
    navigationError = error instanceof Error ? error.message : String(error);
  }

  const rootHtml = await page.locator('#root').innerHTML().catch(() => '');
  const actionableConsoleErrors = consoleErrors.filter((message) => !(
    auth401Observed
      && message === 'Failed to load resource: the server responded with a status of 401 (Unauthorized)'
  ));
  const buildIdentity = page.locator('.build-identity').first();
  const result = {
    route: routePath,
    loginVisible: await page.locator('#login-title').isVisible().catch(() => false),
    rootNonEmpty: rootHtml.trim().length > 0,
    buildSha: await buildIdentity.getAttribute('data-build-sha').catch(() => null),
    buildLabel: (await buildIdentity.textContent().catch(() => null))?.trim() ?? null,
    pageErrors,
    consoleErrors: actionableConsoleErrors,
    auth401Observed,
    failedRequests,
    navigationError,
  };
  await context.close();
  return result;
}

async function assertDistEmbedsSha(distDir, sha) {
  const entries = await readdir(resolve(distDir, 'assets')).catch(() => null);
  if (!entries) return false;
  for (const entry of entries) {
    if (!entry.endsWith('.js')) continue;
    const body = await readFile(resolve(distDir, 'assets', entry), 'utf8').catch(() => null);
    if (body !== null && body.includes(sha)) return true;
  }
  return false;
}

const { server, baseUrl } = await startStaticServer();
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const results = [];
  for (const routePath of ['/', '/login']) {
    results.push(await assertLoginBoot(browser, baseUrl, routePath));
  }

  let distIdentityOk = true;
  if (expectedBuildSha !== '') {
    distIdentityOk = await assertDistEmbedsSha(distDirectory, expectedBuildSha);
    console.log(`production-dist build-sha embedded=${distIdentityOk ? 'PASS' : 'FAIL'}`);
  }

  const expectedShortSha = expectedBuildSha.slice(0, 7);
  for (const result of results) {
    const parityOk = expectedBuildSha === ''
      || (result.buildSha === expectedBuildSha
        && (result.buildLabel ?? '').includes(expectedShortSha));
    console.log(`production-dist ${result.route} login=${result.loginVisible ? 'PASS' : 'FAIL'} root=${result.rootNonEmpty ? 'PASS' : 'FAIL'} auth401=${result.auth401Observed ? 'PASS' : 'FAIL'} pageErrors=${result.pageErrors.length} consoleErrors=${result.consoleErrors.length} failedRequests=${result.failedRequests.length}${expectedBuildSha === '' ? '' : ` parity=${parityOk ? 'PASS' : `FAIL (data-build-sha=${result.buildSha ?? 'none'} label=${result.buildLabel ?? 'none'})`}`}`);
    if (result.navigationError) console.log(`  navigationError=${result.navigationError}`);
    for (const message of [...result.pageErrors, ...result.consoleErrors, ...result.failedRequests]) {
      console.log(`  error=${message}`);
    }
    if (!parityOk) result.navigationError = result.navigationError || 'build identity parity mismatch';
  }

  const failed = !distIdentityOk || results.some((result) => !result.loginVisible
    || !result.rootNonEmpty
    || !result.auth401Observed
    || result.pageErrors.length > 0
    || result.consoleErrors.length > 0
    || result.failedRequests.length > 0
    || result.navigationError);
  if (failed) process.exitCode = 1;
} finally {
  await browser?.close();
  await new Promise((resolveServer) => server.close(resolveServer));
}
