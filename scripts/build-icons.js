// Build every Jhola icon from the master SVG: node scripts/build-icons.js
//
//   assets/brand/jhola-icon.svg   the master (edit this one, nothing else)
//   -> src/ui/icon.svg            exact copy, served as /icon.svg and the favicon
//   -> src/ui/icon-180.png        /apple-touch-icon.png (iPhone home screen)
//   -> src/ui/icon-192.png        web app manifest
//   -> src/ui/icon-512.png        web app manifest (any + maskable)
//   -> assets/brand/jhola-icon-1024.png   for stores, slides and social posts
//
// PNGs are rendered by the same headless Chrome the engine uses, so it needs
// Chrome (set CHROME_PATH if it isn't found). test/brand.test.js fails if
// src/ui/icon.svg drifts from the master.
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome } from '../src/engine/chrome.js';
import { CdpTab } from '../src/engine/cdp.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const master = join(root, 'assets', 'brand', 'jhola-icon.svg');
const svg = readFileSync(master, 'utf8');

copyFileSync(master, join(root, 'src', 'ui', 'icon.svg'));
console.log('copied  src/ui/icon.svg');

const targets = [
  [180, join(root, 'src', 'ui', 'icon-180.png')],
  [192, join(root, 'src', 'ui', 'icon-192.png')],
  [512, join(root, 'src', 'ui', 'icon-512.png')],
  [1024, join(root, 'assets', 'brand', 'jhola-icon-1024.png')],
];

const profile = mkdtempSync(join(tmpdir(), 'jhola-icons-'));
const chrome = await launchChrome({ port: 9395, profileDir: profile });
try {
  const tab = await CdpTab.open(chrome.endpoint);
  await tab.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 1100, deviceScaleFactor: 1, mobile: false });
  for (const [size, file] of targets) {
    const sized = svg.replace('<svg ', `<svg width="${size}" height="${size}" `);
    const html = `<!doctype html><body style="margin:0;background:transparent">${sized}</body>`;
    await tab.goto('data:text/html;base64,' + Buffer.from(html).toString('base64'), { waitMs: 5000 });
    await new Promise((r) => setTimeout(r, 300));
    const shot = await tab.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: size, height: size, scale: 1 } });
    writeFileSync(file, Buffer.from(shot.data, 'base64'));
    console.log(`wrote   ${file.slice(root.length + 1)} (${size}px)`);
  }
  await tab.close();
} finally {
  await chrome.close();
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* Windows may still hold the profile */ }
}
process.exit(0);
