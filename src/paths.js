/**
 * Where things live.
 *
 * The package directory is read-only in a global install, so nothing may be
 * written inside it. Everything mutable goes to a per-user data directory.
 */

import './env.js';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';

/** Package root — read-only. Contains src/, scripts/, the UI template. */
export const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The HTML template we serve. Read from the package, never written to. */
export const PAGE_FILE = join(PKG_ROOT, 'src', 'ui', 'basket.html');

/**
 * The data folder: JHOLA_HOME (or the old BASKET_HOME) wins. Otherwise
 * ~/.jhola, except that an existing ~/.basket from before the rename is kept
 * in use, so saved prices, sessions and settings are never left behind.
 */
export function resolveDataDir(env = process.env, home = homedir()) {
  if (env.BASKET_HOME) return resolve(env.BASKET_HOME);
  const current = join(home, '.jhola');
  const legacy = join(home, '.basket');
  const dir = !existsSync(current) && existsSync(legacy) ? legacy : current;
  try {
    mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    const fallback = join(tmpdir(), '.jhola');
    mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}

/** Writable per-user state. JHOLA_HOME (or BASKET_HOME) lets tests and CI redirect it. */
export const DATA_DIR = resolveDataDir();

/** Most recent comparison, so a browser tab survives the CLI exiting. */
export const LAST_RESULT = join(DATA_DIR, 'last-result.json');

export function ensureDataDir() {
  mkdirSync(DATA_DIR, { recursive: true });
  return DATA_DIR;
}
