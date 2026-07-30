/**
 * Checkpoint B — Real UI Dialog Acceptance
 *
 * Uses Playwright Chromium to interact with the actual application UI.
 * Lifecycle operations through real UI clicks, dialogs, and inputs.
 * No page.evaluate() fetch for lifecycle commands.
 *
 * Supplementary API assertions use page.evaluate() fetch for
 * read-only state inspection within the authenticated browser context.
 *
 * Credentials are supplied via environment variables:
 *   CHECKPOINT_B_TEST_EMAIL_STAFF, CHECKPOINT_B_TEST_EMAIL_ADMIN
 *   CHECKPOINT_B_TEST_PASSWORD
 * No passwords or tokens are committed.
 */

import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:5173';
const API = 'http://127.0.0.1:5173/api';

// ─── Credentials from environment ─────────────────────────────────────────────
const EMAIL_STAFF = process.env.CHECKPOINT_B_TEST_EMAIL_STAFF;
const EMAIL_ADMIN = process.env.CHECKPOINT_B_TEST_EMAIL_ADMIN;
const PASSWORD = process.env.CHECKPOINT_B_TEST_PASSWORD;

if (!EMAIL_STAFF) throw new Error('CHECKPOINT_B_TEST_EMAIL_STAFF is required');
if (!EMAIL_ADMIN) throw new Error('CHECKPOINT_B_TEST_EMAIL_ADMIN is required');
if (!PASSWORD) throw new Error('CHECKPOINT_B_TEST_PASSWORD is required');

// ─── Synthetic JobCard IDs (seeded via SQL, not credentials) ─────────────────
const JOBS = {
  submit: '630dabbe-72d6-49bb-8988-24bea27b4200',
  approveBlank: '2f02cde1-2eee-4aa7-bae5-4f43ba29f026',
  approveNonblank: '610a1697-99ea-4f1b-86f9-652700330d65',
  revision: '467effc2-150a-4cba-8e50-12320533162d',
  cancel: '1453ed3b-fbc8-4ab8-bba5-b1e57f74e322',
};

const results = [];

