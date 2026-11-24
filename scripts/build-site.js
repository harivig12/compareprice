// Build the public landing page for GitHub Pages: node scripts/build-site.js [outDir]
//
// The landing page IS the in-app guide (src/ui/guide.html). It is a static page:
// no server is needed to read it. The only differences from the in-app copy:
//   - <html class="static">: links to app pages (Compare, Settings) disappear and
//     GitHub links appear (see the .static rules at the top of guide.html);
//   - the web app manifest starts at the page itself, not at "/";
//   - a social preview image and a .nojekyll marker are added.
// The app itself (headless Chrome + a scheduler) cannot run on Pages: see
// docs/OPERATIONS.md. Output goes to ./site (git-ignored).
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ui = join(root, 'src', 'ui');
const out = resolve(process.argv[2] || join(root, 'site'));

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// Page
const guide = readFileSync(join(ui, 'guide.html'), 'utf8');
if (!/<html lang="en">/.test(guide)) throw new Error('guide.html: <html lang="en"> not found');
writeFileSync(join(out, 'index.html'), guide.replace('<html lang="en">', '<html lang="en" class="static">'));

// Assets the page links to by relative path
for (const [from, to] of [
  ['theme.css', 'theme.css'],
  ['icon.svg', 'icon.svg'],
  ['icon-180.png', 'apple-touch-icon.png'],
  ['icon-192.png', 'icon-192.png'],
  ['icon-512.png', 'icon-512.png'],
]) cpSync(join(ui, from), join(out, to));

// Manifest: relative start so it works under /compareprice/
const manifest = JSON.parse(readFileSync(join(ui, 'manifest.webmanifest'), 'utf8'));
manifest.start_url = './';
manifest.scope = './';
for (const icon of manifest.icons) icon.src = icon.src.replace(/^\//, '');
writeFileSync(join(out, 'manifest.webmanifest'), JSON.stringify(manifest, null, 2) + '\n');

// Social preview (link cards): optional, built by the docs workflow
const preview = join(root, 'docs', 'assets', 'social-preview.png');
if (existsSync(preview)) cpSync(preview, join(out, 'social-preview.png'));

writeFileSync(join(out, '.nojekyll'), '');
console.log(`site built in ${out}`);
