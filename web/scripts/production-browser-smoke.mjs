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
  const actionableConsoleErrors = consoleErrors.filter((message) => !(
    auth401Observed && /401\s*\(Unauthorized\)|responded with a status of 401/i.test(message)
  ));
  const result = {
    route: routePath,
    documentStatus,
    rootNonEmpty: rootHtml.trim().length > 0,
    loginVisible,
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

  let failed = false;
  for (const result of results) {
    const errors = [...result.pageErrors, ...result.consoleErrors, ...result.failedRequests, ...result.badResponses];
    const typeErrorPresent = errors.some((message) => /TypeError:\s*pt is not a function/i.test(message));
    const routeFailed = result.documentStatus !== 200
      || !result.rootNonEmpty
      || !result.loginVisible
      || result.pageErrors.length > 0
      || result.consoleErrors.length > 0
      || result.failedRequests.length > 0
      || result.badResponses.length > 0
      || Boolean(result.navigationError)
      || typeErrorPresent;
    failed ||= routeFailed;
    console.log(
      `production-browser ${result.route} document=${result.documentStatus === 200 ? 'PASS' : 'FAIL'} root=${result.rootNonEmpty ? 'PASS' : 'FAIL'} login=${result.loginVisible ? 'PASS' : 'FAIL'} pageErrors=${result.pageErrors.length} consoleErrors=${result.consoleErrors.length} failedRequests=${result.failedRequests.length} badResponses=${result.badResponses.length}${result.navigationError ? ` navigation=${result.navigationError}` : ''}`,
    );
    for (const message of errors) console.log(`  error=${message}`);
  }
  if (failed) process.exitCode = 1;
} finally {
  await browser.close();
}
