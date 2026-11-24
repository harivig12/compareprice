/**
 * Close the warm Chrome when nothing needs it.
 *
 * Between the three daily runs the open store pages keep running their own
 * scripts (JioMart's home page alone ~360 ms/s of main thread). Measured idle
 * cost ~1 GB and 50–75% of a core, for runs that take about a minute
 * (docs/diagnosis/2026-11-19-resource-use-and-otp-step.md). So: once no job
 * and no sign-in has been active for `idleMs`, close Chrome. The next job or
 * sign-in relaunches it; the profile (cookies, location, sign-ins) is on disk.
 */
export class IdleCloser {
  /**
   * @param {{ getPool: () => { isOpen(): boolean, restart(): Promise<void> } | null,
   *           isBusy: () => boolean, idleMs: number, now?: () => number,
   *           log?: (msg: string) => void }} opts
   */
  constructor({ getPool, isBusy, idleMs, now = () => Date.now(), log = () => {} }) {
    this.getPool = getPool;
    this.isBusy = isBusy;
    this.idleMs = idleMs;
    this.now = now;
    this.log = log;
    this.lastActive = now();
    this.closing = null;
  }

  /** Something used the browser (a job event, a sign-in step). */
  touch() {
    this.lastActive = this.now();
  }

  /** Check once; closes Chrome if it has been idle long enough. */
  async tick() {
    if (!(this.idleMs > 0) || this.closing) return false;
    const pool = this.getPool();
    if (!pool?.isOpen()) return false;
    if (this.isBusy()) {
      this.touch();
      return false;
    }
    const idleFor = this.now() - this.lastActive;
    if (idleFor < this.idleMs) return false;
    this.closing = pool
      .restart()
      .then(() => this.log(`browser closed after ${Math.round(idleFor / 60000)} min idle; it reopens with the next job`))
      .catch((e) => this.log(`browser idle close failed: ${e.message}`))
      .finally(() => { this.closing = null; });
    await this.closing;
    return true;
  }

  /** Run tick() every `everyMs` until stopped. */
  start(everyMs = 30_000) {
    const t = setInterval(() => { this.tick(); }, everyMs);
    t.unref?.();
    return { stop: () => clearInterval(t) };
  }
}
