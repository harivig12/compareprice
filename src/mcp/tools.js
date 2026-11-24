/**
 * Basket MCP tools: a thin client of the running basket service.
 *
 * The MCP process holds no engine, browser or database of its own. Every
 * answer comes from the service's HTTP API (docs/API.md), so the chatbot sees
 * the same saved prices, the same per-site limits and the same compareBasket()
 * totals as the web page. Live searches go through the service's job queue and
 * its request budget, never around them.
 *
 * Sign-in is deliberately not a tool: OTPs are typed into the web popup, not
 * passed through a chat transcript.
 */

import { ALL_PLATFORMS } from '../platforms.js';

export const DEFAULT_URL = 'http://127.0.0.1:7777';
const POLL_MS = 3000;
const DEFAULT_WAIT_S = 180;
const MAX_WAIT_S = 600;

/** The service could not be reached at all (not running, wrong URL). */
export class ServiceDownError extends Error {
  constructor(baseUrl, cause) {
    super(
      `The Jhola service isn't reachable at ${baseUrl} (${cause?.cause?.code ?? cause?.code ?? cause?.message ?? 'no answer'}). ` +
        'Start it with `docker start jhola` (or `jhola serve`), or set JHOLA_URL to where it runs.',
    );
    this.name = 'ServiceDownError';
  }
}

/**
 * @param {object} [opts]
 * @param {string} [opts.baseUrl]   default $JHOLA_URL, $BASKET_URL or http://127.0.0.1:7777
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {number} [opts.timeoutMs] per request
 */
