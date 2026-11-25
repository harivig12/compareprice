/**
 * The browser as a whole reports a real-Chrome user-agent: never "HeadlessChrome".
 *
 * WHY THIS EXISTS (root cause, proved 2026-11-25 with test/ua-guard.test.js and a live run):
 * headless Chrome's own user-agent says "HeadlessChrome" (and its client hints name a "HeadlessChrome"
 * brand). A `Network.setUserAgentOverride` fixes that for one tab, but ONLY WHILE THE CONNECTION THAT
 * SET IT STAYS OPEN. Close that connection, or open a tab from another script, and the tab reads
 * "HeadlessChrome" again. Bot walls reject that on sight: BigBasket's Akamai answered "Access Denied"
 * to a page load made that way (AGENTS.md: "a mismatch makes BigBasket return 403"), and Swiggy's
 * pages showed "Something went wrong". The service's own tabs were never affected (their connection
 * lives as long as the tab) but anything that attached to the debugging port could slip: a probe
 * script that reconnected for every step did, and it cost a false "Instamart cart is broken"
 * finding and a BigBasket wall.
 *
 * So the BROWSER holds the override: one connection to the browser itself, kept for the browser's
 * whole life, that auto-attaches to every page (existing and new), applies the override before the
 * page runs, and lets it go. A tab opened by any script is then born with a real user-agent.
 * The per-tab override (CdpTab.setUserAgent, with the page's own client hints) stays on top of it.
 */
import { userAgentOverride } from './cdp.js';

const CALL_TIMEOUT_MS = 5000;

/** Default transport: a browser-level CDP websocket with flat session ids. */
export async function connectBrowser(wsUrl, timeoutMs = 10000) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => { try { ws.close(); } catch { /* */ } reject(new Error('browser websocket timed out')); }, timeoutMs);
    ws.addEventListener('open', () => { clearTimeout(t); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('browser websocket error')); }, { once: true });
  });
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id != null) { const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result ?? {}); } return; }
    if (m.method) for (const l of listeners) { try { l(m); } catch { /* listener bug */ } }
  });
  return {
    send(method, params = {}, sessionId) {
      const my = ++id;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(my); reject(new Error(`${method} timed out`)); }, CALL_TIMEOUT_MS);
        pending.set(my, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
        ws.send(JSON.stringify({ id: my, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
    onEvent(cb) { listeners.push(cb); },
    onClose(cb) { ws.addEventListener('close', cb, { once: true }); },
    close() { try { ws.close(); } catch { /* */ } },
  };
}

/**
 * Keep every page of this browser on `userAgent` for as long as the returned guard is open.
 * @param {{ endpoint: string, userAgent: string, connect?: typeof connectBrowser, fetchVersion?: Function, log?: (m: string) => void }} opts
 * @returns {Promise<{ stop(): void, applied: number }>}
 */
export async function holdUserAgent({ endpoint, userAgent, connect = connectBrowser, fetchVersion, log = () => {} }) {
  const version = await (fetchVersion ?? (() => fetch(`${endpoint}/json/version`).then((r) => r.json())))();
  if (!version?.webSocketDebuggerUrl) throw new Error('the browser exposes no browser-level debugging socket');
  const browser = await connect(version.webSocketDebuggerUrl);
  const override = userAgentOverride(userAgent);
  const state = { applied: 0 };

  const apply = async (sessionId, waiting) => {
    try {
      await browser.send('Network.setUserAgentOverride', override, sessionId);
      state.applied++;
    } catch (e) {
      log(`ua-guard: could not set the user-agent on a tab: ${e.message}`);
    } finally {
      // A tab started "waiting for the debugger" stays frozen until it is let go, whatever happened above.
      if (waiting) await browser.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
    }
  };

  browser.onEvent((m) => {
    if (m.method !== 'Target.attachedToTarget') return;
    const { sessionId, targetInfo, waitingForDebugger } = m.params ?? {};
    if (!sessionId) return;
    if (targetInfo?.type === 'page') apply(sessionId, waitingForDebugger);
    else if (waitingForDebugger) browser.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
  });

  // New tabs from now on: attach, set the override before the page runs, then let it go.
  await browser.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  // Tabs that already exist.
  const { targetInfos = [] } = await browser.send('Target.getTargets').catch(() => ({}));
  for (const t of targetInfos.filter((x) => x.type === 'page')) {
    try {
      const { sessionId } = await browser.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
      await apply(sessionId, false);
    } catch (e) {
      log(`ua-guard: could not attach to an open tab: ${e.message}`);
    }
  }
  return { get applied() { return state.applied; }, stop: () => browser.close() };
}
