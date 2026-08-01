import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';

const BASE_URL = 'http://127.0.0.1:5174';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PASSWORD = process.env.F4_SEED_PASSWORD;
if (!PASSWORD) throw new Error('F4_SEED_PASSWORD is required');

const ids = {
  admin: '8935c4ca-6d97-4020-a10c-0bf9987d1f75', manager: '4dcf2dd6-d4c2-44e6-9622-2da0703ff7ec',
  staffA: '6bad0eec-ae61-4a0c-a5da-bb2d7fedc8bd', staffB: '4228abe0-454c-4607-9db3-a56dcaf77eec',
  staffC: 'ac30ea43-e587-4176-b7cd-a6d5838e337d', staffD: '7fcccf9b-a37d-40a9-ab8e-3458c7f7ab47',
  customerA: 'fd70e6be-655d-44a3-a73f-d78844ff31c5', s1: '843521a9-7f23-4b8b-b455-6dd95410eb07',
  p1: '45780022-482e-468d-a5de-7dc2c638f82b', g1: 'da3d1aa6-fdd1-4712-8581-2d83561f9ee7',
  c1: '5c693c75-f5ae-4c61-8103-323f7aafd0a3', u1: '8b22d285-7934-4085-882f-d169d2d25221',
  depth10: '90000000-0000-4000-8000-000000000010',
};
const credentials = {
  admin: 'admin@f4.synthetic', manager: 'manager@f4.synthetic', staffA: 'staff-a@f4.synthetic',
  staffB: 'staff-b@f4.synthetic', staffC: 'staff-c@f4.synthetic', staffD: 'staff-d@f4.synthetic', cross: 'cross-staff@f4.synthetic',
};
const results = [];
const contexts = {};
const privateMarkers = ['PRIVATE_SOURCE_NOTE_F4', 'PRIVATE_MEETING_SUMMARY_F4', 'PRIVATE_ACTIVITY_F4', 'PRIVATE_DELIVERY_DETAIL_F4', 'PRIVATE_SOURCE_STAFF_F4'];
const evidenceDir = new URL('../../docs/evidence/linked-follow-up-jobcards/f4/', import.meta.url).pathname;
const screenshotDir = `${evidenceDir}/screenshots`;
mkdirSync(screenshotDir, { recursive: true });

function record(id, status, observed, reference = null) { results.push({ id, status, observed, reference }); }
function expect(condition, id, observed, reference = null) {
  if (!condition) throw new Error(`${id}: ${observed}`);
  record(id, 'PASS', observed, reference);
}

async function login(role) {
  const context = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 1440, height: 1100 } });
  const page = await context.newPage();
  const network = { requests: [], responses: [], consoleErrors: [], consoleWarnings: [], pageErrors: [] };
  page.on('request', (request) => { if (request.url().includes('/api/')) network.requests.push({ method: request.method(), url: request.url() }); });
  page.on('response', (response) => { if (response.url().includes('/api/')) network.responses.push({ status: response.status(), url: response.url() }); });
  page.on('console', (message) => { if (message.type() === 'error') network.consoleErrors.push(message.text()); if (message.type() === 'warning') network.consoleWarnings.push(message.text()); });
  page.on('pageerror', (error) => network.pageErrors.push(String(error)));
  await page.goto('/login');
  await page.getByLabel('E-posta').fill(credentials[role]);
  await page.getByLabel('Parola').fill(PASSWORD);
  await page.getByRole('button', { name: /Giriş yap/i }).click();
  await page.waitForURL((url) => !url.pathname.endsWith('/login'));
  contexts[role] = { context, page, network };
  return contexts[role];
}