export function makeClient({ baseUrl = process.env.JHOLA_URL || process.env.BASKET_URL || DEFAULT_URL, fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  const base = baseUrl.replace(/\/+$/, '');
  async function request(method, path, body) {
    let res;
    try {
      res = await fetchImpl(base + path, {
        method,
        headers: body ? { 'content-type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new ServiceDownError(base, err);
    }
    const text = res.status === 204 ? '' : await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { error: text.slice(0, 200) };
    }
    return { status: res.status, data };
  }
  return {
    baseUrl: base,
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body ?? {}),
  };
}

// ---------------------------------------------------------------- formatting

const rupees = (n) =>
  n == null ? '—' : `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const arrow = (change) => (change === 'down' ? ' ▼' : change === 'up' ? ' ▲' : '');
const pct = (p) => (p == null ? '' : ` (${p > 0 ? '+' : ''}${p}%)`);
const day = (iso) => (iso ? String(iso).slice(0, 10) : '—');

const text = (t) => ({ type: 'text', text: t });
const jsonBlock = (obj) => text('```json\n' + JSON.stringify(obj, null, 2) + '\n```');
const fail = (msg) => ({ content: [text(msg)], isError: true });

/** One basket result (live or saved) as a markdown table the model can read back. */
export function resultMarkdown(r) {
  const lines = [];
  const saved = r.source === 'history';
  const range = r.cachedRange ? ` (saved ${day(r.cachedRange.oldest)} → ${day(r.cachedRange.newest)})` : '';
  lines.push(`**${saved ? 'Saved prices' : 'Live prices'} — pincode ${r.pincode}**${saved ? range : ` (${(r.elapsedMs / 1000).toFixed(1)}s)`}`);
  lines.push('');

  const cols = r.platforms ?? [];
  const header = ['Item', ...cols.map((p) => p.label ?? p.platform)];
  lines.push(`| ${header.join(' | ')} |`);
  lines.push(`|${header.map(() => '---').join('|')}|`);
  for (const item of r.basket ?? []) {
    const label = item.qty > 1 ? `${item.qty}× ${item.query}` : item.query;
    const cells = cols.map((p) => {
      if (p.failed) return 'error';
      const line = p.lines?.find((l) => l.query === item.query);
      if (!line) return '—';
      if (line.status === 'not-cached') return 'not saved yet';
      if (line.lineTotal == null) return line.status === 'bigger-pack' ? 'only bigger pack' : 'not found';
      const prod = line.product ?? {};
      const packs = prod.packs > 1 ? `${prod.packs}× ` : '';
      const pack = prod.packLabel ? ` ${packs}${prod.packLabel}` : '';
      const flag = line.status === 'low-confidence' ? ' ⚠️' : '';
      return `${rupees(line.lineTotal)}${arrow(line.history?.change)}${flag}${pack}`;
    });
    lines.push(`| ${label} | ${cells.join(' | ')} |`);
  }
  lines.push(`| **${r.feesKnown ? 'TOTAL' : 'GOODS TOTAL'}** | ${cols.map((p) => (p.failed || !p.fulfilledLines ? '—' : `**${rupees(p.total)}**`)).join(' | ')} |`);
  lines.push(`| items found | ${cols.map((p) => `${p.fulfilledLines ?? 0}/${p.totalLines ?? 0}`).join(' | ')} |`);
  lines.push('');

  if (r.winner) {
    const onSubset = !r.likeForLike && r.winner.subsetTotal != null;
    const mine = onSubset ? r.winner.subsetTotal : r.winner.total;
    if (r.runnerUp && r.saving > 0) {
      lines.push(`### ${r.winner.label} is cheapest${onSubset ? ' on what every site stocks' : ''}: ${rupees(mine)}, saving ${rupees(r.saving)} vs ${r.runnerUp.label}`);
    } else {
      lines.push(`### ${r.winner.label}: ${rupees(mine)}`);
    }
  } else {
    lines.push('### No site returned a usable basket.');
  }
  if (!r.likeForLike && r.comparedOn) lines.push(`> The verdict compares ${r.comparedOn}; column totals cover different goods.`);
  if (r.coverageWarning) {
    const cw = r.coverageWarning;
    lines.push(`> Best coverage: ${cw.label}, ${cw.fulfilledLines}/${cw.totalLines} at ${rupees(cw.total)} (one trip instead of two).`);
  }

  const errors = (r.unavailable ?? []).map((u) => `- ${u.label ?? u.platform}: ${u.error}`);
  if (errors.length) lines.push('', '**Sites that failed** (not the same as "not stocked"):', ...errors);
  const low = cols.flatMap((p) => (p.lowConfidence ?? []).map((l) => `- ${p.label ?? p.platform}: "${l.query}" → ${l.name} (${l.reason})`));
  if (low.length) lines.push('', '**Below the confidence threshold** (shown, not totalled):', ...low);
  if (saved && r.uncached?.length) {
    lines.push('', `${r.uncached.length} item/site pair(s) have no saved price yet. Call compare_basket with fresh=true to search live.`);
  }

  lines.push('');
  if (!r.feesKnown) lines.push('> Totals are goods only. Delivery and handling are not included (sites show them only at checkout).');
  lines.push('_▼ cheaper / ▲ dearer than the previous saved price for that site._');
  return lines.join('\n');
}

/** The compact JSON a model can reason over, next to the table. */
function resultSummary(r) {
  return {
    source: r.source ?? 'live',
    cachedRange: r.cachedRange ?? null,
    winner: r.winner,
    runnerUp: r.runnerUp,
    saving: r.saving,
    likeForLike: r.likeForLike,
    totalsInclude: r.feesKnown ? 'goods + fees' : 'goods only',
    totals: (r.platforms ?? []).map((p) => ({
      site: p.platform,
      total: p.failed || !p.fulfilledLines ? null : p.total,
      found: `${p.fulfilledLines ?? 0}/${p.totalLines ?? 0}`,
      error: p.error ?? null,
    })),
  };
}

