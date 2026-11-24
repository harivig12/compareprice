// Render the Jhola app icons (src/ui/icon*.svg) to the PNGs phones need for
// "Add to home screen": 192, 512, maskable 512 and the 180 px Apple touch icon.
// usage: node scripts/build-icons.js   (headless Chrome, same launcher as the engine)
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { launchChrome } from '../src/engine/chrome.js';
import { CdpTab } from '../src/engine/cdp.js';

const ui = (f) => fileURLToPath(new URL(`../src/ui/${f}`, import.meta.url));
const OUT = [
  ['icon.svg', 'icon-192.png', 192],
  ['icon.svg', 'icon-512.png', 512],
  ['icon-maskable.svg', 'icon-maskable-512.png', 512],
  ['icon-maskable.svg', 'apple-touch-icon.png', 180], // iOS rounds the corners itself
];
const b = await launchChrome({ port: 9343, profileDir: '/tmp/jhola-icons-profile' });
const tab = await CdpTab.open(b.endpoint);
try {
  for (const [src, out, size] of OUT) {
    await tab.send('Emulation.setDeviceMetricsOverride', { width: size, height: size, deviceScaleFactor: 1, mobile: false });
    const svg = readFileSync(ui(src), 'utf8');
    const page = `<html><body style="margin:0;background:transparent"><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" width="${size}" height="${size}" style="display:block"></body></html>`;
    await tab.goto(`data:text/html;base64,${Buffer.from(page).toString('base64')}`, { waitMs: 5000 });
    await tab.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    await new Promise((r) => setTimeout(r, 300));
    const shot = await tab.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: size, height: size, scale: 1 } });
    writeFileSync(ui(out), Buffer.from(shot.data, 'base64'));
    console.log(`src/ui/${out} (${size}px)`);
  }
} finally {
  await tab.close();
  await b.close();
}
process.exit(0);
