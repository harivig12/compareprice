/**
 * Swiggy Instamart search adapter.
 *
 * Strategy: pending recon (see extractExpression).
 */

export const site = 'instamart';
export const label = 'Instamart';

export function searchUrl(query) {
  return `https://www.swiggy.com/instamart/search?custom_back=true&query=${encodeURIComponent(query)}`;
}

export const readyExpression = `(() => {
  return !!document.querySelector('[data-testid]')
      || !!window.___INITIAL_STATE__;
})()`;

export const extractExpression = `(() => ({ error: 'not_implemented' }))()`;
