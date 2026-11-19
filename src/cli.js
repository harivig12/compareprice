#!/usr/bin/env node
/**
 * Basket CLI.
 *
 *   basket <list.txt>            compare
 *   basket <list.txt> --web      compare, then serve the web view
 *   basket serve                 long-running service: web UI, API, scheduler
 *   basket run-now [--sites=a,b] queue the configured basket on the service
 *   basket history "<item>"      lowest price seen per site, with dates
 *   basket setup / doctor        legacy webcmd helpers
 */

import { readFileSync, existsSync } from 'node:fs';
import process from 'node:process';

import { compareBasket, DEFAULT_PINCODE } from './compare.js';
import { PLATFORMS, ALL_PLATFORMS } from './platforms.js';
import { renderTui } from './tui.js';
import { saveResult, openInBrowser } from './ui-writer.js';
import { startServer } from './server.js';
import { startService } from './service.js';
import { loadConfig } from './config.js';
import { openStore } from './store.js';
import { DATA_DIR } from './paths.js';
import { SITES } from './engine/sites/index.js';
import { join } from 'node:path';
import { setup, doctor } from './setup.js';
import { loadFees, saveFees, clearFees, FEES_FILE } from './fees.js';

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `${code}${s}${C.reset}` : String(s));

function rupees(n) {
  if (n == null) return '—';
  return `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function pad(s, width, align = 'left') {
  const str = String(s ?? '');
  // Strip ANSI when measuring so colour doesn't break alignment.
  const visible = str.replace(/\x1b\[[0-9;]*m/g, '');
  const gap = Math.max(0, width - [...visible].length);
  return align === 'right' ? ' '.repeat(gap) + str : str + ' '.repeat(gap);
}

function truncate(s, n) {
  const str = String(s ?? '');
  return [...str].length <= n ? str : [...str].slice(0, n - 1).join('') + '…';
}

const siteLabel = (p) => SITES[p]?.label ?? p;

/** dd/mm/yy in India time, the tag on every saved price. */
export function ddmmyy(iso) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: '2-digit' }).format(new Date(iso));
}

/**
 * One status line for parallel sites:  Instamart 3/5 · BigBasket ✔ · Zepto ✖
 * Non-TTY output (logs, cron) gets one plain line per event instead.
 */
function progressPrinter() {
  const state = new Map();
  const tty = process.stdout.isTTY;
  return (e) => {
    if (!e || typeof e !== 'object') return;
    const s = state.get(e.site) ?? { text: '…' };
    if (e.type === 'query') s.text = `${e.index}/${e.total} ${truncate(e.query, 18)}`;
    if (e.type === 'retry') s.text = `retry (${e.kind})`;
    if (e.type === 'fallback') s.text = 'page fallback';
    if (e.type === 'site-done') s.text = e.ok ? '✔' : '✖';
    state.set(e.site, s);
    if (tty) {
      const line = [...state].map(([site, v]) => `${siteLabel(site)} ${v.text}`).join(' · ');
      const width = (process.stdout.columns || 100) - 2;
      process.stdout.write('\r\x1b[2K' + c(C.dim, '  ' + truncate(line, width)));
    } else if (e.type === 'query') {
      console.log(`  ${siteLabel(e.site)} · ${e.index}/${e.total} · ${e.query}`);
    } else if (e.type === 'site-done') {
      console.log(`  ${siteLabel(e.site)} · ${e.ok ? 'done' : `failed: ${e.error}`}`);
    } else if (e.type === 'retry') {
      console.log(`  ${siteLabel(e.site)} · retry after ${e.kind}: ${e.message}`);
    }
  };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function renderTable(result) {
  const platforms = result.platforms;
  if (platforms.length === 0) return;

  // Fit the terminal instead of overflowing it: shrink columns first.
  const cols = process.stdout.columns || 140;
  const itemWidth = Math.min(34, Math.max(18, Math.floor(cols * 0.24)));
  const colWidth = Math.max(11, Math.min(22, Math.floor((cols - itemWidth) / platforms.length)));

  const header =
    pad('ITEM', itemWidth) +
    platforms.map((p) => pad(truncate((p.label ?? p.platform).toUpperCase(), colWidth - 1), colWidth)).join('');
  console.log(c(C.bold, header));
  console.log(c(C.dim, '─'.repeat(itemWidth + colWidth * platforms.length)));

  for (const item of result.basket) {
    const label = item.qty > 1 ? `${item.qty}× ${item.query}` : item.query;
    let row = pad(truncate(label, itemWidth - 1), itemWidth);

    // Cheapest and second cheapest confident price for this item.
    const prices = [...new Set(platforms
      .map((p) => p.lines.find((l) => l.query === item.query))
      .filter((l) => l?.status === 'ok' && l.lineTotal != null)
      .map((l) => l.lineTotal))].sort((a, b) => a - b);

    for (const p of platforms) {
      const line = p.lines.find((l) => l.query === item.query);
      if (p.failed) {
        row += pad(c(C.red, truncate(p.errorKind ?? 'error', colWidth - 1)), colWidth);
        continue;
      }
      if (!line || line.lineTotal == null) {
        const why = line?.status === 'out-of-stock' ? 'out of stock' : line?.status === 'not-cached' ? 'no saved price' : line?.status === 'no-match' ? 'no match' : 'not found';
        row += pad(c(line?.status === 'not-cached' ? C.dim : C.red, why), colWidth);
        continue;
      }
      let cell = rupees(line.lineTotal);
      if (line.status === 'low-confidence') cell = c(C.yellow, cell + ' ?');
      else if (line.lineTotal === prices[0]) cell = c(C.green + C.bold, cell + ' ★');
      else if (line.lineTotal === prices[1]) cell = c(C.green, cell);
      if (line.history?.tag === 'new-low') cell += c(C.cyan, ' ↓');
      row += pad(cell, colWidth);
    }
    console.log(row);

    // Pack + per-unit line, so the arithmetic is visible rather than claimed.
    let sub = pad('', itemWidth);
    let anyUnit = false;
    for (const p of platforms) {
      const prod = p.lines.find((l) => l.query === item.query)?.product;
      const line = p.lines.find((l) => l.query === item.query);
      let detail = line?.cachedAt ? `${ddmmyy(line.cachedAt)} · ` : '';
      if (prod?.packLabel) {
        detail += prod.packs > 1 ? `${prod.packs}× ${prod.packLabel}` : prod.packLabel;
        if (prod.pricePerUnitLabel) detail += ` · ${prod.pricePerUnitLabel.replace('₹', '')}`;
        anyUnit = true;
      } else if (prod?.pricePerUnitLabel) {
        detail += prod.pricePerUnitLabel;
        anyUnit = true;
      }
      sub += pad(c(C.dim, truncate(detail, colWidth - 1)), colWidth);
    }
    if (anyUnit) console.log(sub);
  }

  console.log(c(C.dim, '─'.repeat(itemWidth + colWidth * platforms.length)));

  const subtotalRow =
    pad('Goods subtotal', itemWidth) +
    platforms.map((p) => pad(rupees(p.subtotal), colWidth)).join('');
  console.log(subtotalRow);

  const deliveryRow =
    pad('Delivery', itemWidth) +
    platforms
      .map((p) =>
        pad(
          !p.fees.known ? '—' : p.fees.freeDeliveryApplied ? c(C.green, 'FREE') : rupees(p.fees.deliveryFee),
          colWidth,
        ),
      )
      .join('');
  console.log(deliveryRow);

  const handlingRow =
    pad('Handling', itemWidth) +
    platforms.map((p) => pad(p.fees.known ? rupees(p.fees.handlingFee) : '—', colWidth)).join('');
  console.log(handlingRow);

  console.log(c(C.dim, '─'.repeat(itemWidth + colWidth * platforms.length)));

  const totalRow =
    pad(c(C.bold, 'BASKET TOTAL'), itemWidth) +
    platforms
      .map((p) => {
        const isWinner = result.winner?.platform === p.platform;
        const value = rupees(p.total);
        return pad(isWinner ? c(C.green + C.bold, value) : c(C.bold, value), colWidth);
      })
      .join('');
  console.log(totalRow);

  const fulfilledRow =
    pad(c(C.dim, 'items found'), itemWidth) +
    platforms
      .map((p) =>
        pad(
          c(p.complete ? C.dim : C.yellow, `${p.fulfilledLines}/${p.totalLines}`),
          colWidth,
        ),
      )
      .join('');
  console.log(fulfilledRow);
}

function renderVerdict(result) {
  console.log('');
  if (!result.winner) {
    console.log(c(C.red, '✖ No platform returned a usable basket.'));
    return;
  }

  const w = result.winner;
  const onSubset = !result.likeForLike && w.subsetTotal != null;
  const mine = onSubset ? w.subsetTotal : w.total;

  if (result.runnerUp && result.saving > 0) {
    const rival = onSubset ? result.runnerUp.subsetTotal : result.runnerUp.total;
    const what = onSubset ? ' on what everyone stocks' : '';
    console.log(
      c(C.green + C.bold, `✔ ${w.label} is cheapest${what} — ${rupees(mine)}`) +
        c(C.dim, `  vs ${result.runnerUp.label} ${rupees(rival)}`),
    );
    console.log(c(C.bold, `  You save ${c(C.green, rupees(result.saving))}.`));
  } else {
    console.log(c(C.green + C.bold, `✔ ${w.label} — ${rupees(mine)}`));
  }

  if (!result.likeForLike) {
    const ws = result.platforms.find((p) => p.platform === w.platform);
    console.log(
      c(C.yellow, `  ⚠ ${w.label} only stocked ${ws?.fulfilledLines}/${ws?.totalLines} of your basket.`),
    );
    if (result.comparedOn) {
      console.log(
        c(C.dim, `    Verdict compares ${result.comparedOn}; column totals cover different goods.`),
      );
    }
    if (result.coverageWarning) {
      const cw = result.coverageWarning;
      console.log(
        c(C.cyan, `  → Best coverage: `) +
          c(C.bold, `${cw.label} ${cw.fulfilledLines}/${cw.totalLines}`) +
          c(C.dim, ` at ${rupees(cw.total)} — one trip instead of two.`),
      );
      console.log(
        c(C.dim, `    Cheapest is only cheapest if you don't mind sourcing ${cw.winnerMissing} item${cw.winnerMissing === 1 ? '' : 's'} elsewhere.`),
      );
    }
  }
}

