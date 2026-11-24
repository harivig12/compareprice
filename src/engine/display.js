/**
 * A screen for a headed (visible) Chrome.
 *
 * On Windows and macOS a headed Chrome just opens a window. On Linux it needs
 * an X display: the desktop's own ($DISPLAY), or, on a server or in Docker,
 * a virtual one. Xvfb is started once per process, on first need, and closed
 * when the process exits. Nothing is shown anywhere: Xvfb draws into memory.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';

const XVFB_DISPLAY = ':99';
let xvfb = null; // Promise<string> (the DISPLAY value)

/**
 * Environment for spawning a headed Chrome.
 * @param {{ platform?: string, env?: NodeJS.ProcessEnv, spawn?: typeof nodeSpawn, socketExists?: (p: string) => boolean, waitMs?: number }} [opts]
 * @returns {Promise<NodeJS.ProcessEnv>}
 */
export async function headedEnv({ platform = process.platform, env = process.env, spawn = nodeSpawn, socketExists = existsSync, waitMs = 5000 } = {}) {
  if (platform !== 'linux' || env.DISPLAY) return env;
  xvfb ??= startXvfb({ spawn, socketExists, waitMs }).catch((e) => { xvfb = null; throw e; });
  return { ...env, DISPLAY: await xvfb };
}

async function startXvfb({ spawn, socketExists, waitMs }) {
  // A container restart keeps /tmp: a lock and socket left by the last Xvfb
  // would make this one refuse to start (or look ready before it is).
  for (const stale of [`/tmp/.X${XVFB_DISPLAY.slice(1)}-lock`, `/tmp/.X11-unix/X${XVFB_DISPLAY.slice(1)}`]) {
    try { rmSync(stale, { force: true }); } catch { /* not ours to remove */ }
  }
  const proc = spawn('Xvfb', [XVFB_DISPLAY, '-screen', '0', '1366x900x24', '-nolisten', 'tcp'], { stdio: 'ignore', detached: false });
  const failed = new Promise((_, reject) => {
    proc.once('error', (e) => reject(new Error(`a headed Chrome needs a screen, and Xvfb could not start (${e.code === 'ENOENT' ? 'not installed: apt-get install xvfb' : e.message})`)));
    proc.once('exit', (code) => reject(new Error(`Xvfb exited at once (code ${code}); is display ${XVFB_DISPLAY} taken?`)));
  });
  failed.catch(() => {});
  // Ready once its socket exists.
  const socket = `/tmp/.X11-unix/X${XVFB_DISPLAY.slice(1)}`;
  const ready = (async () => {
    for (let t = 0; t < waitMs; t += 100) {
      if (socketExists(socket)) return XVFB_DISPLAY;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Xvfb did not open display ${XVFB_DISPLAY} within ${waitMs} ms`);
  })();
  const display = await Promise.race([ready, failed]);
  process.once('exit', () => { try { proc.kill('SIGTERM'); } catch { /* gone */ } });
  return display;
}

/** Tests only: forget the started Xvfb. */
export function _resetDisplay() {
  xvfb = null;
}
