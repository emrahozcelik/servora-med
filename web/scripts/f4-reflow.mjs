import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const BASE_URL = 'http://127.0.0.1:5174';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PASSWORD = process.env.F4_SEED_PASSWORD;
if (!PASSWORD) throw new Error('F4_SEED_PASSWORD is required');

const ids = {
  admin: '8935c4ca-6d97-4020-a10c-0bf9987d1f75',
  staffD: '7fcccf9b-a37d-40a9-ab8e-3458c7f7ab47',
  source: '843521a9-7f23-4b8b-b455-6dd95410eb07',
  f2: '084a0c9a-5778-466c-968a-e66013698298',
  customerA: 'fd70e6be-655d-44a3-a73f-d78844ff31c5',
  staffA: '6bad0eec-ae61-4a0c-a5da-bb2d7fedc8bd',
};
const credentials = { admin: 'admin@f4.synthetic', staffD: 'staff-d@f4.synthetic' };
const evidenceDir = new URL('../../docs/evidence/linked-follow-up-jobcards/f4/', import.meta.url).pathname;
mkdirSync(evidenceDir, { recursive: true });

async function login(browser, role) {
  const context = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByLabel('E-posta').fill(credentials[role]);
  await page.getByLabel('Parola').fill(PASSWORD);
  await page.getByRole('button', { name: /Giriş yap/i }).click();
  await page.waitForURL((url) => !url.pathname.endsWith('/login'));
  return { context, page };
}

async function measure(page) {
  await page.waitForTimeout(250);
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    scrollHeight: document.documentElement.scrollHeight,
    clientHeight: document.documentElement.clientHeight,
    horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  }));
}

const browser = await chromium.launch({ headless: true, executablePath: CHROME });
const sessions = {};
try {
  sessions.admin = await login(browser, 'admin');
  sessions.staffD = await login(browser, 'staffD');
  const surfaces = [
    { id: 'JOB_DETAIL_FULL', session: sessions.admin, path: `/jobs/${ids.f2}`, ready: '[data-job-detail="true"]' },
    { id: 'FOLLOW_UP_CREATE_FORM', session: sessions.admin, path: `/jobs/new-follow-up?source=${ids.source}`, ready: '[data-follow-up-create="true"]' },
    { id: 'CUSTOMER_HISTORY', session: sessions.admin, path: `/customers/${ids.customerA}`, ready: '.customer-detail h1' },
    { id: 'STAFF_HISTORY', session: sessions.admin, path: `/staff/${ids.staffA}`, ready: '#staff-job-history-title' },
    { id: 'CALENDAR_RESTRICTED', session: sessions.staffD, path: '/calendar', ready: '.servora-calendar-cell[data-date="2026-08-06"]', selectDate: true },
  ];
  const results = [];
  for (const surface of surfaces) {
    const { page } = surface.session;
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(surface.path);
    await page.waitForSelector(surface.ready, { timeout: 15_000 });
    if (surface.selectDate) await page.locator(surface.ready).click();
    const textStyle = await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    const text200 = await measure(page);
    await textStyle.evaluate((node) => node.remove());
    await page.setViewportSize({ width: 320, height: 844 });
    await page.goto(surface.path);
    await page.waitForSelector(surface.ready, { timeout: 15_000 });
    if (surface.selectDate) await page.locator(surface.ready).click();
    const reflow400 = await measure(page);
    results.push({ id: surface.id, methodology: '200% html font-size at 390 CSS px; 400% WCAG-equivalent 320 CSS px viewport', measurements: { '200pct-text': text200, '400pct-reflow': reflow400 } });
  }
  const output = { syntheticOnly: true, browser: 'Google Chrome application executable via Playwright', results };
  writeFileSync(`${evidenceDir}/reflow-results.json`, `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify(output));
} finally {
  await Promise.all(Object.values(sessions).map(({ context }) => context.close().catch(() => undefined)));
  await browser.close();
}
