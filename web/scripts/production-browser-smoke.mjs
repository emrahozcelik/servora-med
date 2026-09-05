/**
 * Public production browser smoke used after activation.
 *
 * This intentionally uses a fresh anonymous context. It verifies that the
 * public SPA shell and login screen boot without credentials, while allowing
 * the expected anonymous 401 from the auth bootstrap endpoint.
 */
import { chromium } from 'playwright';

const fqdn = process.env.SERVORA_PROD_FQDN?.trim() ?? '';
if (!/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(fqdn)) {
  console.error('SERVORA_PROD_FQDN is required and must be a hostname.');
  process.exit(2);
}

/**
 * Optional fail-closed parity gate. The deploy path exports
 * SERVORA_EXPECTED_DEPLOY_SHA, and this smoke proves
 * FRONTEND_BUILD_SHA == SERVER_RELEASE_SHA == EXPECTED_DEPLOY_SHA.
 * When unset, the legacy boot assertions still run (local/CI usage).
 */
const expectedDeploySha = (process.env.SERVORA_EXPECTED_DEPLOY_SHA ?? '').trim().toLowerCase();
if (expectedDeploySha !== '' && !/^[0-9a-f]{40}$/.test(expectedDeploySha)) {
  console.error('SERVORA_EXPECTED_DEPLOY_SHA must be an exact 40-character lowercase Git SHA.');
  process.exit(2);
}

const baseUrl = `https://${fqdn}`;
const routes = ['/', '/login'];

function isExpectedAnonymousAuthFailure(url, status) {
  return status === 401 && /\/api\/auth\/me(?:\?|$)/.test(url);
}

async function smokeRoute(browser, routePath) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  const failedRequests = [];
  const badResponses = [];
  let auth401Observed = false;

  page.on('pageerror', (error) => pageErrors.push(String(error?.message ?? error)));
  page.on('console', (message) => {
    if (message.type() === 'error') {
      const text = message.text();
      consoleErrors.push(text);
    }
  });
  page.on('requestfailed', (request) => {
    failedRequests.push(`${request.method()} ${request.url()}`);
  });
  page.on('response', (response) => {
    if (isExpectedAnonymousAuthFailure(response.url(), response.status())) {
      auth401Observed = true;
    } else if (response.status() >= 400) {
      badResponses.push(`${response.status()} ${response.url()}`);
    }
  });

  let navigationError = '';
  let documentStatus = 0;
  try {
    const response = await page.goto(`${baseUrl}${routePath}`, {
      waitUntil: 'domcontentloaded',
      timeout: 15_000,
    });
    documentStatus = response?.status() ?? 0;
    await page.locator('#root').waitFor({ state: 'attached', timeout: 10_000 });
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
  } catch (error) {
    navigationError = error instanceof Error ? error.message : String(error);
  }

  const rootHtml = await page.locator('#root').innerHTML().catch(() => '');
  const loginVisible = await page.locator('#login-title').isVisible().catch(() => false);
  const buildIdentity = page.locator('.build-identity').first();
  const actionableConsoleErrors = consoleErrors.filter((message) => !(
    auth401Observed && /401\s*\(Unauthorized\)|responded with a status of 401/i.test(message)
  ));
  const result = {
    route: routePath,
    documentStatus,
    rootNonEmpty: rootHtml.trim().length > 0,
    loginVisible,
    frontendBuildSha: await buildIdentity.getAttribute('data-build-sha').catch(() => null),
    frontendBuildLabel: (await buildIdentity.textContent().catch(() => null))?.trim() ?? null,
    pageErrors,
    consoleErrors: actionableConsoleErrors,
    failedRequests,
    badResponses,
    navigationError,
  };
  await context.close();
  return result;
}

const browser = await chromium.launch({ headless: true });
try {
  const results = [];
  for (const routePath of routes) {
    results.push(await smokeRoute(browser, routePath));
  }

  let serverReleaseSha = null;
  if (expectedDeploySha !== '') {
    try {
      const healthResponse = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(15_000) });
      const healthBody = await healthResponse.json();
      serverReleaseSha = typeof healthBody?.releaseSha === 'string' ? healthBody.releaseSha : null;
    } catch {
      serverReleaseSha = null;
    }
  }

  let failed = false;
  const expectedShortSha = expectedDeploySha.slice(0, 7);
  for (const result of results) {
    const errors = [...result.pageErrors, ...result.consoleErrors, ...result.failedRequests, ...result.badResponses];
    const typeErrorPresent = errors.some((message) => /TypeError:\s*pt is not a function/i.test(message));
    let parityOk = true;
    if (expectedDeploySha !== '') {
      parityOk = result.frontendBuildSha === expectedDeploySha
        && serverReleaseSha === expectedDeploySha
        && (result.frontendBuildLabel ?? '').includes(expectedShortSha);
      if (!parityOk) {
        errors.push(
          `release parity mismatch: frontend=${result.frontendBuildSha ?? 'none'} `
          + `server=${serverReleaseSha ?? 'none'} expected=${expectedDeploySha}`,
        );
      }
    }
    const routeFailed = result.documentStatus !== 200
      || !result.rootNonEmpty
      || !result.loginVisible
      || result.pageErrors.length > 0
      || result.consoleErrors.length > 0
      || result.failedRequests.length > 0
      || result.badResponses.length > 0
      || Boolean(result.navigationError)
      || typeErrorPresent
      || !parityOk;
    failed ||= routeFailed;
    console.log(
      `production-browser ${result.route} document=${result.documentStatus === 200 ? 'PASS' : 'FAIL'} root=${result.rootNonEmpty ? 'PASS' : 'FAIL'} login=${result.loginVisible ? 'PASS' : 'FAIL'} pageErrors=${result.pageErrors.length} consoleErrors=${result.consoleErrors.length} failedRequests=${result.failedRequests.length} badResponses=${result.badResponses.length}${expectedDeploySha === '' ? '' : ` parity=${parityOk ? 'PASS' : 'FAIL'}`}${result.navigationError ? ` navigation=${result.navigationError}` : ''}`,
    );
    for (const message of errors) console.log(`  error=${message}`);
  }
  if (failed) process.exitCode = 1;
} finally {
  await browser.close();
}
