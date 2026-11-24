/**
 * Accounts per site (accounts.json in the data dir).
 *
 * The main account of every site lives in the shared browser profile
 * (`chrome-profile`), except BigBasket's, which has a profile of its own
 * (`profiles/bigbasket`, OWN_PROFILES; src/engine/pool.js). Sites that allow it (`LOGIN_SITES[site].multiAccount`:
 * Instamart, Milkbasket) can have up to MAX_ACCOUNTS, each extra one in its
 * own profile under `profiles/<site>-<id>`, so cookies, site storage and
 * device ids never mix between accounts.
 *
 * Stored per account: id, the name the user typed, a masked hint
 * (••••••0494 / a•••@x.com), when it signed in, and its profile directory.
 * Never a number, email, OTP or password.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { SiteError } from './errors.js';

export const MAX_ACCOUNTS = 3;
export const MAIN = 'main';

/** Sites whose main account runs in a Chrome and profile of its own (user decision 2026-11-24). */
export const OWN_PROFILES = Object.freeze({ bigbasket: 'profiles/bigbasket' });

const profileOf = (site, id) => (id === MAIN ? OWN_PROFILES[site] ?? 'chrome-profile' : `profiles/${site}-${id}`);

/** A display name: trimmed, printable, at most 24 characters. */
export function cleanName(name) {
  return String(name ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 24);
}

/** The old sessions.json shape ({ site: { loggedInAt, phoneLast4, hint } }) -> accounts. */
function fromLegacy(legacy) {
  const out = {};
  for (const [site, v] of Object.entries(legacy ?? {})) {
    if (Array.isArray(v)) {
      // A hand-edited file can't point a profile anywhere: it is always derived from site + id.
      out[site] = v.filter((a) => a && /^(main|a\d+)$/.test(a.id)).map((a) => ({ ...a, profile: profileOf(site, a.id) }));
      continue;
    }
    if (!v || typeof v !== 'object') continue;
    out[site] = [{
      id: MAIN, name: 'Main',
      hint: v.hint ?? (v.phoneLast4 ? `••••••${v.phoneLast4}` : null),
      loggedInAt: v.loggedInAt ?? null,
      profile: profileOf(site, MAIN),
    }];
  }
  return out;
}

/**
 * @param {string} file           accounts.json
 * @param {{ legacyFile?: string, multiAccount?: (site: string) => boolean }} [opts]
 */
export function openAccounts(file, { legacyFile, multiAccount = () => false } = {}) {
  const read = () => {
    for (const f of [file, legacyFile]) {
      if (!f || !existsSync(f)) continue;
      try {
        return fromLegacy(JSON.parse(readFileSync(f, 'utf8')));
      } catch { /* unreadable: try the next */ }
    }
    return {};
  };
  const write = (data) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2) + '\n');
    renameSync(`${file}.tmp`, file);
  };
  const update = (fn) => {
    const data = read();
    const out = fn(data);
    write(data);
    return out;
  };
  const listOf = (data, site) => {
    const list = data[site] ?? [];
    // Main always exists (signed in or not), so the popup has a row for it.
    if (!list.some((a) => a.id === MAIN)) list.unshift({ id: MAIN, name: 'Main', hint: null, loggedInAt: null, profile: profileOf(site, MAIN) });
    return list;
  };

  return {
    file,
    list: (site) => listOf(read(), site),
    get: (site, id = MAIN) => listOf(read(), site).find((a) => a.id === id) ?? null,
    signedIn: (site) => listOf(read(), site).filter((a) => a.loggedInAt),
    /** Account id -> display name / hint, for one site (deal hovers). */
    labels(site) {
      const list = listOf(read(), site);
      return { names: Object.fromEntries(list.map((a) => [a.id, a.name])), hints: Object.fromEntries(list.map((a) => [a.id, a.hint])) };
    },

    /** A new, not-yet-signed-in account on a multi-account site. */
    add(site, { name }) {
      if (!multiAccount(site)) throw new SiteError('parse', `${site}: one account only on this site`, { site, code: 'one_account' });
      const clean = cleanName(name);
      if (!clean) throw new SiteError('parse', `${site}: give the account a name (e.g. "Amma")`, { site, code: 'bad_name' });
      return update((data) => {
        const list = listOf(data, site);
        if (list.length >= MAX_ACCOUNTS) throw new SiteError('parse', `${site}: ${MAX_ACCOUNTS} accounts is the limit`, { site, code: 'too_many' });
        if (list.some((a) => a.name.toLowerCase() === clean.toLowerCase())) throw new SiteError('parse', `${site}: there is already an account called "${clean}"`, { site, code: 'bad_name' });
        let n = 2;
        while (list.some((a) => a.id === `a${n}`)) n++;
        const acc = { id: `a${n}`, name: clean, hint: null, loggedInAt: null, profile: profileOf(site, `a${n}`) };
        list.push(acc);
        data[site] = list;
        return acc;
      });
    },

    markSignedIn(site, id, { hint, at = new Date().toISOString() }) {
      return update((data) => {
        const list = listOf(data, site);
        const acc = list.find((a) => a.id === id);
        if (!acc) throw new SiteError('not_found', `${site}: no account "${id}"`, { site });
        Object.assign(acc, { hint: hint ?? acc.hint, loggedInAt: at });
        data[site] = list;
        return acc;
      });
    },

    markSignedOut(site, id) {
      return update((data) => {
        const list = listOf(data, site);
        const acc = list.find((a) => a.id === id);
        if (acc) Object.assign(acc, { loggedInAt: null });
        data[site] = list;
        return acc ?? null;
      });
    },

    /** Drop an extra account (its profile directory is deleted by the caller). */
    remove(site, id) {
      if (id === MAIN) throw new SiteError('parse', `${site}: the main account can be signed out, not removed`, { site, code: 'main' });
      return update((data) => {
        const list = listOf(data, site);
        const i = list.findIndex((a) => a.id === id);
        const [acc] = i >= 0 ? list.splice(i, 1) : [null];
        data[site] = list;
        return acc;
      });
    },
  };
}
