/**
 * Offer check: each signed-in account's own deals, without searching products.
 *
 *   Milkbasket: every signed-in account (main and extra) -> its flash deal.
 *   Instamart:  every signed-in account (or the guest main) -> its home feed.
 *   BigBasket:  the main profile (guest or signed in) -> its deal storefronts,
 *               at any discount (`offersMinPct: 0`), one group per storefront.
 *
 * Accounts run one after another, each through the site's shared request
 * budget. Only rows at the deal threshold are kept (src/deals.js); they go to
 * the store as `feed` deals, replacing that account's previous ones. Runs
 * at the deal times (src/offer-schedule.js) and from "Check offers" (as a
 * queued job, so it never shares a tab with a search).
 */
import { isDeal, toDeal, DEFAULT_MIN_DISCOUNT_PCT } from './deals.js';
import { MAIN } from './engine/accounts.js';

// Zepto has no deal feed; it is checked for its free-delivery minimum only.
export const OFFER_SITES = ['instamart', 'milkbasket', 'zepto', 'bigbasket'];

/**
 * @param {object} opts
 * @param {import('./engine/poolset.js').PoolSet} opts.poolSet
 * @param {ReturnType<import('./engine/accounts.js').openAccounts>} opts.accounts
 * @param {object} opts.sitesImpl   site modules (each with `offers(tab)`)
 * @param {object} [opts.store]
 * @param {object} [opts.limiter]   src/limits.js budget, shared with searches
 * @param {string[]} [opts.sites]
 * @param {number} [opts.minPct]
 * @param {(e: object) => void} [opts.onProgress]
 * @param {AbortSignal} [opts.signal]
 * @param {() => string} [opts.now] ISO time
 * @returns {Promise<{ generatedAt: string, elapsedMs: number, kind: 'offers', offers: object[], platforms: [], deals: [] }>}
 */
export const OFFER_ACCOUNT_GAP_MS = 60_000;

export async function checkOffers({ poolSet, accounts, sitesImpl, store, limiter, sites = OFFER_SITES, minPct = DEFAULT_MIN_DISCOUNT_PCT, onProgress, signal, now = () => new Date().toISOString(), accountGapMs = 0, zeptoCart = true, cartOffers = {}, log }) {
  // Which sites may put one item in the signed-in cart to read its offers (config deals.zeptoCart / deals.instamartCart).
  const cartOk = (site) => (cartOffers[site] ?? (site === 'zepto' ? zeptoCart : true)) !== false;
  const t0 = Date.now();
  const emit = (e) => { try { onProgress?.(e); } catch { /* observer bug */ } };
  const results = [];
  for (const site of sites) {
    const impl = sitesImpl[site];
    if (!impl?.offers) continue;
    // Milkbasket needs a session; Instamart's home feed works as a guest too.
    const signed = accounts.signedIn(site);
    let list = signed;
    if (!list.length && !impl.signedInOnly) list = [accounts.get(site, MAIN)];
    emit({ type: 'site-start', site, total: list.length });
    for (const [i, acc] of list.entries()) {
      if (signal?.aborted) throw new Error('Operation aborted');
      // Accounts a minute apart: spreads the CPU (one Chrome each) and the traffic.
      if (i > 0 && accountGapMs > 0) await new Promise((r) => setTimeout(r, accountGapMs));
      emit({ type: 'query', site, query: `offers · ${acc.name}`, index: i + 1, total: list.length });
      const checkedAt = now();
      try {
        await limiter?.acquire(site, { signal });
        // A site that reads many pages (BigBasket's storefronts) paces each one.
        const ctx = { signal, log, acquire: () => limiter?.acquire(site, { signal }), cart: cartOk(site) && acc.id === MAIN, signedIn: signed.some((a) => a.id === acc.id) };
        const out = await poolSet.with(site, acc, async (pool) => impl.offers(await pool.tab(site), ctx));
        const sitePct = impl.offersMinPct ?? minPct;
        const deals = (out.rows ?? []).filter((r) => r.inStock !== false && isDeal(r, sitePct))
          .map((r) => toDeal(r, { site, account: acc.id, source: 'feed', seenAt: checkedAt, conditions: out.conditions }));
        // Smarter, free: deals in the catalogue the site already gave us today
        // (Milkbasket: ~6,200 products), no extra call. Main account only.
        if (acc.id === MAIN && impl.cachedRows) {
          const have = new Set(deals.map((d) => d.product));
          for (const r of impl.cachedRows()) {
            if (r.inStock !== false && isDeal(r, minPct) && !have.has(r.name)) {
              have.add(r.name);
              deals.push(toDeal(r, { site, account: acc.id, source: 'feed', seenAt: checkedAt }));
            }
          }
        }
        // A part of the check that failed (Zepto's cart offers) is shown like any failed check, with the rest kept.
        store?.recordDeals(deals, { site, account: acc.id, source: 'feed', checkedAt, error: out.warning ?? null });
        // Coupons and payment offers (not products): the cart lists (Zepto: payment + coupons; Instamart: coupons).
        if (out.lists && acc.id === MAIN) {
          for (const kind of ['payment', 'coupons'].filter((k) => Array.isArray(out.lists[k]))) store?.recordOfferList?.({ site, account: acc.id, kind, offers: out.lists[kind], checkedAt, cart: out.lists.cart, item: out.lists.item });
        }
        // Fee facts are the site's, from the main account's view.
        if (out.info && acc.id === MAIN) store?.setSiteInfo?.(site, out.info, checkedAt);
        results.push({ site, account: acc.id, name: acc.name, deals: deals.length, scanned: out.rows?.length ?? 0, note: out.note ?? null, ...(out.lists ? { offers: (out.lists.payment?.length ?? 0) + (out.lists.coupons?.length ?? 0), cart: out.lists.cart } : {}), ...(out.warning ? { warning: out.warning } : {}) });
      } catch (e) {
        // One account's failure is that account's; the others still run.
        if (e?.kind === 'blocked' && e?.code !== 'resting') limiter?.penalize?.(site, String(e.message).slice(0, 120));
        // A lost session means the account isn't signed in any more: say so in the popup.
        if (e?.kind === 'session' && impl.signedInOnly) accounts.markSignedOut?.(site, acc.id);
        const error = `${String(e?.message ?? e)}${acc.id === MAIN ? '' : ` (account "${acc.name}")`}`;
        store?.recordDeals([], { site, account: acc.id, source: 'feed', checkedAt, error });
        results.push({ site, account: acc.id, name: acc.name, deals: 0, scanned: 0, error });
      }
    }
    const failed = results.filter((r) => r.site === site && r.error);
    emit({ type: 'site-done', site, ok: !failed.length, ...(failed.length ? { error: failed.map((r) => r.error).join('; ') } : {}) });
  }
  return { kind: 'offers', generatedAt: now(), elapsedMs: Date.now() - t0, offers: results, platforms: [], deals: [], basket: [], winner: null };
}
