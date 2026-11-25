/**
 * One Chrome tab driven over raw CDP (global WebSocket, no deps).
 *
 * Same request/response pattern as src/browser.js, plus event listeners so a
 * site module can watch the page's own network traffic (Network.*), and crash
 * detection so the pool can relaunch.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function newTarget(endpoint) {
  const url = `${endpoint}/json/new?about:blank`;
  let res = await fetch(url, { method: 'PUT' });
  // Older Chrome builds want GET here.
  if (!res.ok) res = await fetch(url);
  if (!res.ok) throw new Error(`CDP new tab failed: HTTP ${res.status}`);
  return res.json();
}

function connect(wsUrl, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* ignore */ }
      reject(new Error('CDP attach timed out'));
    }, timeoutMs);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(ws); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP websocket error')); }, { once: true });
  });
}

/**
 * Chromium's deterministic GREASE brand list for a major version
 * (components/embedder_support/user_agent_utils.cc). Used when the page is
 * not a secure context and navigator.userAgentData can't be read.
 * 156 -> "Not:A-Brand";v="8", "Chromium";v="156", "Google Chrome";v="156".
 */
export function greasedBrands(major, chromiumVersion, chromeVersion) {
  const chars = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_'];
  const versions = ['8', '99', '24'];
  const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  const greaseVersion = versions[major % 3];
  const grease = {
    brand: `Not${chars[major % 11]}A${chars[(major + 1) % 11]}Brand`,
    version: chromiumVersion.includes('.') ? `${greaseVersion}.0.0.0` : greaseVersion,
  };
  const order = orders[major % 6];
  const out = [];
  out[order[0]] = grease;
  out[order[1]] = { brand: 'Chromium', version: chromiumVersion };
  out[order[2]] = { brand: 'Google Chrome', version: chromeVersion };
  return out;
}

/**
 * The `Network.setUserAgentOverride` parameters for a real-Chrome UA: the string, plus client hints
 * (`sec-ch-ua`) that carry the same version and no "HeadlessChrome" brand. `real` is what the page
 * itself reports through navigator.userAgentData (its true GREASE brand); without it the hints are
 * rebuilt with Chromium's own algorithm (greasedBrands).
 * @param {string} ua
 * @param {object|null} [real]
 */
export function userAgentOverride(ua, real = null) {
  const params = { userAgent: ua };
  const m = ua.match(/Chrome\/((\d+)[\d.]*)/);
  const clean = (list) => list?.map((b) => ({ brand: b.brand.replace(/^HeadlessChrome$/, 'Google Chrome'), version: b.version }));
  if (real?.brands?.length) {
    params.userAgentMetadata = {
      brands: clean(real.brands),
      fullVersionList: clean(real.fullVersionList || real.brands),
      fullVersion: real.uaFullVersion || m?.[1] || '',
      platform: real.platform || 'Linux',
      platformVersion: real.platformVersion || '',
      architecture: real.architecture || 'x86',
      model: real.model || '',
      mobile: !!real.mobile,
      bitness: real.bitness || '64',
    };
  } else if (m) {
    const [, full, major] = m;
    const platform = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : 'Linux';
    params.userAgentMetadata = {
      brands: greasedBrands(Number(major), major, major),
      fullVersionList: greasedBrands(Number(major), full, full),
      fullVersion: full,
      platform,
      platformVersion: '',
      architecture: 'x86',
      model: '',
      mobile: /Mobile/.test(ua),
      bitness: '64',
    };
  }
  return params;
}

