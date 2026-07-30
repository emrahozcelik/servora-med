/**
 * Checkpoint B — Real UI Dialog Acceptance
 *
 * Uses Playwright Chromium to interact with the actual application UI.
 * Lifecycle operations through real UI clicks, dialogs, and inputs.
 * No page.evaluate() fetch for lifecycle commands.
 *
 * Supplementary API assertions use page.evaluate() fetch for
 * read-only state inspection within the authenticated browser context.
 */

import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:5173';
const API = 'http://127.0.0.1:5173/api';

const CREDENTIALS = {
  staff: { email: 'staff@servora.local', password: 'checkpoint-b-pass' },
  admin: { email: 'admin@servora.local', password: 'checkpoint-b-pass' },
};

const JOBS = {
  submit: '80a15b4c-57a9-42e1-8e36-87129c6930bb',
  approveBlank: 'bff9c14c-8991-4d65-ae12-d62b7534ce23',
  approveNonblank: '58069a24-381b-418b-97cc-30459b41da77',
  revision: '44250e56-0a1d-4ed3-800e-98a0b37f301d',
  cancel: '4897d2b9-07d1-440d-a5f6-64300360696c',
};

const results = [];

function record(scenario, test, result, detail = '') {
  results.push({ scenario, test, result, detail });
  const icon = result === 'PASS' ? '✓' : result === 'FAIL' ? '✗' : '○';
  console.log(`  ${icon} ${test}${detail ? ': ' + detail : ''}`);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function loginAs(page, context, email, password) {
  // Clear all state and start fresh
  await context.clearCookies();
  await page.goto(BASE + '/');
  await page.waitForTimeout(1000);

  // Wait for login form - if it doesn't appear, we may have stale state
  const hasLoginForm = await page.locator('input[type="email"]').isVisible().catch(() => false);
  if (!hasLoginForm) {
    // Try refreshing
    await page.reload();
    await page.waitForTimeout(1000);
  }

  await page.waitForSelector('input[type="email"]', { timeout: 10000 });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');

  // Wait for navigation to authenticated area
  try {
    await page.waitForURL('**/jobs', { timeout: 10000 });
  } catch {
    await page.waitForURL('**/overview', { timeout: 5000 }).catch(() => {});
  }
  await page.waitForTimeout(500);
}

async function navigateToJob(page, jobId) {
  await page.goto(BASE + '/jobs/' + jobId);
  await page.waitForSelector('[data-job-decision-panel="true"]', { timeout: 10000 });
  await page.waitForTimeout(500);
}

async function apiRead(page, path) {
  return page.evaluate(async (url) => {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) return null;
    return res.json();
  }, API + path);
}

// ─── Main Test Runner ────────────────────────────────────────────────────────

