import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const file = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const pngSize = (p) => { const b = readFileSync(file(p)); assert.equal(b.subarray(1, 4).toString(), 'PNG', `${p} is a PNG`); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };

test('the served icon is an exact copy of the brand master (run npm run build:icons after editing it)', () => {
  assert.equal(readFileSync(file('src/ui/icon.svg'), 'utf8'), readFileSync(file('assets/brand/jhola-icon.svg'), 'utf8'));
});

test('every icon export exists at its size', () => {
  for (const [p, s] of [['src/ui/icon-180.png', 180], ['src/ui/icon-192.png', 192], ['src/ui/icon-512.png', 512], ['assets/brand/jhola-icon-1024.png', 1024]]) {
    assert.deepEqual(pngSize(p), [s, s], p);
  }
});

test('the app is called Jhola everywhere a user sees a name', () => {
  const manifest = JSON.parse(readFileSync(file('src/ui/manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.name, 'Jhola');
  assert.equal(manifest.short_name, 'Jhola');
  for (const page of ['basket.html', 'settings.html', 'guide.html']) {
    const html = readFileSync(file(`src/ui/${page}`), 'utf8');
    assert.match(html, /<title>Jhola/, `${page} title`);
    assert.doesNotMatch(html, /compareprice/i, `${page} has no old name`);
  }
  const pkg = JSON.parse(readFileSync(file('package.json'), 'utf8'));
  assert.equal(pkg.name, 'jhola');
  assert.equal(pkg.bin.jhola, 'src/cli.js');
  assert.equal(pkg.bin.basket, 'src/cli.js', 'the old command keeps working for one release');
});
