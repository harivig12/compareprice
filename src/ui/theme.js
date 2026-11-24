// Light / dark / auto theme. Loaded synchronously in <head> so the right
// colours apply before first paint (no flash). The choice is per browser
// (localStorage); "auto" follows the system setting and is the default.
(() => {
  const KEY = 'basket-theme';
  const media = window.matchMedia('(prefers-color-scheme: light)');
  const choice = () => {
    try { return localStorage.getItem(KEY) || 'auto'; } catch { return 'auto'; }
  };
  const resolve = (c) => (c === 'light' || c === 'dark' ? c : media.matches ? 'light' : 'dark');
  const apply = () => { document.documentElement.dataset.theme = resolve(choice()); };
  apply();
  media.addEventListener?.('change', () => { if (choice() === 'auto') apply(); });

  function render(el) {
    const cur = choice();
    el.innerHTML = '';
    el.className = 'themetoggle';
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', 'Colour theme');
    for (const [value, label] of [['light', '☀ Light'], ['dark', '☾ Dark'], ['auto', 'Auto']]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.setAttribute('aria-pressed', String(cur === value));
      b.title = value === 'auto' ? 'Follow the system setting' : `${label.slice(2)} theme`;
      b.addEventListener('click', () => {
        try { localStorage.setItem(KEY, value); } catch { /* private mode: still apply for this page */ }
        apply();
        render(el);
      });
      el.appendChild(b);
    }
  }
  document.addEventListener('DOMContentLoaded', () => {
    const el = document.getElementById('themetoggle');
    if (el) render(el);
  });
})();
