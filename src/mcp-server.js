#!/usr/bin/env node
/**
 * Basket MCP server (stdio).
 *
 * Wraps compareBasket() — the same function the CLI calls — so any MCP client
 * gets identical numbers. Four coarse tools rather than a thin mirror of the
 * library: agents do better with few, task-shaped tools.
 *
 * Register with:
 *   claude mcp add basket -- node <abs path>/src/mcp-server.js
 */

import './env.js';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { compareBasket, DEFAULT_PINCODE } from './compare.js';
import { PLATFORMS, ALL_PLATFORMS } from './platforms.js';
import { FEES } from './fees.js';
import { saveResult, openInBrowser } from './ui-writer.js';
import { startServer } from './server.js';

/** The MCP process is long-lived, so it can host the web view itself. */
let webServer = null;
async function ensureServer() {
  if (!webServer) webServer = await startServer({});
  return webServer;
}

/** Last result, so open_basket_view and open_platform need no re-run. */
let lastResult = null;

function rupees(n) {
  return `₹${Number(n).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Render the comparison as a markdown table — what the model reads back. */
function toMarkdown(r) {
  const lines = [];
  lines.push(`**Basket comparison — pincode ${r.pincode}** (${(r.elapsedMs / 1000).toFixed(1)}s)`);
  lines.push('');

  const header = ['Item', ...r.platforms.map((p) => FEES[p.platform]?.label ?? p.platform)];
  lines.push(`| ${header.join(' | ')} |`);
  lines.push(`|${header.map(() => '---').join('|')}|`);

  for (const item of r.basket) {
    const label = item.qty > 1 ? `${item.qty}× ${item.query}` : item.query;
    const cells = r.platforms.map((p) => {
      const line = p.lines.find((l) => l.query === item.query);
      if (!line || line.lineTotal == null) return '—';
      const prod = line.product;
      const packs = prod.packs > 1 ? `${prod.packs}× ` : '';
      const detail = prod.packLabel ? ` <br><sub>${packs}${prod.packLabel}</sub>` : '';
      const flag = line.status === 'low-confidence' ? ' ⚠️' : '';
      return `${rupees(line.lineTotal)}${flag}${detail}`;
    });
    lines.push(`| ${label} | ${cells.join(' | ')} |`);
  }

  lines.push(
    `| **Fees** | ${r.platforms
      .map((p) => (!p.fees.known
        ? 'not set'
        : `${p.fees.freeDeliveryApplied ? 'free delivery' : rupees(p.fees.deliveryFee)} + ${rupees(p.fees.handlingFee)}`))
      .join(' | ')} |`,
  );
  lines.push(
    `| **${r.feesKnown ? 'TOTAL' : 'GOODS TOTAL'}** | ${r.platforms.map((p) => `**${rupees(p.total)}**`).join(' | ')} |`,
  );
  lines.push(
    `| items found | ${r.platforms.map((p) => `${p.fulfilledLines}/${p.totalLines}`).join(' | ')} |`,
  );
  lines.push('');

  if (r.winner) {
    const onSubset = !r.likeForLike && r.winner.subsetTotal != null;
    const mine = onSubset ? r.winner.subsetTotal : r.winner.total;
    if (r.runnerUp && r.saving > 0) {
      const what = onSubset ? ' on what every platform stocks' : '';
      lines.push(
        `### ${r.winner.label} wins${what} — ${rupees(mine)}, saving ${rupees(r.saving)} vs ${r.runnerUp.label}`,
      );
    } else {
      lines.push(`### ${r.winner.label} — ${rupees(mine)}`);
    }
  } else {
    lines.push('### No platform returned a usable basket.');
  }

  if (!r.likeForLike) {
    const ws = r.platforms.find((p) => p.platform === r.winner?.platform);
    lines.push('');
    lines.push(
      `> ⚠️ **${r.winner?.label} only stocked ${ws?.fulfilledLines}/${ws?.totalLines} of the basket.**`,
    );
    if (r.comparedOn) {
      lines.push(`> The verdict compares **${r.comparedOn}**; the column totals cover different goods.`);
    }
    if (r.coverageWarning) {
      const cw = r.coverageWarning;
      lines.push('>');
      lines.push(
        `> **Best coverage: ${cw.label} — ${cw.fulfilledLines}/${cw.totalLines} at ${rupees(cw.total)}**, one trip instead of two. ` +
          `The cheaper basket leaves ${cw.winnerMissing} item(s) to source elsewhere.`,
      );
    }
  }

  const lowConf = r.platforms.flatMap((p) =>
    p.lowConfidence.map((l) => `- ${p.platform}: "${l.query}" → ${l.name} (${l.reason})`),
  );
  if (lowConf.length > 0) {
    lines.push('');
    lines.push('**Flagged below confidence threshold** (shown, not silently totalled):');
    lines.push(...lowConf);
  }

  const missing = r.platforms.flatMap((p) =>
    p.missing.map((m) => `- ${p.platform}: "${m.query}" ${m.status}`),
  );
  if (missing.length > 0) {
    lines.push('');
    lines.push('**Excluded from totals:**');
    lines.push(...missing);
  }

  lines.push('');
  if (!r.feesKnown) {
    lines.push(
      `> ⚠️ **Totals are goods only — delivery and handling are NOT included.** ` +
        `Platforms only reveal fees at checkout, so they can't be read here. ` +
        (r.feesMissing?.length ? `No fees set for: ${r.feesMissing.join(', ')}. ` : '') +
        'Set them with `jhola fees --set <platform> --delivery N --handling N`.',
    );
    lines.push('');
  }
  lines.push(`_Backend: ${r.backend}. Confidence threshold ${r.confidenceThreshold}._`);
  lines.push('');
  lines.push('👉 Call `open_basket_view` to see this as an interactive page, or `open_platform` to go buy it.');
  return lines.join('\n');
}

