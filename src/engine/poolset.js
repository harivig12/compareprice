/**
 * One browser pool per account.
 *
 * The main account of every site uses the shared pool (`chrome-profile`, kept
 * warm and closed by the idle closer). Each extra account (Instamart and
 * Milkbasket only) gets its own pool on its own profile directory and debug
 * port, launched only for one step (a sign-in, a search, an offer check) and
 * closed straight after, so a second Chrome never idles.
 *
 * Work on one account runs one step at a time; different accounts never run
 * in parallel on the same site either (the caller awaits each in turn).
 */
import { join, resolve, sep } from 'node:path';
import { rmSync } from 'node:fs';
import { BrowserPool, getPool, peekPool } from './pool.js';
import { launchChrome } from './chrome.js';
import { DATA_DIR } from '../paths.js';
import { MAIN } from './accounts.js';

export const BASE_PORT = 9400;

export class PoolSet {
  /**
   * @param {{ dataDir?: string, getLocation?: () => object, blockMedia?: boolean, basePort?: number,
   *           makePool?: (opts: object) => BrowserPool, getMain?: () => BrowserPool,
   *           signedIn?: (siteId: string, accountId: string) => boolean }} [opts]
   */
  constructor({ dataDir = DATA_DIR, getLocation = () => undefined, blockMedia = true, basePort = BASE_PORT, makePool, getMain, signedIn = () => false, canCloseMain = () => false } = {}) {
    // () => true when nothing is using the main Chrome (no sign-in open), so it
    // can be closed before an extra account's Chrome starts.
    this.canCloseMain = canCloseMain;
    this.dataDir = dataDir;
    this.getLocation = getLocation;
    this.blockMedia = blockMedia;
    this.basePort = basePort;
    this.makePool = makePool ?? ((o) => new BrowserPool(o));
    this.getMain = getMain ?? (() => getPool({ location: this.getLocation(), blockMedia: this.blockMedia }));
    this.signedIn = signedIn;
    this.extra = new Map(); // profile -> { pool, port, busy, chain }
    this.nextPort = 0;
  }

  /** Is this the shared main pool? */
  isMain(acc) {
    return !acc || acc.id === MAIN;
  }

  /** The pool for an account (created for extra accounts on first use). */
  forAccount(siteId, acc) {
    if (this.isMain(acc)) return this.getMain();
    let e = this.extra.get(acc.profile);
    if (!e) {
      // First free port: never one a live extra pool still holds.
      const taken = new Set([...this.extra.values()].map((x) => x.port));
      let port = this.basePort;
      while (taken.has(port)) port++;
      const profileDir = join(this.dataDir, acc.profile);
      e = {
        port,
        busy: 0,
        chain: Promise.resolve(),
        pool: this.makePool({
          profileDir,
          // A loaded machine can take longer than one start's 15 s (2026-11-20:
          // "DevTools not reachable at :9400"); one more try after a pause.
          launch: async (o) => {
            try {
              return await launchChrome({ ...o, port });
            } catch {
              await new Promise((r) => setTimeout(r, 3000));
              return launchChrome({ ...o, port });
            }
          },
          location: this.getLocation(),
          blockMedia: this.blockMedia,
          // A signed-in extra account always keeps the address saved on it.
          ownLocation: () => true,
        }),
      };
      this.extra.set(acc.profile, e);
    }
    return e.pool;
  }

  /** Is this account's pool doing something right now? */
  busy(acc) {
    return !this.isMain(acc) && (this.extra.get(acc.profile)?.busy ?? 0) > 0;
  }

  /**
   * Run `fn(pool)` for an account, one step at a time per account. An extra
   * account's Chrome is closed afterwards, even when `fn` throws.
   */
  async with(siteId, acc, fn) {
    const pool = this.forAccount(siteId, acc);
    if (this.isMain(acc)) return fn(pool);
    const e = this.extra.get(acc.profile);
    // Counted as busy from the moment it is queued, so finishing step A never
    // closes the pool that queued step B is about to use.
    e.busy++;
    const run = e.chain.then(async () => {
      // One Chrome at a time: two (main + extra) maxed the CPU and the second
      // failed to start (2026-11-20). The main one reopens on its next use.
      if (this.canCloseMain()) await peekPool()?.restart().catch(() => {});
      try {
        return await fn(pool);
      } finally {
        e.busy--;
        if (e.busy === 0) await this.#closeExtra(acc.profile);
      }
    });
    e.chain = run.catch(() => {});
    return run;
  }

  async #closeExtra(profile) {
    const e = this.extra.get(profile);
    if (!e || e.busy > 0) return;
    this.extra.delete(profile);
    await e.pool.close().catch(() => {});
  }

  /** A sign-in step finished: release the main login tab, or close the extra Chrome. */
  async releaseLogin(siteId, acc, { inUse = false } = {}) {
    if (this.isMain(acc)) return peekPool()?.releaseLoginTab(siteId, { inUse });
    return this.#closeExtra(acc.profile);
  }

  /** Delete an extra account's profile directory (only ever under <data>/profiles/). */
  async removeProfile(acc) {
    if (this.isMain(acc)) throw new Error('the main profile is never deleted');
    await this.#closeExtra(acc.profile);
    const root = resolve(this.dataDir, 'profiles') + sep;
    const dir = resolve(this.dataDir, acc.profile);
    if (!dir.startsWith(root)) throw new Error(`refusing to delete ${dir}: not under ${root}`);
    rmSync(dir, { recursive: true, force: true });
  }

  async closeAll() {
    await Promise.all([...this.extra.keys()].map((p) => this.#closeExtra(p)));
  }
}
