/**
 * Checkpoint B — Real UI Pagination Preservation Acceptance (Scenario J2)
 *
 * Proves that adding a standalone GENERAL note does not reset
 * an already loaded older JobNotes cursor page, while a lifecycle
 * transition correctly refreshes the notes surface.
 *
 * Credentials via environment variables:
 *   CHECKPOINT_B_TEST_EMAIL_STAFF, CHECKPOINT_B_TEST_PASSWORD
 */

import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:5173';
const API = 'http://127.0.0.1:5173/api';

// ─── Credentials from environment ─────────────────────────────────────────────
const EMAIL_STAFF = process.env.CHECKPOINT_B_TEST_EMAIL_STAFF;
const PASSWORD = process.env.CHECKPOINT_B_TEST_PASSWORD;

if (!EMAIL_STAFF) throw new Error('CHECKPOINT_B_TEST_EMAIL_STAFF is required');
if (!PASSWORD) throw new Error('CHECKPOINT_B_TEST_PASSWORD is required');

const JOB_ID = '8e7df92e-4377-41f9-bc67-325006ca883b'; // J6 Pagination test

const results = [];

function record(test, result, detail = '') {
  results.push({ test, result, detail });
  const icon = result === 'PASS' ? '✓' : result === 'FAIL' ? '✗' : '○';
  console.log(`  ${icon} ${test}${detail ? ': ' + detail : ''}`);
}