export class CdpTab {
  /** @private use CdpTab.open */
  constructor(endpoint, target, ws) {
    this.endpoint = endpoint;
    this.targetId = target.id;
    this.ws = ws;
    this.alive = true;
    this._id = 0;
    this._pending = new Map();
    this._listeners = new Map();
    this._crashCbs = [];
    this._closing = false;

    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id != null) {
        const p = this._pending.get(msg.id);
        if (p) { this._pending.delete(msg.id); p(msg); }
        return;
      }
      if (msg.method === 'Inspector.targetCrashed') this._crashed('target crashed');
      if (msg.method === 'Inspector.detached') this._crashed(`detached: ${msg.params?.reason || ''}`);
      const set = this._listeners.get(msg.method);
      if (set) for (const cb of [...set]) { try { cb(msg.params); } catch { /* listener bug */ } }
    });
    ws.addEventListener('close', () => {
      if (!this._closing) this._crashed('websocket closed');
      this.alive = false;
      for (const p of this._pending.values()) p({ error: { message: 'CDP connection closed' } });
      this._pending.clear();
    });
  }

  /**
   * Open a new tab on a running Chrome and (optionally) navigate it.
   * @param {string} endpoint e.g. http://127.0.0.1:9333
   * @param {string} [url]
   */
  static async open(endpoint, url = 'about:blank') {
    const target = await newTarget(endpoint);
    const ws = await connect(target.webSocketDebuggerUrl);
    const tab = new CdpTab(endpoint, target, ws);
    try {
      await tab.send('Page.enable');
      await tab.send('Runtime.enable');
      await tab.send('Network.enable');
      await tab.send('Inspector.enable').catch(() => {});
      // Every tab behaves as focused/visible, so parallel site tabs keep working.
      await tab.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
      if (url && url !== 'about:blank') await tab.goto(url, { waitMs: 15000 });
    } catch (e) {
      await tab.close();
      throw e;
    }
    return tab;
  }

  _crashed(reason) {
    this.alive = false;
    if (this._closing || this._crashFired) return;
    this._crashFired = true;
    for (const cb of this._crashCbs) { try { cb(reason); } catch { /* ignore */ } }
  }

  /** Raw CDP call. Resolves with `result`, rejects on protocol error. */
  send(method, params = {}, timeoutMs = 30000) {
    if (!this.alive) return Promise.reject(new Error(`CDP ${method}: tab is closed`));
    const id = ++this._id;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, timeoutMs);
      this._pending.set(id, (m) => {
        clearTimeout(t);
        if (m.error) reject(new Error(`CDP ${method}: ${m.error.message}`));
        else resolve(m.result);
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Subscribe to a CDP event. Returns an unsubscribe function. */
  on(method, cb) {
    if (!this._listeners.has(method)) this._listeners.set(method, new Set());
    this._listeners.get(method).add(cb);
    return () => this._listeners.get(method)?.delete(cb);
  }

  /** Resolve with the first event matching `pred`, or null after timeoutMs. */
  waitForEvent(method, pred = () => true, timeoutMs = 10000) {
    return new Promise((resolve) => {
      const off = this.on(method, (p) => {
        if (!pred(p)) return;
        clearTimeout(t); off(); resolve(p);
      });
      const t = setTimeout(() => { off(); resolve(null); }, timeoutMs);
    });
  }

  /**
   * Navigate and wait for the load event (at most waitMs). Throws when the
   * page ends on a chrome-error:// page.
   */
  async goto(url, { waitMs = 6000 } = {}) {
    const loaded = this.waitForEvent('Page.loadEventFired', () => true, waitMs);
    const r = await this.send('Page.navigate', { url });
    if (r?.errorText) throw new Error(`navigation to ${url} failed: ${r.errorText}`);
    await loaded;
    const href = await this.evaluate('location.href', { timeoutMs: 5000 }).catch(() => null);
    if (href && String(href).startsWith('chrome-error')) throw new Error(`navigation to ${url} failed`);
    return href;
  }

  /**
   * Evaluate an expression in the page; returns the value by JSON.
   * Throws Error('evaluate timeout') or the page exception text.
   */
  async evaluate(expr, { awaitPromise = true, timeoutMs = 30000 } = {}) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('evaluate timeout')), timeoutMs);
    });
    try {
      const r = await Promise.race([
        this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise }, timeoutMs + 5000),
        timeout,
      ]);
      const ex = r?.exceptionDetails;
      if (ex) throw new Error(ex.exception?.description || ex.exception?.value || ex.text || 'evaluate threw');
      return r?.result?.value;
    } finally {
      clearTimeout(timer);
    }
  }

  /** @param {Array<{name,value,domain?,url?,path?,secure?,httpOnly?,expires?,sameSite?}>} cookies */
  async setCookies(cookies) {
    if (!cookies?.length) return;
    await this.send('Network.setCookies', { cookies });
  }

  /** @param {string[]} [urls] cookies for these URLs, or the current page's */
  async getCookies(urls) {
    const r = await this.send('Network.getCookies', urls ? { urls } : {});
    return r?.cookies || [];
  }

  /**
   * Override the UA for this tab. Client hints are rebuilt from the UA so the
   * `sec-ch-ua` brands carry the same version and no "HeadlessChrome" brand.
   *
   * THE OVERRIDE LASTS ONLY AS LONG AS THIS CONNECTION: when the socket that set it closes, the tab
   * reads "HeadlessChrome" again (proved 2026-11-25, test/ua-guard.test.js). The browser as a whole
   * therefore also holds it for every tab (ua-guard.js, started by launchChrome); this per-tab call
   * stays as the exact version with the page's own client hints.
   */
  async setUserAgent(ua) {
    // Prefer the browser's own hints (real GREASE brand) over synthesized ones.
    const real = await this.evaluate(
      `navigator.userAgentData ? navigator.userAgentData.getHighEntropyValues(['architecture','bitness','model','platformVersion','fullVersionList','uaFullVersion']).then(v => JSON.parse(JSON.stringify(v))) : null`,
      { timeoutMs: 5000 },
    ).catch(() => null);
    await this.send('Network.setUserAgentOverride', userAgentOverride(ua, real));
  }

  /** Called once with a reason when the tab crashes or the socket drops. */
  onCrash(cb) {
    this._crashCbs.push(cb);
  }

  async close() {
    if (this._closing) return;
    this._closing = true;
    this.alive = false;
    try { this.ws.close(); } catch { /* ignore */ }
    try {
      await fetch(`${this.endpoint}/json/close/${this.targetId}`, { signal: AbortSignal.timeout(3000) });
    } catch { /* tab or browser already gone */ }
    await sleep(0);
  }
}
