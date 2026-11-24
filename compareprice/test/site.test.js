import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/build-site.js', import.meta.url));

test('build-site turns the guide into a static landing page', () => {
  const out = mkdtempSync(join(tmpdir(), 'basket-site-'));
  try {
    execFileSync(process.execPath, [script, out], { stdio: 'pipe' });

    const html = readFileSync(join(out, 'index.html'), 'utf8');
    assert.match(html, /<html lang="en" class="static">/, 'marked static: app links hide, GitHub links show');
    assert.match(html, /class="static-only"/);
    assert.match(html, /class="app-only"/);
    assert.doesNotMatch(html, /fonts\.googleapis|fonts\.gstatic/);

    // Every file the page links to by relative path is shipped.
    const hrefs = [...html.matchAll(/<link[^>]+href="([^"]+)"/g)].map((m) => m[1]).filter((h) => !/^(https?:|data:|#|\/)/.test(h));
    assert.ok(hrefs.length >= 4, 'theme, icon, touch icon and manifest are linked');
    for (const h of hrefs) assert.ok(existsSync(join(out, h)), `${h} is in the site`);
    assert.ok(!/href="\/(?:theme\.css|icon\.svg|manifest)/.test(html), 'no root-absolute asset links (the site lives under /compareprice/)');

    const manifest = JSON.parse(readFileSync(join(out, 'manifest.webmanifest'), 'utf8'));
    assert.equal(manifest.start_url, './');
    assert.equal(manifest.scope, './');
    for (const icon of manifest.icons) {
      assert.ok(!icon.src.startsWith('/'), `${icon.src} is relative`);
      assert.ok(existsSync(join(out, icon.src)), `${icon.src} exists`);
    }
    assert.ok(existsSync(join(out, '.nojekyll')));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('the in-app guide still works at /guide: it has no class="static" marker', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/ui/guide.html', import.meta.url)), 'utf8');
  assert.match(src, /<html lang="en">/);
  assert.doesNotMatch(src, /<html[^>]*class="static"/);
});
