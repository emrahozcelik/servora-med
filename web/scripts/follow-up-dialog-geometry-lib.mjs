/**
 * Shared helpers for web/scripts/follow-up-dialog-geometry.mjs.
 *
 * User-style scroll results use an explicit tri-state model so an
 * unsupported input can never be mistaken for a passing measurement:
 * PASS (movement observed), FAIL (supported input, no movement),
 * NOT_SUPPORTED (input API unavailable in this browser).
 */

export function classifyUserStyleScroll({ supported, moved }) {
  if (!supported) return 'NOT_SUPPORTED';
  return moved ? 'PASS' : 'FAIL';
}

const WHEEL_DELTA_Y = 800;

/**
 * Attempts user-style wheel scrolling inside the dialog and classifies the
 * outcome. Retries are bounded (default 2 attempts) for CI compositor
 * readiness; a persistent zero-scroll result is FAIL, never PASS.
 *
 * `page` needs only { mouse: { move, wheel }, waitForTimeout, evaluate },
 * which keeps this unit-testable with a fake page object.
 */
export async function userStyleScroll(page, viewport, { attempts = 2, waitMs = 400 } = {}) {
  try {
    await page.mouse.move(viewport.width / 2, viewport.height / 2);
  } catch {
    return { result: 'NOT_SUPPORTED', wheelTop: 0 };
  }
  let wheelTop = 0;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await page.mouse.wheel(0, WHEEL_DELTA_Y);
    } catch {
      return { result: 'NOT_SUPPORTED', wheelTop };
    }
    await page.waitForTimeout(waitMs);
    wheelTop = await page.evaluate(() => document.querySelector('#dialog').scrollTop);
    if (wheelTop > 0) return { result: 'PASS', wheelTop };
  }
  return { result: 'FAIL', wheelTop };
}