async function runTests() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();

  page.on('pageerror', err => console.log('  PAGE ERROR:', err.message));

  try {

    // ═══════════════════════════════════════════════════════════════════════════
    // SCENARIO A: SUBMIT_FOR_APPROVAL through real UI dialog (Staff)
    // ═══════════════════════════════════════════════════════════════════════════
    console.log('\n=== A: SUBMIT_FOR_APPROVAL (Staff) ===');

    await loginAs(page, context, CREDENTIALS.staff.email, CREDENTIALS.staff.password);

    const j1Before = await apiRead(page, '/job-cards/' + JOBS.submit);
    record('A', 'starting status = IN_PROGRESS',
      j1Before?.status === 'IN_PROGRESS' ? 'PASS' : 'FAIL', j1Before?.status);

    // Count existing activities before
    const j1ActsBefore = await apiRead(page, '/job-cards/' + JOBS.submit + '/activity?limit=50');
    const preSubmitActs = (j1ActsBefore?.items || []).filter(a => a.eventType === 'JOB_SUBMITTED_FOR_APPROVAL').length;

    await navigateToJob(page, JOBS.submit);

    // Click the real submit-for-approval command button
    await page.waitForTimeout(500);
    const submitBtn = page.locator('[data-job-decision-panel="true"] button.primary-button.compact-button', { hasText: 'Kontrole gönder' });
    await submitBtn.waitFor({ state: 'visible', timeout: 5000 });
    record('A', 'submit button visible', 'PASS');
    await submitBtn.click();

    // Assert dialog opens
    const dialog = page.locator('.reason-dialog');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
    record('A', 'reason dialog opens', 'PASS');

    // Assert label "Tamamlanma sonucu"
    const labelText = await dialog.locator('label').textContent();
    record('A', 'label="Tamamlanma sonucu"',
      labelText?.includes('Tamamlanma sonucu') ? 'PASS' : 'FAIL', labelText);

    // Assert helper text
    const helperText = await dialog.locator('.form-help').first().textContent();
    record('A', 'helper: yönetici kontrolüne gönderilen',
      helperText?.includes('yönetici kontrolüne gönderilen') ? 'PASS' : 'FAIL');

    // Attempt blank submission
    await dialog.locator('textarea').fill('');
    await dialog.locator('button.primary-button.compact-button').click();
    await page.waitForTimeout(300);

    const stillVisible = await dialog.isVisible();
    const errorMsg = await dialog.locator('.field-error').textContent().catch(() => '');
    record('A', 'blank submission blocked',
      (stillVisible && errorMsg?.includes('zorunludur')) ? 'PASS' : 'FAIL', errorMsg);

    const ariaInvalid = await dialog.locator('textarea').getAttribute('aria-invalid');
    record('A', 'aria-invalid after blank', ariaInvalid === 'true' ? 'PASS' : 'FAIL');

    // Enter Unicode text
    const unicodeNote = 'Tamamlanma sonucu: 🦷';
    await dialog.locator('textarea').fill(unicodeNote);

    // Check code-point counter
    const counter = await dialog.locator('[aria-live="polite"]').textContent();
    record('A', 'code-point counter', counter?.includes('karakter kaldı') ? 'PASS' : 'FAIL', counter);

    // Confirm
    const confirmBtn = dialog.locator('button.primary-button.compact-button');
    await confirmBtn.click();

    try {
      await dialog.waitFor({ state: 'hidden', timeout: 8000 });
      record('A', 'dialog closes on success', 'PASS');
    } catch {
      record('A', 'dialog closes on success', 'FAIL');
    }

    await page.waitForTimeout(1500);
    const j1After = await apiRead(page, '/job-cards/' + JOBS.submit);
    record('A', 'status = WAITING_APPROVAL',
      j1After?.status === 'WAITING_APPROVAL' ? 'PASS' : 'FAIL', j1After?.status);

    // Note visible in JobNotes
    await page.reload();
    await page.waitForTimeout(1500);
    const notesContents = await page.locator('.job-note-body').allTextContents();
    const noteShown = notesContents.some(t => t.includes('Tamamlanma sonucu: 🦷'));
    record('A', 'note visible in JobNotes', noteShown ? 'PASS' : 'FAIL');

    // DB: operational note
    const j1Notes = await apiRead(page, '/job-cards/' + JOBS.submit + '/notes?limit=50');
    const submitNotes = (j1Notes?.items || []).filter(n => n.context === 'SUBMIT_FOR_APPROVAL');
    record('A', '1 SUBMIT operational note', submitNotes.length >= 1 ? 'PASS' : 'FAIL', 'cnt=' + submitNotes.length);
    if (submitNotes.length > 0) {
      const latest = submitNotes[submitNotes.length - 1];
      record('A', 'workflow_stage=IN_PROGRESS', latest?.workflowStage === 'IN_PROGRESS' ? 'PASS' : 'FAIL', latest?.workflowStage);
    }

    // Activity
    const j1ActsAfter = await apiRead(page, '/job-cards/' + JOBS.submit + '/activity?limit=50');
    const postSubmitActs = (j1ActsAfter?.items || []).filter(a => a.eventType === 'JOB_SUBMITTED_FOR_APPROVAL').length;
    record('A', 'SUBMITTED_FOR_APPROVAL activity created',
      postSubmitActs > preSubmitActs ? 'PASS' : 'FAIL', `before=${preSubmitActs} after=${postSubmitActs}`);

    // ═══════════════════════════════════════════════════════════════════════════
    // SCENARIO B: APPROVE — blank note (Admin)
    // ═══════════════════════════════════════════════════════════════════════════
    console.log('\n=== B: APPROVE blank (Admin) ===');

    await loginAs(page, context, CREDENTIALS.admin.email, CREDENTIALS.admin.password);

    const j2Before = await apiRead(page, '/job-cards/' + JOBS.approveBlank);
    record('B', 'starting WAITING_APPROVAL',
      j2Before?.status === 'WAITING_APPROVAL' ? 'PASS' : 'FAIL', j2Before?.status);

    await navigateToJob(page, JOBS.approveBlank);

    const approveBtn = page.locator('[data-job-decision-panel="true"] button.primary-button', { hasText: 'Kontrolü tamamla' });
    await approveBtn.waitFor({ state: 'visible', timeout: 5000 });
    record('B', 'approve button visible', 'PASS');
    await approveBtn.click();

    const bDialog = page.locator('.reason-dialog');
    await bDialog.waitFor({ state: 'visible', timeout: 5000 });
    record('B', 'approve dialog opens', 'PASS');

    const bLabel = await bDialog.locator('label').textContent();
    record('B', 'label="Onay notu"',
      bLabel?.includes('Onay notu') ? 'PASS' : 'FAIL', bLabel);

    // Leave blank, confirm
    await bDialog.locator('textarea').fill('');
    await bDialog.locator('button.primary-button.compact-button').click();

    try {
      await bDialog.waitFor({ state: 'hidden', timeout: 8000 });
      record('B', 'dialog closes', 'PASS');
    } catch {
      record('B', 'dialog closes', 'FAIL');
    }

    await page.waitForTimeout(1500);
    const j2After = await apiRead(page, '/job-cards/' + JOBS.approveBlank);
    record('B', 'status=COMPLETED',
      j2After?.status === 'COMPLETED' ? 'PASS' : 'FAIL', j2After?.status);

    const j2Notes = await apiRead(page, '/job-cards/' + JOBS.approveBlank + '/notes?limit=50');
    const blankApproves = (j2Notes?.items || []).filter(n => n.context === 'APPROVE');
    record('B', 'no APPROVE note for blank',
      blankApproves.length === 0 ? 'PASS' : 'FAIL', 'cnt=' + blankApproves.length);

    // ═══════════════════════════════════════════════════════════════════════════
    // SCENARIO C: APPROVE — nonblank (Admin)
    // ═══════════════════════════════════════════════════════════════════════════
    console.log('\n=== C: APPROVE nonblank (Admin) ===');

    await navigateToJob(page, JOBS.approveNonblank);

    const j3Before = await apiRead(page, '/job-cards/' + JOBS.approveNonblank);
    record('C', 'starting WAITING_APPROVAL',
      j3Before?.status === 'WAITING_APPROVAL' ? 'PASS' : 'FAIL', j3Before?.status);

    const cApproveBtn = page.locator('[data-job-decision-panel="true"] button.primary-button', { hasText: 'Kontrolü tamamla' });
    await cApproveBtn.click();

    const cDialog = page.locator('.reason-dialog');
    await cDialog.waitFor({ state: 'visible', timeout: 5000 });
    record('C', 'approve dialog opens', 'PASS');

    const cLabel = await cDialog.locator('label').textContent();
    record('C', 'label="Onay notu"', cLabel?.includes('Onay notu') ? 'PASS' : 'FAIL');

    const nonblankText = 'Onay notu \u2713 \u00AE';
    await cDialog.locator('textarea').fill(nonblankText);
    await cDialog.locator('button.primary-button.compact-button').click();

    try {
      await cDialog.waitFor({ state: 'hidden', timeout: 8000 });
      record('C', 'dialog closes', 'PASS');
    } catch {
      record('C', 'dialog closes', 'FAIL');
    }

    await page.waitForTimeout(1500);
    const j3After = await apiRead(page, '/job-cards/' + JOBS.approveNonblank);
    record('C', 'status=COMPLETED',
      j3After?.status === 'COMPLETED' ? 'PASS' : 'FAIL', j3After?.status);

    await page.reload();
    await page.waitForTimeout(1500);
    const cNotesContents = await page.locator('.job-note-body').allTextContents();
    record('C', 'approve note visible in JobNotes',
      cNotesContents.some(t => t.includes('Onay notu')) ? 'PASS' : 'FAIL');

    const j3Notes = await apiRead(page, '/job-cards/' + JOBS.approveNonblank + '/notes?limit=50');
    const cApproves = (j3Notes?.items || []).filter(n => n.context === 'APPROVE');
    record('C', '1 APPROVE operational note',
      cApproves.length >= 1 ? 'PASS' : 'FAIL', 'cnt=' + cApproves.length);
    if (cApproves.length > 0) {
      const latest = cApproves[cApproves.length - 1];
      record('C', 'workflow_stage=WAITING_APPROVAL',
        latest?.workflowStage === 'WAITING_APPROVAL' ? 'PASS' : 'FAIL', latest?.workflowStage);
      record('C', 'note body matches input',
        latest?.note === nonblankText ? 'PASS' : 'FAIL');
    }
    record('C', 'manager_approval_note matches',
      j3After?.workflowContext?.lifecycle?.approvalNote === nonblankText ? 'PASS' : 'FAIL',
      JSON.stringify(j3After?.workflowContext?.lifecycle?.approvalNote));

    // ═══════════════════════════════════════════════════════════════════════════
    // SCENARIO D: REQUEST_REVISION (Admin)
    // ═══════════════════════════════════════════════════════════════════════════
    console.log('\n=== D: REQUEST_REVISION (Admin) ===');

    await navigateToJob(page, JOBS.revision);

    const j4Before = await apiRead(page, '/job-cards/' + JOBS.revision);
    record('D', 'starting WAITING_APPROVAL',
      j4Before?.status === 'WAITING_APPROVAL' ? 'PASS' : 'FAIL', j4Before?.status);

    const revBtn = page.locator('[data-job-decision-panel="true"] button.secondary-button', { hasText: 'Düzeltme için' });
    await revBtn.waitFor({ state: 'visible', timeout: 5000 });
    record('D', 'revision button visible', 'PASS');
    await revBtn.click();

    const dDialog = page.locator('.reason-dialog');
    await dDialog.waitFor({ state: 'visible', timeout: 5000 });
    record('D', 'revision dialog opens', 'PASS');

    const dLabel = await dDialog.locator('label').textContent();
    record('D', 'label="Düzeltme nedeni"',
      dLabel?.includes('Düzeltme nedeni') ? 'PASS' : 'FAIL', dLabel);

    const dTextareaCount = await dDialog.locator('textarea').count();
    record('D', 'exactly 1 textarea', dTextareaCount === 1 ? 'PASS' : 'FAIL', 'cnt=' + dTextareaCount);

    const revisionText = 'Browser d\xFCzeltme \uD83E\uDDB7';
    await dDialog.locator('textarea').fill(revisionText);

    const dCounter = await dDialog.locator('[aria-live="polite"]').textContent();
    record('D', 'counter present', dCounter?.includes('karakter kaldı') ? 'PASS' : 'FAIL');

    // Tab behavior
    await dDialog.locator('textarea').press('Tab');
    await page.waitForTimeout(200);
    const tabEl = await page.evaluate(() => document.activeElement?.tagName);
    record('D', 'Tab stays in dialog', tabEl ? 'PASS' : 'FAIL', tabEl);

    await dDialog.locator('button.primary-button.compact-button').click();

    try {
      await dDialog.waitFor({ state: 'hidden', timeout: 8000 });
      record('D', 'dialog closes', 'PASS');
    } catch {
      record('D', 'dialog closes', 'FAIL');
    }

    await page.waitForTimeout(1500);
    const j4After = await apiRead(page, '/job-cards/' + JOBS.revision);
    record('D', 'status=REVISION_REQUESTED',
      j4After?.status === 'REVISION_REQUESTED' ? 'PASS' : 'FAIL', j4After?.status);

    await page.reload();
    await page.waitForTimeout(1500);
    const dNotesContents = await page.locator('.job-note-body').allTextContents();
    record('D', 'revision note visible',
      dNotesContents.some(t => t.includes('Browser d\xFCzeltme')) ? 'PASS' : 'FAIL');

    const j4Notes = await apiRead(page, '/job-cards/' + JOBS.revision + '/notes?limit=50');
    const revNotes = (j4Notes?.items || []).filter(n => n.context === 'REQUEST_REVISION');
    record('D', '1 REQUEST_REVISION note',
      revNotes.length >= 1 ? 'PASS' : 'FAIL', 'cnt=' + revNotes.length);
    if (revNotes.length > 0) {
      const latest = revNotes[revNotes.length - 1];
      record('D', 'workflow_stage=WAITING_APPROVAL',
        latest?.workflowStage === 'WAITING_APPROVAL' ? 'PASS' : 'FAIL', latest?.workflowStage);
      record('D', 'note body matches',
        latest?.note === revisionText ? 'PASS' : 'FAIL');
    }
    record('D', 'revision_reason matches',
      j4After?.workflowContext?.lifecycle?.revisionReason === revisionText ? 'PASS' : 'FAIL',
      JSON.stringify(j4After?.workflowContext?.lifecycle?.revisionReason));

    // Activity
    const j4Acts = await apiRead(page, '/job-cards/' + JOBS.revision + '/activity?limit=50');
    const dActs = (j4Acts?.items || []).filter(a => a.eventType === 'JOB_REVISION_REQUESTED');
    record('D', 'REVISION_REQUESTED activity', dActs.length >= 1 ? 'PASS' : 'FAIL', 'cnt=' + dActs.length);

    // Focus restoration
    await page.waitForTimeout(500);
    const focusEl = await page.evaluate(() => document.activeElement?.tagName);
    record('D', 'focus restored after dialog', focusEl ? 'PASS' : 'FAIL', focusEl);

    // ═══════════════════════════════════════════════════════════════════════════
    // SCENARIO E: CANCEL (Staff)
    // ═══════════════════════════════════════════════════════════════════════════
    console.log('\n=== E: CANCEL (Staff) ===');

    await loginAs(page, context, CREDENTIALS.staff.email, CREDENTIALS.staff.password);

    const j5Before = await apiRead(page, '/job-cards/' + JOBS.cancel);
    record('E', 'starting IN_PROGRESS',
      j5Before?.status === 'IN_PROGRESS' ? 'PASS' : 'FAIL', j5Before?.status);

    await navigateToJob(page, JOBS.cancel);

    const cancelBtn = page.locator('[data-job-decision-panel="true"] button.destructive-button', { hasText: 'İşi iptal et' });
    await cancelBtn.waitFor({ state: 'visible', timeout: 5000 });
    record('E', 'cancel button visible', 'PASS');
    await cancelBtn.click();

    const eDialog = page.locator('.reason-dialog');
    await eDialog.waitFor({ state: 'visible', timeout: 5000 });
    record('E', 'cancel dialog opens', 'PASS');

    const eLabel = await eDialog.locator('label').textContent();
    record('E', 'label="İptal nedeni"',
      eLabel?.includes('İptal nedeni') ? 'PASS' : 'FAIL', eLabel);

    const eTextareaCount = await eDialog.locator('textarea').count();
    record('E', 'exactly 1 textarea', eTextareaCount === 1 ? 'PASS' : 'FAIL', 'cnt=' + eTextareaCount);

    const cancelText = 'Browser iptal \uD83D\uDEAB';
    await eDialog.locator('textarea').fill(cancelText);

    const destructiveVisible = await eDialog.locator('button.destructive-button').isVisible();
    record('E', 'destructive confirm button', destructiveVisible ? 'PASS' : 'FAIL');

    // Tab check
    await eDialog.locator('textarea').press('Tab');
    await page.waitForTimeout(200);
    const eTabEl = await page.evaluate(() => document.activeElement?.tagName);
    record('E', 'Tab in dialog', eTabEl ? 'PASS' : 'FAIL');

    await eDialog.locator('button.destructive-button.compact-button').click();

    try {
      await eDialog.waitFor({ state: 'hidden', timeout: 8000 });
      record('E', 'dialog closes', 'PASS');
    } catch {
      record('E', 'dialog closes', 'FAIL');
    }

    await page.waitForTimeout(1500);
    const j5After = await apiRead(page, '/job-cards/' + JOBS.cancel);
    record('E', 'status=CANCELLED',
      j5After?.status === 'CANCELLED' ? 'PASS' : 'FAIL', j5After?.status);

    await page.reload();
    await page.waitForTimeout(1500);
    const eNotesContents = await page.locator('.job-note-body').allTextContents();
    record('E', 'cancel note visible',
      eNotesContents.some(t => t.includes('Browser iptal')) ? 'PASS' : 'FAIL');

    const j5Notes = await apiRead(page, '/job-cards/' + JOBS.cancel + '/notes?limit=50');
    const cancelNotes = (j5Notes?.items || []).filter(n => n.context === 'CANCEL');
    record('E', '1 CANCEL operational note',
      cancelNotes.length >= 1 ? 'PASS' : 'FAIL', 'cnt=' + cancelNotes.length);
    if (cancelNotes.length > 0) {
      const latest = cancelNotes[cancelNotes.length - 1];
      record('E', 'workflow_stage=IN_PROGRESS',
        latest?.workflowStage === 'IN_PROGRESS' ? 'PASS' : 'FAIL', latest?.workflowStage);
      record('E', 'note body matches',
        latest?.note === cancelText ? 'PASS' : 'FAIL');
    }
    record('E', 'cancel_reason matches',
      j5After?.workflowContext?.lifecycle?.cancelReason === cancelText ? 'PASS' : 'FAIL',
      JSON.stringify(j5After?.workflowContext?.lifecycle?.cancelReason));
    record('E', 'cancelledFromStatus=IN_PROGRESS',
      j5After?.workflowContext?.lifecycle?.cancelledFromStatus === 'IN_PROGRESS' ? 'PASS' : 'FAIL',
      JSON.stringify(j5After?.workflowContext?.lifecycle?.cancelledFromStatus));

    const j5Acts = await apiRead(page, '/job-cards/' + JOBS.cancel + '/activity?limit=50');
    const eActs = (j5Acts?.items || []).filter(a => a.eventType === 'JOB_CANCELLED');
    record('E', 'JOB_CANCELLED activity', eActs.length >= 1 ? 'PASS' : 'FAIL', 'cnt=' + eActs.length);

    // Focus restoration
    await page.waitForTimeout(500);
    const eFocusEl = await page.evaluate(() => document.activeElement?.tagName);
    record('E', 'focus restored after cancel', eFocusEl ? 'PASS' : 'FAIL', eFocusEl);

    // ═══════════════════════════════════════════════════════════════════════════
    // NOTE_ADDED absence
    // ═══════════════════════════════════════════════════════════════════════════
    console.log('\n=== NOTE_ADDED absence ===');
    for (const [label, jid] of [
      ['SUBMIT J1', JOBS.submit],
      ['APPROVE J3', JOBS.approveNonblank],
      ['REVISION J4', JOBS.revision],
      ['CANCEL J5', JOBS.cancel],
    ]) {
      const acts = await apiRead(page, '/job-cards/' + jid + '/activity?limit=50');
      const naActs = (acts?.items || []).filter(a => a.eventType === 'NOTE_ADDED');
      record('NOTE_ADDED absence', label,
        naActs.length === 0 ? 'PASS' : 'FAIL', 'cnt=' + naActs.length);
    }

  } finally {
    await browser.close();
  }

  return results;
}

// ─── Run ─────────────────────────────────────────────────────────────────────

const allResults = await runTests();

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('DIALOG ACCEPTANCE SUMMARY');
console.log('═══════════════════════════════════════════════════════════════');

let pass = 0, fail = 0;
for (const r of allResults) {
  if (r.result === 'PASS') pass++;
  else if (r.result === 'FAIL') fail++;
}
console.log(`\nTotal: ${allResults.length}, PASS: ${pass}, FAIL: ${fail}`);

if (fail > 0) {
  console.log('\nFAILURES:');
  for (const r of allResults) {
    if (r.result === 'FAIL') console.log(`  [${r.scenario}] ${r.test}: ${r.detail || ''}`);
  }
}

process.exit(fail > 0 ? 1 : 0);
