/**
 * Launch (or attach to) a headless Chrome for the engine.
 *
 * The UA must match the real browser version with "Headless" removed, and
 * AutomationControlled must be off: BigBasket 403s otherwise (see
 * docs/diagnosis/2026-11-16-api-platforms-failing.md).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
import { hostname as osHostname } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Chrome's RESULT_CODE_PROFILE_IN_USE. */
const PROFILE_IN_USE = 21;

/**
 * Is `pid` a live Chrome? Pids are small and get reused inside a restarted
 * container, so on Linux also check the process name.
 */
function chromeAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch (e) {
    if (e.code !== 'EPERM') return false;
  }
  try {
    return /chrom/i.test(readFileSync(`/proc/${pid}/comm`, 'utf8'));
  } catch {
    return true; // no /proc (macOS): trust the pid check
  }
}

/**
 * Remove a stale profile lock so Chrome can start.
 *
 * Chrome writes `SingletonLock -> <hostname>-<pid>`. It only breaks the lock
 * itself when the hostname matches and the pid is dead. A Docker container
 * gets a new hostname each time it is recreated, so the lock left by the old
 * container makes every launch exit with code 21 (profile in use).
 *
 * The lock is kept when it belongs to a live process on this host (a real
 * Chrome is using the profile). It is removed when that pid is dead, or when
 * it names another host: the data dir belongs to this one service, so a
 * foreign-host lock can only be left over from an earlier container.
 *
 * @param {string} profileDir
 * @param {{ hostname?: string, isAlive?: (pid: number) => boolean }} [deps]
 * @returns {{ cleared: boolean, owner: string | null }}
 */
export function clearStaleProfileLock(profileDir, { hostname = osHostname(), isAlive = chromeAlive } = {}) {
  let owner;
  try {
    owner = readlinkSync(join(profileDir, 'SingletonLock'));
  } catch {
    return { cleared: false, owner: null };
  }
  const cut = owner.lastIndexOf('-');
  const host = cut > 0 ? owner.slice(0, cut) : owner;
  const pid = Number(cut > 0 ? owner.slice(cut + 1) : NaN);
  if (host === hostname && Number.isInteger(pid) && pid > 0 && isAlive(pid)) {
    return { cleared: false, owner };
  }
  for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    rmSync(join(profileDir, f), { force: true });
  }
  return { cleared: true, owner };
}

/**
 * @param {{ port: number, profileDir: string, headless?: boolean, userAgent?: string }} opts
 * @returns {string[]}
 */
export function chromeArgs({ port, profileDir, headless = true, userAgent } = {}) {
  const args = [
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profileDir}`,
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-dev-shm-usage',
    '--disable-features=Translate,MediaRouter',
    // One warm tab per site runs in parallel; background tabs must not be throttled.
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--window-size=1366,900',
    '--lang=en-IN',
  ];
  if (headless) args.unshift('--headless=new');
  if (userAgent) args.push(`--user-agent=${userAgent}`);
  // Chrome's sandbox needs user namespaces, which Docker blocks by default, and
  // it refuses to run as root. The image sets BASKET_CHROME_NO_SANDBOX=1 so the
  // container (non-root user, no extra capabilities) is the isolation boundary.
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  if (isRoot || process.env.BASKET_CHROME_NO_SANDBOX === '1') args.push('--no-sandbox');
  return args;
}

/**
 * The real UA from /json/version with HeadlessChrome replaced by Chrome.
 * @param {{ 'User-Agent': string, Browser?: string }} versionJson
 */
export function matchedUserAgent(versionJson) {
  return String(versionJson['User-Agent'] || '').replace(/HeadlessChrome\//g, 'Chrome/');
}

function resolveChromePath(chromePath) {
  const candidates = [chromePath, process.env.CHROME_PATH, 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].filter(Boolean);
  const dirs = (process.env.PATH || '').split(delimiter).filter(Boolean);
  for (const c of candidates) {
    if (isAbsolute(c) || c.includes('/')) {
      if (existsSync(c)) return c;
      continue;
    }
    for (const d of dirs) {
      const p = join(d, c);
      if (existsSync(p)) return p;
    }
  }
  throw new Error(`Chrome not found (tried ${candidates.join(', ')}); set CHROME_PATH`);
}

async function readVersion(endpoint, timeoutMs, proc) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    if (proc && proc.exitCode != null) throw new Error(`Chrome exited early (code ${proc.exitCode})`);
    try {
      const res = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return await res.json();
    } catch (e) {
      lastErr = e;
    }
    await sleep(250);
  }
  throw new Error(`Chrome DevTools not reachable at ${endpoint} after ${timeoutMs} ms${lastErr ? `: ${lastErr.message}` : ''}`);
}

/**
 * @param {{ port?: number, profileDir: string, headless?: boolean, chromePath?: string }} opts
 * @returns {Promise<{ endpoint: string, userAgent: string, close(): Promise<void>, process: import('node:child_process').ChildProcess | null }>}
 */
export async function launchChrome({ port = 9333, profileDir, headless = true, chromePath } = {}) {
  if (process.env.CDP_ENDPOINT) {
    const endpoint = process.env.CDP_ENDPOINT.replace(/\/+$/, '');
    const version = await readVersion(endpoint, 15000, null);
    return { endpoint, userAgent: matchedUserAgent(version), process: null, close: async () => {} };
  }
  if (!profileDir) throw new Error('launchChrome: profileDir is required');
  mkdirSync(profileDir, { recursive: true });
  const lock = clearStaleProfileLock(profileDir);
  const bin = resolveChromePath(chromePath);
  const proc = spawn(bin, [...chromeArgs({ port, profileDir, headless }), 'about:blank'], {
    stdio: 'ignore',
    detached: false,
  });
  const spawnErr = new Promise((_, reject) => proc.once('error', reject));
  const endpoint = `http://127.0.0.1:${port}`;
  let version;
  try {
    version = await Promise.race([readVersion(endpoint, 15000, proc), spawnErr]);
  } catch (e) {
    proc.kill('SIGKILL');
    if (proc.exitCode === PROFILE_IN_USE) {
      const who = lock.owner && !lock.cleared ? ` by ${lock.owner}` : '';
      throw new Error(`Chrome exited early (code 21): profile ${profileDir} is in use${who}; stop the other Chrome or remove its SingletonLock`);
    }
    throw e;
  }
  const exited = new Promise((r) => (proc.exitCode != null ? r() : proc.once('exit', r)));
  async function close() {
    if (proc.exitCode != null || proc.signalCode) return;
    proc.kill('SIGTERM');
    const done = await Promise.race([exited.then(() => true), sleep(5000).then(() => false)]);
    if (!done) {
      proc.kill('SIGKILL');
      await Promise.race([exited, sleep(2000)]);
    }
  }
  return { endpoint, userAgent: matchedUserAgent(version), process: proc, close };
}