export function lookupMarkdown(l) {
  const out = [`**${l.query}** — saved prices per ${l.per}`, ''];
  const dates = l.dates ?? [];
  out.push(`| Site | ${dates.length ? `Last ${dates.length} dates (${dates.join(', ')})` : 'Trend'} | Now | Pack | Lowest ever |`);
  out.push('|---|---|---|---|---|');
  for (const s of l.sites ?? []) {
    const trend = (s.trend ?? []).map((c) => (c ? c.rate : '—')).join(' → ') || '—';
    out.push(
      `| ${s.site} | ${trend} | ${rupees(s.rate)}/${l.per}${arrow(s.change)}${pct(s.changePct)} · ${rupees(s.lastPrice)} on ${day(s.seenAt)} | ${s.pack ?? '—'} | ${rupees(s.lowRate)} on ${day(s.lowSeenAt)} |`,
    );
  }
  const best = l.sites?.[0];
  if (best) out.push('', `### Cheapest saved: ${best.site}, ${rupees(best.rate)} per ${l.per} (${best.product ?? ''})`);
  if (l.options?.length) out.push('', `Other saved items: ${l.options.map((o) => o.query).join(', ')}`);
  out.push('', '_Saved prices, not live. Call compare_basket with fresh=true to search the sites now._');
  return out.join('\n');
}

const hhmm = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }) : '—');
const condText = (c) => [c?.maxQty ? `max ${c.maxQty} item${c.maxQty > 1 ? 's' : ''}` : null, c?.minBasket ? `basket ₹${c.minBasket}+` : null].filter(Boolean).join(' · ');

export function dealsMarkdown(d) {
  const out = [`**Deals · ${d.minDiscountPct ?? 80}%+ off** (not in totals)`, ''];
  const row = (x) => `- ${x.product}${x.pack ? ` · ${x.pack}` : ''}: ${rupees(x.price)} (MRP ${rupees(x.mrp)}, ${Math.round(x.pct)}% off)${condText(x.conditions) ? ` · ${condText(x.conditions)}` : ''} · seen by ${x.seenBy.map((s) => s.name).join(', ')}`;
  for (const g of d.groups ?? []) {
    out.push(`**${g.site}** (checked ${hhmm(g.checkedAt)})${condText(g.conditions) ? ` · ${condText(g.conditions)}` : ''}`);
    out.push(...(g.deals.length ? g.deals.map(row) : [`- No ${d.minDiscountPct ?? 80}%+ deals in the last check (${hhmm(g.checkedAt)}).`]));
    out.push('');
  }
  if (d.fromSearches?.length) out.push('**From searches** (last 24 h)', ...d.fromSearches.map((x) => `- ${x.site}: ${row(x).slice(2)}`), '');
  for (const e of d.errors ?? []) out.push(`> ${e.site} · ${e.name}: ${e.error}`);
  if (!(d.groups?.length || d.fromSearches?.length)) out.push('No offer check has run yet. It runs at the deal times (07:00 and 18:00 unless changed), or press "Check offers" on the page.');
  return out.join('\n');
}

// --------------------------------------------------------------------- tools

const sitesSchema = {
  type: 'array',
  items: { type: 'string', enum: ALL_PLATFORMS },
  description: 'Which sites to use. Defaults to the service\'s configured sites.',
};

