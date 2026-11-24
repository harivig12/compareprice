/**
 * Environment names: JHOLA_* is the current spelling, BASKET_* the old one.
 *
 * The project was called "basket" (and its command still answers to it), so
 * every setting is read as BASKET_* inside the code. This module runs first in
 * each entry point and copies JHOLA_HOME, JHOLA_PORT, JHOLA_HOST, JHOLA_URL,
 * JHOLA_BACKEND, JHOLA_CHROME_NO_SANDBOX and JHOLA_DATA onto their BASKET_*
 * names. An explicit BASKET_* value is never overwritten, so old scripts,
 * Docker files and CI settings keep working unchanged.
 *
 * Import it before anything else: `import './env.js';`
 */
export function bridgeEnv(env = process.env) {
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('JHOLA_')) continue;
    const old = `BASKET_${key.slice('JHOLA_'.length)}`;
    if (env[old] === undefined) env[old] = value;
  }
  return env;
}

bridgeEnv();
