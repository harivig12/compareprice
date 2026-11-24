/** Small helpers shared by site modules. */
import { parsePack } from '../../normalize.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Best pack from candidate texts. "1 pack (1 kg)" -> 1 kg, not 1 piece:
 * a mass/volume reading beats a count, and text in parentheses is tried first.
 */
export function bestPack(...texts) {
  // parsePack already prefers mass/volume over a count inside one text and
  // multiplies multipacks ("80g x4", "Pack of 4 (80 g each)"); across texts,
  // the first mass/volume reading wins, else the first count.
  let count = null;
  for (const t of texts) {
    if (!t) continue;
    const p = parsePack(String(t));
    if (!p) continue;
    if (p.family !== 'count') return p;
    count ??= p;
  }
  return count;
}

/** Text the address autocomplete understands: config searchText, else label + locality. */
export function addressSearchText(loc) {
  if (loc.searchText) return loc.searchText;
  const locality = String(loc.address || '').split(',').map((s) => s.trim()).find((s) => /tambaram|nagar|road|street/i.test(s) && s !== loc.label);
  return [loc.label, locality].filter(Boolean).join(' ') || String(loc.pincode || '');
}

/**
 * Real mouse click (CDP Input events) on the element `js` evaluates to.
 * Some React apps ignore element.click(). Returns the element text or null.
 */
export async function cdpClick(tab, js, { waitMs = 10000 } = {}) {
  const deadline = Date.now() + waitMs;
  let r = null;
  while (Date.now() < deadline) {
    r = await tab
      .evaluate(`(() => { const e = (${js}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, t: (e.textContent || '').trim().slice(0, 80) }; })()`, { timeoutMs: 5000 })
      .catch(() => null);
    if (r) break;
    await sleep(400);
  }
  if (!r) return null;
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await tab.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
  }
  return r.t;
}

/** Type text into the focused element as real input. */
export async function typeText(tab, text) {
  await tab.send('Input.insertText', { text });
}
