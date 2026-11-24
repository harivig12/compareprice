/**
 * Terminal UI renderer.
 *
 * The same view as src/ui/basket.html, drawn with box characters and ANSI
 * colour so it works inside Claude Code without leaving the terminal.
 * Degrades to plain ASCII when NO_COLOR is set or stdout is not a TTY.
 */

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

const A = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
  cyan: '\x1b[36m', grey: '\x1b[90m',
  bgGreen: '\x1b[42m', black: '\x1b[30m',
};
const c = (code, s) => (useColor ? `${code}${s}${A.reset}` : String(s));

const B = { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│', lt: '├', rt: '┤' };

/** Visible width, ignoring ANSI escapes. */
function width(s) {
  return [...String(s).replace(/\x1b\[[0-9;]*m/g, '')].length;
}
function pad(s, w, align = 'left') {
  const gap = Math.max(0, w - width(s));
  if (align === 'right') return ' '.repeat(gap) + s;
  if (align === 'center') {
    const l = Math.floor(gap / 2);
    return ' '.repeat(l) + s + ' '.repeat(gap - l);
  }
  return s + ' '.repeat(gap);
}
function truncate(s, n) {
  const raw = String(s ?? '');
  return width(raw) <= n ? raw : [...raw].slice(0, Math.max(0, n - 1)).join('') + '…';
}

/** Wrap string into lines of at most maxW visible characters. */
function wrap(s, maxW) {
  const raw = String(s ?? '').trim();
  if (!raw) return [''];
  const words = raw.split(/\s+/);
  const lines = [];
  let cur = '';

  for (const word of words) {
    if (!cur) {
      cur = word;
    } else if (width(cur + ' ' + word) <= maxW) {
      cur += ' ' + word;
    } else {
      lines.push(cur);
      cur = word;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}
function rupees(n) {
  if (n == null) return '—';
  return `₹${Number(n).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function box(lines, { title = '', color = A.grey, inner = 76 } = {}) {
  const out = [];
  const head = title ? ` ${title} ` : '';
  const headLen = width(head);
  out.push(c(color, B.tl + B.h + head + B.h.repeat(Math.max(0, inner - headLen - 1)) + B.tr));
  for (const line of lines) {
    out.push(c(color, B.v) + ' ' + pad(line, inner - 2) + ' ' + c(color, B.v));
  }
  out.push(c(color, B.bl + B.h.repeat(inner) + B.br));
  return out;
}

/**
 * Render the full comparison as a terminal view.
 * @returns {string}
 */
export function renderTui(r) {
  const out = [];
  const plats = r.platforms;
  const winner = r.winner?.platform;

  // Layout: item column takes what's left after the platform columns.
  const term = Math.min(process.stdout.columns || 100, 120);
  const colW = Math.max(18, Math.min(24, Math.floor((term - 30) / Math.max(1, plats.length))));
  const itemW = Math.max(22, term - colW * plats.length - 4);
  const inner = itemW + colW * plats.length;

  out.push('');
  out.push(
    c(A.bold, '  BASKET') +
      c(A.dim, `   pincode ${r.pincode} · ${(r.elapsedMs / 1000).toFixed(1)}s · ${plats.length} platforms · via ${r.backend}`),
  );
  out.push('');

  // ── header
  out.push(
    c(A.grey, '  ' + B.tl + B.h.repeat(inner) + B.tr),
  );
  let head = pad(c(A.bold, 'ITEM'), itemW);
  for (const p of plats) {
    const name = (r.labels?.[p.platform] ?? p.platform).toUpperCase();
    head += pad(
      p.platform === winner ? c(A.green + A.bold, name) : c(A.bold, name),
      colW,
      'right',
    );
  }
  out.push(c(A.grey, '  ' + B.v) + head + c(A.grey, B.v));
  out.push(c(A.grey, '  ' + B.lt + B.h.repeat(inner) + B.rt));

  // ── rows
  for (const item of r.basket) {
    const label = item.qty > 1 ? `${item.qty}× ${item.query}` : item.query;
    const itemLines = wrap(label, itemW - 2);

    const platRows = [];
    let maxSubLines = 1;

    for (const p of plats) {
      const line = p.lines.find((l) => l.query === item.query);
      if (!line || line.lineTotal == null) {
        const msg = line?.status === 'out-of-stock' ? 'out of stock' : 'not found';
        platRows.push({
          top: pad(c(A.red, msg), colW, 'right'),
          subLines: [],
        });
        continue;
      }
      const prod = line.product;
      const flagged = line.status === 'low-confidence';
      const money = rupees(line.lineTotal);
      const top = pad(
        flagged
          ? c(A.yellow, money + ' ?')
          : p.platform === winner
            ? c(A.green, money)
            : money,
        colW,
        'right',
      );

      const packs = prod.packs > 1 ? `${prod.packs}× ` : '';
      const detail = prod.packLabel
        ? `${packs}${prod.packLabel}${prod.pricePerUnitLabel ? ' · ' + prod.pricePerUnitLabel.replace('₹', '') : ''}`
        : prod.pricePerUnitLabel ?? '';

      const wrappedDetail = detail ? wrap(detail, colW - 2).map((dl) => pad(c(A.dim, dl), colW, 'right')) : [];
      if (wrappedDetail.length > maxSubLines) maxSubLines = wrappedDetail.length;

      platRows.push({
        top,
        subLines: wrappedDetail,
      });
    }

    // Output top line (item label line 0 + top prices)
    let firstLine = pad(c(A.bold, itemLines[0] || ''), itemW);
    for (const pr of platRows) firstLine += pr.top;
    out.push(c(A.grey, '  ' + B.v) + firstLine + c(A.grey, B.v));

    // Output remaining wrapped item lines (if any) or subLines (pack/unit info)
    const totalLines = Math.max(itemLines.length, maxSubLines);
    for (let li = 1; li < totalLines; li++) {
      let extra = pad(li < itemLines.length ? c(A.dim, itemLines[li]) : '', itemW);
      let hasAnyContent = li < itemLines.length;
      for (const pr of platRows) {
        const subIndex = li - 1;
        if (pr.subLines[subIndex]) {
          extra += pr.subLines[subIndex];
          hasAnyContent = true;
        } else {
          extra += pad('', colW, 'right');
        }
      }
      if (hasAnyContent) {
        out.push(c(A.grey, '  ' + B.v) + extra + c(A.grey, B.v));
      }
    }
  }

  // ── fees + totals
  out.push(c(A.grey, '  ' + B.lt + B.h.repeat(inner) + B.rt));

  const feeRow = (name, get) => {
    let row = pad(c(A.dim, name), itemW);
    for (const p of plats) row += pad(c(A.dim, get(p)), colW, 'right');
    out.push(c(A.grey, '  ' + B.v) + row + c(A.grey, B.v));
  };
  feeRow('delivery', (p) =>
    !p.fees.known ? '—' : p.fees.freeDeliveryApplied ? 'FREE' : rupees(p.fees.deliveryFee),
  );
  feeRow('handling', (p) => (p.fees.known ? rupees(p.fees.handlingFee) : '—'));

  out.push(c(A.grey, '  ' + B.lt + B.h.repeat(inner) + B.rt));

  // Say plainly what the number is. A "TOTAL" that silently omits delivery is
  // the kind of thing someone quotes on stage and then can't defend.
  let totals = pad(c(A.bold, r.feesKnown ? 'TOTAL' : 'GOODS TOTAL'), itemW);
  for (const p of plats) {
    totals += pad(
      p.platform === winner ? c(A.green + A.bold, rupees(p.total)) : c(A.bold, rupees(p.total)),
      colW,
      'right',
    );
  }
  out.push(c(A.grey, '  ' + B.v) + totals + c(A.grey, B.v));

  let found = pad(c(A.dim, 'items found'), itemW);
  for (const p of plats) {
    const txt = `${p.fulfilledLines}/${p.totalLines}`;
    found += pad(p.complete ? c(A.dim, txt) : c(A.yellow, txt), colW, 'right');
  }
  out.push(c(A.grey, '  ' + B.v) + found + c(A.grey, B.v));
  out.push(c(A.grey, '  ' + B.bl + B.h.repeat(inner) + B.br));
  out.push('');

  // ── verdict banner
  const winnerScore = plats.find((p) => p.platform === winner);
  if (r.winner) {
    const onSubset = !r.likeForLike && r.winner.subsetTotal != null;
    const head = onSubset
      ? `${r.winner.label} is cheapest on what everyone stocks — ${rupees(r.winner.subsetTotal)}`
      : `${r.winner.label} is cheapest — ${rupees(r.winner.total)}`;
    const lines = [c(A.bold + A.green, head)];

    if (r.runnerUp && r.saving > 0) {
      const rival = onSubset ? r.runnerUp.subsetTotal : r.runnerUp.total;
      lines.push('');
      lines.push(
        c(A.bold + A.green, `You save ${rupees(r.saving)}`) +
          c(A.dim, `  vs ${r.runnerUp.label} at ${rupees(rival)}`),
      );
    }
    if (!r.likeForLike) {
      lines.push('');
      lines.push(
        c(A.yellow, `⚠ ${r.winner.label} only stocked `) +
          c(A.yellow + A.bold, `${winnerScore?.fulfilledLines}/${winnerScore?.totalLines}`) +
          c(A.yellow, ' of your basket.'),
      );
      if (r.comparedOn) {
        lines.push(c(A.dim, `  Verdict compares ${r.comparedOn}; column totals cover different goods.`));
      }
      if (r.coverageWarning) {
        const w = r.coverageWarning;
        lines.push('');
        lines.push(
          c(A.cyan, '→ Best coverage: ') +
            c(A.bold, `${w.label} ${w.fulfilledLines}/${w.totalLines}`) +
            c(A.dim, ` at ${rupees(w.total)} — one trip instead of two.`),
        );
        lines.push(
          c(A.dim, `  Cheapest is only cheapest if you don't mind sourcing ${w.winnerMissing} item${w.winnerMissing === 1 ? '' : 's'} elsewhere.`),
        );
      }
    }
    out.push(...box(lines, { title: c(A.green, 'VERDICT'), color: A.green, inner: inner + 2 }).map((l) => '  ' + l));
  } else {
    out.push(...box([c(A.red, 'No platform returned a usable basket.')], { title: 'VERDICT', color: A.red, inner: inner + 2 }).map((l) => '  ' + l));
  }
  out.push('');

  // ── flags
  const low = plats.flatMap((p) => (p.lowConfidence || []).map((l) => ({ p: p.platform, ...l })));
  if (low.length > 0) {
    const lines = low
      .slice(0, 8)
      .map((l) => c(A.yellow, '? ') + c(A.dim, `${l.p} `) + truncate(`"${l.query}" → ${l.name}`, inner - 24) + c(A.dim, ` (${l.reason})`));
    lines.push('');
    lines.push(c(A.dim, 'Shown, not silently totalled.'));
    out.push(...box(lines, { title: c(A.yellow, 'FLAGGED BELOW THRESHOLD'), color: A.yellow, inner: inner + 2 }).map((l) => '  ' + l));
    out.push('');
  }

  const missing = plats.flatMap((p) => (p.missing || []).map((m) => ({ p: p.platform, ...m })));
  if (missing.length > 0) {
    const lines = missing.slice(0, 8).map((m) => c(A.red, '✖ ') + c(A.dim, `${m.p} `) + `"${m.query}" ${m.status}`);
    out.push(...box(lines, { title: c(A.red, 'EXCLUDED FROM TOTALS'), color: A.red, inner: inner + 2 }).map((l) => '  ' + l));
    out.push('');
  }

  // ── links
  const linkLines = plats.map((p) => {
    const url = p.lines.find((l) => l.product?.url)?.product.url;
    const mark = p.platform === winner ? c(A.green, '→ ') : '  ';
    return mark + pad(p.platform, 12) + c(A.cyan, truncate(url ?? '—', inner - 18));
  });
  out.push(...box(linkLines, { title: 'BUY IT HERE', color: A.grey, inner: inner + 2 }).map((l) => '  ' + l));

  out.push('');
  out.push(c(A.dim, `  confidence threshold ${r.confidenceThreshold}`));
  if (!r.feesKnown) {
    const missing = (r.feesMissing || []).join(', ');
    out.push(
      c(A.yellow, '  ⚠ Goods only — delivery and handling are NOT included') +
        (missing ? c(A.dim, ` (no fees set for ${missing})`) : ''),
    );
    out.push(
      c(A.dim, '    Platforms only reveal fees at checkout, so they cannot be read here.'),
    );
    out.push(c(A.dim, '    Set them once:  basket fees --set blinkit --delivery 25 --handling 9'));
  }
  out.push('');

  return out.join('\n');
}