function renderCaveats(result) {
  const lowConf = result.platforms.flatMap((p) =>
    p.lowConfidence.map((l) => `${p.platform}: "${l.query}" → ${l.name} (${l.reason})`),
  );
  const missing = result.platforms.flatMap((p) =>
    p.missing.map((m) => `${p.platform}: "${m.query}" ${m.status}`),
  );

  if (lowConf.length > 0) {
    console.log('');
    console.log(c(C.yellow + C.bold, 'Flagged — matched below confidence threshold:'));
    for (const l of lowConf) console.log(c(C.yellow, `  ? ${l}`));
    console.log(c(C.dim, '  These are shown, not silently totalled.'));
  }

  if (missing.length > 0) {
    console.log('');
    console.log(c(C.red + C.bold, 'Excluded from totals:'));
    for (const m of missing) console.log(c(C.red, `  ✖ ${m}`));
  }

  const partial = result.platforms.flatMap((p) =>
    p.failed ? [] : (p.failures ?? []).map((f) => `${siteLabel(p.platform)}: "${f.query}": ${f.kind} — ${f.message}`),
  );
  if (partial.length > 0) {
    console.log('');
    console.log(c(C.yellow + C.bold, 'Some searches failed:'));
    for (const f of partial) console.log(c(C.yellow, `  ⚠ ${f}`));
  }

  if (result.unavailable.length > 0) {
    console.log('');
    console.log(c(C.red + C.bold, 'Platforms unavailable:'));
    for (const u of result.unavailable) {
      console.log(c(C.red, `  ✖ ${siteLabel(u.platform)}${u.errorKind ? ` [${u.errorKind}]` : ''}: ${u.error}`));
    }
  }
}

