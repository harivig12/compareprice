/**
 * Browser pool: one Chrome, one warm tab per site.
 *
 * Tabs are opened on the site's origin, get the location applied once, and are
 * cached. A crashed tab is dropped; if the socket dropped (Chrome died) the
 * browser is relaunched on the next tab() call.
 */
import { join } from 'node:path';

import { DATA_DIR } from '../paths.js';
import { CdpTab } from './cdp.js';
import { launchChrome } from './chrome.js';
import { SiteError } from './errors.js';
import { BrowserMode } from './browser-mode.js';
import { OWN_PROFILES } from './accounts.js';

async function defaultSites() {
  return (await import('./sites/index.js')).SITES;
}

// Bot-wall pages (Akamai, Cloudflare, AWS WAF) that replace the whole document.
const WALL_RE = /^(Access Denied|Attention Required|Just a moment|Request blocked|403 Forbidden|Pardon Our Interruption)/i;

const HEADLESS_UA = /HeadlessChrome/i;

/**
 * Never load a site's page from a tab that says "HeadlessChrome". Bot walls (BigBasket's Akamai: "Access
 * Denied") reject that user-agent on sight, and a refused page can start a block that lasts hours.
 * The browser keeps every tab on a real user-agent (ua-guard.js) and the pool sets one per tab; this is
 * the last check before the first request, so a leak fails loudly here instead of as a mystery wall.
 * (Navigator is read from the tab's current document: an override applies to it at once.)
 */
export async function assertRealUserAgent(tab, siteId) {
  if (typeof tab.evaluate !== 'function') return;
  const ua = await tab.evaluate('navigator.userAgent', { timeoutMs: 5000 }).catch(() => null);
  if (typeof ua === 'string' && HEADLESS_UA.test(ua)) {
    throw new SiteError(
      'browser',
      `${siteId}: this tab reports a HeadlessChrome user-agent, so ${siteId} was not loaded (its bot protection rejects that and can block for hours). The user-agent override was lost; restart the browser`,
      { site: siteId, code: 'headless_ua' },
    );
  }
}

