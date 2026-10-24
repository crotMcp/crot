/** Synchronous, CSP-safe external head script: theme is resolved before CSS/first paint. */
export const THEME_BOOTSTRAP = String.raw`(() => {
  const media = matchMedia('(prefers-color-scheme: dark)');
  let preference = 'system';
  try { const saved = JSON.parse(localStorage.getItem('crot.theme')); if (['light','dark','system'].includes(saved)) preference = saved; } catch { /* restricted storage */ }
  const apply = () => { document.documentElement.dataset.theme = preference === 'system' ? (media.matches ? 'dark' : 'light') : preference; document.documentElement.dataset.themePreference = preference; };
  window.CrotTheme = { get: () => preference, set: value => { if (!['light','dark','system'].includes(value)) return; preference = value; try { localStorage.setItem('crot.theme', JSON.stringify(value)); } catch { /* optional */ } apply(); } };
  media.addEventListener('change', apply); apply();
})();`;
