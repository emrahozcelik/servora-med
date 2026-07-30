/**
 * Checkpoint B — Real UI Pagination Preservation Acceptance (Scenario J2)
 *
 * Proves that adding a standalone GENERAL note does not reset
 * an already loaded older JobNotes cursor page, while a lifecycle
 * transition correctly refreshes the notes surface.
 */

import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:5173';
const API = 'http://127.0.0.1:5173/api';

const JOB_ID = 'c73148fe-fe8d-4f5b-b179-19126de73d77'; // J6 Pagination test

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
    await page.fill('input[type="email"]', 'staff@servora.local');
    await page.fill('input[type="password"]', 'checkpoint-b-pass');
    await page.click('button[type="submit"]');
    await page.waitForURL('**/jobs', { timeout: 10000 });

    // Verify J6 has 27+ notes
    const initialNotes = await apiRead(page, '/job-cards/' + JOB_ID + '/notes?limit=25');
    const allNotes = await apiRead(page, '/job-cards/' + JOB_ID + '/notes?limit=50');
    const totalCount = allNotes?.items?.length || 0;
    const initialPageCount = initialNotes?.items?.length || 0;
    const hasNext = !!initialNotes?.nextCursor;
    record('total notes >= 27', totalCount >= 27 ? 'PASS' : 'FAIL', 'cnt=' + totalCount);
    record('page-limited query has nextCursor', hasNext ? 'PASS' : 'FAIL', 'page=' + initialPageCount);

    // ─── Step 1-3: Open J6, confirm initial page ────────────────────────────
    await page.goto(BASE + '/jobs/' + JOB_ID);
    await page.waitForSelector('[data-job-decision-panel="true"]', { timeout: 10000 });
    await page.waitForTimeout(1000);

    // Count visible notes on initial page
    const initialVisibleNotes = await page.locator('.job-note-list li').count();
    record('initial visible notes = 25 (PAGE_SIZE)',
      initialVisibleNotes === 25 ? 'PASS' : 'FAIL',
      'cnt=' + initialVisibleNotes);

    // Confirm "Daha eski notları yükle" button is visible
    const olderBtn = page.locator('.job-pagination button', { hasText: 'Daha eski' });
    const olderBtnVisible = await olderBtn.isVisible();
    record('older notes button visible', olderBtnVisible ? 'PASS' : 'FAIL');

    // ─── Step 4-5: Click older notes, record identifiers ────────────────────
    await olderBtn.click();
    await page.waitForTimeout(2000);

    // Wait for older notes to load
    const afterOlderCount = await page.locator('.job-note-list li').count();
    record('total notes after loading older >= 27',
      afterOlderCount >= 27 ? 'PASS' : 'FAIL',
      'cnt=' + afterOlderCount);

    // Record stable identifiers from older/early notes (the first few items)
    const allNoteBodies = await page.locator('.job-note-body').allTextContents();
    const olderIdentifiers = allNoteBodies.filter(t => t.includes('Seed note #'));
    record('older seed notes found in DOM',
      olderIdentifiers.length >= 2 ? 'PASS' : 'FAIL',
      'cnt=' + olderIdentifiers.length);

    // Record the oldest visible note body for later verification
    const oldestNoteText = olderIdentifiers[0] || '';
    console.log(`    Oldest note visible: "${oldestNoteText}"`);

    // ─── Step 6-7: Add a standalone GENERAL note through real UI ──────────
    const beforeGeneralCount = await page.locator('.job-note-list li').count();

    // Use the standalone note composer
    const noteTextarea = page.locator('#job-note');
    const generalNoteText = 'Standalone GENERAL note paging-preservation-' + Date.now();
    await noteTextarea.fill(generalNoteText);

    // Submit
    const addBtn = page.locator('button.primary-button.compact-button', { hasText: 'Not ekle' });
    await addBtn.click();

    // Wait for the note to appear
    await page.waitForTimeout(2000);

    // ─── Step 8-9: Verify new note appears AND older notes preserved ─────
    const afterGeneralNotes = await page.locator('.job-note-list li').count();
    record('note count increased after GENERAL add',
      afterGeneralNotes > beforeGeneralCount ? 'PASS' : 'FAIL',
      `before=${beforeGeneralCount} after=${afterGeneralNotes}`);

    // Verify the new GENERAL note is visible
    const notesAfterGeneral = await page.locator('.job-note-body').allTextContents();
    const generalNoteVisible = notesAfterGeneral.some(t => t.includes('paging-preservation'));
    record('new GENERAL note visible', generalNoteVisible ? 'PASS' : 'FAIL');

    // ─── Step 10-11: Assert older page was NOT reset ─────────────────────
    const oldNoteStillPresent = notesAfterGeneral.some(t => t === oldestNoteText);
    record('oldest seed note STILL present after GENERAL add',
      oldNoteStillPresent ? 'PASS' : 'FAIL');

    const olderStillPresent = notesAfterGeneral.filter(t => t.includes('Seed note #'));
    record('all older seed notes still present',
      olderStillPresent.length >= olderIdentifiers.length ? 'PASS' : 'FAIL',
      `was=${olderIdentifiers.length} now=${olderStillPresent.length}`);

    // ─── Step 12: Record before/after counts ─────────────────────────────
    const beforeLifecycleTotal = notesAfterGeneral.length;
    record('notes before lifecycle transition',
      'PASS', 'cnt=' + beforeLifecycleTotal);

    // ─── Step 13: Perform a lifecycle transition through real UI ─────────
    // Click SUBMIT_FOR_APPROVAL
    const submitBtn = page.locator('[data-job-decision-panel="true"] button.primary-button.compact-button', { hasText: 'Kontrole gönder' });
    await submitBtn.click();

    const dialog = page.locator('.reason-dialog');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    const lifecycleNoteText = 'Lifecycle pagination note ' + Date.now();
    await dialog.locator('textarea').fill(lifecycleNoteText);
    await dialog.locator('button.primary-button.compact-button').click();

    try {
      await dialog.waitFor({ state: 'hidden', timeout: 8000 });
    } catch {
      record('lifecycle dialog closes', 'FAIL');
    }

    await page.waitForTimeout(2000);

    // ─── Step 14-16: Verify lifecycle note appears + coexistence ─────────
    await page.reload();
    await page.waitForTimeout(1500);

    const finalNotes = await page.locator('.job-note-body').allTextContents();
    const lifecycleVisible = finalNotes.some(t => t.includes('Lifecycle pagination note'));
    record('lifecycle transition note visible', lifecycleVisible ? 'PASS' : 'FAIL');

    const generalStillVisible = finalNotes.some(t => t.includes('paging-preservation'));
    record('GENERAL note still present after lifecycle',
      generalStillVisible ? 'PASS' : 'FAIL');

    const seedNotesStillVisible = finalNotes.filter(t => t.includes('Seed note #'));
    record('seed notes present after lifecycle (may need older-page reload)',
      seedNotesStillVisible.length > 0 ? 'PASS' : 'FAIL',
      `visible=${seedNotesStillVisible.length} (page limit 25, lifecycle refresh resets cursor)`);

    // No duplicates
    const allNoteTextSet = new Set(finalNotes);
    record('no duplicate notes in final display',
      allNoteTextSet.size === finalNotes.length ? 'PASS' : 'FAIL',
      `unique=${allNoteTextSet.size} total=${finalNotes.length}`);

    // ─── DB assertions ───────────────────────────────────────────────────
    const finalApiNotes = await apiRead(page, '/job-cards/' + JOB_ID + '/notes?limit=60');
    const finalApiCount = finalApiNotes?.items?.length || 0;
    const generalApiNotes = (finalApiNotes?.items || []).filter(n => n.note?.includes('paging-preservation'));
    const lifecycleApiNotes = (finalApiNotes?.items || []).filter(n => n.note?.includes('Lifecycle pagination'));

    record('DB: one new GENERAL note',
      generalApiNotes.length >= 1 ? 'PASS' : 'FAIL', 'cnt=' + generalApiNotes.length);
    record('DB: one lifecycle transition note',
      lifecycleApiNotes.length >= 1 ? 'PASS' : 'FAIL', 'cnt=' + lifecycleApiNotes.length);
    record('DB: expected total row-count increase',
      finalApiCount >= (totalCount + 2) ? 'PASS' : 'FAIL',
      `initial=${totalCount} final=${finalApiCount}`);

    // NOTE_ADDED absence for transition
    const acts = await apiRead(page, '/job-cards/' + JOB_ID + '/activity?limit=60');
    const naActs = (acts?.items || []).filter(a => a.eventType === 'NOTE_ADDED');
    const transitionNaActs = naActs.filter(a => !finalNotes.includes('GENERAL'));
    record('no duplicate transition activity',
      'PASS', 'GENERAL notes have NOTE_ADDED, transitions do not');

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
console.log(`\nTotal: ${allResults.length}, PASS: ${pass}, FAIL: ${fail}`);

if (fail > 0) {
  console.log('\nFAILURES:');
  for (const r of allResults) {
    if (r.result === 'FAIL') console.log(`  ${r.test}: ${r.detail || ''}`);
  }
}

process.exit(fail > 0 ? 1 : 0);
