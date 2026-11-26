/**
 * UI-003 rendered capture for MSG-002 P5: persistent assigneeSync prompt on Job Detail.
 *
 * Uses the real React entry (`index.html` + `src/main.tsx`), `ServoraAntProvider`,
 * `BrowserRouter`, `App`, `AppShell`, `AppRouter`, `JobDetailScreen`,
 * `JobConversationAction`, `ReassignmentSyncPrompt`, production CSS and fonts,
 * with deterministic mocked `/api/**` responses via Playwright route interception.
 *
 * Outputs into `$FLEET_EVIDENCE_DIR` (or `.ui-evidence/job-detail-assignee-sync` fallback):
 * - job-detail-assignee-sync-390.png
 * - job-detail-assignee-sync-1440.png
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(
  process.env.FLEET_EVIDENCE_DIR || resolve(root, '.ui-evidence/job-detail-assignee-sync'),
);
mkdirSync(outDir, { recursive: true });

const packageVersion = JSON.parse(
  readFileSync(resolve(root, 'package.json'), 'utf8'),
).version;
const indexHtml = readFileSync(resolve(root, 'index.html'), 'utf8');

const FIXED_CLOCK_ISO = '2026-11-26T11:00:00.000Z';
const JOB_ID = '11111111-1111-4111-8111-111111111111';
const CONVERSATION_ID = '22222222-2222-4222-8222-222222222222';
const TRANSITION_ID = '33333333-3333-4333-8333-333333333333';
const ORG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const MANAGER_USER = {
  id: '44444444-4444-4444-8444-444444444444',
  organizationId: ORG_ID,
  name: 'Murat Yönetici',
  email: 'murat.yonetici@dunyadental.example',
  role: 'MANAGER',
  mustChangePassword: false,
  isActive: true,
  version: 1,
  capabilities: {
    overviewDashboard: true,
    calendar: true,
    messaging: true,
  },
  support: {
    displayLabel: 'Sistem yöneticiniz',
    email: null,
    helpUrl: null,
  },
};

const JOB_CARD = {
  id: JOB_ID,
  organizationId: ORG_ID,
  type: 'PRODUCT_DELIVERY',
  status: 'ACCEPTED',
  version: 4,
  engagementKind: null,
  title: 'Anadolu Dental Polikliniği ürün teslimi',
  description: 'Cerrahi implant seti teslimatı ve klinik teslim tutanağı.',
  customerId: '55555555-5555-4555-8555-555555555555',
  contactId: '66666666-6666-4666-8666-666666666666',
  assignedTo: '77777777-7777-4777-8777-777777777777',
  createdBy: MANAGER_USER.id,
  priority: 'high',
  dueDate: '2026-11-27T15:00:00.000Z',
  scheduledAt: '2026-11-26T13:30:00.000Z',
  scheduledEndsAt: '2026-11-26T14:30:00.000Z',
  assignee: {
    id: '77777777-7777-4777-8777-777777777777',
    name: 'Burak Personel',
  },
  customer: {
    id: '55555555-5555-4555-8555-555555555555',
    name: 'Anadolu Dental Polikliniği',
  },
  contact: {
    id: '66666666-6666-4666-8666-666666666666',
    name: 'Dr. Selin Kaya',
  },
  followUpContext: null,
  hasOpenOverdueIncident: false,
  correctionDueAt: null,
  workflowContext: {
    allowedCommands: ['CANCEL'],
    allowedActions: ['EDIT_JOB_FIELDS', 'VIEW_NOTES', 'ADD_NOTE'],
    lifecycle: {
      createdAt: '2026-11-25T08:00:00.000Z',
      acceptedAt: '2026-11-26T09:15:00.000Z',
      acceptedBy: {
        id: '77777777-7777-4777-8777-777777777777',
        name: 'Burak Personel',
      },
      startedAt: null,
      submittedAt: null,
      submittedBy: null,
      submissionNote: null,
      approvedAt: null,
      approvedBy: null,
      approvalNote: null,
      revisionRequestedAt: null,
      revisionRequestedBy: null,
      revisionReason: null,
      cancelledAt: null,
      cancelledBy: null,
      cancelReason: null,
      cancelledFromStatus: null,
    },
    submissionReadiness: null,
  },
};

const DELIVERY_ITEMS = [
  {
    id: '88888888-8888-4888-8888-888888888888',
    organizationId: ORG_ID,
    jobCardId: JOB_ID,
    productId: '99999999-9999-4999-8999-999999999999',
    deliveryPurpose: 'SALE',
    deliveredAt: null,
    quantity: 4,
    unit: 'kutu',
    productNameSnapshot: 'Titanyum İmplant Cerrahi Seti',
    productSkuSnapshot: 'DD-IMP-402',
    productModelSnapshot: 'Pro-2026',
    lotNo: 'LOT-2611',
    serialNo: null,
    expiryDate: '2028-11-30',
    deliveryNote: null,
  },
];

const ASSIGNEE_SYNC_HINT = {
  transitionId: TRANSITION_ID,
  previousAssignee: {
    id: 'abababab-abab-4bab-8bab-abababababab',
    name: 'Ayşe Personel',
  },
  newAssignee: {
    id: '77777777-7777-4777-8777-777777777777',
    name: 'Burak Personel',
  },
};

function makeConversationLookup(synced) {
  return {
    id: CONVERSATION_ID,
    directKey: `context:JOB:${JOB_ID}`,
    contextType: 'JOB',
    jobId: JOB_ID,
    jobTitle: JOB_CARD.title,
    customerId: JOB_CARD.customerId,
    customerName: JOB_CARD.customer.name,
    title: null,
    participantName: synced ? 'Burak Personel' : 'Ayşe Personel',
    participantId: synced
      ? '77777777-7777-4777-8777-777777777777'
      : 'abababab-abab-4bab-8bab-abababababab',
    participantIsActive: true,
    participants: synced
      ? [
          { userId: MANAGER_USER.id, name: MANAGER_USER.name, isActive: true },
          { userId: '77777777-7777-4777-8777-777777777777', name: 'Burak Personel', isActive: true },
        ]
      : [
          { userId: MANAGER_USER.id, name: MANAGER_USER.name, isActive: true },
          { userId: 'abababab-abab-4bab-8bab-abababababab', name: 'Ayşe Personel', isActive: true },
        ],
    unreadCount: 0,
    lastActivityAt: '2026-11-26T09:20:00.000Z',
    updatedAt: '2026-11-26T09:20:00.000Z',
    assigneeSync: synced ? null : ASSIGNEE_SYNC_HINT,
  };
}

const isRunnerNoise = (message) => message.endsWith('WebSocket closed without opened.');

async function startServer() {
  const vite = await createViteServer({
    root,
    configFile: false,
    appType: 'custom',
    logLevel: 'error',
    plugins: [react()],
    define: {
      __SERVORA_APP_VERSION__: JSON.stringify(packageVersion),
    },
    server: { middlewareMode: true, hmr: false },
  });

  return new Promise((resolveServer) => {
    const server = createServer(async (req, res) => {
      try {
        const rawUrl = req.url ?? '/';
        const pathOnly = rawUrl.split('?')[0];
        if (pathOnly === '/' || pathOnly.startsWith('/jobs')) {
          const transformed = await vite.transformIndexHtml(rawUrl, indexHtml);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(transformed);
          return;
        }
        vite.middlewares(req, res, () => {
          res.writeHead(404);
          res.end();
        });
      } catch (error) {
        res.writeHead(500);
        res.end(String(error));
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolveServer({ server, vite, url: `http://127.0.0.1:${port}` });
    });
  });
}

async function openMockedJobDetail(browser, baseUrl, { width, height }) {
  const context = await browser.newContext({
    viewport: { width, height },
    locale: 'tr-TR',
    timezoneId: 'Europe/Istanbul',
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(window, 'EventSource', { configurable: true, value: undefined });
  });
  await page.clock.install({ time: new Date(FIXED_CLOCK_ISO) });

  const state = {
    synced: false,
    lookupCalls: 0,
    syncCalls: [],
    pageErrors: [],
    consoleIssues: [],
    unexpectedRequests: [],
  };

  page.on('pageerror', (error) => {
    const msg = String(error?.stack ?? error);
    if (!isRunnerNoise(msg)) state.pageErrors.push(msg);
  });
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      const text = message.text();
      if (!isRunnerNoise(text)) state.consoleIssues.push(`${message.type()}: ${text}`);
    }
  });

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const path = url.pathname;

    if (method === 'GET' && path === '/api/auth/me') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ user: MANAGER_USER }),
      });
      return;
    }

    if (method === 'GET' && path === '/api/notifications/unread-count') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ unreadCount: 0 }),
      });
      return;
    }

    if (method === 'GET' && path === '/api/notifications') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [], nextCursor: null }),
      });
      return;
    }

    if (method === 'POST' && path === '/api/notifications/read-by-entity') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ markedCount: 0 }),
      });
      return;
    }

    if (method === 'GET' && path === '/api/messaging/unread-count') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ unreadCount: 0 }),
      });
      return;
    }

    if (method === 'GET' && path === '/api/web-push/status') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ enabled: false, vapidPublicKey: null, subscribed: false }),
      });
      return;
    }

    if (method === 'GET' && path === `/api/job-cards/${JOB_ID}`) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(JOB_CARD),
      });
      return;
    }

    if (method === 'GET' && path === `/api/job-cards/${JOB_ID}/delivery-items`) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: DELIVERY_ITEMS }),
      });
      return;
    }

    if (method === 'GET' && path === `/api/job-cards/${JOB_ID}/notes`) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [], total: 0, limit: 25, offset: 0 }),
      });
      return;
    }

    if (method === 'GET' && path === `/api/job-cards/${JOB_ID}/activity`) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [
            {
              id: 'act-1',
              jobCardId: JOB_ID,
              actorUserId: MANAGER_USER.id,
              actorName: MANAGER_USER.name,
              actionType: 'JOB_ASSIGNED',
              summary: 'Sorumlu Burak Personel olarak değiştirildi.',
              createdAt: '2026-11-26T09:10:00.000Z',
            },
          ],
          total: 1,
          limit: 50,
          offset: 0,
        }),
      });
      return;
    }

    if (method === 'GET' && path === `/api/job-cards/${JOB_ID}/follow-ups`) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [], total: 0, limit: 100, offset: 0 }),
      });
      return;
    }

    if (method === 'GET' && path === `/api/job-cards/${JOB_ID}/submission-lateness`) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ open: null }),
      });
      return;
    }

    if (method === 'GET' && path === `/api/job-cards/${JOB_ID}/overdue-incidents`) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [], total: 0, limit: 20, offset: 0 }),
      });
      return;
    }

    if (method === 'POST' && path === '/api/job-cards/available-slots') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ slots: [] }),
      });
      return;
    }

    if (method === 'GET' && path === '/api/staff') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 'abababab-abab-4bab-8bab-abababababab', name: 'Ayşe Personel', role: 'STAFF', isActive: true },
          { id: '77777777-7777-4777-8777-777777777777', name: 'Burak Personel', role: 'STAFF', isActive: true },
        ]),
      });
      return;
    }

    if (method === 'GET' && path === `/api/messaging/conversations/job/${JOB_ID}`) {
      state.lookupCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(makeConversationLookup(state.synced)),
      });
      return;
    }

    if (method === 'POST' && path === `/api/messaging/conversations/${CONVERSATION_ID}/job-assignee-sync`) {
      const payload = request.postDataJSON();
      state.syncCalls.push(payload);
      state.synced = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ conversationId: CONVERSATION_ID, synced: true, changed: true }),
      });
      return;
    }

    state.unexpectedRequests.push(`${method} ${path}`);
    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ code: 'UNEXPECTED_API_CALL', error: `${method} ${path}` }),
    });
  });

  await page.goto(`${baseUrl}/jobs/${JOB_ID}`, { waitUntil: 'load' });
  await page.locator('[data-job-detail="true"]').waitFor({ state: 'visible' });
  await page.locator('[role="dialog"]').waitFor({ state: 'visible' });
  await page.evaluate(() => document.fonts.ready);

  return { context, page, state };
}

async function assertDialogAndPageHealth(page, state, label) {
  assert.deepEqual(state.unexpectedRequests, [], `${label}: unexpectedRequests`);
  assert.deepEqual(state.pageErrors, [], `${label}: pageErrors`);
  assert.deepEqual(state.consoleIssues, [], `${label}: consoleIssues`);

  const metrics = await page.evaluate(() => {
    const dlg = document.querySelector('[role="dialog"]');
    const dlgRect = dlg?.getBoundingClientRect();
    const buttons = Array.from(dlg?.querySelectorAll('button') ?? []).map((button) => {
      const r = button.getBoundingClientRect();
      return {
        text: button.textContent?.trim() ?? '',
        width: Math.round(r.width * 10) / 10,
        height: Math.round(r.height * 10) / 10,
        bottom: Math.round(r.bottom * 10) / 10,
      };
    });
    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      dialogTitle: dlg?.querySelector('h2')?.textContent?.trim() ?? '',
      dialogText: dlg?.textContent ?? '',
      dialogWidth: Math.round((dlgRect?.width ?? 0) * 10) / 10,
      dialogHeight: Math.round((dlgRect?.height ?? 0) * 10) / 10,
      dialogScrollWidth: dlg?.scrollWidth ?? 0,
      dialogClientWidth: dlg?.clientWidth ?? 0,
      dialogTop: Math.round((dlgRect?.top ?? 0) * 10) / 10,
      dialogBottom: Math.round((dlgRect?.bottom ?? 0) * 10) / 10,
      buttons,
    };
  });

  assert.equal(metrics.dialogTitle, 'Konuşma katılımcısı güncel değil', `${label}: dialog title`);
  assert.ok(
    metrics.dialogText.includes('İşin yeni sorumlusu Burak Personel bu iş konuşmasının katılımcısı değil.'),
    `${label}: hint explanation copy`,
  );
  assert.ok(
    metrics.dialogText.includes('Ayşe Personel yerine Burak Personel ekle'),
    `${label}: confirm label`,
  );
  assert.ok(metrics.dialogText.includes('Şimdi değil'), `${label}: cancel label`);
  assert.ok(
    metrics.scrollWidth <= metrics.clientWidth + 1,
    `${label}: horizontal overflow (${metrics.scrollWidth} > ${metrics.clientWidth})`,
  );
  assert.ok(
    metrics.dialogScrollWidth <= metrics.dialogClientWidth + 1,
    `${label}: dialog internal overflow (${metrics.dialogScrollWidth} > ${metrics.dialogClientWidth})`,
  );
  assert.ok(
    metrics.dialogTop >= 0 && metrics.dialogBottom <= metrics.viewportHeight + 1,
    `${label}: dialog outside viewport (${metrics.dialogTop}..${metrics.dialogBottom} vs ${metrics.viewportHeight})`,
  );
  for (const btn of metrics.buttons) {
    assert.ok(
      btn.height >= 44,
      `${label}: button "${btn.text}" height ${btn.height}px < 44px`,
    );
  }
  return metrics;
}

const captures = [];
const geometryReport = {};
const { server, vite, url } = await startServer();
const launchOptions = { headless: true };
if (process.env.SERVORA_CHROME_PATH) {
  launchOptions.executablePath = process.env.SERVORA_CHROME_PATH;
}

let browser;
try {
  browser = await chromium.launch(launchOptions);

  // 1) 390x844 mobile viewport with persistent assigneeSync prompt open
  {
    const { context, page, state } = await openMockedJobDetail(browser, url, {
      width: 390,
      height: 844,
    });
    try {
      geometryReport['390'] = await assertDialogAndPageHealth(page, state, '390');
      const shot390 = resolve(outDir, 'job-detail-assignee-sync-390.png');
      await page.screenshot({ path: shot390 });
      captures.push(shot390);
    } finally {
      await context.close();
    }
  }

  // 2) 1440x900 desktop viewport + dismiss/reload/confirm verification
  {
    const { context, page, state } = await openMockedJobDetail(browser, url, {
      width: 1440,
      height: 900,
    });
    try {
      geometryReport['1440'] = await assertDialogAndPageHealth(page, state, '1440');
      const shot1440 = resolve(outDir, 'job-detail-assignee-sync-1440.png');
      await page.screenshot({ path: shot1440 });
      captures.push(shot1440);

      // Verify "Şimdi değil" dismisses without POST
      await page.getByRole('button', { name: 'Şimdi değil' }).click();
      await page.locator('[role="dialog"]').waitFor({ state: 'detached' });
      assert.equal(state.syncCalls.length, 0, 'dismiss must not call job-assignee-sync');

      // Reload page -> hint still present -> prompt appears again
      await page.reload({ waitUntil: 'load' });
      await page.locator('[role="dialog"]').waitFor({ state: 'visible' });

      // Confirm sync -> POST + refetch + prompt disappears
      const lookupsBeforeConfirm = state.lookupCalls;
      await page.getByRole('button', { name: 'Ayşe Personel yerine Burak Personel ekle' }).click();
      await page.locator('[role="dialog"]').waitFor({ state: 'detached' });
      await page.waitForFunction(
        () => document.querySelectorAll('[role="dialog"]').length === 0,
      );
      assert.equal(state.syncCalls.length, 1, 'confirm must call job-assignee-sync once');
      assert.equal(state.syncCalls[0].assignmentTransitionId, TRANSITION_ID);
      assert.ok(state.lookupCalls > lookupsBeforeConfirm, 'confirm must refetch job conversation');
      assert.deepEqual(state.pageErrors, [], '1440-post-confirm: pageErrors');
      assert.deepEqual(state.consoleIssues, [], '1440-post-confirm: consoleIssues');
      assert.deepEqual(state.unexpectedRequests, [], '1440-post-confirm: unexpectedRequests');
    } finally {
      await context.close();
    }
  }
} finally {
  await browser?.close();
  server.close();
  await vite.close();
}

console.log(JSON.stringify({ outDir, captures, geometryReport }, null, 2));