function renderLinks(result) {
  console.log('');
  console.log(c(C.bold, 'Buy it here:'));
  for (const p of result.platforms) {
    const firstUrl = p.lines.find((l) => l.product?.url)?.product.url;
    const mark = result.winner?.platform === p.platform ? c(C.green, '→') : ' ';
    console.log(`  ${mark} ${pad(p.platform, 12)} ${c(C.cyan, firstUrl ?? '—')}`);
  }
}

function renderFooter(result) {
  console.log('');
  console.log(
    c(
      C.dim,
      `pincode ${result.pincode} · ${(result.elapsedMs / 1000).toFixed(1)}s · ` +
        `confidence threshold ${result.confidenceThreshold}`,
    ),
  );
  if (!result.feesKnown) {
    const missing = (result.feesMissing || []).join(', ');
    console.log(
      c(C.yellow, '⚠ Goods only — delivery and handling are NOT included') +
        (missing ? c(C.dim, ` (no fees set for ${missing})`) : ''),
    );
    console.log(c(C.dim, '  Set them once:  basket fees --set blinkit --delivery 25 --handling 9'));
  }
}

function usage() {
  console.log(`
Basket — grocery price comparison across Indian quick-commerce platforms

  basket <list.txt> [options]      compare a basket
  basket "amul butter 500g"        compare a one-line basket
  cat list.txt | basket            read the basket from stdin

Commands
  search "<query>"      Price one item across platforms
  serve                 Run the service: web UI + API + daily scheduler
                        (--port=7777 --host=127.0.0.1 --open)
  run-now [--sites=a,b] Queue the configured basket on the running service
                        (runs locally if no service answers)
  history "<item>"      Lowest price seen per site, with the date
  fees                  Show / set delivery and handling charges
  setup, doctor         Legacy webcmd helpers (only for BASKET_BACKEND=webcmd)

Config (location, sites, schedules, basket) lives in ${join(DATA_DIR, 'config.json')}
and is editable at http://localhost:7777/settings while the service runs.

Fees are NOT read automatically — platforms only reveal them at checkout.
Totals are goods-only until you set them:
  basket fees --set blinkit --delivery 25 --handling 9 --free-above 199

Exit codes: 0 ok · 1 runtime error · 2 usage error · 3 nothing found

Options
  --web                 Serve the interactive web view and print its URL,
                        then stay running (Ctrl+C to stop)
  --ui                  Rich boxed terminal view
  --cached              Saved prices only (last record per item and site, dated);
                        no site is contacted. Drop the flag to fetch fresh prices.
  --json                Machine-readable output, nothing else
  --platforms=a,b,c     Which platforms to hit (default: ${PLATFORMS.join(',')})
                        Available: ${ALL_PLATFORMS.join(', ')}
  --pincode=600045      Displayed pincode (the location comes from config.json)
  --port=7777           Port for --web / serve
  --no-open             Don't launch a browser with --web
  -h, --help            This text

Examples
  basket basket.txt --ui
  basket basket.txt --web
  basket search "amul butter 500g" --json
  basket "tata salt 1kg" --platforms=instamart,bigbasket,zepto
  basket serve
  basket run-now --sites=instamart,bigbasket
  basket history "toor dal 1kg"
`);
}