export const TOOLS = [
  {
    name: 'lookup_price',
    description:
      'Saved price of ONE grocery item across sites, from the basket service\'s history: what each site last charged ' +
      '(as a rate per 100 g / 100 ml / piece and as the pack), ▼/▲ vs the previous saved price, the last 3 dates that ' +
      'have data, and the lowest rate ever seen. Instant, contacts no site. Use for "how much is X" or "has X gone up". ' +
      'Set fresh=true only when the user asks for the current price: it searches the sites live first (same limits as compare_basket).',
    inputSchema: {
      type: 'object',
      properties: {
        item: { type: 'string', description: 'The item, e.g. "toor dal 1kg" or just "onion".' },
        sites: sitesSchema,
        fresh: { type: 'boolean', description: 'Search the sites live first, then show the updated saved prices. Default false.' },
        waitSeconds: { type: 'number' },
      },
      required: ['item'],
    },
  },
  {
    name: 'suggest_items',
    description: 'Find saved items matching some text (autocomplete), with the best saved rate for each. Use when unsure of the exact item name.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Part of an item name, e.g. "dal".' }, limit: { type: 'number' } },
      required: ['text'],
    },
  },
  {
    name: 'compare_basket',
    description:
      'Compare a grocery basket across Indian quick-commerce sites and name the cheapest. By default answers from ' +
      'SAVED prices (instant, no site contacted, shows when each price was saved). Set fresh=true only when the user ' +
      'asks for current/live prices: that runs a real search through the service\'s queue (30 s to a few minutes) and ' +
      'respects per-site rate limits, so it may be told to wait. Totals are goods only unless fees are configured; ' +
      'repeat that caveat to the user.',
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: ['string', 'array'],
          items: { type: 'string' },
          description: 'One item per line (or an array). Optional leading quantity: "2x amul milk 500ml".',
        },
        sites: sitesSchema,
        fresh: { type: 'boolean', description: 'Search the sites live instead of using saved prices. Default false.' },
        waitSeconds: { type: 'number', description: `Live only: how long to wait for the run (default ${DEFAULT_WAIT_S}, max ${MAX_WAIT_S}).` },
      },
      required: ['items'],
    },
  },
  {
    name: 'run_saved_basket',
    description:
      'Run the service\'s own saved basket (the one the daily schedule checks) live now. Same limits and queue as ' +
      'compare_basket fresh=true. Use when the user says "check my usual basket now".',
    inputSchema: {
      type: 'object',
      properties: { sites: sitesSchema, waitSeconds: { type: 'number' } },
    },
  },
  {
    name: 'job_result',
    description: 'Fetch the result of a live run that was still going when compare_basket or run_saved_basket returned.',
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'number' }, waitSeconds: { type: 'number' } },
      required: ['jobId'],
    },
  },
  {
    name: 'deals',
    description:
      'Deep discounts (80%+ off MRP by default) the household\'s accounts can get right now, such as Milkbasket\'s ₹1 ' +
      'flash deal, with conditions (max quantity, minimum basket) and which account saw each one. These are never ' +
      'part of a basket total. Instant; reads the last offer check.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'site_status',
    description:
      'Which sites can be searched right now: per-site rate-limit budget and cool-downs, and which sites are signed in. ' +
      'Signing in is done by the user in the web page (Sign in button), not through chat.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'open_basket_view',
    description: 'Return (and open on this machine) the URL of the basket web page: table, trends, sign-in, settings.',
    inputSchema: { type: 'object', properties: {} },
  },
];

const asItems = (v) => (Array.isArray(v) ? v.map(String).join('\n') : String(v ?? '')).trim();
const asSites = (v) => (Array.isArray(v) && v.length ? v : undefined);
const waitFor = (v) => Math.min(MAX_WAIT_S, Math.max(0, Number(v ?? DEFAULT_WAIT_S) || 0));
const errorOf = (res, fallback) => res.data?.error ?? `${fallback} (HTTP ${res.status})`;

/**
 * Poll the service until the job finishes, fails or the wait runs out.
 * @returns {Promise<{ result?: object, status: string, error?: string }>}
 */
async function waitForJob(client, jobId, waitS, { sleep, now }) {
  const deadline = now() + waitS * 1000;
  for (;;) {
    const res = await client.get(`/api/result?jobId=${jobId}`);
    if (res.status === 200 && res.data) return { status: 'done', result: res.data };
    const jobs = await client.get('/api/jobs?limit=50');
    const job = jobs.data?.jobs?.find((j) => j.id === jobId);
    if (job && (job.status === 'failed' || job.status === 'cancelled')) return { status: job.status, error: job.error ?? job.status };
    // Done but the service no longer holds it in memory (restart): it is saved, though.
    if (job?.status === 'done') return { status: 'done-not-held' };
    if (now() >= deadline) {
      return { status: jobs.data?.pending?.some((j) => j.id === jobId) ? 'queued' : 'running' };
    }
    await sleep(Math.min(POLL_MS, Math.max(0, deadline - now())));
  }
}