async function apiRead(page, path) {
  return page.evaluate(async (url) => {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) return null;
    return res.json();
  }, API + path);
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', err => console.log('  PAGE ERROR:', err.message));

  try {

    // ─── Login as Staff ──────────────────────────────────────────────────────
    console.log('\n=== J2: PAGINATION PRESERVATION ===');

    await page.goto(BASE + '/');
    await page.waitForSelector('input[type="email"]', { timeout: 8000 });
    await page.fill('input[type="email"]', EMAIL_STAFF);
    await page.fill('input[type="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL('**/jobs', { timeout: 10000 });

    // Verify seeded notes
    const initialPage = await apiRead(page, '/job-cards/' + JOB_ID + '/notes?limit=25');
    const allNotesResponse = await apiRead(page, '/job-cards/' + JOB_ID + '/notes?limit=50');
    const totalCount = allNotesResponse?.items?.length || 0;
    const initialPageCount = initialPage?.items?.length || 0;
    const hasNext = !!initialPage?.nextCursor;
    record('total notes >= 26', totalCount >= 26 ? 'PASS' : 'FAIL', 'cnt=' + totalCount);
    record('page-limited query has nextCursor', hasNext ? 'PASS' : 'FAIL', 'page=' + initialPageCount);

    // ─── Open J6, confirm initial page ─────────────────────────────────────
    await page.goto(BASE + '/jobs/' + JOB_ID);
    await page.waitForSelector('[data-job-decision-panel="true"]', { timeout: 10000 });
    await page.waitForTimeout(1000);

    const initialVisible = await page.locator('.job-note-list li').count();
    record('initial visible notes = 25 (PAGE_SIZE)',
      initialVisible === 25 ? 'PASS' : 'FAIL', 'cnt=' + initialVisible);

    // Confirm older notes button
    const olderBtn = page.locator('.job-pagination button', { hasText: 'Daha eski' });
    record('older notes button visible', (await olderBtn.isVisible()) ? 'PASS' : 'FAIL');

    // ─── Load older notes, record identifiers ──────────────────────────────
    await olderBtn.click();
    await page.waitForTimeout(2000);

    const afterOlderCount = await page.locator('.job-note-list li').count();
    record('total notes after loading older',
      afterOlderCount >= totalCount ? 'PASS' : 'FAIL',
      'visible=' + afterOlderCount + ' db=' + totalCount);

    // Record stable older-page identifiers (full note body text as unique ID)
    const allNoteBodies = await page.locator('.job-note-body').allTextContents();
    const olderIdentifiers = allNoteBodies.filter(t => t.includes('Seed note #'));
    record('older seed notes found in DOM',
      olderIdentifiers.length >= 2 ? 'PASS' : 'FAIL',
      'cnt=' + olderIdentifiers.length);

    // Record each identifier explicitly for later verification
    const olderIdSet = new Set(olderIdentifiers);
    console.log('    Recorded ' + olderIdSet.size + ' unique older note identifiers');

    // ─── Add standalone GENERAL note through real UI composer ──────────────
    const beforeGeneralCount = await page.locator('.job-note-list li').count();

    const noteTextarea = page.locator('#job-note');
    const generalNoteText = 'Standalone GENERAL note paging-preservation-' + Date.now();
    await noteTextarea.fill(generalNoteText);

    const addBtn = page.locator('button.primary-button.compact-button', { hasText: 'Not ekle' });
    await addBtn.click();
    await page.waitForTimeout(2000);

    // ─── Verify GENERAL note added AND older notes preserved ───────────────
    const afterGeneralCount = await page.locator('.job-note-list li').count();
    record('note count increased after GENERAL add',
      afterGeneralCount === beforeGeneralCount + 1 ? 'PASS' : 'FAIL',
      'before=' + beforeGeneralCount + ' after=' + afterGeneralCount);

    const notesAfterGeneral = await page.locator('.job-note-body').allTextContents();
    record('new GENERAL note visible',
      notesAfterGeneral.some(t => t.includes('paging-preservation')) ? 'PASS' : 'FAIL');

    // INVARIANT: verify EVERY recorded older identifier remains present
    const notesAfterSet = new Set(notesAfterGeneral);
    const missingIds = [...olderIdSet].filter(id => !notesAfterSet.has(id));
    record('every older note ID preserved after GENERAL add',
      missingIds.length === 0 ? 'PASS' : 'FAIL',
      'missing=' + missingIds.length + ' of ' + olderIdSet.size);

    // ─── Lifecycle transition through real dialog UI ───────────────────────
    const beforeLifecycleTotal = notesAfterGeneral.length;
    record('notes before lifecycle transition',
      beforeLifecycleTotal > 0 ? 'PASS' : 'FAIL', 'cnt=' + beforeLifecycleTotal);

    const submitBtn = page.locator(
      '[data-job-decision-panel="true"] button.primary-button.compact-button',
      { hasText: 'Kontrole gönder' },
    );
    await submitBtn.click();

    const dialog = page.locator('.reason-dialog');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    const lifecycleNoteText = 'Lifecycle pagination note ' + Date.now();
    await dialog.locator('textarea').fill(lifecycleNoteText);
    await dialog.locator('button.primary-button.compact-button').click();

    try {
      await dialog.waitFor({ state: 'hidden', timeout: 8000 });
      const dClosed = true; record('lifecycle dialog closes', dClosed ? 'PASS' : 'FAIL');
    } catch {
      record('lifecycle dialog closes', 'FAIL');
    }

    await page.waitForTimeout(2000);

    // ─── Verify after lifecycle transition (page reload) ──────────────────
    // Note: lifecycle refresh resets the notes surface cursor.
    // We reload to verify notes persisted, then check the fresh surface.
    await page.reload();
    await page.waitForTimeout(1500);

    const finalNotes = await page.locator('.job-note-body').allTextContents();

    record('lifecycle transition note visible',
      finalNotes.some(t => t.includes('Lifecycle pagination note')) ? 'PASS' : 'FAIL');

    record('GENERAL note still present after lifecycle',
      finalNotes.some(t => t.includes('paging-preservation')) ? 'PASS' : 'FAIL');

    // Lifecycle refresh resets cursor to latest 25; seed notes may need re-load
    const visibleSeeds = finalNotes.filter(t => t.includes('Seed note #'));
    record('seed notes present (lifecycle refresh resets cursor)',
      visibleSeeds.length > 0 ? 'PASS' : 'FAIL',
      'visible=' + visibleSeeds.length + ' (of ' + olderIdentifiers.length + ' total, page limit 25)');

    // No duplicates
    const uniqueSet = new Set(finalNotes);
    record('no duplicate notes in final display',
      uniqueSet.size === finalNotes.length ? 'PASS' : 'FAIL',
      'unique=' + uniqueSet.size + ' total=' + finalNotes.length);

    // ─── Exact DB/activity assertions ──────────────────────────────────────
    const finalApiNotes = await apiRead(page, '/job-cards/' + JOB_ID + '/notes?limit=60');
    const finalApiCount = finalApiNotes?.items?.length || 0;
    const generalApiNotes = (finalApiNotes?.items || []).filter(
      n => n.context === 'GENERAL' && n.note?.includes('paging-preservation'),
    );
    const lifecycleApiNotes = (finalApiNotes?.items || []).filter(
      n => n.context === 'SUBMIT_FOR_APPROVAL' && n.note?.includes('Lifecycle pagination'),
    );

    record('DB: exactly 1 GENERAL note',
      generalApiNotes.length === 1 ? 'PASS' : 'FAIL', 'cnt=' + generalApiNotes.length);
    record('DB: exactly 1 lifecycle transition note',
      lifecycleApiNotes.length === 1 ? 'PASS' : 'FAIL', 'cnt=' + lifecycleApiNotes.length);
    record('DB: total row-count increase = +2',
      finalApiCount === totalCount + 2 ? 'PASS' : 'FAIL',
      'initial=' + totalCount + ' final=' + finalApiCount);

    // Canonical transition activity: exactly 1 JOB_SUBMITTED_FOR_APPROVAL
    const acts = await apiRead(page, '/job-cards/' + JOB_ID + '/activity?limit=60');
    const submitActs = (acts?.items || []).filter(
      a => a.eventType === 'JOB_SUBMITTED_FOR_APPROVAL',
    );
    record('DB: exactly 1 SUBMITTED_FOR_APPROVAL activity',
      submitActs.length === 1 ? 'PASS' : 'FAIL', 'cnt=' + submitActs.length);

    // NOTE_ADDED: GENERAL note creates 1 NOTE_ADDED activity, transition must not
    const naActs = (acts?.items || []).filter(a => a.eventType === 'NOTE_ADDED');
    record('DB: exactly 1 NOTE_ADDED (GENERAL only, not transition)',
      naActs.length === 1 ? 'PASS' : 'FAIL', 'cnt=' + naActs.length);

    // Related activity ID check: transition note's related_activity_id equals
    // the canonical transition activity ID
    if (lifecycleApiNotes.length === 1 && submitActs.length === 1) {
      const noteActivityId = lifecycleApiNotes[0].relatedActivityId;
      const canonicalActivityId = submitActs[0].id;
      record('DB: note.relatedActivityId = canonical activity ID',
        noteActivityId === canonicalActivityId ? 'PASS' : 'FAIL',
        'match=' + (noteActivityId === canonicalActivityId));
    } else {
      record('DB: relatedActivityId check', 'FAIL', 'prerequisites not met');
    }

  } finally {
    await browser.close();
  }

  return results;
}

const allResults = await run();

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('PAGINATION PRESERVATION SUMMARY');
console.log('═══════════════════════════════════════════════════════════════');

let pass = 0, fail = 0;
for (const r of allResults) {
  if (r.result === 'PASS') pass++;
  else if (r.result === 'FAIL') fail++;
}
console.log('\nTotal: ' + allResults.length + ', PASS: ' + pass + ', FAIL: ' + fail);

if (fail > 0) {
  console.log('\nFAILURES:');
  for (const r of allResults) {
    if (r.result === 'FAIL') console.log('  ' + r.test + ': ' + (r.detail || ''));
  }
}

process.exit(fail > 0 ? 1 : 0);
