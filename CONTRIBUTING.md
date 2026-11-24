# Contributing to compareprice

Thanks for helping. The most useful contribution is usually a **fix to one site module**: sites change their pages and APIs often, and each change breaks a parser. New sites, new catalogue products, and clearer docs are all welcome too.

## Set up

You need Node 22.13 or newer. For anything that touches a live site you also need Google Chrome or Chromium (set `CHROME_PATH` if it isn't on your `PATH`).

```bash
git clone https://github.com/harivig12/compareprice.git
cd compareprice
npm ci
npm test                  # the offline suite: no network, no Chrome
node src/cli.js serve     # the web page at http://localhost:7777
```

Read these first, in this order:

1. [`AGENTS.md`](AGENTS.md): the rules that exist for a reason.
2. [`docs/ENGINE.md`](docs/ENGINE.md): how a site is searched, the error kinds, and how to add or fix a site.
3. [`docs/API.md`](docs/API.md): the HTTP and SSE contract, if you touch the server or the pages.

## The rules, short version

- **`compareBasket()` in `src/compare.js` is the only entry point.** The CLI, server, job queue and MCP all call it. Don't compute totals anywhere else.
- **No tokens, cookies or device IDs in source.** Sessions live in the browser profile. Copy rotating headers from the page's own request.
- **Site calls run inside the site's tab** (`pageFetch`), never from Node `fetch`. BigBasket and Blinkit block non-browser clients.
- **Every failure is a `SiteError`** with a kind, and a message that starts with the site id. `[]` means "the site answered and had no match", never "something broke".
- **Location comes from config.** Never hardcode it in a site module.
- **Be gentle with live sites.** Reuse one profile and pace requests. Burst traffic has already got an IP blocked once.

## Tests

- `npm test` must stay green and runs offline. Site parsers are tested against scrubbed fixtures in `test/fixtures/sites/` (its README explains how to refresh them).
- `npm run test:live` searches the real sites. Run it when you change a site module, but don't put it in CI.
- On Windows a few tests fail with `EPERM` (profile-lock symlinks and temp-folder cleanup). They aren't caused by your change. CI runs on Linux.
- A bug fix needs a test that fails without it. A new site needs a fixture and a parser test.

## Common changes

**Fix a site.** Capture a fresh response (see `scripts/probe.js` and `src/engine/sites/_capture.js`), scrub it, update the fixture, fix the parser, and add the failing case to the tests.

**Add a catalogue product.** Add a row to `src/catalog-data.js`: `[name, category, aka, sub?, brands?]`. The first name in `aka` is the canonical tag. Names that mean exactly the product go in `aka`. Narrower names ("salted butter") go in `sub`. Brands go in `brands`, never in `aka`. A name may belong to one product only, and `test/catalog.test.js` fails if two products claim the same one.

**Change a page.** Pages are plain HTML in `src/ui/` and share `src/ui/theme.css`. Keep text at 4.5:1 contrast, touch targets at 44 px or more, and no sideways scroll at 390 px. Capture screenshots with `scripts/ui-screenshot.js` into `docs/evidence/<date>-<topic>/`.

**Change the landing page.** It is `src/ui/guide.html`, built for GitHub Pages by `npm run build:site`. Mark links that only make sense inside the app with `class="app-link"` or `class="app-only"`, and GitHub-only content with `class="static-only"`.

## Pull requests

- One topic per pull request, branched from `main`.
- Say what changed and why, how you tested it, and which sites you ran it against (for site changes).
- Add a line to the `[Unreleased]` section of [`CHANGELOG.md`](CHANGELOG.md).
- Don't commit data: `basket.db`, `config.json`, results, browser profiles, or anything from a signed-in session.

## Reporting a problem

Use the issue forms. For a site that stopped working, include the site, the error kind and message shown on the page, and the commit or version you ran. For anything security-related, read [SECURITY.md](SECURITY.md) first.
