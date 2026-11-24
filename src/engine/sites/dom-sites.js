/**
 * DOM-only sites (no guest API found yet). Each note records why, so the
 * next person knows where recon stopped. See docs/diagnosis/2026-11-16-api-platforms-failing.md.
 */
import { domSite } from './_dom.js';

export const milkbasket = domSite({
  id: 'milkbasket',
  label: 'Milkbasket',
  origin: 'https://www.milkbasket.com/',
  note: 'GraphQL consumerbff needs a session/society assignment; web search is app-driven.',
  // Recon 2026-11-18/19: guests get no location input; every guest GraphQL
  // call is pinned to cityid=1/hubid=1 (its default city) and /search?q=
  // renders a brand store, not results. A web login exists at /login
  // (mobile number -> OTP); the location comes from the account's society
  // (GraphQL has getSocieties). Supporting it needs one OTP login.
  skip: 'needs a login: guests are pinned to the default city and search shows no results; sign-in is mobile + OTP at milkbasket.com/login, then a society is picked',
});
