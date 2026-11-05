/**
 * compareBasket() — the single entry point every surface calls.
 *
 * CLI, MCP server and web UI all render the object this returns. Nothing
 * computes a total twice; if two surfaces disagree, that's a bug here, not
 * a formatting difference there.
 */

import { resolveBasket } from './resolver.js';
import { searchAll, PLATFORMS, selectBackend } from './platforms.js';
import { scorePlatform, rank } from './score.js';
import { CONFIDENCE_THRESHOLD } from './normalize.js';
import { FEES, loadFees, allFeesKnown } from './fees.js';

/** Whatever is set in the browser profile wins — this is only for display.
 *  Currently Greater Kailash II, matching the location set on both platforms. */
export const DEFAULT_PINCODE = '110048';

/**
 * @param {object} opts
 * @param {string|string[]} opts.items      basket text, or pre-split lines
 * @param {string} [opts.pincode]
 * @param {string[]} [opts.platforms]       defaults to whatever is installed
 * @param {(p: string, q: string) => void} [opts.onProgress]
 */
export async function compareBasket({
  items,
  pincode = DEFAULT_PINCODE,
  platforms,
  onProgress,
} = {}) {
  const text = Array.isArray(items) ? items.join('\n') : String(items ?? '');
  const basket = resolveBasket(text);

  if (basket.length === 0) {
    throw new Error('Basket is empty — give me at least one item, one per line.');
  }

  const active = platforms ?? PLATFORMS;

  const backend = await selectBackend();
  if (!backend) {
    throw new Error(
      'No search backend available.\n' +
        '  · webcmd adapters not installed / bridge down, and\n' +
        '  · no debuggable Chrome on the CDP endpoint.\n' +
        '  Start Chrome with: --remote-debugging-port=9222 --user-data-dir=C:\\Users\\HP\\chrome-basket-profile',
    );
  }

  const startedAt = Date.now();
  const queries = [...new Set(basket.map((i) => i.query))];

  const platformResults = await searchAll(queries, { platforms: active, backend, onProgress });

  // Read the user's fee config once, not per platform per line.
  const feeConfig = loadFees();

  const scores = [];
  const unavailable = [];

  for (const result of platformResults) {
    if (!result.available) {
      unavailable.push({ platform: result.platform, error: result.error });
      continue;
    }
    scores.push(scorePlatform(result.platform, basket, result.resultsByQuery, feeConfig));
  }

  const ranking = rank(scores);

  return {
    pincode,
    backend,
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    confidenceThreshold: CONFIDENCE_THRESHOLD,
    basket,
    platforms: ranking.allScores ?? scores,
    unavailable,
    winner: ranking.winner
      ? {
          platform: ranking.winner.platform,
          total: ranking.winner.total,
          subsetTotal: ranking.winner.subsetTotal ?? null,
          label: FEES[ranking.winner.platform]?.label ?? ranking.winner.platform,
        }
      : null,
    runnerUp: ranking.runnerUp
      ? {
          platform: ranking.runnerUp.platform,
          total: ranking.runnerUp.total,
          subsetTotal: ranking.runnerUp.subsetTotal ?? null,
          label: FEES[ranking.runnerUp.platform]?.label ?? ranking.runnerUp.platform,
        }
      : null,
    saving: ranking.saving,
    likeForLike: ranking.likeForLike,
    comparedOn: ranking.comparedOn ?? null,
    commonItems: ranking.commonItems ?? null,
    coverageWarning: ranking.coverageWarning
      ? {
          ...ranking.coverageWarning,
          label:
            FEES[ranking.coverageWarning.platform]?.label ?? ranking.coverageWarning.platform,
        }
      : null,
    // Totals are goods-only unless the user configured fees. Surfaces let the
    // reader know which they're looking at; nothing invents a delivery charge.
    feesKnown: allFeesKnown(active, feeConfig),
    feesConfigured: active.filter((p) => Boolean(feeConfig[p])),
    feesMissing: active.filter((p) => !feeConfig[p]),
  };
}