/** Print the web-view banner. Last thing on screen, so it's easy to click. */
function printWebBanner(url, opened) {
  console.log('');
  console.log(`  ${c(C.green, '●')} ${c(C.bold, 'Web view')}  ${c(C.cyan, url)}`);
  console.log(
    c(C.dim, `    ${opened ? 'Opened in your browser. ' : ''}Edit the basket there and press Compare.`),
  );
  console.log(c(C.dim, '    Ctrl+C to stop the server.'));
  console.log('');
}

/** Keep the process alive until Ctrl+C, then shut the server down cleanly. */
function holdUntilInterrupt(server) {
  return new Promise((resolve) => {
    const stop = async () => {
      console.log(c(C.dim, '\n  stopping…'));
      await server.close();
      resolve();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('-h') || args.includes('--help')) {
    usage();
    return;
  }

  const jsonOnly = args.includes('--json');
  // --web implies the rich view: you asked for the pretty surface.
  const wantWeb = args.includes('--web') || args.includes('--open');
  const wantTui = args.includes('--ui') || wantWeb;
  const noOpen = args.includes('--no-open');
  const positional = args.filter((a) => !a.startsWith('-'));

  const portArg = args.find((a) => a.startsWith('--port='));
  const port = portArg ? Number(portArg.split('=')[1]) : undefined;

  const pincodeArg = args.find((a) => a.startsWith('--pincode='));
  const cfg = loadConfig();
  const pincode = pincodeArg ? pincodeArg.split('=')[1] : cfg.location?.pincode || DEFAULT_PINCODE;

  const platArg = args.find((a) => a.startsWith('--platforms='));
  let platforms;
  if (platArg) {
    platforms = platArg.split('=')[1].split(',').map((s) => s.trim()).filter(Boolean);
    const unknown = platforms.filter((p) => !ALL_PLATFORMS.includes(p));
    if (unknown.length > 0) {
      console.error(
        c(C.red, `✖ Unknown platform(s): ${unknown.join(', ')}`) +
          `\n  Available: ${ALL_PLATFORMS.join(', ')}`,
      );
      process.exit(2);
    }
  }

  // A positional is a file if it exists on disk, otherwise it's the basket
  // itself — `basket "tata salt 1kg"` should just work.
  let text;
  if (positional.length > 0) {
    text = existsSync(positional[0]) ? readFileSync(positional[0], 'utf8') : positional.join('\n');
  } else if (!process.stdin.isTTY) {
    text = await readStdin();
  } else {
    usage();
    process.exit(2);
  }

  if (!jsonOnly) {
    console.log('');
    console.log(c(C.bold, `Comparing basket at ${cfg.location?.label ? `${cfg.location.label}, ` : ''}${pincode}…`));
    console.log('');
  }

  // --cached: history-first, from stored prices only; no site is contacted.
  const cachedOnly = args.includes('--cached');
  const store = cachedOnly ? openStore(join(DATA_DIR, 'basket.db')) : null;
  let result;
  try {
    result = await compareBasket({
      items: text,
      pincode,
      platforms,
      cached: cachedOnly,
      store,
      onProgress: jsonOnly || cachedOnly ? undefined : progressPrinter(),
    });
  } finally {
    store?.close();
  }

  if (process.stdout.isTTY && !jsonOnly) process.stdout.write('\r\x1b[2K');

  if (cachedOnly && !jsonOnly) {
    const r = result.cachedRange;
    console.log(c(C.yellow, r
      ? `  Saved prices from ${ddmmyy(r.oldest)}${ddmmyy(r.oldest) !== ddmmyy(r.newest) ? ` – ${ddmmyy(r.newest)}` : ''} — no site was contacted. Run again without --cached for fresh prices.`
      : '  No saved prices for this list yet. Run again without --cached to fetch them.'));
    console.log('');
  }

  // Persist regardless of surface: a browser tab left open picks this up on
  // its next poll, so the terminal and the web view never disagree.
  // (A history-only view is not a new observation, so it isn't saved.)
  if (!cachedOnly) saveResult(result);

  if (jsonOnly) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (wantTui) {
    console.log(renderTui(result));
  } else {
    renderTable(result);
    renderVerdict(result);
    renderCaveats(result);
    renderLinks(result);
    renderFooter(result);
    console.log('');
  }

  if (wantWeb) {
    const server = await startServer({ port });
    if (!noOpen) openInBrowser(server.url);
    printWebBanner(server.url, !noOpen);
    await holdUntilInterrupt(server);
  }
}

/** Exit codes, so an agent can branch without parsing prose. */
const EXIT = { OK: 0, RUNTIME: 1, USAGE: 2, NO_RESULTS: 3 };

/** One JSON shape for every machine-readable response, success or failure. */
function emitJson(payload, exitCode = EXIT.OK) {
  console.log(JSON.stringify(payload, null, 2));
  process.exitCode = exitCode;
}

function flagValue(args, name) {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.split('=').slice(1).join('=');
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
  return undefined;
}

async function feesCommand(args) {
  const asJson = args.includes('--json');
  const setTarget = flagValue(args, 'set');
  const clearTarget = args.includes('--clear') ? flagValue(args, 'clear') ?? null : undefined;

  if (clearTarget !== undefined) {
    clearFees(clearTarget || undefined);
    const msg = clearTarget ? `Cleared fees for ${clearTarget}.` : 'Cleared all fees.';
    if (asJson) return emitJson({ ok: true, action: 'clear', platform: clearTarget || null });
    console.log(`  ${c(C.green, '✔')} ${msg}`);
    return;
  }

  if (setTarget) {
    if (!ALL_PLATFORMS.includes(setTarget)) {
      const err = `Unknown platform "${setTarget}". Available: ${ALL_PLATFORMS.join(', ')}`;
      if (asJson) return emitJson({ ok: false, error: err }, EXIT.USAGE);
      console.error(c(C.red, `✖ ${err}`));
      process.exitCode = EXIT.USAGE;
      return;
    }
    const delivery = flagValue(args, 'delivery');
    const handling = flagValue(args, 'handling');
    const freeAbove = flagValue(args, 'free-above');
    if (delivery == null && handling == null && freeAbove == null) {
      const err = 'Give at least one of --delivery, --handling, --free-above.';
      if (asJson) return emitJson({ ok: false, error: err }, EXIT.USAGE);
      console.error(c(C.red, `✖ ${err}`));
      process.exitCode = EXIT.USAGE;
      return;
    }
    const saved = saveFees(setTarget, {
      deliveryFee: delivery != null ? Number(delivery) : undefined,
      handlingFee: handling != null ? Number(handling) : undefined,
      freeDeliveryAbove: freeAbove != null ? Number(freeAbove) : undefined,
    });
    if (asJson) return emitJson({ ok: true, action: 'set', platform: setTarget, fees: saved });
    console.log(`  ${c(C.green, '✔')} ${setTarget}: ${JSON.stringify(saved)}`);
    return;
  }

  // Show
  const cfg = loadFees();
  if (asJson) {
    return emitJson({
      ok: true,
      file: FEES_FILE,
      configured: cfg,
      missing: ALL_PLATFORMS.filter((p) => !cfg[p]),
    });
  }

  console.log(`\n${c(C.bold, 'Platform fees')}  ${c(C.dim, FEES_FILE)}\n`);
  console.log(c(C.dim, '  Fees are only shown at checkout, so they cannot be read automatically.'));
  console.log(c(C.dim, '  Anything not set here is left out of totals rather than guessed.\n'));
  for (const p of ALL_PLATFORMS) {
    const f = cfg[p];
    if (!f) {
      console.log(`  ${c(C.yellow, '—')} ${pad(p, 12)} ${c(C.dim, 'not set')}`);
      continue;
    }
    const bits = [
      f.deliveryFee != null ? `delivery ${rupees(f.deliveryFee)}` : null,
      f.handlingFee != null ? `handling ${rupees(f.handlingFee)}` : null,
      f.freeDeliveryAbove != null ? `free above ${rupees(f.freeDeliveryAbove)}` : null,
    ].filter(Boolean).join(' · ');
    console.log(`  ${c(C.green, '✔')} ${pad(p, 12)} ${bits}${f.updatedAt ? c(C.dim, `  (${f.updatedAt})`) : ''}`);
  }
  console.log(c(C.dim, '\n  Set one:  basket fees --set blinkit --delivery 25 --handling 9 --free-above 199'));
  console.log(c(C.dim, '  Clear:    basket fees --clear blinkit\n'));
}

async function searchCommand(args) {
  const asJson = args.includes('--json');
  const positional = args.filter((a) => !a.startsWith('-'));
  const query = positional.slice(1).join(' ').trim();

  if (!query) {
    const err = 'Usage: basket search "<query>" [--platforms=a,b] [--json]';
    if (asJson) return emitJson({ ok: false, error: err }, EXIT.USAGE);
    console.error(c(C.red, `✖ ${err}`));
    process.exitCode = EXIT.USAGE;
    return;
  }

  const platArg = args.find((a) => a.startsWith('--platforms='));
  const platforms = platArg
    ? platArg.split('=')[1].split(',').map((s) => s.trim()).filter(Boolean)
    : undefined;

  // A one-line basket is exactly a single-item search.
  const result = await compareBasket({ items: query, platforms });
  saveResult(result);

  // A platform whose only query failed lands in `unavailable`, not `platforms`.
  // Both have to appear, and be told apart: "nobody stocks this" and "that
  // scrape broke" want completely different next moves from a caller.
  const rows = [
    ...result.platforms.map((p) => {
      const line = p.lines[0];
      return {
        platform: p.platform,
        found: line?.lineTotal != null,
        // Below the threshold the matcher refused this candidate. It is shown
        // so the user can judge it, never treated as an answer.
        confident: line?.status === 'ok',
        price: line?.product?.price ?? null,
        name: line?.product?.name ?? null,
        pack: line?.product?.packLabel ?? null,
        pricePerUnit: line?.product?.pricePerUnitLabel ?? null,
        confidence: line?.product?.confidence ?? null,
        confidenceReason: line?.product?.confidenceReason ?? null,
        url: line?.product?.url ?? null,
        error: null,
      };
    }),
    ...result.unavailable.map((u) => ({
      platform: u.platform,
      found: false,
      confident: false,
      price: null,
      name: null,
      pack: null,
      pricePerUnit: null,
      confidence: null,
      confidenceReason: null,
      url: null,
      error: u.error,
    })),
  ];
  const cheapest =
    rows.filter((r) => r.found && r.confident).sort((a, b) => a.price - b.price)[0] ?? null;

  if (asJson) {
    return emitJson(
      { ok: true, query, cheapest, results: rows, feesKnown: result.feesKnown },
      cheapest ? EXIT.OK : EXIT.NO_RESULTS,
    );
  }

  console.log('');
  console.log(c(C.bold, `  ${query}`));
  console.log('');
  for (const r of rows) {
    if (!r.found) {
      const why = r.error ? truncate(r.error, 48) : 'not found';
      console.log(`  ${c(C.red, '✖')} ${pad(r.platform, 12)} ${c(C.dim, why)}`);
      continue;
    }
    const mark = r.confident ? c(C.green, '✔') : c(C.yellow, '?');
    console.log(
      `  ${mark} ${pad(r.platform, 12)} ${pad(rupees(r.price), 12)}` +
        c(C.dim, `${r.pack ?? ''}  ${r.pricePerUnit ?? ''}`),
    );
    console.log(`    ${c(C.dim, truncate(r.name, 60))}`);
    if (!r.confident) {
      console.log(
        `    ${c(C.yellow, `below confidence threshold${r.confidenceReason ? ` — ${r.confidenceReason}` : ''}`)}`,
      );
    }
  }
  if (cheapest) {
    console.log('');
    console.log(c(C.green + C.bold, `  Cheapest: ${cheapest.platform} at ${rupees(cheapest.price)}`));
  } else {
    console.log('');
    console.log(
      c(C.yellow, rows.some((r) => r.found)
        ? '  No confident match — the results above are not this product.'
        : '  Not found on any platform.'),
    );
    process.exitCode = EXIT.NO_RESULTS;
  }
  console.log('');
}

async function serveOnly(args) {
  const portArg = args.find((a) => a.startsWith('--port='));
  const port = portArg ? Number(portArg.split('=')[1]) : undefined;
  const hostArg = args.find((a) => a.startsWith('--host='));
  const host = hostArg ? hostArg.split('=')[1] : undefined;
  const open = args.includes('--open');

  const service = await startService({ port, host });
  if (open) openInBrowser(service.server.url);
  console.log('');
  console.log(`  ${c(C.green, '●')} ${c(C.bold, 'Basket service')}  ${c(C.cyan, service.server.url)}   settings: ${c(C.cyan, service.server.url + '/settings')}`);
  console.log(c(C.dim, `    Scheduled runs + history in ${DATA_DIR}. Results: ${service.resultsDir}. Ctrl+C to stop.`));
  console.log('');
  await new Promise((resolve) => {
    const stop = async () => {
      console.log(c(C.dim, '\n  stopping…'));
      await service.close();
      resolve();
      process.exit(0);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

/** Queue the configured basket on a running service, or run it here if none answers. */
async function runNowCommand(args) {
  const cfg = loadConfig();
  const sitesArg = flagValue(args, 'sites');
  const sites = sitesArg ? sitesArg.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  const base = flagValue(args, 'url') || process.env.BASKET_URL || `http://127.0.0.1:${process.env.BASKET_PORT || cfg.server?.port || 7777}`;
  try {
    const res = await fetch(`${base}/api/compare`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: cfg.basket, platforms: sites }),
      signal: AbortSignal.timeout(5000),
    });
    const body = await res.json();
    if (res.status !== 202) throw new Error(body.error || `HTTP ${res.status}`);
    console.log(`  queued job ${body.jobId} on ${base} — watch it at ${base}/`);
    return;
  } catch (err) {
    if (!/fetch failed|ECONNREFUSED|timeout/i.test(String(err.message) + String(err.cause?.code))) throw err;
    console.log(c(C.dim, `  no service at ${base}; running here instead`));
  }
  const store = openStore(join(DATA_DIR, 'basket.db'));
  try {
    const result = await compareBasket({ items: cfg.basket, platforms: sites, onProgress: progressPrinter() });
    if (process.stdout.isTTY) process.stdout.write('\r\x1b[2K');
    store.annotate(result);
    store.recordResult(result, { trigger: 'manual' });
    saveResult(result);
    console.log(renderTui(result));
  } finally {
    store.close();
  }
}

/** Lowest price seen per site for one item. */
function historyCommand(args) {
  const query = args.filter((a) => !a.startsWith('-')).slice(1).join(' ').trim();
  if (!query) {
    console.error(c(C.red, '✖ Usage: basket history "<item>" [--json]'));
    process.exitCode = EXIT.USAGE;
    return;
  }
  const store = openStore(join(DATA_DIR, 'basket.db'));
  try {
    const h = store.historyFor(query);
    if (args.includes('--json')) return emitJson({ ok: true, query, sites: h });
    const rows = Object.entries(h).sort((a, b) => a[1].lowUnitPrice - b[1].lowUnitPrice);
    console.log('');
    console.log(c(C.bold, `  ${query} — lowest seen`));
    if (rows.length === 0) console.log(c(C.dim, '  no history yet'));
    for (const [site, v] of rows) {
      console.log(
        `  ${pad(siteLabel(site), 14)} ${pad(`${rupees(v.lowUnitPrice)}/${v.unit}`, 16)}` +
          c(C.dim, `${v.seenAt.slice(0, 16).replace('T', ' ')}  ${truncate(v.product, 40)} ${v.pack ?? ''}  · last ${rupees(v.lastUnitPrice)}/${v.unit}`),
      );
    }
    console.log('');
  } finally {
    store.close();
  }
}

async function dispatch() {
  const args = process.argv.slice(2);
  const first = args.find((a) => !a.startsWith('-'));

  switch (first) {
    case 'setup':
      // Interactive by definition — refuse rather than hang in a pipeline.
      if (!process.stdin.isTTY) {
        console.error(c(C.red, '✖ basket setup needs an interactive terminal.'));
        console.error(c(C.dim, '  Run basket doctor for a non-interactive check.'));
        process.exitCode = EXIT.USAGE;
        return;
      }
      process.exitCode = (await setup()) ? EXIT.OK : EXIT.RUNTIME;
      return;
    case 'doctor': {
      const healthy = await doctor({ quiet: args.includes('--json') });
      if (args.includes('--json')) emitJson({ ok: healthy }, healthy ? EXIT.OK : EXIT.RUNTIME);
      else process.exitCode = healthy ? EXIT.OK : EXIT.RUNTIME;
      return;
    }
    case 'fees':
      await feesCommand(args);
      return;
    case 'search':
      await searchCommand(args);
      return;
    case 'serve':
      await serveOnly(args);
      return;
    case 'run-now':
      await runNowCommand(args);
      return;
    case 'history':
      historyCommand(args);
      return;
    default:
      await main();
  }
}

/** One-shot commands own the warm Chrome only for their run: close it so the process exits. */
async function closeEngine() {
  const { peekPool } = await import('./engine/pool.js');
  await peekPool()?.close().catch(() => {});
}

dispatch()
  .then(closeEngine)
  .catch(async (err) => {
    await closeEngine();
    throw err;
  })
  .catch((err) => {
  // Structured errors when a machine is reading, prose when a human is.
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ ok: false, error: err.message }, null, 2));
  } else {
    console.error(c(C.red, `\n✖ ${err.message}`));
  }
  process.exit(EXIT.RUNTIME);
});