function jobAnswer(jobId, outcome, extra = '') {
  if (outcome.status === 'done') {
    return { content: [text(extra + resultMarkdown(outcome.result)), jsonBlock({ jobId, ...resultSummary(outcome.result) })] };
  }
  if (outcome.status === 'done-not-held') {
    return { content: [text(`Run ${jobId} finished and its prices are saved. Call compare_basket (fresh=false) for the same items to read them.`)] };
  }
  if (outcome.status === 'failed' || outcome.status === 'cancelled') return fail(`Run ${jobId} ${outcome.status}: ${outcome.error}`);
  return {
    content: [text(`Run ${jobId} is still ${outcome.status}. Call job_result with jobId ${jobId} in a minute, or watch it in the web page.`)],
  };
}

/** The /api/compare body; `platforms` only when the caller chose sites. */
const compareBody = (items, sites, extra = {}) => ({ items, ...(sites ? { platforms: sites } : {}), ...extra });

/**
 * Start a live run and wait for it.
 * @returns {Promise<{ status: string, answer: object }>} status is the job outcome
 *   ('done', 'failed', 'running', …) or 'limited' / 'refused' when no job started
 */
async function liveRun(client, { items, sites, waitSeconds }, deps) {
  const res = await client.post('/api/compare', compareBody(items, sites));
  if (res.status === 429) {
    // Over a site's budget: say how long, and give the saved answer meanwhile.
    const waits = (res.data?.waits ?? []).map((w) => `- ${w.label}: wait ${Math.ceil(w.waitMs / 1000)} s (${w.reason})`);
    const note = `Live search not started: ${res.data?.error ?? 'a site needs a pause'}\n${waits.join('\n')}\n\n`;
    const cached = await client.post('/api/compare', compareBody(items, sites, { mode: 'cached' }));
    const answer = cached.status === 200
      ? { content: [text(`${note}Showing saved prices instead.\n\n${resultMarkdown(cached.data)}`), jsonBlock({ liveWait: res.data, ...resultSummary(cached.data) })] }
      : { content: [text(`${note}No saved prices to show either.`)] };
    return { status: 'limited', answer };
  }
  if (res.status !== 202) return { status: 'refused', answer: fail(errorOf(res, 'The service refused the run')) };
  const { jobId, queued } = res.data;
  const outcome = await waitForJob(client, jobId, waitFor(waitSeconds), deps);
  return { status: outcome.status, answer: jobAnswer(jobId, outcome, queued ? `_Run ${jobId} waited behind ${queued} other run(s)._\n\n` : '') };
}

/**
 * Run one tool call against the service.
 * @param {string} name
 * @param {object} args
 * @param {object} deps
 * @param {ReturnType<typeof makeClient>} deps.client
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 * @param {() => number} [deps.now]
 * @param {(url: string) => void} [deps.openUrl]
 */
