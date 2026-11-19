// UI evidence: screenshot a page in headless Chrome and check for horizontal overflow.
// usage: node scripts/ui-screenshot.js <url> <out.png> <width> <height> [waitMs] [fullPage]
//   SHOT_JS='<js run in the page before the wait>'  e.g. fill the list and press a button
import fs from 'node:fs';
import { launchChrome } from '../src/engine/chrome.js';
import { CdpTab } from '../src/engine/cdp.js';
const [, , url, out, w, h, waitMs = '2500', full = ''] = process.argv;
const b = await launchChrome({ port: 9341, profileDir: process.env.SHOT_PROFILE || '/tmp/basket-shot-profile' });
const tab = await CdpTab.open(b.endpoint);
await tab.send('Emulation.setDeviceMetricsOverride', { width: Number(w), height: Number(h), deviceScaleFactor: 1, mobile: Number(w) < 700 });
await tab.goto(url, { waitMs: 10000 });
await new Promise((r) => setTimeout(r, 1500));
if (process.env.SHOT_JS) await tab.evaluate(process.env.SHOT_JS);
await new Promise((r) => setTimeout(r, Number(waitMs)));
const m = await tab.evaluate(`(() => {
  const W = ${Number(w)};
  let widest = null;
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width && r.right > W + 1 && (!widest || r.right > widest.right)) widest = { right: Math.round(r.right), tag: el.tagName + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : '') };
  }
  return { scrollWidth: document.documentElement.scrollWidth, innerWidth: W, height: document.documentElement.scrollHeight, widest };
})()`);
let clip;
if (full) clip = { x: 0, y: 0, width: Number(w), height: Math.min(m.height, 4000), scale: 1 };
const shot = await tab.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip, captureBeyondViewport: true } : {}) });
fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log(JSON.stringify({ out, ...m, noHorizontalScroll: m.scrollWidth <= m.innerWidth }));
await tab.close(); await b.close();
process.exit(0);