/** Throw SiteError('blocked') when the warm page is a bot wall, with its reference id. */
export async function assertNotWalled(tab, siteId) {
  if (typeof tab.evaluate !== 'function') return;
  const info = await tab
    .evaluate(`({ title: document.title, ua: navigator.userAgent, text: (document.body && document.body.innerText || '').slice(0, 300) })`, { timeoutMs: 5000 })
    .catch(() => null);
  if (!info || !WALL_RE.test(String(info.title || '').trim())) return;
  const ref = String(info.text).match(/Reference\s*#?\s*([\w.]+)/i)?.[1];
  // A wall on a tab that says HeadlessChrome is our leak, not the site's verdict on this IP.
  const leak = typeof info.ua === 'string' && HEADLESS_UA.test(info.ua);
  throw new SiteError(
    'blocked',
    leak
      ? `${siteId}: bot protection page "${info.title.trim()}"${ref ? ` (ref ${ref})` : ''} on a tab that reported a HeadlessChrome user-agent: the override was lost, not necessarily an IP block`
      : `${siteId}: bot protection page "${info.title.trim()}"${ref ? ` (ref ${ref})` : ''} — this IP is temporarily blocked; it usually clears within hours`,
    { site: siteId, ...(leak ? { code: 'headless_ua' } : {}) },
  );
}

export class BrowserPool {
  /**
   * @param {{ launch?: Function, profileDir?: string, location?: object,
   *           sites?: Record<string, object>, openTab?: Function,
   *           headless?: () => boolean, wallWatch?: { walled(site: string, msg: string): boolean, clear(site: string): void } }} [opts]
   *   `sites` and `openTab` are injection points for tests.
   *   `headless` is asked at each launch; `wallWatch` hears every bot-wall check
   *   and returns true from walled() when the browser must relaunch (BigBasket: headed).
   */
  constructor({ launch = launchChrome, profileDir, location, sites, openTab = CdpTab.open, blockMedia = false, ownLocation = () => false, headless, wallWatch } = {}) {
    this.headless = headless;
    this.wallWatch = wallWatch;
    this._relaunch = false;
    // (siteId) => true when the profile is signed in there: keep the site's own address.
    this.ownLocation = ownLocation;
    this.launch = launch;
    this.profileDir = profileDir;
    this.location = location;
    this._sites = sites;
    this._openTab = openTab;
    this._browser = null; // Promise<browser>
    this._tabs = new Map(); // siteId -> Promise<CdpTab>
    this._closed = false;
    this.blockMedia = blockMedia;
  }

  /** Is a Chrome running (or starting) right now? */
  isOpen() {
    return this._browser !== null;
  }

  /** Close one site's tab (e.g. a sign-in page once done); it reopens on demand. */
  async closeTab(siteId) {
    const p = this._tabs.get(siteId);
    if (!p) return;
    this._tabs.delete(siteId);
    await p.then((t) => t.close(), () => {});
  }

  /**
   * Sign one site out of this profile: delete its cookies (including
   * `.domain` ones) and its storage, for that site's origins only, so every
   * other site keeps its session. The site's tab is closed and reopens signed out.
   * @param {string} siteId
   * @param {string[]} origins e.g. ['https://www.swiggy.com']
   */
  async clearSiteData(siteId, origins) {
    await this.closeTab(siteId);
    const browser = await this._browserP();
    const tab = await this._openTab(browser.endpoint, 'about:blank');
    try {
      const hosts = origins.map((o) => new URL(o).hostname.replace(/^www\./, ''));
      const { cookies = [] } = await tab.send('Network.getAllCookies');
      for (const c of cookies) {
        const d = c.domain.replace(/^\./, '');
        if (hosts.some((h) => d === h || d.endsWith(`.${h}`) || h.endsWith(`.${d}`) && d.includes('.'))) {
          await tab.send('Network.deleteCookies', { name: c.name, domain: c.domain, path: c.path });
        }
      }
      for (const origin of origins) {
        await tab.send('Storage.clearDataForOrigin', { origin, storageTypes: 'local_storage,indexeddb,cache_storage,service_workers,websql,file_systems' }).catch(() => {});
      }
    } finally {
      await tab.close().catch(() => {});
    }
  }
  /**
   * Done with a sign-in. The login tab is the site's search tab, so while a job
   * may be searching that site it stays open and only gets its media block back;
   * otherwise it is closed and reopens on demand.
   */
  async releaseLoginTab(siteId, { inUse = false } = {}) {
    if (!inUse) return this.closeTab(siteId);
    const tab = await this._tabs.get(siteId)?.catch(() => null);
    if (tab && this.blockMedia) await tab.send('Network.setBlockedURLs', { urls: MEDIA_PATTERNS }).catch(() => {});
  }
  /**
   * The site's tab for driving its sign-in page: same tab and session as
   * searches, but with images allowed again (CAPTCHAs, OTP widgets).
   */
  async loginTab(siteId) {
    const tab = await this.tab(siteId);
    if (this.blockMedia) await tab.send('Network.setBlockedURLs', { urls: [] }).catch(() => {});
    return tab;
  }

  async _site(siteId) {
    const sites = (this._sites ??= await defaultSites());
    const site = sites[siteId];
    if (!site) throw new SiteError('not_found', `unknown site "${siteId}"`, { site: siteId });
    return site;
  }

  _browserP() {
    if (!this._browser) {
      const p = Promise.resolve().then(() => this.launch({ profileDir: this.profileDir, ...(this.headless ? { headless: this.headless() } : {}) }));
      p.catch(() => { if (this._browser === p) this._browser = null; });
      this._browser = p;
    }
    return this._browser;
  }

  async _create(siteId) {
    const site = await this._site(siteId);
    let browser;
    try {
      browser = await this._browserP();
    } catch (e) {
      throw new SiteError('browser', `${siteId}: could not start Chrome: ${e.message}`, { site: siteId, cause: e });
    }
    try {
      const tab = await this._openTab(browser.endpoint, 'about:blank');
      tab.onCrash((reason) => this._onCrash(siteId, tab, reason));
      if (browser.userAgent) await tab.setUserAgent(browser.userAgent);
      // Before the first request to the site: never as HeadlessChrome.
      await assertRealUserAgent(tab, siteId);
      // API calls run inside the page; its pictures, video and fonts are dead weight.
      if (this.blockMedia) await tab.send('Network.setBlockedURLs', { urls: MEDIA_PATTERNS }).catch(() => {});
      // A signed-in account keeps the address saved on it (decision 2026-11-19):
      // config location only fills in what the site doesn't have yet.
      const keep = this.ownLocation(siteId);
      let cookies = site.locationCookies?.(this.location) ?? [];
      if (keep && cookies.length) {
        const have = new Set((await tab.getCookies([site.origin]).catch(() => [])).map((c) => c.name));
        cookies = cookies.filter((c) => !have.has(c.name));
      }
      if (cookies.length) await tab.setCookies(cookies);
      if (site.origin) await tab.goto(site.origin, { waitMs: 15000 });
      await this._wallCheck(tab, siteId);
      // Pickers would move a signed-in account to the config address; passive
      // hooks (header watchers) still run.
      if (site.setLocation && (!keep || site.locationPassive)) await site.setLocation(tab, this.location);
      return tab;
    } catch (e) {
      if (e instanceof SiteError) throw e;
      throw new SiteError('browser', `${siteId}: ${e.message}`, { site: siteId, cause: e });
    }
  }

  _onCrash(siteId, tab, reason) {
    const cur = this._tabs.get(siteId);
    // Drop only if it is still this tab; a replacement may already be cached.
    cur?.then((t) => { if (t === tab) this._tabs.delete(siteId); }, () => {});
    // A dropped socket means Chrome itself is gone: relaunch on next tab().
    if (/websocket closed/.test(String(reason))) this._browser = null;
  }

  /** Switch location: warm tabs are re-opened (and re-located) on next use. */
  setLocation(location) {
    if (JSON.stringify(location) === JSON.stringify(this.location)) return;
    this.location = location;
    this._stale = true;
  }

  /** Warm tab for a site (opened on first use). */
  async tab(siteId) {
    if (this._closed) throw new SiteError('browser', 'browser pool is closed', { site: siteId });
    if (this._relaunch) {
      // The launch mode changed (headless -> headed): start a new Chrome.
      this._relaunch = false;
      await this.restart();
    }
    if (this._stale) {
      this._stale = false;
      await this._closeTabs();
    }
    const cached = this._tabs.get(siteId);
    if (cached) {
      try {
        const t = await cached;
        if (t.alive) return t;
      } catch { /* fall through to recreate */ }
      if (this._tabs.get(siteId) === cached) this._tabs.delete(siteId);
    }
    const p = this._create(siteId);
    this._tabs.set(siteId, p);
    p.catch(() => { if (this._tabs.get(siteId) === p) this._tabs.delete(siteId); });
    return p;
  }

  /** Reload the site's origin in its warm tab. */
  async refresh(siteId) {
    const tab = await this.tab(siteId);
    const site = await this._site(siteId);
    // Headers copied from the page's own requests (signatures, csrf, store
    // ids) go stale; drop them so the retry re-captures fresh ones.
    if (tab._capture) for (const k of Object.keys(tab._capture)) tab._capture[k].headers = null;
    await assertRealUserAgent(tab, siteId);
    try {
      await tab.goto(site.origin, { waitMs: 15000 });
    } catch (e) {
      throw new SiteError('browser', `${siteId}: refresh failed: ${e.message}`, { site: siteId, cause: e });
    }
    await this._wallCheck(tab, siteId);
  }

  /** The bot-wall check, reported to `wallWatch` (which may ask for a relaunch). */
  async _wallCheck(tab, siteId) {
    try {
      await assertNotWalled(tab, siteId);
    } catch (e) {
      // A wall caused by our own user-agent leak says nothing about the site: it must not push the
      // site into headed mode (a headed Chrome would not cure it).
      if (e?.kind === 'blocked' && e.code !== 'headless_ua' && this.wallWatch?.walled(siteId, e.message)) this._relaunch = true;
      throw e;
    }
    this.wallWatch?.clear(siteId);
  }

  async _closeTabs() {
    const tabs = [...this._tabs.values()];
    this._tabs.clear();
    await Promise.all(tabs.map((p) => p.then((t) => t.close(), () => {})));
  }

  /** Close everything and relaunch lazily on the next tab(). */
  async restart() {
    await this._closeTabs();
    const b = this._browser;
    this._browser = null;
    if (b) await b.then((x) => x.close(), () => {});
  }

  async close() {
    this._closed = true;
    await this.restart();
  }
}

/** Resource patterns skipped on search tabs when `blockMedia` is on. */
export const MEDIA_PATTERNS = ['*.png', '*.jpg', '*.jpeg', '*.webp', '*.avif', '*.gif', '*.svg', '*.ico', '*.woff', '*.woff2', '*.ttf', '*.otf', '*.mp4', '*.webm', '*.m3u8'];

/**
 * The main pool plus the sites that run in a Chrome of their own.
 *
 * BigBasket gets its own profile (<data>/profiles/bigbasket) and debug port
 * (user decision 2026-11-24): its bot wall then never touches the other
 * sites' sessions, and it can switch to a headed Chrome on its own
 * (src/engine/browser-mode.js). Everything else shares the main Chrome.
 * Callers see one pool: each call goes to the site's own Chrome.
 */
export class SitePools {
  /** @param {{ main: BrowserPool, own?: Record<string, BrowserPool> }} pools */
  constructor({ main, own = {} }) {
    this.main = main;
    this.own = own;
  }

  /** The pool that serves this site. */
  for(siteId) {
    return this.own[siteId] ?? this.main;
  }

  #all() {
    return [this.main, ...Object.values(this.own)];
  }

  isOpen() { return this.#all().some((p) => p.isOpen()); }
  tab(siteId) { return this.for(siteId).tab(siteId); }
  refresh(siteId) { return this.for(siteId).refresh(siteId); }
  closeTab(siteId) { return this.for(siteId).closeTab(siteId); }
  loginTab(siteId) { return this.for(siteId).loginTab(siteId); }
  releaseLoginTab(siteId, opts) { return this.for(siteId).releaseLoginTab(siteId, opts); }
  clearSiteData(siteId, origins) { return this.for(siteId).clearSiteData(siteId, origins); }
  setLocation(location) { for (const p of this.#all()) p.setLocation(location); }
  async restart() { await Promise.all(this.#all().map((p) => p.restart())); }
  async close() { await Promise.all(this.#all().map((p) => p.close())); }

  get location() { return this.main.location; }
  get profileDir() { return this.main.profileDir; }
  get blockMedia() { return this.main.blockMedia; }
  set blockMedia(v) { for (const p of this.#all()) p.blockMedia = v; }
  get ownLocation() { return this.main.ownLocation; }
  set ownLocation(fn) { for (const p of this.#all()) p.ownLocation = fn; }
}

/** Debug ports of the sites with a Chrome of their own (main: 9333, extra accounts: 9400+). */
export const OWN_PORTS = Object.freeze({ bigbasket: 9350 });

let shared = null;
let mode = null;

/** Headless/headed choice per own-profile site (one per process). */
export function browserMode() {
  mode ??= new BrowserMode({ file: join(DATA_DIR, 'browser-mode.json') });
  return mode;
}

/** The shared pools if they were created, without creating them. */
export function peekPool() {
  return shared;
}

/** Process-wide pools, created on first use and closed on exit. */
export function getPool(opts = {}) {
  if (!shared) {
    const m = browserMode();
    const own = {};
    for (const [site, profile] of Object.entries(OWN_PROFILES)) {
      own[site] = new BrowserPool({
        ...opts,
        profileDir: join(DATA_DIR, profile),
        launch: (o) => launchChrome({ ...o, port: OWN_PORTS[site] }),
        headless: () => m.headless(site),
        wallWatch: { walled: (s, msg) => m.walled(s, msg), clear: (s) => m.clear(s) },
      });
    }
    shared = new SitePools({
      main: new BrowserPool({ profileDir: join(DATA_DIR, 'chrome-profile'), ...opts }),
      own,
    });
    const closeShared = () => shared?.close().catch(() => {});
    // Chrome is a child process; on Linux it outlives a parent that exits
    // abruptly, so close it before exiting (bounded, in case it hangs).
    const exitAfterClose = (code) => {
      Promise.race([closeShared(), new Promise((r) => setTimeout(r, 8000))]).finally(() => process.exit(code));
    };
    process.once('beforeExit', closeShared);
    process.once('SIGINT', () => exitAfterClose(130));
    process.once('SIGTERM', () => exitAfterClose(143));
  } else {
    if (opts.location) shared.setLocation(opts.location);
    if (opts.blockMedia != null) shared.blockMedia = opts.blockMedia;
    if (opts.ownLocation) shared.ownLocation = opts.ownLocation;
  }
  return shared;
}