const server = new Server(
  { name: 'jhola', version: '1.2.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'compare_basket',
      description:
        'Compare a grocery basket across the top Indian quick-commerce sites at the configured delivery address. ' +
        'Normalizes pack sizes to price-per-unit, ' +
        'refuses to compare products it is not confident are the same item, and names the ' +
        'cheapest platform with the rupee saving. Call this when the user gives a shopping ' +
        'list or asks where groceries are cheapest. ' +
        'Totals are GOODS ONLY unless the user has configured delivery/handling via ' +
        '`jhola fees --set` — the response says which, and you must repeat that caveat ' +
        'rather than presenting a goods-only total as a final bill. ' +
        'A full basket takes 30s–5min because it drives a real browser; do not call it ' +
        'for a single product — use search_product for that.',
      inputSchema: {
        type: 'object',
        properties: {
          items: {
            type: 'string',
            description:
              'The basket, one item per line. Optional leading quantity ("2x amul milk 500ml").',
          },
          pincode: {
            type: 'string',
            description: `Delhi pincode. Defaults to ${DEFAULT_PINCODE} (whatever the browser profile has set).`,
          },
          platforms: {
            type: 'array',
            items: { type: 'string', enum: ALL_PLATFORMS },
            description:
              `Which platforms to check. Defaults to ${PLATFORMS.join(', ')}. ` +
              'Include "amazon" (Amazon Now) only when the user asks for it — its ' +
              'quick-commerce catalogue is thin and adds mostly empty columns.',
          },
        },
        required: ['items'],
      },
    },
    {
      name: 'search_product',
      description:
        'Price one product across platforms and return the cheapest. Same matching and ' +
        'pack-normalization as compare_basket, but for a single query — use it for ' +
        '"how much is X", "where is X cheapest", or to check one item before building a ' +
        'basket. Much faster than compare_basket. Returns per-platform price, pack size, ' +
        'price-per-unit, match confidence and a product URL.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'One product, as a shopper would type it — "amul butter 500g".',
          },
          platforms: {
            type: 'array',
            items: { type: 'string', enum: ALL_PLATFORMS },
            description: `Which platforms to check. Defaults to ${PLATFORMS.join(', ')}.`,
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'open_basket_view',
      description:
        'Open the interactive comparison view in the browser and return its URL. ' +
        'The page shows the latest comparison with per-item confidence badges, pack ' +
        'maths and the winner, and has its own basket editor so the user can re-run ' +
        'without coming back here. Call after compare_basket, or on its own when the ' +
        'user asks for a visual/web view.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'open_platform',
      description:
        'Return (and open) the buy link for a platform from the last comparison. ' +
        'Defaults to the winning platform.',
      inputSchema: {
        type: 'object',
        properties: {
          platform: {
            type: 'string',
            enum: PLATFORMS,
            description: 'Which platform to open. Defaults to the cheapest.',
          },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;

  try {
    if (name === 'compare_basket') {
      if (!args.items || !String(args.items).trim()) {
        return { content: [{ type: 'text', text: 'No items given. Provide a basket, one item per line.' }], isError: true };
      }
      lastResult = await compareBasket({
        items: String(args.items),
        pincode: args.pincode || DEFAULT_PINCODE,
        platforms: Array.isArray(args.platforms) && args.platforms.length > 0
          ? args.platforms
          : undefined,
      });
      // Persist so any open web view picks it up on its next poll.
      saveResult(lastResult);
      return {
        content: [
          { type: 'text', text: toMarkdown(lastResult) },
          {
            type: 'text',
            text:
              '```json\n' +
              JSON.stringify(
                {
                  winner: lastResult.winner,
                  saving: lastResult.saving,
                  likeForLike: lastResult.likeForLike,
                  comparedOn: lastResult.comparedOn,
                  // Whether these totals include delivery/handling at all.
                  totalsInclude: lastResult.feesKnown ? 'goods + fees' : 'goods only',
                  feesKnown: lastResult.feesKnown,
                  feesMissing: lastResult.feesMissing,
                  totals: lastResult.platforms.map((p) => ({
                    platform: p.platform,
                    total: p.total,
                    fulfilled: `${p.fulfilledLines}/${p.totalLines}`,
                  })),
                },
                null,
                2,
              ) +
              '\n```',
          },
        ],
      };
    }

    if (name === 'search_product') {
      const query = String(args.query ?? '').trim();
      if (!query) {
        return {
          content: [{ type: 'text', text: 'No query given. Provide one product, e.g. "amul butter 500g".' }],
          isError: true,
        };
      }
      // A one-line basket is exactly a single-product search — same code path,
      // so a price here can never disagree with the same price in a basket.
      const r = await compareBasket({
        items: query,
        platforms: Array.isArray(args.platforms) && args.platforms.length > 0 ? args.platforms : undefined,
      });

      // Platforms whose search failed live in `unavailable`, not `platforms` —
      // report them as errored, not as "this product isn't stocked there".
      const rows = [
        ...r.platforms.map((p) => {
          const line = p.lines[0];
          return {
            platform: p.platform,
            label: FEES[p.platform]?.label ?? p.platform,
            found: line?.lineTotal != null,
            // Below threshold the matcher refused it — shown, never an answer.
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
        ...r.unavailable.map((u) => ({
          platform: u.platform,
          label: FEES[u.platform]?.label ?? u.platform,
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
        rows.filter((x) => x.found && x.confident).sort((a, b) => a.price - b.price)[0] ?? null;

      const md = [`**${query}** — pincode ${r.pincode}`, ''];
      md.push('| Platform | Price | Pack | Per unit | Confidence |');
      md.push('|---|---|---|---|---|');
      for (const x of rows) {
        if (!x.found) {
          md.push(`| ${x.label} | ${x.error ? 'search failed' : 'not found'} | — | — | — |`);
          continue;
        }
        const flag = x.confident ? '' : ' ⚠️';
        md.push(
          `| ${x.label} | ${rupees(x.price)}${flag} | ${x.pack ?? '—'} | ${x.pricePerUnit ?? '—'} | ${x.confidence?.toFixed(2) ?? '—'} |`,
        );
      }
      md.push('');
      if (cheapest) {
        md.push(`### Cheapest: ${cheapest.label} — ${rupees(cheapest.price)}\n${cheapest.name}\n${cheapest.url ?? ''}`);
      } else if (rows.some((x) => x.found)) {
        md.push(
          '### No confident match.\nThe rows above scored below the confidence threshold — ' +
            'they are a different product. Do not report them as this item\'s price.',
        );
      } else {
        md.push('### Not found on any platform.');
      }
      md.push('');
      md.push('_Prices are for the goods only; delivery and handling are not included._');

      return {
        content: [
          { type: 'text', text: md.join('\n') },
          { type: 'text', text: '```json\n' + JSON.stringify({ query, cheapest, results: rows }, null, 2) + '\n```' },
        ],
      };
    }

    if (name === 'open_basket_view') {
      // Works with no prior comparison: the page has its own basket editor,
      // so opening it empty is a useful thing to do.
      if (lastResult) saveResult(lastResult);
      const server = await ensureServer();
      openInBrowser(server.url);
      return {
        content: [
          {
            type: 'text',
            text:
              `Interactive basket view: ${server.url}\n\n` +
              (lastResult
                ? `Showing: ${lastResult.winner?.label ?? 'no winner'} at ` +
                  `${lastResult.winner ? rupees(lastResult.winner.total) : '—'}` +
                  (lastResult.saving ? `, saving ${rupees(lastResult.saving)}.` : '.') +
                  '\nYou can edit the basket there and re-run without coming back here.'
                : 'No comparison yet — paste a basket into the page and press Compare.'),
          },
        ],
      };
    }

    if (name === 'open_platform') {
      if (!lastResult) {
        return {
          content: [{ type: 'text', text: 'No comparison yet — run compare_basket first.' }],
          isError: true,
        };
      }
      const target = args.platform || lastResult.winner?.platform;
      const score = lastResult.platforms.find((p) => p.platform === target);
      const url = score?.lines.find((l) => l.product?.url)?.product.url;
      if (!url) {
        return { content: [{ type: 'text', text: `No link available for ${target}.` }], isError: true };
      }
      openInBrowser(url);
      return {
        content: [
          { type: 'text', text: `Opening ${FEES[target]?.label ?? target} — ${rupees(score.total)}\n${url}` },
        ],
      };
    }

    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  } catch (err) {
    return { content: [{ type: 'text', text: `Failed: ${err.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('Jhola MCP server ready (stdio)');
