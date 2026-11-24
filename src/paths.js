/**
 * Where things live.
 *
 * The package directory is read-only in a global install, so nothing may be
 * written inside it. Everything mutable goes to a per-user data directory.
 */

import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';

/** Package root — read-only. Contains src/, scripts/, the UI template. */
export const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The HTML template we serve. Read from the package, never written to. */
export const PAGE_FILE = join(PKG_ROOT, 'src', 'ui', 'basket.html');

function resolveDataDir() {
  if (process.env.BASKET_HOME) return resolve(process.env.BASKET_HOME);
  try {
    const dir = join(homedir(), '.basket');
    mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    const fallback = join(tmpdir(), '.basket');
    mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}

/** Writable per-user state. BASKET_HOME lets tests and CI redirect it. */
export const DATA_DIR = resolveDataDir();

/** Most recent comparison, so a browser tab survives the CLI exiting. */
export const LAST_RESULT = join(DATA_DIR, 'last-result.json');

export function ensureDataDir() {
  mkdirSync(DATA_DIR, { recursive: true });
  return DATA_DIR;
}
