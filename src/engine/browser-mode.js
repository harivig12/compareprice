/**
 * Headless or headed, per site (BigBasket only, user decision 2026-11-24).
 *
 * BigBasket runs in its own headless Chrome first. Its Akamai wall answers
 * "Access Denied" to page loads it distrusts; if that happens on two page
 * loads in a row (with no clean load in between), the site switches to a
 * headed Chrome (on a server, inside a virtual screen: src/engine/display.js)
 * and stays headed. A clean page load resets the count.
 *
 * The choice is kept in <data>/browser-mode.json, so a restart keeps it:
 *   { "bigbasket": { "mode": "headed", "since": "<iso>", "reason": "…" } }
 * Set "mode" to "headless" there (or delete the file) to go back.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const WALLS_BEFORE_HEADED = 2;

export class BrowserMode {
  /**
   * @param {{ file?: string|null, now?: () => Date, log?: (msg: string) => void }} [opts]
   *   file: null keeps everything in memory (tests)
   */
  constructor({ file = null, now = () => new Date(), log = (m) => console.warn(m) } = {}) {
    this.file = file;
    this.now = now;
    this.log = log;
    this.walls = new Map(); // site -> walls in a row
    this.state = this.#read();
  }

  #read() {
    if (!this.file) return {};
    try {
      const j = JSON.parse(readFileSync(this.file, 'utf8'));
      return j && typeof j === 'object' ? j : {};
    } catch {
      return {};
    }
  }

  #write() {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, `${JSON.stringify(this.state, null, 2)}\n`);
    } catch (e) {
      this.log(`browser-mode: could not save ${this.file}: ${e.message}`);
    }
  }

  /** Should this site's Chrome run headless? */
  headless(site) {
    return this.state[site]?.mode !== 'headed';
  }

  /**
   * A page load hit the bot wall.
   * @returns {boolean} true when this switched the site to headed (restart its Chrome)
   */
  walled(site, reason = 'bot wall') {
    const n = (this.walls.get(site) ?? 0) + 1;
    this.walls.set(site, n);
    if (!this.headless(site) || n < WALLS_BEFORE_HEADED) return false;
    this.state[site] = { mode: 'headed', since: this.now().toISOString(), reason: `${n} bot walls in a row: ${String(reason).slice(0, 160)}` };
    this.#write();
    this.walls.set(site, 0);
    this.log(`${site}: ${n} bot walls in a row; its Chrome runs headed from now on (${this.file ?? 'in memory'})`);
    return true;
  }

  /** A page load got through. */
  clear(site) {
    this.walls.set(site, 0);
  }

  /** For the status page / API. */
  status(site) {
    return { mode: this.headless(site) ? 'headless' : 'headed', wallsInARow: this.walls.get(site) ?? 0, ...(this.state[site]?.since ? { since: this.state[site].since, reason: this.state[site].reason } : {}) };
  }
}
