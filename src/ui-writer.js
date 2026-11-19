/**
 * Persists the last comparison so the web view survives the CLI exiting, and
 * opens URLs. Shared by the CLI, the server and the MCP server so every surface
 * reads byte-identical data.
 */

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

import { ensureDataDir, LAST_RESULT } from './paths.js';

export { LAST_RESULT, PAGE_FILE } from './paths.js';

/** @returns {string} path the result was written to */
export function saveResult(result) {
  ensureDataDir();
  writeFileSync(LAST_RESULT, JSON.stringify(result, null, 2), 'utf8');
  return LAST_RESULT;
}

/** @returns {object|null} the last comparison, or null if there isn't one */
export function loadResult() {
  if (!existsSync(LAST_RESULT)) return null;
  try {
    return JSON.parse(readFileSync(LAST_RESULT, 'utf8'));
  } catch {
    // A truncated write (killed mid-run) shouldn't take the server down.
    return null;
  }
}

export function openInBrowser(target) {
  const cmd =
    process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', target] : [target];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
}