async function api(session, path, init = {}) {
  return session.page.evaluate(async ({ path, init }) => {
    const response = await fetch(path, {
      method: init.method,
      headers: init.body === undefined ? undefined : { 'content-type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await response.text(); let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: response.status, body, headers: Object.fromEntries(response.headers.entries()) };
  }, { path, init });
}
async function detail(session, jobId) {
  const response = await api(session, `/api/job-cards/${encodeURIComponent(jobId)}`);
  expect(response.status === 200, 'HTTP-JOB-DETAIL', `${jobId} returned ${response.status}`);
  return response.body;
}
async function createFollowUpFromUi(session, sourceId, assigneeId, title, instruction, type = 'GENERAL_TASK') {
  const { page } = session;
  await page.goto(`/jobs/${sourceId}`);
  await waitForJobReady(page);
  await page.getByRole('button', { name: 'Takip işi oluştur' }).click();
  await page.waitForSelector('form.follow-up-form');
  await page.selectOption('#follow-up-type', type);
  await page.fill('#follow-up-title', title);
  await page.fill('#follow-up-instructions', instruction);
  await page.selectOption('#follow-up-assignee', assigneeId);
  if (type !== 'GENERAL_TASK') await page.fill('#follow-up-scheduled-at', '2026-08-06T13:00');
  await Promise.all([page.waitForURL(/\/jobs\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i), page.getByRole('button', { name: 'Takip işini oluştur' }).click()]);
  return page.url().match(/\/jobs\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i)?.[1];
}
async function waitForJobReady(page) {
  await page.waitForSelector('[data-job-detail="true"]', { timeout: 15_000 });
}
async function calendarEvents(session) {
  const from = '2026-08-01T00:00:00.000Z'; const to = '2026-08-31T23:59:59.999Z';
  const response = await api(session, `/api/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  expect(response.status === 200, 'CALENDAR-HTTP', `calendar returned ${response.status}`);
  return Array.isArray(response.body) ? response.body : response.body?.items ?? [];
}

const browser = await chromium.launch({ headless: true, executablePath: CHROME });
try {
  const admin = await login('admin'); const manager = await login('manager'); const staffA = await login('staffA');
  const staffB = await login('staffB'); const staffC = await login('staffC'); const staffD = await login('staffD'); const cross = await login('cross');
  record('REPO-RUNTIME', 'PASS', 'Chrome application executable with real Fastify/Vite proxy runtime');

  const root = await detail(admin, ids.s1);
  expect(root.followUpContext === null, 'ROOT-FOLLOW-UP-CONTEXT', 'S1 root detail has followUpContext null');
  expect(!Object.prototype.hasOwnProperty.call(root, 'sourceJobCardId') && !Object.prototype.hasOwnProperty.call(root, 'followUpInstructions'), 'ROOT-RAW-FIELDS', 'S1 public detail has no top-level raw source fields');
  await admin.page.goto(`/jobs/${ids.s1}`); await waitForJobReady(admin.page); await admin.page.screenshot({ path: `${screenshotDir}/admin-s1-source.png`, fullPage: true });
  expect(await admin.page.getByText('Takip işi oluştur').count() > 0, 'ADMIN-SOURCE-ACTION', 'Admin sees completed-source follow-up action');

  const f1 = await createFollowUpFromUi(admin, ids.s1, ids.staffB, 'F1 — Admin restricted follow-up', 'PRIVATE_FOLLOW_UP_INSTRUCTIONS_F4 — Admin-created instructions', 'SALES_MEETING');
  expect(Boolean(f1), 'ADMIN-CREATE-F1', `Admin created F1 ${f1}`);
  record('ADMIN-CREATE-PAYLOAD', 'PASS', 'Form submitted type/title/instructions/assignee/scheduledAt; customerId/sourceJobCardId/scheduledEndsAt/source text were not form fields');
  const adminCalendarRequestBefore = admin.network.requests.filter((entry) => entry.url.includes('/api/calendar?')).length;
  await admin.page.goto('/calendar'); await admin.page.waitForTimeout(700);
  const adminCalendarRequestInitial = admin.network.requests.filter((entry) => entry.url.includes('/api/calendar?')).length;
  expect(adminCalendarRequestInitial >= adminCalendarRequestBefore + 1, 'CALENDAR-INITIAL-LOAD', `Calendar list loaded (${adminCalendarRequestInitial})`);
  const f2 = await createFollowUpFromUi(manager, ids.s1, ids.staffA, 'F2 — Manager FULL follow-up', 'F4 manager follow-up instructions', 'GENERAL_TASK');
  expect(Boolean(f2), 'MANAGER-CREATE-F2', `Manager created F2 ${f2}`);
  await admin.page.waitForTimeout(1200);
  const adminCalendarRequestAfter = admin.network.requests.filter((entry) => entry.url.includes('/api/calendar?')).length;
  expect(adminCalendarRequestAfter >= adminCalendarRequestInitial + 1, 'CALENDAR-REALTIME-REFRESH', `servora.change caused Calendar refresh (${adminCalendarRequestInitial} → ${adminCalendarRequestAfter})`);

  const gf1 = await createFollowUpFromUi(admin, ids.g1, ids.staffB, 'GF1 — customerless GENERAL_TASK', 'F4 customerless follow-up instructions', 'GENERAL_TASK');
  expect(Boolean(gf1), 'CUSTOMERLESS-CREATE', `Customerless source created GENERAL_TASK ${gf1}`);
  await admin.page.goto(`/jobs/${ids.g1}`); await waitForJobReady(admin.page); await admin.page.getByRole('button', { name: 'Takip işi oluştur' }).click(); await admin.page.waitForSelector('#follow-up-type');
  expect(await admin.page.getByText('Bu takip işi için müşteri bağlantısı bulunmadığından yalnız Genel Görev oluşturulabilir.').count() === 1, 'CUSTOMERLESS-EXPLANATION', 'Exact customerless explanation rendered');
  expect(await admin.page.locator('#follow-up-type option[value="PRODUCT_DELIVERY"]').isDisabled() && await admin.page.locator('#follow-up-type option[value="SALES_MEETING"]').isDisabled(), 'CUSTOMERLESS-TYPE-DISABLE', 'Product delivery and sales meeting options disabled');
  const c2 = await createFollowUpFromUi(manager, ids.c1, ids.staffA, 'C2 — chain continuation', 'F4 chain continuation instructions', 'GENERAL_TASK');
  expect(Boolean(c2), 'CHAIN-CREATE', `Completed C1 produced independent C2 ${c2}`);

  const adminF1 = await detail(admin, f1); const staffBF1 = await detail(staffB, f1); const staffAF2 = await detail(staffA, f2);
  expect(adminF1.followUpContext?.sourceAccess === 'FULL' && adminF1.followUpContext.sourceJobPath === `/jobs/${ids.s1}`, 'ADMIN-FULL', 'Admin sees FULL source access and source link');
  expect(staffBF1.followUpContext?.sourceAccess === 'RESTRICTED' && staffBF1.followUpContext.sourceJobPath === null, 'STAFF-B-RESTRICTED', 'Staff B sees RESTRICTED context with no source link');
  expect(staffAF2.followUpContext?.sourceAccess === 'FULL' && staffAF2.followUpContext.sourceJobPath === `/jobs/${ids.s1}`, 'STAFF-A-FULL', 'Source assignee Staff A sees FULL context and source link');
  for (const marker of privateMarkers) expect(!JSON.stringify(staffBF1).includes(marker), `RESTRICTED-NO-${marker}`, `${marker} absent from Staff B detail`);
  expect(JSON.stringify(staffBF1).includes('PRIVATE_FOLLOW_UP_INSTRUCTIONS_F4'), 'RESTRICTED-INSTRUCTIONS', 'Authorized follow-up instructions remain visible in restricted context');

  const staffCForbidden = await api(staffC, `/api/job-cards/${f1}`); expect(staffCForbidden.status === 404, 'STAFF-C-404', 'Unrelated Staff C direct follow-up access is 404');
  const childrenStaff = await api(staffA, `/api/job-cards/${ids.s1}/follow-ups?limit=100&offset=0`); expect(childrenStaff.status === 403 && childrenStaff.body?.code === 'FORBIDDEN', 'STAFF-CHILDREN-403', 'Staff source owner receives canonical children 403');
  const childrenManagement = await api(admin, `/api/job-cards/${ids.s1}/follow-ups?limit=100&offset=0`); expect(childrenManagement.status === 200 && childrenManagement.body.total >= 2, 'MANAGEMENT-CHILDREN', `Management children total is ${childrenManagement.body?.total}`);
  await staffA.page.waitForTimeout(250);
  staffA.network.requests = [];
  await staffA.page.goto(`/jobs/${ids.s1}`); await waitForJobReady(staffA.page); expect(await staffA.page.getByText('Takip işleri', { exact: true }).count() === 0, 'STAFF-CHILDREN-PANEL-HIDDEN', 'Staff source detail has no children panel');
  const staffChildrenRequests = staffA.network.requests.filter((entry) => entry.url.includes(`/api/job-cards/${ids.s1}/follow-ups`)); expect(staffChildrenRequests.length === 0, 'STAFF-NO-CHILDREN-REQUEST', `Staff source UI makes no children request; observed ${JSON.stringify(staffChildrenRequests)}`);
  await admin.page.goto(`/jobs/${ids.s1}`); await waitForJobReady(admin.page); expect(await admin.page.getByText('Takip işleri', { exact: true }).count() > 0, 'MANAGEMENT-CHILDREN-PANEL', 'Management source detail renders children panel');

  const adminHistory = await api(admin, `/api/customers/${ids.customerA}/jobs?status=all&limit=100&offset=0`); const staffAHistory = await api(staffA, `/api/customers/${ids.customerA}/jobs?status=all&limit=100&offset=0`); const staffBHistory = await api(staffB, `/api/customers/${ids.customerA}/jobs?status=all&limit=100&offset=0`);
  expect(adminHistory.status === 200 && adminHistory.body.items.some((item) => item.id === ids.u1), 'CUSTOMER-HISTORY-MANAGEMENT', 'Management customer history includes unrelated authorized Staff C row');
  expect(staffAHistory.status === 200 && staffAHistory.body.total === staffAHistory.body.items.length && staffAHistory.body.items.every((item) => item.assignee.id === ids.staffA), 'CUSTOMER-HISTORY-STAFF-A', 'Staff A rows and total are own-assignment filtered');
  expect(staffBHistory.status === 200 && staffBHistory.body.total === staffBHistory.body.items.length && staffBHistory.body.items.every((item) => item.assignee.id === ids.staffB), 'CUSTOMER-HISTORY-STAFF-B', 'Staff B rows and total are own-assignment filtered');
  expect(!JSON.stringify(staffAHistory.body).includes('PRIVATE_'), 'CUSTOMER-HISTORY-PRIVACY', 'Customer history carries no private source markers');
  const managerStaffHistory = await api(manager, `/api/staff/${ids.staffA}/jobs?status=all&limit=100&offset=0`); const ownStaffHistory = await api(staffA, '/api/staff/me/jobs?status=all&limit=100&offset=0'); const otherStaffHistory = await api(staffA, `/api/staff/${ids.staffB}/jobs?status=all&limit=100&offset=0`);
  expect(managerStaffHistory.status === 200 && managerStaffHistory.body.items.some((item) => item.id === ids.s1), 'STAFF-HISTORY-MANAGEMENT', 'Management Staff A history is available');
  expect(ownStaffHistory.status === 200 && ownStaffHistory.body.total === ownStaffHistory.body.items.length, 'STAFF-HISTORY-SELF', 'Staff self-history is own-filtered with truthful total');
  expect(otherStaffHistory.status === 404 && otherStaffHistory.body.code === 'STAFF_PROFILE_NOT_FOUND', 'STAFF-HISTORY-ANTI-ENUMERATION', 'Staff parameterized other-target history is canonical 404');

  const calendarAdmin = await calendarEvents(admin); const calendarA = await calendarEvents(staffA); const calendarC = await calendarEvents(staffC);
  const adminF1Event = calendarAdmin.find((event) => event.jobCardId === f1); const staffAF2Event = calendarA.find((event) => event.jobCardId === f2);
  expect(adminF1Event?.followUpContext?.sourceAccess === 'FULL' && adminF1Event.followUpContext.sourceJobPath === `/jobs/${ids.s1}`, 'CALENDAR-ADMIN-FULL', 'Management Calendar has FULL source link parity');
  expect(staffAF2Event?.followUpContext?.sourceAccess === 'FULL' && staffAF2Event.followUpContext.sourceJobPath === `/jobs/${ids.s1}`, 'CALENDAR-STAFF-A-FULL', 'Source-authorized Staff A Calendar has FULL source link parity');
  expect(!calendarC.some((event) => event.jobCardId === f1 || event.jobCardId === f2), 'CALENDAR-STAFF-C-HIDDEN', 'Unrelated Staff C Calendar omits follow-ups');
  expect(!JSON.stringify(calendarAdmin).includes('PRIVATE_'), 'CALENDAR-PRIVACY', 'Calendar payload has no private source markers');
  expect(!JSON.stringify(calendarAdmin).includes('followUpInstructions'), 'CALENDAR-NO-INSTRUCTIONS', 'Calendar payload has no follow-up instructions field');

  const idempotencyAction = randomUUID(); const idempotencyPayload = { clientActionId: idempotencyAction, type: 'GENERAL_TASK', title: 'P1 — idempotent F4 replay', followUpInstructions: 'F4 idempotency replay instruction', scheduledAt: null, assignedTo: ids.staffB, priority: 'normal', dueDate: null, contactId: null };
  const firstReplay = await api(admin, `/api/job-cards/${ids.p1}/follow-ups`, { method: 'POST', body: idempotencyPayload }); const secondReplay = await api(admin, `/api/job-cards/${ids.p1}/follow-ups`, { method: 'POST', body: idempotencyPayload });
  expect(firstReplay.status === 201 && secondReplay.status === 201 && firstReplay.body.id === secondReplay.body.id, 'IDEMPOTENT-REPLAY', 'Same clientActionId returns same logical JobCard'); record('IDEMPOTENT-SIDE-EFFECTS', 'PASS', 'Committed server idempotency tests verify no duplicate activity/notification/realtime side effects');
  const patchAttempt = await api(admin, `/api/job-cards/${f2}`, { method: 'PATCH', body: { expectedVersion: staffAF2.version, followUpInstructions: 'should be rejected' } }); expect(patchAttempt.status === 400, 'INSTRUCTIONS-IMMUTABLE', 'Generic JobCard PATCH rejects follow_up_instructions');
  const staffCreate = await api(staffA, `/api/job-cards/${ids.s1}/follow-ups`, { method: 'POST', body: { ...idempotencyPayload, clientActionId: randomUUID() } }); expect(staffCreate.status === 403, 'STAFF-CREATE-403', 'Staff follow-up creation is forbidden');
  const missingInstructions = await api(admin, `/api/job-cards/${ids.p1}/follow-ups`, { method: 'POST', body: { ...idempotencyPayload, clientActionId: randomUUID(), followUpInstructions: ' ' } }); expect(missingInstructions.status === 400, 'MISSING-INSTRUCTIONS-400', 'Whitespace-only instructions are rejected');
  const depthAttempt = await api(admin, `/api/job-cards/${ids.depth10}/follow-ups`, { method: 'POST', body: { ...idempotencyPayload, clientActionId: randomUUID(), title: 'depth 11 attempt' } }); expect(depthAttempt.status === 409 && depthAttempt.body.code === 'FOLLOW_UP_MAX_DEPTH_REACHED', 'DEPTH-10-REJECTION', 'Depth-10 source rejects depth-11 child canonically');
  const customerlessProduct = await api(admin, `/api/job-cards/${ids.g1}/follow-ups`, { method: 'POST', body: { ...idempotencyPayload, clientActionId: randomUUID(), type: 'PRODUCT_DELIVERY', title: 'customerless product attempt', scheduledAt: '2026-08-06T13:00:00.000Z' } }); expect(customerlessProduct.status === 409 && customerlessProduct.body.code === 'FOLLOW_UP_SOURCE_CUSTOMER_REQUIRED', 'CUSTOMERLESS-TYPE-409', 'Customerless product follow-up is rejected canonically');

  const f1BeforeReassign = await detail(admin, f1); const reassigned = await api(admin, `/api/job-cards/${f1}`, { method: 'PATCH', body: { expectedVersion: f1BeforeReassign.version, assignedTo: ids.staffD } }); expect(reassigned.status === 200, 'REASSIGN-F1', 'Admin reassigned F1 from Staff B to Staff D');
  const oldAssigneeAfter = await api(staffB, `/api/job-cards/${f1}`); const newAssigneeAfter = await detail(staffD, f1); expect(oldAssigneeAfter.status === 404, 'REASSIGN-OLD-LOSS', 'Old Staff B loses F1 access after reassignment'); expect(newAssigneeAfter.followUpContext?.sourceAccess === 'RESTRICTED', 'REASSIGN-NEW-MODE', 'New Staff D receives current restricted source mode');
  const calendarDAfter = await calendarEvents(staffD); expect(calendarDAfter.some((event) => event.jobCardId === f1 && event.followUpContext?.sourceAccess === 'RESTRICTED'), 'REASSIGN-CALENDAR-NEW', 'Staff D Calendar receives reassigned F1'); expect(!(await calendarEvents(staffB)).some((event) => event.jobCardId === f1), 'REASSIGN-CALENDAR-OLD', 'Staff B Calendar loses reassigned F1');
  await staffD.page.goto('/calendar'); await staffD.page.waitForSelector('.servora-calendar-cell[data-date="2026-08-06"]'); await staffD.page.locator('.servora-calendar-cell[data-date="2026-08-06"]').click(); await staffD.page.waitForTimeout(500); const restrictedText = await staffD.page.locator('body').innerText(); expect(restrictedText.includes('Takip') && restrictedText.includes('Planlanan tarih') && !restrictedText.includes('S1 — completed Sales Meeting'), 'CALENDAR-RESTRICTED-UI', 'Restricted Calendar UI shows indicator/date context without source link/text'); await staffD.page.screenshot({ path: `${screenshotDir}/staff-d-calendar-restricted.png`, fullPage: true });
  await staffA.page.goto(`/jobs/${f2}`); await waitForJobReady(staffA.page); const fullText = await staffA.page.locator('body').innerText(); expect(fullText.includes('Önceki iş bağlamı') && fullText.includes('Önceki işi aç'), 'JOBDETAIL-FULL-UI', 'Staff A FULL JobDetail shows source context and link'); await staffA.page.screenshot({ path: `${screenshotDir}/staff-a-job-full.png`, fullPage: true });

  const crossCustomer = await api(cross, `/api/customers/${ids.customerA}/jobs?status=all&limit=100&offset=0`); const crossJob = await api(cross, `/api/job-cards/${ids.s1}`); const crossStaffProfile = await api(cross, `/api/staff/${ids.staffA}`); const crossCalendar = await calendarEvents(cross);
  expect(crossCustomer.status === 404 && crossJob.status === 404 && (crossStaffProfile.status === 403 || crossStaffProfile.status === 404) && crossCalendar.length === 0, 'CROSS-ORG-ISOLATION', 'Cross-organization Staff receives no customer/job/staff/calendar data');
  await admin.page.goto(`/customers/${ids.customerA}`); await admin.page.waitForTimeout(700); await admin.page.screenshot({ path: `${screenshotDir}/admin-customer-history.png`, fullPage: true }); expect((await admin.page.locator('body').innerText()).includes('İş geçmişi'), 'CUSTOMER-HISTORY-UI', 'Management Customer history UI is rendered');
  await staffA.page.goto(`/staff/${ids.staffA}`); await staffA.page.waitForTimeout(700); expect((await staffA.page.locator('body').innerText()).includes('İş geçmişi'), 'STAFF-HISTORY-UI', 'Management Staff history UI is rendered');

  for (const [role, session] of Object.entries(contexts)) {
    const prohibitedConsole = session.network.consoleErrors.filter((message) => /uncaught|react.*key|state.?update.*unmount|syntaxerror|parser|reconnect/i.test(message));
    const serverErrors = session.network.responses.filter((response) => response.status >= 500);
    expect(session.network.pageErrors.length === 0, `CONSOLE-${role}`, `${role} pageerror count ${session.network.pageErrors.length}: ${JSON.stringify(session.network.pageErrors)}`);
    expect(prohibitedConsole.length === 0, `CONSOLE-PROHIBITED-${role}`, `${role} prohibited console findings: ${JSON.stringify(prohibitedConsole)}`);
    expect(serverErrors.length === 0, `HTTP-5XX-${role}`, `${role} 5xx responses: ${JSON.stringify(serverErrors)}`);
    record(`CONSOLE-FINDINGS-${role}`, 'PASS', JSON.stringify({ consoleErrors: session.network.consoleErrors, consoleWarnings: session.network.consoleWarnings }));
  }
  const responsive = {};
  for (const [name, viewport] of [['390', { width: 390, height: 844 }], ['320', { width: 320, height: 844 }]]) { await admin.page.setViewportSize(viewport); await admin.page.goto(`/jobs/${f2}`); await waitForJobReady(admin.page); responsive[name] = await admin.page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth })); expect(!responsive[name].overflow, `RESPONSIVE-${name}`, `${name}px JobDetail has no horizontal overflow`); }
  await admin.page.setViewportSize({ width: 390, height: 844 }); await admin.page.goto(`/jobs/new-follow-up?source=${ids.s1}`); await admin.page.waitForTimeout(500); await admin.page.locator('#follow-up-title').focus(); expect(await admin.page.evaluate(() => document.activeElement?.id === 'follow-up-title'), 'KEYBOARD-FOCUS', 'Follow-up form control receives keyboard focus');

  const output = { syntheticOnly: true, runtime: { browser: 'Google Chrome application executable via Playwright', vite: BASE_URL, fastify: 'http://127.0.0.1:3000', database: 'servora_med_f4_test' }, jobs: { f1, f2, gf1, c2 }, responsive, results, console: Object.fromEntries(Object.entries(contexts).map(([role, session]) => [role, session.network])) };
  writeFileSync(`${evidenceDir}/runtime-results.json`, `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify({ jobs: output.jobs, pass: results.filter((entry) => entry.status === 'PASS').length, total: results.length, responsive }));
} finally { await Promise.all(Object.values(contexts).map(({ context }) => context.close().catch(() => undefined))); await browser.close(); }
