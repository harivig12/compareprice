/**
 * One queue for manual and scheduled runs.
 *
 * Jobs run one at a time, FIFO. Sites inside a job run in parallel (the
 * engine does that), so a site is never in two jobs at once: a schedule that
 * fires during a manual run just waits its turn.
 */
import { EventEmitter } from 'node:events';

// Lazy so importing the queue (tests, server boot) doesn't load the engine.
const compareBasket = (opts) => import('./compare.js').then((m) => m.compareBasket(opts));

export class JobQueue extends EventEmitter {
  #run;
  #pending = [];
  #current = null;
  #localId = 0;

  /**
   * @param {object} opts
   * @param {(opts: object) => Promise<object>} [opts.run]  compareBasket-compatible
   * @param {ReturnType<import('./store.js').openStore>} [opts.store]
   */
  constructor({ run = compareBasket, store } = {}) {
    super();
    this.#run = run;
    this.store = store ?? null;
  }

  /** @returns {number} jobId */
  enqueue({ items, sites, trigger = 'manual', only }) {
    const id = this.store ? this.store.createJob({ sites, items, trigger }) : ++this.#localId;
    // `only`: { site: [queries] } — search just these pairs ("Get for missing only").
    this.#pending.push({ id, items, sites, trigger, ...(only ? { only } : {}), status: 'queued', createdAt: new Date().toISOString() });
    // Start on the next turn so the caller has the id before any events fire.
    queueMicrotask(() => this.#next());
    return id;
  }

  /** The running job, or null. */
  current() {
    if (!this.#current) return null;
    const { controller, ...job } = this.#current;
    return job;
  }

  /** Jobs waiting behind the current one, in run order. */
  pending() {
    return this.#pending.map((job) => ({ ...job }));
  }

  cancel(jobId) {
    if (this.#current?.id === jobId) {
      this.#current.controller.abort(new Error('cancelled'));
      return true;
    }
    const i = this.#pending.findIndex((job) => job.id === jobId);
    if (i === -1) return false;
    this.#pending.splice(i, 1);
    this.store?.updateJob(jobId, { status: 'cancelled', finishedAt: new Date().toISOString() });
    this.emit('done', jobId, new Error('cancelled'));
    return true;
  }

  async #next() {
    if (this.#current || this.#pending.length === 0) return;
    const job = this.#pending.shift();
    const controller = new AbortController();
    this.#current = { ...job, status: 'running', startedAt: new Date().toISOString(), controller };
    this.store?.updateJob(job.id, { status: 'running', startedAt: this.#current.startedAt });

    let outcome;
    try {
      const result = await this.#run({
        items: job.items,
        platforms: job.sites,
        // 'offers' jobs are the offer check (src/offers.js), not a basket run.
        trigger: job.trigger,
        ...(job.only ? { only: job.only } : {}),
        signal: controller.signal,
        onProgress: (...args) =>
          this.emit('progress', job.id, args.length === 1 ? args[0] : { platform: args[0], query: args[1] }),
      });
      if (controller.signal.aborted) throw controller.signal.reason ?? new Error('cancelled');
      if (this.store) {
        this.store.annotate(result);
        this.store.recordResult(result, { jobId: job.id, trigger: job.trigger });
      }
      this.store?.updateJob(job.id, {
        status: 'done',
        finishedAt: new Date().toISOString(),
        summary: { winner: result?.winner ?? null, unavailable: result?.unavailable ?? [] },
      });
      outcome = result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.store?.updateJob(job.id, {
        status: controller.signal.aborted ? 'cancelled' : 'failed',
        finishedAt: new Date().toISOString(),
        error: error.message,
      });
      outcome = error;
    }
    this.#current = null;
    // Schedule the next job first so a throwing 'done' listener can't stall the queue.
    queueMicrotask(() => this.#next());
    this.emit('done', job.id, outcome);
  }
}