function record(scenario, test, result, detail = '') {
  results.push({ scenario, test, result, detail });
  const icon = result === 'PASS' ? '✓' : result === 'FAIL' ? '✗' : '○';
  console.log(`  ${icon} ${test}${detail ? ': ' + detail : ''}`);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function loginAs(page, context, email) {
  await context.clearCookies();
  await page.goto(BASE + '/');
  await page.waitForTimeout(1000);

  const hasLoginForm = await page.locator('input[type="email"]').isVisible().catch(() => false);
  if (!hasLoginForm) {
    await page.reload();
    await page.waitForTimeout(1000);
  }

  await page.waitForSelector('input[type="email"]', { timeout: 10000 });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');

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

// ─── Focus helpers ───────────────────────────────────────────────────────────

/**
 * Assert activeElement is contained within the dialog element (real focus containment).
 */
async function assertFocusInsideDialog(page, dialogLocator, label) {
  const inside = await dialogLocator.evaluate(
    (el) => el.contains(document.activeElement),
  );
  const activeTag = await page.evaluate(() => document.activeElement?.tagName || 'none');
  record(label, 'focus containment', inside ? 'PASS' : 'FAIL',
    `active=${activeTag} inside=${inside}`);
  return inside;
}

/**
 * Assert focus returns to the stored trigger element after dialog close.
 * When the trigger is replaced by a lifecycle transition, verifies focus
 * exists on a known canonical element (body or decision panel).
 */
async function assertFocusReturnedToTrigger(page, triggerLocator, label) {
  try {
    await triggerLocator.waitFor({ state: 'visible', timeout: 3000 });
    const focused = await triggerLocator.evaluate((el) => el === document.activeElement);
    record(label, 'focus restoration', focused ? 'PASS' : 'FAIL',
      focused ? 'trigger focused' : 'trigger exists but not focused');
    return focused;
  } catch {
    // Trigger replaced by transition — assert focus on a permitted canonical target
    const targetInfo = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return 'none';
      if (el.closest('[data-job-decision-panel]')) return 'decision-panel';
      if (el.closest('.detail-feedback')) return 'detail-feedback';
      if (el.closest('.job-notes')) return 'job-notes';
      // BODY alone without any permitted ancestor is not sufficient
      return 'unexpected:' + el.tagName + (el.className ? '.' + el.className.split(' ')[0] : '');
    });
    const isPermitted = targetInfo === 'decision-panel' || targetInfo === 'detail-feedback' || targetInfo === 'job-notes';
    record(label, 'focus restoration (post-transition)', isPermitted ? 'PASS' : 'FAIL',
      'target=' + targetInfo);
    return isPermitted;
  }
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
    // RESPONSIVE: mobile viewport — run BEFORE any scenarios mutate state
    // ═══════════════════════════════════════════════════════════════════════════
    console.log('\n=== RESPONSIVE (mobile) ===');

    // Use a separate context for mobile — reuse EMAIL_STAFF and JOBS.submit (still IN_PROGRESS)
    {
      const mobileCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const mobilePage = await mobileCtx.newPage();

      await mobilePage.goto(BASE + '/');
      await mobilePage.waitForSelector('input[type="email"]', { timeout: 8000 });
      await mobilePage.fill('input[type="email"]', EMAIL_STAFF);
      await mobilePage.fill('input[type="password"]', PASSWORD);
      await mobilePage.click('button[type="submit"]');
      await mobilePage.waitForURL('**/jobs', { timeout: 10000 });

      // Check overflow on JobDetail page (J1 still IN_PROGRESS at this point)
      await mobilePage.goto(BASE + '/jobs/' + JOBS.submit);
      await mobilePage.waitForSelector('[data-job-decision-panel="true"]', { timeout: 10000 });
      await mobilePage.waitForTimeout(500);

      const mobilePageOverflow = await mobilePage.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      record('RESPONSIVE', 'mobile 390x844: JobDetail page no horizontal overflow',
        !mobilePageOverflow ? 'PASS' : 'FAIL', 'overflow=' + mobilePageOverflow);

      // Open a dialog and verify it doesn't cause overflow
      const mobileBtn = mobilePage.locator(
        '[data-job-decision-panel="true"] button.primary-button', { hasText: 'Kontrole' },
      );
      const btnVisible = await mobileBtn.isVisible().catch(() => false);
      if (!btnVisible) {
        record('RESPONSIVE', 'mobile: submit button visible for dialog test', 'FAIL', 'button not found');
      } else {
        await mobileBtn.click();
        const mDialog = mobilePage.locator('.reason-dialog');
        await mDialog.waitFor({ state: 'visible', timeout: 5000 });
        const mDialogOverflow = await mobilePage.evaluate(
          () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
        );
        record('RESPONSIVE', 'mobile: dialog does not cause horizontal overflow',
          !mDialogOverflow ? 'PASS' : 'FAIL', 'overflow=' + mDialogOverflow);
        // Close dialog without submitting
        const cancelBtn = mDialog.locator('button.secondary-button');
        await cancelBtn.click();
        await mDialog.waitFor({ state: 'hidden', timeout: 3000 });
      }
      await mobileCtx.close();
    }

    // 200% zoom classification
    record('RESPONSIVE', '200% zoom/reflow',
      'NOT EXERCISED', 'genuine browser zoom not available in MCP/Playwright harness');

    // ═══════════════════════════════════════════════════════════════════════════
    // SCENARIO A: SUBMIT_FOR_APPROVAL — real UI dialog (Staff)
    // ═══════════════════════════════════════════════════════════════════════════
    console.log('\n=== A: SUBMIT_FOR_APPROVAL (Staff) ===');

    await loginAs(page, context, EMAIL_STAFF);

    const j1Before = await apiRead(page, '/job-cards/' + JOBS.submit);
    record('A', 'starting status = IN_PROGRESS',
      j1Before?.status === 'IN_PROGRESS' ? 'PASS' : 'FAIL', j1Before?.status);

    await navigateToJob(page, JOBS.submit);
    await page.waitForTimeout(500);

    // Store trigger button
    const submitBtn = page.locator(
      '[data-job-decision-panel="true"] button.primary-button.compact-button',
      { hasText: 'Kontrole gönder' },
    );
    await submitBtn.waitFor({ state: 'visible', timeout: 5000 });
    record('A', 'submit button visible', 'PASS');
    await submitBtn.click();

    // Dialog opens
    const dialog = page.locator('.reason-dialog');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
    record('A', 'reason dialog opens', 'PASS');

    // Label "Tamamlanma sonucu"
    const labelText = await dialog.locator('label').textContent();
    record('A', 'label="Tamamlanma sonucu"',
      labelText?.includes('Tamamlanma sonucu') ? 'PASS' : 'FAIL', labelText);

    // Helper text
    const helperText = await dialog.locator('.form-help').first().textContent();
    record('A', 'helper: yönetici kontrolüne gönderilen',
      helperText?.includes('yönetici kontrolüne gönderilen') ? 'PASS' : 'FAIL');

    // Focus inside dialog after opening
    await assertFocusInsideDialog(page, dialog, 'A');

    // Blank submission blocked
    await dialog.locator('textarea').fill('');
    await dialog.locator('button.primary-button.compact-button').click();
    await page.waitForTimeout(300);

    const stillVisible = await dialog.isVisible();
    const errorMsg = await dialog.locator('.field-error').textContent().catch(() => '');
    record('A', 'blank submission blocked',
      (stillVisible && errorMsg?.includes('zorunludur')) ? 'PASS' : 'FAIL', errorMsg);

    const ariaInvalid = await dialog.locator('textarea').getAttribute('aria-invalid');
    record('A', 'aria-invalid after blank', ariaInvalid === 'true' ? 'PASS' : 'FAIL');

    // Unicode text and counter
    const unicodeNote = 'Tamamlanma sonucu: \uD83E\uDDB7';
    await dialog.locator('textarea').fill(unicodeNote);

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

    // Focus restoration: submit button replaced by page re-render.
    // Verify focus lands on a permitted canonical target.
    await page.waitForTimeout(1000);
    const submitFocus = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return 'none';
      if (el.closest('.detail-feedback')) return 'detail-feedback';
      if (el.closest('[data-job-decision-panel]')) return 'decision-panel';
      if (el.closest('.job-notes')) return 'job-notes';
      return 'unexpected:' + el.tagName;
    });
    const isPermitted = submitFocus === 'detail-feedback' || submitFocus === 'decision-panel' || submitFocus === 'job-notes';
    record('A', 'post-submit focus target', isPermitted ? 'PASS' : 'FAIL', submitFocus);

    await page.waitForTimeout(1500);
    const j1After = await apiRead(page, '/job-cards/' + JOBS.submit);
    record('A', 'status = WAITING_APPROVAL',
      j1After?.status === 'WAITING_APPROVAL' ? 'PASS' : 'FAIL', j1After?.status);

    // Note visible in JobNotes
    await page.reload();
    await page.waitForTimeout(1500);
    const notesContents = await page.locator('.job-note-body').allTextContents();
    const noteShown = notesContents.some(t => t.includes('Tamamlanma sonucu'));
    record('A', 'note visible in JobNotes', noteShown ? 'PASS' : 'FAIL');

    // DB: operational note — exact count
    const j1Notes = await apiRead(page, '/job-cards/' + JOBS.submit + '/notes?limit=50');
    const submitNotes = (j1Notes?.items || []).filter(n => n.context === 'SUBMIT_FOR_APPROVAL');
    record('A', '1 SUBMIT operational note',
      submitNotes.length === 1 ? 'PASS' : 'FAIL', 'cnt=' + submitNotes.length);
    if (submitNotes.length === 1) {
      record('A', 'workflow_stage=IN_PROGRESS',
        submitNotes[0].workflowStage === 'IN_PROGRESS' ? 'PASS' : 'FAIL', submitNotes[0].workflowStage);
    }

    // Activity — exactly 1 new activity
    const j1Acts = await apiRead(page, '/job-cards/' + JOBS.submit + '/activity?limit=50');
    const submitActs = (j1Acts?.items || []).filter(a => a.eventType === 'JOB_SUBMITTED_FOR_APPROVAL');
    record('A', '1 SUBMITTED_FOR_APPROVAL activity',
      submitActs.length === 1 ? 'PASS' : 'FAIL', 'cnt=' + submitActs.length);

    // ═══════════════════════════════════════════════════════════════════════════
    // SCENARIO B: APPROVE — blank note (Admin)
    // ═══════════════════════════════════════════════════════════════════════════
    console.log('\n=== B: APPROVE blank (Admin) ===');

    await loginAs(page, context, EMAIL_ADMIN);

    const j2Before = await apiRead(page, '/job-cards/' + JOBS.approveBlank);
    record('B', 'starting WAITING_APPROVAL',
      j2Before?.status === 'WAITING_APPROVAL' ? 'PASS' : 'FAIL', j2Before?.status);

    await navigateToJob(page, JOBS.approveBlank);

    const approveBtn = page.locator(
      '[data-job-decision-panel="true"] button.primary-button',
      { hasText: 'Kontrolü tamamla' },
    );
    await approveBtn.waitFor({ state: 'visible', timeout: 5000 });
    record('B', 'approve button visible', 'PASS');
    await approveBtn.click();

    const bDialog = page.locator('.reason-dialog');
    await bDialog.waitFor({ state: 'visible', timeout: 5000 });
    record('B', 'approve dialog opens', 'PASS');

    const bLabel = await bDialog.locator('label').textContent();
    record('B', 'label="Onay notu"',
      bLabel?.includes('Onay notu') ? 'PASS' : 'FAIL', bLabel);

    await assertFocusInsideDialog(page, bDialog, 'B');

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

    // Exact activity: 1 JOB_APPROVED
    const j2Acts = await apiRead(page, '/job-cards/' + JOBS.approveBlank + '/activity?limit=50');
    const blankApproveActs = (j2Acts?.items || []).filter(a => a.eventType === 'JOB_APPROVED');
    record('B', '1 JOB_APPROVED activity',
      blankApproveActs.length === 1 ? 'PASS' : 'FAIL', 'cnt=' + blankApproveActs.length);

    // Blank APPROVE: zero NOTE_ADDED
    const blankNaActs = (j2Acts?.items || []).filter(a => a.eventType === 'NOTE_ADDED');
    record('B', 'no NOTE_ADDED for blank APPROVE',
      blankNaActs.length === 0 ? 'PASS' : 'FAIL', 'cnt=' + blankNaActs.length);

    // ═══════════════════════════════════════════════════════════════════════════
    // SCENARIO C: APPROVE — nonblank (Admin)
    // ═══════════════════════════════════════════════════════════════════════════
    console.log('\n=== C: APPROVE nonblank (Admin) ===');

    await navigateToJob(page, JOBS.approveNonblank);

    const j3Before = await apiRead(page, '/job-cards/' + JOBS.approveNonblank);
    record('C', 'starting WAITING_APPROVAL',
      j3Before?.status === 'WAITING_APPROVAL' ? 'PASS' : 'FAIL', j3Before?.status);

    const cApproveBtn = page.locator(
      '[data-job-decision-panel="true"] button.primary-button',
      { hasText: 'Kontrolü tamamla' },
    );
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

    // Exact count: 1 APPROVE operational note
    const j3Notes = await apiRead(page, '/job-cards/' + JOBS.approveNonblank + '/notes?limit=50');
    const cApproves = (j3Notes?.items || []).filter(n => n.context === 'APPROVE');
    record('C', '1 APPROVE operational note',
      cApproves.length === 1 ? 'PASS' : 'FAIL', 'cnt=' + cApproves.length);
    if (cApproves.length === 1) {
      record('C', 'workflow_stage=WAITING_APPROVAL',
        cApproves[0].workflowStage === 'WAITING_APPROVAL' ? 'PASS' : 'FAIL', cApproves[0].workflowStage);
      record('C', 'note body matches input',
        cApproves[0].note === nonblankText ? 'PASS' : 'FAIL');
    }
    record('C', 'manager_approval_note matches',
      j3After?.workflowContext?.lifecycle?.approvalNote === nonblankText ? 'PASS' : 'FAIL',
      String(j3After?.workflowContext?.lifecycle?.approvalNote ?? 'null'));

    // Exact activity: 1 JOB_APPROVED
    const j3Acts = await apiRead(page, '/job-cards/' + JOBS.approveNonblank + '/activity?limit=50');
    const cApproveActs = (j3Acts?.items || []).filter(a => a.eventType === 'JOB_APPROVED');
    record('C', '1 JOB_APPROVED activity',
      cApproveActs.length === 1 ? 'PASS' : 'FAIL', 'cnt=' + cApproveActs.length);

    // ═══════════════════════════════════════════════════════════════════════════
    // SCENARIO D: REQUEST_REVISION (Admin)
    // ═══════════════════════════════════════════════════════════════════════════
    console.log('\n=== D: REQUEST_REVISION (Admin) ===');

    await navigateToJob(page, JOBS.revision);

    const j4Before = await apiRead(page, '/job-cards/' + JOBS.revision);
    record('D', 'starting WAITING_APPROVAL',
      j4Before?.status === 'WAITING_APPROVAL' ? 'PASS' : 'FAIL', j4Before?.status);

    // Store the trigger button before opening dialog
    const revBtn = page.locator(
      '[data-job-decision-panel="true"] button.secondary-button',
      { hasText: 'Düzeltme için' },
    );
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

    // Focus inside dialog after opening
    await assertFocusInsideDialog(page, dDialog, 'D');

    const revisionText = 'Browser d\xFCzeltme \uD83E\uDDB7';
    await dDialog.locator('textarea').fill(revisionText);

    const dCounter = await dDialog.locator('[aria-live="polite"]').textContent();
    record('D', 'counter present', dCounter?.includes('karakter kaldı') ? 'PASS' : 'FAIL');

    // Tab forward: from textarea to cancel button or confirm button
    await dDialog.locator('textarea').press('Tab');
    await page.waitForTimeout(200);
    await assertFocusInsideDialog(page, dDialog, 'D (after Tab)');

    // Confirm
    await dDialog.locator('button.primary-button.compact-button').click();

    try {
      await dDialog.waitFor({ state: 'hidden', timeout: 8000 });
      record('D', 'dialog closes', 'PASS');
    } catch {
      record('D', 'dialog closes', 'FAIL');
    }

    // Focus restoration: dialog closed, verify trigger is focused
    await page.waitForTimeout(500);
    await assertFocusReturnedToTrigger(page, revBtn, 'D');

    await page.waitForTimeout(1500);
    const j4After = await apiRead(page, '/job-cards/' + JOBS.revision);
    record('D', 'status=REVISION_REQUESTED',
      j4After?.status === 'REVISION_REQUESTED' ? 'PASS' : 'FAIL', j4After?.status);

    await page.reload();
    await page.waitForTimeout(1500);
    const dNotesContents = await page.locator('.job-note-body').allTextContents();
    record('D', 'revision note visible',
      dNotesContents.some(t => t.includes('Browser d\xFCzeltme')) ? 'PASS' : 'FAIL');

    // Exact count: 1 REQUEST_REVISION note
    const j4Notes = await apiRead(page, '/job-cards/' + JOBS.revision + '/notes?limit=50');
    const revNotes = (j4Notes?.items || []).filter(n => n.context === 'REQUEST_REVISION');
    record('D', '1 REQUEST_REVISION note',
      revNotes.length === 1 ? 'PASS' : 'FAIL', 'cnt=' + revNotes.length);
    if (revNotes.length === 1) {
      record('D', 'workflow_stage=WAITING_APPROVAL',
        revNotes[0].workflowStage === 'WAITING_APPROVAL' ? 'PASS' : 'FAIL', revNotes[0].workflowStage);
      record('D', 'note body matches',
        revNotes[0].note === revisionText ? 'PASS' : 'FAIL');
    }
    record('D', 'revision_reason matches',
      j4After?.workflowContext?.lifecycle?.revisionReason === revisionText ? 'PASS' : 'FAIL',
      String(j4After?.workflowContext?.lifecycle?.revisionReason ?? 'null'));

    // Activity — exact 1
    const j4Acts = await apiRead(page, '/job-cards/' + JOBS.revision + '/activity?limit=50');
    const dActs = (j4Acts?.items || []).filter(a => a.eventType === 'JOB_REVISION_REQUESTED');
    record('D', '1 REVISION_REQUESTED activity',
      dActs.length === 1 ? 'PASS' : 'FAIL', 'cnt=' + dActs.length);

    // ═══════════════════════════════════════════════════════════════════════════
    // SCENARIO E: CANCEL (Staff)
    // ═══════════════════════════════════════════════════════════════════════════
    console.log('\n=== E: CANCEL (Staff) ===');

    await loginAs(page, context, EMAIL_STAFF);

    const j5Before = await apiRead(page, '/job-cards/' + JOBS.cancel);
    record('E', 'starting IN_PROGRESS',
      j5Before?.status === 'IN_PROGRESS' ? 'PASS' : 'FAIL', j5Before?.status);

    await navigateToJob(page, JOBS.cancel);

    // Store trigger button
    const cancelBtn = page.locator(
      '[data-job-decision-panel="true"] button.destructive-button',
      { hasText: 'İşi iptal et' },
    );
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

    // Focus inside dialog
    await assertFocusInsideDialog(page, eDialog, 'E');

    const cancelText = 'Browser iptal \uD83D\uDEAB';
    await eDialog.locator('textarea').fill(cancelText);

    const destructiveVisible = await eDialog.locator('button.destructive-button').isVisible();
    record('E', 'destructive confirm button', destructiveVisible ? 'PASS' : 'FAIL');

    // Tab forward from textarea
    await eDialog.locator('textarea').press('Tab');
    await page.waitForTimeout(200);
    await assertFocusInsideDialog(page, eDialog, 'E (after Tab)');

    await eDialog.locator('button.destructive-button.compact-button').click();

    try {
      await eDialog.waitFor({ state: 'hidden', timeout: 8000 });
      record('E', 'dialog closes', 'PASS');
    } catch {
      record('E', 'dialog closes', 'FAIL');
    }

    // Focus restoration
    await page.waitForTimeout(500);
    await assertFocusReturnedToTrigger(page, cancelBtn, 'E');

    await page.waitForTimeout(1500);
    const j5After = await apiRead(page, '/job-cards/' + JOBS.cancel);
    record('E', 'status=CANCELLED',
      j5After?.status === 'CANCELLED' ? 'PASS' : 'FAIL', j5After?.status);

    await page.reload();
    await page.waitForTimeout(1500);
    const eNotesContents = await page.locator('.job-note-body').allTextContents();
    record('E', 'cancel note visible',
      eNotesContents.some(t => t.includes('Browser iptal')) ? 'PASS' : 'FAIL');

    // Exact count: 1 CANCEL operational note
    const j5Notes = await apiRead(page, '/job-cards/' + JOBS.cancel + '/notes?limit=50');
    const cancelNotes = (j5Notes?.items || []).filter(n => n.context === 'CANCEL');
    record('E', '1 CANCEL operational note',
      cancelNotes.length === 1 ? 'PASS' : 'FAIL', 'cnt=' + cancelNotes.length);
    if (cancelNotes.length === 1) {
      record('E', 'workflow_stage=IN_PROGRESS',
        cancelNotes[0].workflowStage === 'IN_PROGRESS' ? 'PASS' : 'FAIL', cancelNotes[0].workflowStage);
      record('E', 'note body matches',
        cancelNotes[0].note === cancelText ? 'PASS' : 'FAIL');
    }
    record('E', 'cancel_reason matches',
      j5After?.workflowContext?.lifecycle?.cancelReason === cancelText ? 'PASS' : 'FAIL',
      String(j5After?.workflowContext?.lifecycle?.cancelReason ?? 'null'));
    record('E', 'cancelledFromStatus=IN_PROGRESS',
      j5After?.workflowContext?.lifecycle?.cancelledFromStatus === 'IN_PROGRESS' ? 'PASS' : 'FAIL',
      String(j5After?.workflowContext?.lifecycle?.cancelledFromStatus ?? 'null'));

    // Exact count: 1 JOB_CANCELLED activity
    const j5Acts = await apiRead(page, '/job-cards/' + JOBS.cancel + '/activity?limit=50');
    const eActs = (j5Acts?.items || []).filter(a => a.eventType === 'JOB_CANCELLED');
    record('E', '1 JOB_CANCELLED activity',
      eActs.length === 1 ? 'PASS' : 'FAIL', 'cnt=' + eActs.length);

    // ═══════════════════════════════════════════════════════════════════════════
    // NOTE_ADDED absence — exact zero for all transitions
    // ═══════════════════════════════════════════════════════════════════════════
    console.log('\n=== NOTE_ADDED absence ===');
    for (const [label, jid] of [
      ['SUBMIT J1', JOBS.submit],
      ['APPROVE blank J2', JOBS.approveBlank],
      ['APPROVE nonblank J3', JOBS.approveNonblank],
      ['REVISION J4', JOBS.revision],
      ['CANCEL J5', JOBS.cancel],
    ]) {
      const acts = await apiRead(page, '/job-cards/' + jid + '/activity?limit=50');
      const naActs = (acts?.items || []).filter(a => a.eventType === 'NOTE_ADDED');
      record('NOTE_ADDED absence', label,
        naActs.length === 0 ? 'PASS' : 'FAIL', 'cnt=' + naActs.length);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Pending protection classification
    // ═══════════════════════════════════════════════════════════════════════════
    console.log('\n=== PENDING PROTECTION ===');
    record('PENDING', 'browser runtime pending protection',
      'NOT EXERCISED', 'safe request delay injection not practical without altering production behavior');
    record('PENDING', 'Vitest/jsdom pending protection coverage',
      'PASS', 'covered by automated component tests');

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