export async function callTool(name, args = {}, { client, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, openUrl = () => {} }) {
  const deps = { sleep, now };
  try {
    if (name === 'lookup_price') {
      const item = String(args.item ?? '').trim();
      if (!item) return fail('No item given, e.g. "toor dal 1kg".');
      // Live first: a one-item run records fresh prices, then the lookup reads them
      // (so the trend and ▼/▲ include today's search).
      let note = '';
      if (args.fresh) {
        const live = await liveRun(client, { items: item, sites: asSites(args.sites), waitSeconds: args.waitSeconds }, deps);
        // Failed, rate-limited or still running: that answer says why and what to do.
        if (live.status !== 'done' && live.status !== 'done-not-held') return live.answer;
        note = '_Searched the sites just now._\n\n';
      }
      const res = await client.get(`/api/lookup?q=${encodeURIComponent(item)}`);
      if (res.status === 404) return { content: [text(`${res.data?.error ?? `No saved price for "${item}".`}${args.fresh ? '' : ' Use fresh=true to search live.'}`)] };
      if (res.status !== 200) return fail(errorOf(res, 'Lookup failed'));
      return { content: [text(note + lookupMarkdown(res.data)), jsonBlock(res.data)] };
    }

    if (name === 'suggest_items') {
      const t = String(args.text ?? '').trim();
      const limit = Math.min(20, Number(args.limit) || 8);
      const res = await client.get(`/api/suggest?q=${encodeURIComponent(t)}&limit=${limit}`);
      if (res.status !== 200) return fail(errorOf(res, 'Suggest failed'));
      if (!res.data?.length) return { content: [text(`No saved items match "${t}".`)] };
      const rows = res.data.map((s) =>
        `- ${s.query} (${s.sites} site${s.sites === 1 ? '' : 's'}, saved ${day(s.seenAt)})` +
        (s.best ? `: best ${s.best.site} ${rupees(s.best.rate)} per ${s.best.per}` : ''),
      );
      return { content: [text(rows.join('\n')), jsonBlock(res.data)] };
    }

    if (name === 'compare_basket') {
      const items = asItems(args.items);
      if (!items) return fail('No items given. Provide a basket, one item per line.');
      const sites = asSites(args.sites);
      if (args.fresh) return (await liveRun(client, { items, sites, waitSeconds: args.waitSeconds }, deps)).answer;
      const res = await client.post('/api/compare', compareBody(items, sites, { mode: 'cached' }));
      if (res.status !== 200) return fail(errorOf(res, 'Compare failed'));
      return { content: [text(resultMarkdown(res.data)), jsonBlock(resultSummary(res.data))] };
    }

    if (name === 'run_saved_basket') {
      const meta = await client.get('/api/meta');
      const items = asItems(meta.data?.basket);
      if (!items) return fail('The service has no saved basket. Set one in the web page Settings.');
      return (await liveRun(client, { items, sites: asSites(args.sites), waitSeconds: args.waitSeconds }, deps)).answer;
    }

    if (name === 'job_result') {
      const jobId = Number(args.jobId);
      if (!Number.isInteger(jobId)) return fail('Pass the numeric jobId.');
      return jobAnswer(jobId, await waitForJob(client, jobId, waitFor(args.waitSeconds ?? 0), deps));
    }

    if (name === 'deals') {
      const res = await client.get('/api/deals');
      if (res.status !== 200) return fail(errorOf(res, 'Deals failed'));
      return { content: [text(dealsMarkdown(res.data)), jsonBlock(res.data)] };
    }

    if (name === 'site_status') {
      const [limits, login, meta] = await Promise.all([client.get('/api/limits'), client.get('/api/login'), client.get('/api/meta')]);
      const labels = meta.data?.labels ?? {};
      const rows = Object.entries(limits.data ?? {}).map(([site, s]) => {
        const state = s.ok ? 'ready' : `wait ${Math.ceil((s.waitMs ?? s.cooldownMs ?? 0) / 1000)} s (${s.reason ?? s.cooldownReason ?? 'limit'})`;
        const skip = meta.data?.skipped?.[site] ? ` · skipped: ${meta.data.skipped[site]}` : '';
        return `- ${labels[site] ?? site}: ${state} · ${s.lastHour} search(es) in the last hour${skip}`;
      });
      const signins = (login.data ?? []).map((l) => `- ${l.label}: ${l.loggedIn ? `signed in since ${day(l.since)}` : l.pending ? `sign-in in progress (${l.state})` : 'not signed in'}${l.why ? ` · ${l.why}` : ''}`);
      return {
        content: [
          text(`**Search budget**\n${rows.join('\n') || '- no data'}\n\n**Sign-ins** (done in the web page, not here)\n${signins.join('\n') || '- none'}`),
          jsonBlock({ limits: limits.data, login: login.data }),
        ],
      };
    }

    if (name === 'open_basket_view') {
      const meta = await client.get('/api/meta');
      if (meta.status !== 200) return fail(errorOf(meta, 'The service did not answer'));
      openUrl(client.baseUrl);
      return { content: [text(`Basket page: ${client.baseUrl}\nIt has the comparison table, ▼/▲ trends, saved-price lookup, Sign in and Settings.`)] };
    }

    return fail(`Unknown tool: ${name}`);
  } catch (err) {
    return fail(err instanceof ServiceDownError ? err.message : `Failed: ${err.message}`);
  }
}
