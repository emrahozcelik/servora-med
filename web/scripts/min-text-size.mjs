/**
 * Shared rendered-text floor probe for the geometry smokes (UI audit F-11).
 *
 * The collector runs inside the page, so it must stay self-contained: no
 * imports, no outer identifiers. It reports only visible elements that
 * directly own text, which is what the 0.75rem (12px) floor is about.
 */

export const MIN_READABLE_TEXT_PX = 12;

export function collectSubMinimumText({ min }) {
  const visuallyHidden = (element, rect) => {
    if (element.closest('.sr-only')) return true;
    if (rect.width <= 1 && rect.height <= 1) return true;
    const style = getComputedStyle(element);
    return style.clipPath === 'inset(50%)' || style.clip === 'rect(0px, 0px, 0px, 0px)';
  };
  const describe = (element) => {
    const id = element.id ? `#${element.id}` : '';
    const classes = typeof element.className === 'string' && element.className.trim()
      ? `.${element.className.trim().split(/\s+/).slice(0, 2).join('.')}`
      : '';
    return `${element.tagName.toLowerCase()}${id}${classes}`;
  };
  const offenders = [];
  for (const element of document.querySelectorAll('body *')) {
    const ownsText = [...element.childNodes].some(
      (node) => node.nodeType === 3 && node.textContent.trim().length > 0,
    );
    if (!ownsText) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    if (visuallyHidden(element, rect)) continue;
    const style = getComputedStyle(element);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue;
    const pixels = Number.parseFloat(style.fontSize);
    if (!Number.isFinite(pixels) || pixels >= min - 0.01) continue;
    offenders.push({ selector: describe(element), pixels: Math.round(pixels * 100) / 100, text: element.textContent.trim().slice(0, 40) });
  }
  return offenders;
}

/** Throws a single readable failure listing every sub-floor text element. */
export function assertNoSubMinimumText(offenders, label) {
  if (offenders.length === 0) return;
  const detail = offenders
    .map((entry) => `${entry.selector} ${entry.pixels}px "${entry.text}"`)
    .join('; ');
  throw new Error(`${label}: text below ${MIN_READABLE_TEXT_PX}px — ${detail}`);
}
